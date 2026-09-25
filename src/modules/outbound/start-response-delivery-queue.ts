import type { TelegramButton } from "./telegram-messages.js";
import { Optional } from "@nestjs/common";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  reserveTelegramSlot,
  deferTelegramSlot,
} from "./telegram-transport-slots.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";

import {
  DATABASE,
  type Database,
  type DeliveryAttemptOutcome,
  type StartResponseDeliveryState,
} from "../../database/database.js";
import type { TelegramDeliveryResult } from "./telegram-messages.js";
import {
  claim,
  expireLeases,
  retryDelay,
  settle,
  type DurableQueue,
  type Lease,
} from "../../database/durable-queue.js";

const MAX_DELIVERY_ATTEMPTS = 3;

const replies: DurableQueue<"start_response_deliveries"> = {
  table: "start_response_deliveries",
  key: ["id"],
  order: ["id"],
  ready: ["pending", "retry_scheduled"],
  leased: "sending",
  due: "available_at",
  attempts: "attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 1000, maxMs: 4000 },
};

export interface ClaimedStartResponseDelivery {
  readonly buttons?: readonly TelegramButton[];
  readonly attemptNumber: number;
  readonly id: string;
  readonly messageText: string;
  readonly privateChatId: string;
  readonly signInRequestRef?: string;
  readonly editMessageId?: string;
  readonly lease: Lease<"start_response_deliveries">;
}

/** One reply the bot sends to a contact's private chat. */
export interface PlannedReply {
  readonly botIdentity: string;
  readonly telegramUserId: string;
  readonly privateChatId: string;
  readonly messageText: string;
  /** Work replayed under the same key reuses the first reply instead of sending twice. */
  readonly sourceKey: string;
  /** The update that asked for this reply, when a contact's own message did. */
  readonly triggerUpdateId?: string;
  readonly buttons?: readonly TelegramButton[];
  readonly signInRequestRef?: string;
  /** Edits this earlier bot message instead of sending a new one. */
  readonly editMessageId?: string;
  readonly now: Date;
}

/**
 * Every reply enters the outbox here; `StartResponseDeliveryQueue.enqueue` is the same call for
 * injected callers. Pass the caller's transaction so the reply commits together with the
 * decision it answers. Returns false, and adds nothing, when the source key already has a reply.
 */
export async function enqueueReply(
  database: Database | Transaction<DatabaseSchema>,
  reply: PlannedReply,
): Promise<boolean> {
  const inserted = await database
    .insertInto("start_response_deliveries")
    .values({
      attempt_count: 0,
      available_at: reply.now,
      bot_identity: reply.botIdentity,
      buttons: reply.buttons
        ? (JSON.stringify(
            reply.buttons,
          ) as unknown as readonly TelegramButton[])
        : null,
      created_at: reply.now,
      delivered_at: null,
      diagnostic_code: null,
      edit_message_id: reply.editMessageId ?? null,
      locked_at: null,
      message_text: reply.messageText,
      private_chat_id: reply.privateChatId,
      sign_in_request_ref: reply.signInRequestRef ?? null,
      source_key: reply.sourceKey,
      state: "pending",
      telegram_user_id: reply.telegramUserId,
      trigger_update_id: reply.triggerUpdateId ?? null,
      updated_at: reply.now,
    })
    .onConflict((conflict) => conflict.column("source_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

/** Whether a reply is due now; service replies always go ahead of marketing sends. */
export async function hasDueReply(
  database: Database | Transaction<DatabaseSchema>,
  botIdentity: string,
  now: Date,
): Promise<boolean> {
  const due = await database
    .selectFrom("start_response_deliveries")
    .select("id")
    .where("bot_identity", "=", botIdentity)
    .where("state", "in", ["pending", "retry_scheduled"])
    .where("available_at", "<=", now)
    .executeTakeFirst();
  return due !== undefined;
}

/** Replies per delivery state, for the redacted operator snapshot. */
export async function replyStateCounts(
  database: Database,
): Promise<Record<string, number>> {
  const rows = await database
    .selectFrom("start_response_deliveries")
    .select(["state as key", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("state")
    .orderBy("state")
    .execute();
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

/** Send attempts per outcome, for the redacted operator snapshot. */
export async function replyAttemptOutcomeCounts(
  database: Database,
): Promise<Record<string, number>> {
  const rows = await database
    .selectFrom("start_response_delivery_attempts")
    .select(["outcome as key", (eb) => eb.fn.countAll<string>().as("count")])
    .groupBy("outcome")
    .orderBy("outcome")
    .execute();
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

@Injectable()
export class StartResponseDeliveryQueue {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Optional()
    @Inject(APPLICATION_CONFIG)
    private readonly config?: ApplicationConfig,
  ) {}

  async enqueue(
    reply: PlannedReply,
    database: Database | Transaction<DatabaseSchema> = this.database,
  ): Promise<boolean> {
    return enqueueReply(database, reply);
  }

  async claimNext(
    now: Date,
    signInEnabled = false,
  ): Promise<ClaimedStartResponseDelivery | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const abandoned = await expireLeases(transaction, replies, now, {
        available_at: now,
        diagnostic_code: "worker_lease_expired",
        locked_at: null,
        state: sql`case when attempt_count >= ${MAX_DELIVERY_ATTEMPTS}
          then 'unknown_exhausted' else 'retry_scheduled' end`,
        updated_at: now,
      });
      for (const lease of abandoned) {
        await transaction
          .insertInto("start_response_delivery_attempts")
          .values({
            attempt_number: lease.attempt,
            attempted_at: now,
            diagnostic_code: "worker_lease_expired",
            outcome: "transport_unknown",
            provider_error_code: null,
            provider_message_id: null,
            start_response_delivery_id: lease.key.id as string,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      }

      const delivery = await claim(transaction, replies, now, {
        select: [
          "buttons",
          "id",
          "message_text",
          "private_chat_id",
          "bot_identity",
          "sign_in_request_ref",
          "edit_message_id",
        ],
        where: (eb) =>
          eb.or([
            eb("sign_in_request_ref", "is", null),
            ...(signInEnabled
              ? [
                  eb.exists(
                    eb
                      .selectFrom("sign_in_requests")
                      .select("request_ref")
                      .whereRef(
                        "request_ref",
                        "=",
                        "start_response_deliveries.sign_in_request_ref",
                      )
                      .where((requestEb) =>
                        requestEb.or([
                          requestEb.and([
                            requestEb(
                              "start_response_deliveries.edit_message_id",
                              "is",
                              null,
                            ),
                            requestEb("state", "=", "awaiting_approval"),
                            requestEb("expires_at", ">", now),
                          ]),
                          requestEb.and([
                            requestEb(
                              "start_response_deliveries.edit_message_id",
                              "is not",
                              null,
                            ),
                            requestEb.or([
                              requestEb("state", "=", "denied"),
                              requestEb.and([
                                requestEb("state", "=", "consumed"),
                                requestEb.exists(
                                  requestEb
                                    .selectFrom("link_transactions")
                                    .select("link_transaction_ref")
                                    .where(
                                      "link_transaction_ref",
                                      "=",
                                      sql<string>`sign_in_requests.request_ref::text`,
                                    )
                                    .where("state", "=", "linked"),
                                ),
                              ]),
                            ]),
                          ]),
                        ]),
                      ),
                  ),
                ]
              : []),
          ]),
        prepare: async (tx, row) =>
          (this.config?.marketingEnabled ||
            this.config?.deliveryMode === "live") &&
          !(await reserveTelegramSlot(
            tx,
            row.bot_identity,
            row.private_chat_id,
            now,
          ))
            ? undefined
            : { diagnostic_code: null, updated_at: now },
      });
      if (!delivery) {
        return undefined;
      }
      const row = delivery.row;
      return {
        ...(row.buttons ? { buttons: row.buttons } : {}),
        attemptNumber: delivery.attempt,
        id: row.id,
        lease: delivery,
        messageText: row.message_text,
        privateChatId: row.private_chat_id,
        ...(row.edit_message_id ? { editMessageId: row.edit_message_id } : {}),
        ...(row.sign_in_request_ref
          ? { signInRequestRef: row.sign_in_request_ref }
          : {}),
      };
    });
  }

  async recordResult(
    delivery: ClaimedStartResponseDelivery,
    result: TelegramDeliveryResult,
    attemptedAt: Date,
  ): Promise<boolean> {
    const persistence = deliveryOutcomePersistence(
      result,
      delivery.attemptNumber,
      attemptedAt,
    );
    return this.database.transaction().execute(async (transaction) => {
      if (
        (this.config?.marketingEnabled ||
          this.config?.deliveryMode === "live") &&
        result.kind === "api_retryable" &&
        result.providerErrorCode === 429
      ) {
        await deferTelegramSlot(
          transaction,
          this.config.botIdentity,
          new Date(
            attemptedAt.getTime() + (result.retryAfterSeconds ?? 5) * 1000,
          ),
        );
      }
      const held = await settle(transaction, replies, delivery.lease, {
        available_at: persistence.delivery.availableAt,
        delivered_at: persistence.delivery.deliveredAt,
        diagnostic_code: persistence.delivery.diagnosticCode,
        locked_at: null,
        state: persistence.delivery.state,
        updated_at: attemptedAt,
      });
      // An expired lease already recorded this attempt as unknown; the late outcome is dropped.
      if (!held) return false;
      await transaction
        .insertInto("start_response_delivery_attempts")
        .values({
          attempt_number: delivery.attemptNumber,
          attempted_at: attemptedAt,
          diagnostic_code: persistence.attempt.diagnosticCode,
          outcome: persistence.attempt.outcome,
          provider_error_code: persistence.attempt.providerErrorCode,
          provider_message_id: persistence.attempt.providerMessageId,
          start_response_delivery_id: delivery.id,
        })
        .execute();
      return true;
    });
  }
}

interface DeliveryOutcomePersistence {
  readonly attempt: {
    readonly diagnosticCode: string | null;
    readonly outcome: DeliveryAttemptOutcome;
    readonly providerErrorCode: number | null;
    readonly providerMessageId: string | null;
  };
  readonly delivery: {
    readonly availableAt: Date;
    readonly deliveredAt: Date | null;
    readonly diagnosticCode: string | null;
    readonly state: StartResponseDeliveryState;
  };
}

function deliveryOutcomePersistence(
  result: TelegramDeliveryResult,
  attemptNumber: number,
  attemptedAt: Date,
): DeliveryOutcomePersistence {
  const exhausted = attemptNumber >= MAX_DELIVERY_ATTEMPTS;
  const exponentialDelay = retryDelay(replies, attemptNumber);

  switch (result.kind) {
    case "delivered":
      return {
        attempt: {
          diagnosticCode: null,
          outcome: "delivered",
          providerErrorCode: null,
          providerMessageId: result.providerMessageId,
        },
        delivery: {
          availableAt: attemptedAt,
          deliveredAt: attemptedAt,
          diagnosticCode: null,
          state: "delivered",
        },
      };
    case "api_rejected":
      return {
        attempt: {
          diagnosticCode: null,
          outcome: "api_rejected",
          providerErrorCode: result.providerErrorCode,
          providerMessageId: null,
        },
        delivery: {
          availableAt: attemptedAt,
          deliveredAt: null,
          diagnosticCode: "telegram_api_rejected",
          state: "rejected",
        },
      };
    case "api_retryable": {
      const providerDelay = (result.retryAfterSeconds ?? 0) * 1000;
      return {
        attempt: {
          diagnosticCode: "telegram_api_retryable",
          outcome: "api_retryable",
          providerErrorCode: result.providerErrorCode,
          providerMessageId: null,
        },
        delivery: {
          availableAt: new Date(
            attemptedAt.getTime() + Math.max(exponentialDelay, providerDelay),
          ),
          deliveredAt: null,
          diagnosticCode: exhausted
            ? "telegram_api_retry_exhausted"
            : "telegram_api_retryable",
          state: exhausted ? "rejected" : "retry_scheduled",
        },
      };
    }
    case "transport_unknown":
      return {
        attempt: {
          diagnosticCode: "transport_unknown",
          outcome: "transport_unknown",
          providerErrorCode: null,
          providerMessageId: null,
        },
        delivery: {
          availableAt: new Date(attemptedAt.getTime() + exponentialDelay),
          deliveredAt: null,
          diagnosticCode: "transport_unknown",
          state: exhausted ? "unknown_exhausted" : "retry_scheduled",
        },
      };
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  void value;
  throw new Error("Unhandled Telegram delivery outcome");
}

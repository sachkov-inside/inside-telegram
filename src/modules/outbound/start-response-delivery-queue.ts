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

@Injectable()
export class StartResponseDeliveryQueue {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Optional()
    @Inject(APPLICATION_CONFIG)
    private readonly config?: ApplicationConfig,
  ) {}

  /**
   * Adds one durable private-chat reply. The source key makes a replayed update
   * reuse the same intent instead of sending twice.
   */
  async enqueue(
    delivery: {
      readonly buttons?: readonly TelegramButton[];
      readonly botIdentity: string;
      readonly telegramUserId: string;
      readonly privateChatId: string;
      readonly messageText: string;
      readonly sourceKey: string;
      readonly triggerUpdateId?: string;
      readonly now: Date;
    },
    database: Database | Transaction<DatabaseSchema> = this.database,
  ): Promise<void> {
    await database
      .insertInto("start_response_deliveries")
      .values({
        buttons: delivery.buttons
          ? (JSON.stringify(
              delivery.buttons,
            ) as unknown as readonly TelegramButton[])
          : null,
        attempt_count: 0,
        available_at: delivery.now,
        bot_identity: delivery.botIdentity,
        created_at: delivery.now,
        delivered_at: null,
        diagnostic_code: null,
        locked_at: null,
        message_text: delivery.messageText,
        private_chat_id: delivery.privateChatId,
        source_key: delivery.sourceKey,
        state: "pending",
        telegram_user_id: delivery.telegramUserId,
        trigger_update_id: delivery.triggerUpdateId ?? null,
        updated_at: delivery.now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
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

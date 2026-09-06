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
import { sql } from "kysely";

import {
  DATABASE,
  type Database,
  type DeliveryAttemptOutcome,
  type StartResponseDeliveryState,
} from "../../database/database.js";
import type { TelegramDeliveryResult } from "./telegram-messages.js";

const MAX_DELIVERY_ATTEMPTS = 3;
const SEND_LEASE_MILLISECONDS = 60_000;

export interface ClaimedStartResponseDelivery {
  readonly attemptNumber: number;
  readonly id: string;
  readonly messageText: string;
  readonly privateChatId: string;
  readonly signInRequestRef?: string;
  readonly editMessageId?: string;
}

@Injectable()
export class StartResponseDeliveryQueue {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Optional()
    @Inject(APPLICATION_CONFIG)
    private readonly config?: ApplicationConfig,
  ) {}

  async claimNext(
    now: Date,
    signInEnabled = false,
  ): Promise<ClaimedStartResponseDelivery | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const stale = await transaction
        .selectFrom("start_response_deliveries")
        .select(["attempt_count", "id"])
        .where("state", "=", "sending")
        .where(
          "locked_at",
          "<=",
          new Date(now.getTime() - SEND_LEASE_MILLISECONDS),
        )
        .orderBy("id", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (stale) {
        await transaction
          .insertInto("start_response_delivery_attempts")
          .values({
            attempt_number: stale.attempt_count,
            attempted_at: now,
            diagnostic_code: "worker_lease_expired",
            outcome: "transport_unknown",
            provider_error_code: null,
            provider_message_id: null,
            start_response_delivery_id: stale.id,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();

        await transaction
          .updateTable("start_response_deliveries")
          .set({
            available_at: now,
            diagnostic_code: "worker_lease_expired",
            locked_at: null,
            state:
              stale.attempt_count >= MAX_DELIVERY_ATTEMPTS
                ? "unknown_exhausted"
                : "retry_scheduled",
            updated_at: now,
          })
          .where("id", "=", stale.id)
          .execute();
      }

      const delivery = await transaction
        .selectFrom("start_response_deliveries")
        .select([
          "attempt_count",
          "id",
          "message_text",
          "private_chat_id",
          "bot_identity",
          "sign_in_request_ref",
          "edit_message_id",
        ])
        .where((eb) =>
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
        )
        .where("state", "in", ["pending", "retry_scheduled"])
        .where("available_at", "<=", now)
        .orderBy("id", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!delivery) {
        return undefined;
      }

      if (
        this.config?.marketingEnabled &&
        !(await reserveTelegramSlot(
          transaction,
          delivery.bot_identity,
          delivery.private_chat_id,
          now,
        ))
      )
        return undefined;
      const attemptNumber = delivery.attempt_count + 1;
      await transaction
        .updateTable("start_response_deliveries")
        .set({
          attempt_count: attemptNumber,
          diagnostic_code: null,
          locked_at: now,
          state: "sending",
          updated_at: now,
        })
        .where("id", "=", delivery.id)
        .execute();

      return {
        attemptNumber,
        id: delivery.id,
        messageText: delivery.message_text,
        privateChatId: delivery.private_chat_id,
        ...(delivery.edit_message_id
          ? { editMessageId: delivery.edit_message_id }
          : {}),
        ...(delivery.sign_in_request_ref
          ? { signInRequestRef: delivery.sign_in_request_ref }
          : {}),
      };
    });
  }

  async recordResult(
    delivery: ClaimedStartResponseDelivery,
    result: TelegramDeliveryResult,
    attemptedAt: Date,
  ): Promise<void> {
    const persistence = deliveryOutcomePersistence(
      result,
      delivery.attemptNumber,
      attemptedAt,
    );
    await this.database.transaction().execute(async (transaction) => {
      if (
        this.config?.marketingEnabled &&
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

      await transaction
        .updateTable("start_response_deliveries")
        .set({
          available_at: persistence.delivery.availableAt,
          delivered_at: persistence.delivery.deliveredAt,
          diagnostic_code: persistence.delivery.diagnosticCode,
          locked_at: null,
          state: persistence.delivery.state,
          updated_at: attemptedAt,
        })
        .where("id", "=", delivery.id)
        .execute();
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
  const exponentialDelay = 1000 * 2 ** (attemptNumber - 1);

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

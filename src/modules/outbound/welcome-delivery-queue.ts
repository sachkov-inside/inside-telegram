import { Inject, Injectable } from "@nestjs/common";

import {
  DATABASE,
  type Database,
  type DeliveryAttemptOutcome,
  type WelcomeDeliveryState,
} from "../../database/database.js";
import type { TelegramDeliveryResult } from "./telegram-messages.js";

const MAX_DELIVERY_ATTEMPTS = 3;
const SEND_LEASE_MILLISECONDS = 60_000;

export interface ClaimedWelcomeDelivery {
  readonly attemptNumber: number;
  readonly id: string;
  readonly messageText: string;
  readonly privateChatId: string;
}

@Injectable()
export class WelcomeDeliveryQueue {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async claimNext(now: Date): Promise<ClaimedWelcomeDelivery | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const stale = await transaction
        .selectFrom("welcome_deliveries")
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
          .insertInto("welcome_delivery_attempts")
          .values({
            attempt_number: stale.attempt_count,
            attempted_at: now,
            diagnostic_code: "worker_lease_expired",
            outcome: "transport_unknown",
            provider_error_code: null,
            provider_message_id: null,
            welcome_delivery_id: stale.id,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();

        await transaction
          .updateTable("welcome_deliveries")
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
        .selectFrom("welcome_deliveries")
        .select(["attempt_count", "id", "message_text", "private_chat_id"])
        .where("state", "in", ["pending", "retry_scheduled"])
        .where("available_at", "<=", now)
        .orderBy("id", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!delivery) {
        return undefined;
      }

      const attemptNumber = delivery.attempt_count + 1;
      await transaction
        .updateTable("welcome_deliveries")
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
      };
    });
  }

  async recordResult(
    delivery: ClaimedWelcomeDelivery,
    result: TelegramDeliveryResult,
    attemptedAt: Date,
  ): Promise<void> {
    const persistence = deliveryOutcomePersistence(
      result,
      delivery.attemptNumber,
      attemptedAt,
    );
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("welcome_delivery_attempts")
        .values({
          attempt_number: delivery.attemptNumber,
          attempted_at: attemptedAt,
          diagnostic_code: persistence.attempt.diagnosticCode,
          outcome: persistence.attempt.outcome,
          provider_error_code: persistence.attempt.providerErrorCode,
          provider_message_id: persistence.attempt.providerMessageId,
          welcome_delivery_id: delivery.id,
        })
        .execute();

      await transaction
        .updateTable("welcome_deliveries")
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
    readonly state: WelcomeDeliveryState;
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

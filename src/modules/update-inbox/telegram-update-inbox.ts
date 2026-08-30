import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type Database } from "../../database/database.js";

const MAX_PROCESS_ATTEMPTS = 5;
const PROCESS_LEASE_MILLISECONDS = 60_000;

export interface ClaimedTelegramUpdate {
  readonly botIdentity: string;
  readonly payload: unknown;
  readonly processAttemptCount: number;
  readonly receivedAt: Date;
  readonly updateId: string;
}

@Injectable()
export class TelegramUpdateInbox {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async accept(
    botIdentity: string,
    updateId: string,
    payload: unknown,
    receivedAt: Date,
  ): Promise<"accepted" | "duplicate"> {
    const inserted = await this.database
      .insertInto("telegram_updates")
      .values({
        available_at: receivedAt,
        bot_identity: botIdentity,
        failure_code: null,
        locked_at: null,
        payload,
        process_attempt_count: 0,
        processed_at: null,
        received_at: receivedAt,
        state: "pending",
        update_id: updateId,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning("update_id")
      .executeTakeFirst();
    return inserted ? "accepted" : "duplicate";
  }

  async claimNext(now: Date): Promise<ClaimedTelegramUpdate | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const stale = await transaction
        .selectFrom("telegram_updates")
        .select(["bot_identity", "update_id"])
        .where("state", "=", "processing")
        .where(
          "locked_at",
          "<=",
          new Date(now.getTime() - PROCESS_LEASE_MILLISECONDS),
        )
        .orderBy("update_id", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (stale) {
        await transaction
          .updateTable("telegram_updates")
          .set({
            available_at: now,
            failure_code: "worker_lease_expired",
            locked_at: null,
            state: "pending",
          })
          .where("bot_identity", "=", stale.bot_identity)
          .where("update_id", "=", stale.update_id)
          .execute();
      }

      const update = await transaction
        .selectFrom("telegram_updates")
        .select([
          "bot_identity",
          "payload",
          "process_attempt_count",
          "received_at",
          "update_id",
        ])
        .where("state", "=", "pending")
        .where("available_at", "<=", now)
        .orderBy("update_id", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!update || update.payload === null) {
        return undefined;
      }

      const processAttemptCount = update.process_attempt_count + 1;
      await transaction
        .updateTable("telegram_updates")
        .set({
          process_attempt_count: processAttemptCount,
          locked_at: now,
          state: "processing",
        })
        .where("bot_identity", "=", update.bot_identity)
        .where("update_id", "=", update.update_id)
        .execute();

      return {
        botIdentity: update.bot_identity,
        payload: update.payload,
        processAttemptCount,
        receivedAt: update.received_at,
        updateId: update.update_id,
      };
    });
  }

  async markProcessed(
    update: ClaimedTelegramUpdate,
    processedAt: Date,
  ): Promise<void> {
    await this.database
      .updateTable("telegram_updates")
      .set({
        failure_code: null,
        locked_at: null,
        payload: null,
        processed_at: processedAt,
        state: "processed",
      })
      .where("bot_identity", "=", update.botIdentity)
      .where("update_id", "=", update.updateId)
      .where("state", "=", "processing")
      .execute();
  }

  async markFailed(
    update: ClaimedTelegramUpdate,
    failedAt: Date,
  ): Promise<"failed" | "retry_scheduled"> {
    if (update.processAttemptCount >= MAX_PROCESS_ATTEMPTS) {
      await this.database
        .updateTable("telegram_updates")
        .set({
          failure_code: "processing_failed",
          locked_at: null,
          payload: null,
          processed_at: failedAt,
          state: "failed",
        })
        .where("bot_identity", "=", update.botIdentity)
        .where("update_id", "=", update.updateId)
        .execute();
      return "failed";
    }

    const delayMilliseconds = 1000 * 2 ** (update.processAttemptCount - 1);
    await this.database
      .updateTable("telegram_updates")
      .set({
        available_at: new Date(failedAt.getTime() + delayMilliseconds),
        failure_code: "processing_failed",
        locked_at: null,
        state: "pending",
      })
      .where("bot_identity", "=", update.botIdentity)
      .where("update_id", "=", update.updateId)
      .execute();
    return "retry_scheduled";
  }
}

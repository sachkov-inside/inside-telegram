import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type Database } from "../../database/database.js";

const CHECK_LEASE_MILLISECONDS = 60_000;

export interface ClaimedInitialMembershipCheck {
  readonly attemptNumber: number;
  readonly checkRef: string;
  readonly id: string;
  readonly telegramIdentityRef: string;
}

@Injectable()
export class InitialMembershipCheckQueue {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async claimNext(
    now: Date,
  ): Promise<ClaimedInitialMembershipCheck | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const stale = await transaction
        .selectFrom("membership_checks")
        .select("id")
        .where("state", "=", "processing")
        .where(
          "locked_at",
          "<=",
          new Date(now.getTime() - CHECK_LEASE_MILLISECONDS),
        )
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (stale) {
        await transaction
          .updateTable("membership_checks")
          .set({
            available_at: now,
            diagnostic_code: "worker_lease_expired",
            locked_at: null,
            state: "pending",
          })
          .where("id", "=", stale.id)
          .execute();
      }

      const check = await transaction
        .selectFrom("membership_checks")
        .select(["attempt_count", "id", "telegram_identity_ref"])
        .where("state", "=", "pending")
        .where("available_at", "<=", now)
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!check) {
        return undefined;
      }

      const attemptNumber = check.attempt_count + 1;
      await transaction
        .updateTable("membership_checks")
        .set({
          attempt_count: attemptNumber,
          diagnostic_code: null,
          locked_at: now,
          state: "processing",
        })
        .where("id", "=", check.id)
        .execute();
      return {
        attemptNumber,
        checkRef: `initial-link:${check.id}`,
        id: check.id,
        telegramIdentityRef: check.telegram_identity_ref,
      };
    });
  }

  async complete(
    check: ClaimedInitialMembershipCheck,
    completedAt: Date,
  ): Promise<void> {
    await this.database
      .updateTable("membership_checks")
      .set({
        completed_at: completedAt,
        diagnostic_code: null,
        locked_at: null,
        state: "completed",
      })
      .where("id", "=", check.id)
      .where("state", "=", "processing")
      .execute();
  }

  async retry(
    check: ClaimedInitialMembershipCheck,
    failedAt: Date,
  ): Promise<void> {
    const delay = Math.min(60_000, 1000 * 2 ** (check.attemptNumber - 1));
    await this.database
      .updateTable("membership_checks")
      .set({
        available_at: new Date(failedAt.getTime() + delay),
        diagnostic_code: "membership_check_failed",
        locked_at: null,
        state: "pending",
      })
      .where("id", "=", check.id)
      .where("state", "=", "processing")
      .execute();
  }
}

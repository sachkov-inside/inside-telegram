import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type Database } from "../../database/database.js";
import {
  claimNext,
  retryDelay,
  settle,
  type DurableQueue,
  type Lease,
} from "../../database/durable-queue.js";

const checks: DurableQueue<"membership_checks"> = {
  table: "membership_checks",
  key: ["id"],
  order: ["id"],
  ready: ["pending"],
  leased: "processing",
  due: "available_at",
  attempts: "attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 1000, maxMs: 60_000 },
};

export interface ClaimedInitialMembershipCheck {
  readonly attemptNumber: number;
  readonly checkRef: string;
  readonly id: string;
  readonly lease: Lease<"membership_checks">;
  readonly telegramIdentityRef: string;
}

@Injectable()
export class InitialMembershipCheckQueue {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async claimNext(
    now: Date,
  ): Promise<ClaimedInitialMembershipCheck | undefined> {
    const claimed = await claimNext(
      this.database,
      checks,
      now,
      {
        available_at: now,
        diagnostic_code: "worker_lease_expired",
        locked_at: null,
        state: "pending",
      },
      {
        select: ["id", "telegram_identity_ref"],
        prepare: () => Promise.resolve({ diagnostic_code: null }),
      },
    );
    if (!claimed) {
      return undefined;
    }
    return {
      attemptNumber: claimed.attempt,
      checkRef: `initial-link:${claimed.row.id}`,
      id: claimed.row.id,
      lease: claimed,
      telegramIdentityRef: claimed.row.telegram_identity_ref,
    };
  }

  async complete(
    check: ClaimedInitialMembershipCheck,
    completedAt: Date,
  ): Promise<void> {
    await settle(this.database, checks, check.lease, {
      completed_at: completedAt,
      diagnostic_code: null,
      locked_at: null,
      state: "completed",
    });
  }

  async retry(
    check: ClaimedInitialMembershipCheck,
    failedAt: Date,
  ): Promise<void> {
    await settle(this.database, checks, check.lease, {
      available_at: new Date(
        failedAt.getTime() + retryDelay(checks, check.attemptNumber),
      ),
      diagnostic_code: "membership_check_failed",
      locked_at: null,
      state: "pending",
    });
  }
}

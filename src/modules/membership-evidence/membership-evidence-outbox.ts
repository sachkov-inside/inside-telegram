import { Inject, Injectable } from "@nestjs/common";

import {
  DATABASE,
  type Database,
  type MembershipEvidenceDeliveryState,
} from "../../database/database.js";
import {
  type MembershipEvidence,
  type MembershipEvidenceSource,
  readStoredMembershipEvidence,
} from "./membership-evidence.js";
import {
  claimNext,
  held,
  retryDelay,
  settle,
  type DurableQueue,
  type Lease,
} from "../../database/durable-queue.js";
import { withProviderDeliveryLock } from "./membership-provider-delivery-lock.js";
import type { PlatformEvidenceDeliveryResult } from "./platform-evidence-delivery.js";

const evidenceOutbox: DurableQueue<"membership_evidence_outbox"> = {
  table: "membership_evidence_outbox",
  key: ["id"],
  order: ["id"],
  ready: ["pending", "retry_scheduled"],
  leased: "delivering",
  due: "available_at",
  attempts: "attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 1000, maxMs: 5 * 60_000 },
};

export interface ClaimedMembershipEvidenceDelivery {
  readonly attemptNumber: number;
  readonly evidence: MembershipEvidence;
  readonly idempotencyKey: string;
  readonly lease: Lease<"membership_evidence_outbox">;
  readonly source: MembershipEvidenceSource;
}

@Injectable()
export class MembershipEvidenceOutbox {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async claimNext(
    now: Date,
  ): Promise<ClaimedMembershipEvidenceDelivery | undefined> {
    const claimed = await claimNext(
      this.database,
      evidenceOutbox,
      now,
      {
        available_at: now,
        diagnostic_code: "worker_lease_expired",
        locked_at: null,
        state: "retry_scheduled",
        updated_at: now,
      },
      {
        select: ["envelope", "id", "source"],
        prepare: async () => ({ diagnostic_code: null, updated_at: now }),
      },
    );
    if (!claimed) {
      return undefined;
    }
    return {
      attemptNumber: claimed.attempt,
      evidence: readStoredMembershipEvidence(claimed.row.envelope),
      idempotencyKey: claimed.row.id,
      lease: claimed,
      source: claimed.row.source,
    };
  }

  async recordResult(
    delivery: ClaimedMembershipEvidenceDelivery,
    result: PlatformEvidenceDeliveryResult,
    attemptedAt: Date,
  ): Promise<void> {
    const state = deliveryState(result);
    await settle(this.database, evidenceOutbox, delivery.lease, {
      available_at:
        state === "retry_scheduled"
          ? new Date(
              attemptedAt.getTime() +
                retryDelay(evidenceOutbox, delivery.attemptNumber),
            )
          : attemptedAt,
      delivered_at: state === "delivered" ? attemptedAt : null,
      diagnostic_code:
        result.kind === "delivered" ? null : result.diagnosticCode,
      locked_at: null,
      state,
      updated_at: attemptedAt,
    });
  }

  async deliverIfClaimActive<Result>(
    delivery: ClaimedMembershipEvidenceDelivery,
    operation: () => Promise<Result>,
  ): Promise<Result | undefined> {
    const owner = await this.database
      .selectFrom("membership_evidence_outbox")
      .innerJoin(
        "membership_check_results",
        "membership_check_results.result_ref",
        "membership_evidence_outbox.result_ref",
      )
      .innerJoin(
        "platform_links",
        "platform_links.telegram_identity_ref",
        "membership_check_results.telegram_identity_ref",
      )
      .select("platform_links.bot_identity")
      .where("membership_evidence_outbox.id", "=", delivery.idempotencyKey)
      .executeTakeFirst();
    if (!owner) {
      return undefined;
    }
    return withProviderDeliveryLock(
      this.database,
      owner.bot_identity,
      async (connection) => {
        // Only the current lease holder delivers; a worker whose lease expired stays silent.
        const stored = await connection
          .selectFrom("membership_evidence_outbox")
          .select("id")
          .where(held(evidenceOutbox, delivery.lease))
          .executeTakeFirst();
        return stored ? operation() : Promise.resolve(undefined);
      },
    );
  }
}

function deliveryState(
  result: PlatformEvidenceDeliveryResult,
): MembershipEvidenceDeliveryState {
  switch (result.kind) {
    case "delivered":
      return "delivered";
    case "rejected":
      return "rejected";
    case "retryable":
      return "retry_scheduled";
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  void value;
  throw new Error("Unhandled Platform evidence delivery result");
}

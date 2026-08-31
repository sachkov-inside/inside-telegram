import { Inject, Injectable } from "@nestjs/common";

import {
  DATABASE,
  type Database,
  type MembershipEvidenceDeliveryState,
} from "../../database/database.js";
import {
  type MembershipEvidence,
  readStoredMembershipEvidence,
} from "./membership-evidence.js";
import { withProviderDeliveryLock } from "./membership-provider-delivery-lock.js";
import type { PlatformEvidenceDeliveryResult } from "./platform-evidence-delivery.js";

const DELIVERY_LEASE_MILLISECONDS = 60_000;

export interface ClaimedMembershipEvidenceDelivery {
  readonly attemptNumber: number;
  readonly evidence: MembershipEvidence;
  readonly idempotencyKey: string;
}

@Injectable()
export class MembershipEvidenceOutbox {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async claimNext(
    now: Date,
  ): Promise<ClaimedMembershipEvidenceDelivery | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const stale = await transaction
        .selectFrom("membership_evidence_outbox")
        .select("id")
        .where("state", "=", "delivering")
        .where(
          "locked_at",
          "<=",
          new Date(now.getTime() - DELIVERY_LEASE_MILLISECONDS),
        )
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (stale) {
        await transaction
          .updateTable("membership_evidence_outbox")
          .set({
            available_at: now,
            diagnostic_code: "worker_lease_expired",
            locked_at: null,
            state: "retry_scheduled",
            updated_at: now,
          })
          .where("id", "=", stale.id)
          .execute();
      }

      const delivery = await transaction
        .selectFrom("membership_evidence_outbox")
        .select(["attempt_count", "envelope", "id"])
        .where("state", "in", ["pending", "retry_scheduled"])
        .where("available_at", "<=", now)
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!delivery) {
        return undefined;
      }

      const attemptNumber = delivery.attempt_count + 1;
      await transaction
        .updateTable("membership_evidence_outbox")
        .set({
          attempt_count: attemptNumber,
          diagnostic_code: null,
          locked_at: now,
          state: "delivering",
          updated_at: now,
        })
        .where("id", "=", delivery.id)
        .execute();
      return {
        attemptNumber,
        evidence: readStoredMembershipEvidence(delivery.envelope),
        idempotencyKey: delivery.id,
      };
    });
  }

  async recordResult(
    delivery: ClaimedMembershipEvidenceDelivery,
    result: PlatformEvidenceDeliveryResult,
    attemptedAt: Date,
  ): Promise<void> {
    const state = deliveryState(result);
    const retryDelay = Math.min(
      5 * 60_000,
      1000 * 2 ** (delivery.attemptNumber - 1),
    );
    await this.database
      .updateTable("membership_evidence_outbox")
      .set({
        available_at:
          state === "retry_scheduled"
            ? new Date(attemptedAt.getTime() + retryDelay)
            : attemptedAt,
        delivered_at: state === "delivered" ? attemptedAt : null,
        diagnostic_code:
          result.kind === "delivered" ? null : result.diagnosticCode,
        locked_at: null,
        state,
        updated_at: attemptedAt,
      })
      .where("id", "=", delivery.idempotencyKey)
      .where("state", "=", "delivering")
      .execute();
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
        const stored = await connection
          .selectFrom("membership_evidence_outbox")
          .select("state")
          .where("id", "=", delivery.idempotencyKey)
          .executeTakeFirst();
        return stored?.state === "delivering"
          ? operation()
          : Promise.resolve(undefined);
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

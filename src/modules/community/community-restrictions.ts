import type { Database } from "../../database/database.js";
import { digest } from "../../security/payload-digest.js";
import type { Clock } from "../../shared/clock.js";
import { desiredFor, lockAccount, setDesired } from "./community-ledger.js";
import type { RestrictionAuditState } from "./community-storage.js";

export interface RestrictionDecision {
  readonly operationId: string;
  readonly botIdentity: string;
  readonly accountRef: string;
  readonly identityRef: string;
  readonly expectedRevision: number;
  readonly action: "hold" | "restore";
  readonly actorRef: string;
  readonly reason: string;
}
/** Owner-operated and audited. A purchase or /start has no access to this operation. */
export class CommunityRestrictions {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}
  async decide(
    input: RestrictionDecision,
    apply: boolean,
  ): Promise<"ready" | "applied" | "duplicate" | "conflict"> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        input.operationId,
      ) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !["hold", "restore"].includes(input.action) ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !input.actorRef ||
      input.actorRef.length > 256
    )
      throw new Error("Invalid owner decision");
    return this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, input.botIdentity, input.accountRef);
      const fingerprint = digest(input);
      const replay = await tx
        .selectFrom("community_restriction_decisions")
        .select("fingerprint")
        .where("operation_id", "=", input.operationId)
        .executeTakeFirst();
      if (replay)
        return replay.fingerprint === fingerprint ? "duplicate" : "conflict";
      const current = await desiredFor(tx, input.botIdentity, input.accountRef);
      if (
        current.telegram_identity_ref !== input.identityRef ||
        Number(current.restriction_revision) !== input.expectedRevision
      )
        return "conflict";
      if (!apply) return "ready";
      const operation = await tx
        .selectFrom("community_operations")
        .select("command")
        .where("operation_id", "=", current.latest_operation)
        .where("bot_identity", "=", input.botIdentity)
        .where("account_ref", "=", input.accountRef)
        .executeTakeFirstOrThrow();
      const now = this.clock.now();
      const restriction = input.action === "hold" ? "moderation" : "none";
      const after: RestrictionAuditState = {
        admissionRestriction: restriction,
        removalOrigin:
          input.action === "restore" ? "operator_restore" : "external_unknown",
        confirmedBanAttemptId: null,
        status: input.action === "hold" ? "failed" : "accepted",
      };
      await tx
        .insertInto("community_restriction_decisions")
        .values({
          operation_id: input.operationId,
          fingerprint,
          actor_ref: input.actorRef,
          reason: input.reason,
          created_at: now,
          audit: {
            version: 1,
            target: {
              botIdentity: input.botIdentity,
              accountRef: current.account_ref,
              identityRef: current.telegram_identity_ref,
              linkRef: current.link_ref,
              linkRevision: current.link_revision,
            },
            action: input.action,
            expectedRevision: input.expectedRevision,
            appliedRevision: input.expectedRevision + 1,
            before: {
              admissionRestriction: current.admission_restriction,
              removalOrigin: current.removal_origin,
              confirmedBanAttemptId: current.confirmed_ban_attempt_id,
              status: current.status,
            },
            after,
            communityOperation: {
              operationId: current.latest_operation,
              correlationRef: operation.command.correlationRef,
              contractVersion: operation.command.contractVersion,
              entitlementRevision: current.entitlement_revision,
            },
          },
        })
        .execute();
      await tx
        .updateTable("community_desired_states")
        .set({
          admission_restriction: after.admissionRestriction,
          confirmed_ban_attempt_id: after.confirmedBanAttemptId,
          removal_origin: after.removalOrigin,
          restriction_revision: input.expectedRevision + 1,
          due_at: now,
        })
        .where("bot_identity", "=", input.botIdentity)
        .where("account_ref", "=", input.accountRef)
        .execute();
      await setDesired(
        tx,
        input.botIdentity,
        this.clock,
        { ...current, admission_restriction: restriction },
        { status: after.status },
        now,
      );
      return "applied";
    });
  }
}

import type { Database } from "../../database/database.js";
import { digest } from "../../security/payload-digest.js";
import type { Clock } from "../identity-linking/clock.js";
import { desiredFor, lockAccount, setDesired } from "./community-ledger.js";

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
      const restriction = input.action === "hold" ? "moderation" : "none";
      await tx
        .insertInto("community_restriction_decisions")
        .values({
          operation_id: input.operationId,
          fingerprint,
          actor_ref: input.actorRef,
          reason: input.reason,
          created_at: this.clock.now(),
        })
        .execute();
      await tx
        .updateTable("community_desired_states")
        .set({
          admission_restriction: restriction,
          confirmed_ban_attempt_id: null,
          removal_origin:
            input.action === "restore"
              ? "operator_restore"
              : "external_unknown",
          restriction_revision: input.expectedRevision + 1,
          due_at: this.clock.now(),
        })
        .where("bot_identity", "=", input.botIdentity)
        .where("account_ref", "=", input.accountRef)
        .execute();
      await setDesired(
        tx,
        input.botIdentity,
        this.clock,
        { ...current, admission_restriction: restriction },
        { status: input.action === "hold" ? "failed" : "accepted" },
        this.clock.now(),
      );
      return "applied";
    });
  }
}

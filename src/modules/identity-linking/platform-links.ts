import { sql, type Selectable, type Transaction } from "kysely";
import type {
  Database,
  DatabaseSchema,
  PlatformLinksTable,
} from "../../database/database.js";

type Executor = Database | Transaction<DatabaseSchema>;

/** A confirmed link between a Platform Account and one Telegram identity of the bot. */
export interface PlatformLink {
  readonly accountRef: string;
  readonly botIdentity: string;
  readonly telegramUserId: string;
  readonly telegramIdentityRef: string;
  readonly linkedAt: Date;
  /** Revision of the latest Membership Evidence published for this identity. */
  readonly evidenceVersion: string;
  readonly lastMembershipObservationAt: Date | null;
  readonly lastMembershipObservationUpdateId: string | null;
}

/**
 * Selects a link; every given field must match. A Telegram identity and a bot's Telegram user
 * are unique keys. An Account has at most one link per bot by the linking rules, not by a
 * database constraint.
 */
export type PlatformLinkMatch =
  | {
      readonly telegramIdentityRef: string;
      readonly botIdentity?: string;
      readonly accountRef?: string;
    }
  | {
      readonly botIdentity: string;
      readonly telegramUserId: string;
      readonly accountRef?: string;
    }
  | {
      readonly botIdentity: string;
      readonly accountRef: string;
    };

/**
 * `share` holds the link against an exceptional transfer until the caller commits;
 * `update` additionally serializes Membership Evidence revisions of the identity.
 */
export type PlatformLinkLock = "share" | "update";

export async function findPlatformLink(
  database: Executor,
  match: PlatformLinkMatch,
  lock?: PlatformLinkLock,
): Promise<PlatformLink | undefined> {
  let query = database.selectFrom("platform_links").selectAll();
  if ("telegramIdentityRef" in match)
    query = query.where(
      "telegram_identity_ref",
      "=",
      match.telegramIdentityRef,
    );
  if ("telegramUserId" in match)
    query = query.where("telegram_user_id", "=", match.telegramUserId);
  if (match.botIdentity !== undefined)
    query = query.where("bot_identity", "=", match.botIdentity);
  if (match.accountRef !== undefined)
    query = query.where("account_ref", "=", match.accountRef);
  if (lock === "share") query = query.forShare();
  if (lock === "update") query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row && platformLink(row);
}

/** Locks an identity's link for a Membership Evidence revision; the link must exist. */
export async function lockPlatformLink(
  transaction: Transaction<DatabaseSchema>,
  telegramIdentityRef: string,
): Promise<PlatformLink> {
  return platformLink(
    await transaction
      .selectFrom("platform_links")
      .selectAll()
      .where("telegram_identity_ref", "=", telegramIdentityRef)
      .forUpdate()
      .executeTakeFirstOrThrow(),
  );
}

function platformLink(row: Selectable<PlatformLinksTable>): PlatformLink {
  return {
    accountRef: row.account_ref,
    botIdentity: row.bot_identity,
    telegramUserId: row.telegram_user_id,
    telegramIdentityRef: row.telegram_identity_ref,
    linkedAt: row.linked_at,
    evidenceVersion: row.evidence_version,
    lastMembershipObservationAt: row.last_membership_observation_at,
    lastMembershipObservationUpdateId:
      row.last_membership_observation_update_id,
  };
}

/** A Telegram membership observation of a linked identity. */
export interface MembershipObservation {
  readonly observedAt: Date;
  /** The Telegram update that reported it, when an event did. */
  readonly updateId: string | null;
}

/** Starts a new Membership Evidence revision for a decisive observation and returns it. */
export async function reviseMembershipEvidence(
  transaction: Transaction<DatabaseSchema>,
  telegramIdentityRef: string,
  observation: MembershipObservation,
): Promise<string> {
  const revision = await transaction
    .updateTable("platform_links")
    .set({
      ...observationMarker(observation),
      evidence_version: sql`evidence_version + 1`,
    })
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .returning("evidence_version")
    .executeTakeFirstOrThrow();
  return revision.evidence_version;
}

/** Moves the observation marker without a new revision, for an undecided observation. */
export async function markMembershipObservation(
  transaction: Transaction<DatabaseSchema>,
  telegramIdentityRef: string,
  observation: MembershipObservation,
): Promise<void> {
  await transaction
    .updateTable("platform_links")
    .set(observationMarker(observation))
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .execute();
}

function observationMarker(observation: MembershipObservation) {
  return {
    last_membership_observation_at: observation.observedAt,
    last_membership_observation_update_id: observation.updateId,
  };
}

/** Every linked identity with its link time, for scheduling per-identity work in one statement. */
export function linkedIdentities(database: Executor) {
  return database
    .selectFrom("platform_links")
    .select(["telegram_identity_ref", "linked_at"]);
}

/** Every linked identity with its current Membership Evidence revision, for redacted reports. */
export function linkedEvidenceRevisions(database: Executor) {
  return database
    .selectFrom("platform_links")
    .select(["telegram_identity_ref", "evidence_version"]);
}

import { randomUUID } from "node:crypto";

import { sql, type Selectable, type Transaction } from "kysely";

import type { DatabaseSchema } from "../../database/database.js";
import type { Clock } from "../identity-linking/clock.js";
import {
  accessAllows,
  assertCommunityResult,
  type CommunityEffect,
  type CommunityStatus,
  type ObservedMembership,
} from "./community-contract.js";
import type {
  CommunityEffectState,
  CommunityMutation,
  CommunityTables,
} from "./community-storage.js";

export type Tx = Transaction<DatabaseSchema>;
export type EffectRow = Selectable<CommunityTables["community_effects"]>;
export type DesiredRow = Selectable<
  CommunityTables["community_desired_states"]
>;
export type ObservedState = "member" | "not_member" | "banned";

export const RETRY_BACKOFF_MILLISECONDS = [1000, 5000, 30_000] as const;

/** Every account decision — inbound command, effect, sweep — serializes here. */
export async function lockAccount(
  tx: Tx,
  bot: string,
  accountRef: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`inside-telegram:community:${JSON.stringify([bot, accountRef])}`}, 0))`.execute(
    tx,
  );
}

export async function desiredFor(
  tx: Tx,
  bot: string,
  accountRef: string,
): Promise<DesiredRow> {
  return tx
    .selectFrom("community_desired_states")
    .selectAll()
    .where("bot_identity", "=", bot)
    .where("account_ref", "=", accountRef)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/**
 * Moves the desired state and every operation that still describes it. A
 * duplicate command accepted at the same revision must not freeze its answer.
 */
export async function setDesired(
  tx: Tx,
  bot: string,
  clock: Clock,
  desired: DesiredRow,
  change: { status?: CommunityStatus; observed?: ObservedMembership },
  now: Date,
): Promise<void> {
  const status = change.status ?? desired.status;
  const observed = change.observed ?? desired.observed_membership;
  await tx
    .updateTable("community_desired_states")
    .set({ status, observed_membership: observed, updated_at: now })
    .where("bot_identity", "=", bot)
    .where("account_ref", "=", desired.account_ref)
    .execute();
  const current = await tx
    .selectFrom("community_operations")
    .selectAll()
    .where("bot_identity", "=", bot)
    .where("account_ref", "=", desired.account_ref)
    .where("entitlement_revision", "=", desired.entitlement_revision)
    .where("status", "!=", "superseded")
    .execute();
  for (const operation of current) {
    const result = assertCommunityResult({
      ...operation.result,
      status,
      observedMembership: observed,
      updatedAt: clock.now().toISOString(),
    });
    await tx
      .updateTable("community_operations")
      .set({ result, status, updated_at: now })
      .where("operation_id", "=", operation.operation_id)
      .execute();
  }
}

export async function closeEffect(
  tx: Tx,
  clock: Clock,
  effectRef: string,
  state: "completed" | "superseded" | "failed",
  diagnosticCode: string | null,
): Promise<void> {
  await tx
    .updateTable("community_effects")
    .set({
      state,
      step: "done",
      diagnostic_code: diagnosticCode,
      updated_at: clock.now(),
    })
    .where("effect_ref", "=", effectRef)
    .execute();
}

export interface EffectTarget {
  readonly accountRef: string;
  readonly telegramIdentityRef: string;
  readonly operationId: string;
  readonly entitlementRevision: number;
}

export function targetOf(desired: DesiredRow): EffectTarget {
  return {
    accountRef: desired.account_ref,
    telegramIdentityRef: desired.telegram_identity_ref,
    operationId: desired.latest_operation,
    entitlementRevision: Number(desired.entitlement_revision),
  };
}

export async function openEffect(
  tx: Tx,
  bot: string,
  clock: Clock,
  target: EffectTarget,
  effect: CommunityEffect,
  joinRequestKey?: string,
): Promise<string> {
  const effectRef = randomUUID();
  const now = clock.now();
  await tx
    .insertInto("community_effects")
    .values({
      effect_ref: effectRef,
      bot_identity: bot,
      account_ref: target.accountRef,
      telegram_identity_ref: target.telegramIdentityRef,
      operation_id: target.operationId,
      entitlement_revision: target.entitlementRevision,
      effect,
      step: "observe",
      state: "pending",
      join_request_key: joinRequestKey ?? null,
      available_at: now,
      attempt_count: 0,
      retry_count: 0,
      diagnostic_code: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return effectRef;
}

/** Removal work is opened once; a second sweep must not queue a rival effect. */
export async function openAbsence(
  tx: Tx,
  bot: string,
  clock: Clock,
  desired: DesiredRow,
): Promise<void> {
  const open = await tx
    .selectFrom("community_effects")
    .select("effect_ref")
    .where("bot_identity", "=", bot)
    .where("account_ref", "=", desired.account_ref)
    .where("effect", "=", "community.ensure_absence")
    .where("state", "in", ["pending", "started", "unknown"])
    .executeTakeFirst();
  if (open) return;
  await openEffect(
    tx,
    bot,
    clock,
    targetOf(desired),
    "community.ensure_absence",
  );
}

/**
 * A lapsed or revoked right closes the admission it was opened for and replaces
 * it with removal work. Used wherever the right is re-read under the lock.
 */
export async function lapse(
  tx: Tx,
  bot: string,
  clock: Clock,
  effectRef: string,
  desired: DesiredRow,
  now: Date,
): Promise<void> {
  await closeEffect(tx, clock, effectRef, "superseded", "right_not_current");
  if (desired.access.kind === "finite" && desired.status !== "expired")
    await setDesired(tx, bot, clock, desired, { status: "expired" }, now);
  await openAbsence(tx, bot, clock, desired);
}

/**
 * Nothing started externally, so the work is only rescheduled. A provider or
 * authorization outage keeps retrying instead of dropping a durable right.
 */
export async function deferEffect(
  tx: Tx,
  clock: Clock,
  effect: EffectRow,
  diagnosticCode: string,
  minimumDelay = 0,
): Promise<void> {
  const now = clock.now();
  const backoff =
    RETRY_BACKOFF_MILLISECONDS[
      Math.min(effect.retry_count, RETRY_BACKOFF_MILLISECONDS.length - 1)
    ]!;
  await tx
    .updateTable("community_effects")
    .set({
      state: "pending",
      step: "observe",
      retry_count: effect.retry_count + 1,
      available_at: new Date(now.getTime() + Math.max(backoff, minimumDelay)),
      diagnostic_code: diagnosticCode,
      updated_at: now,
    })
    .where("effect_ref", "=", effect.effect_ref)
    .execute();
}

/**
 * Raw Telegram identifiers come only from our own verified mapping. Removing a
 * historical identity additionally requires that no transfer has taken it over.
 */
export async function resolveIdentity(
  tx: Tx,
  bot: string,
  accountRef: string,
  telegramIdentityRef: string,
  allowHistorical: boolean,
): Promise<string | undefined> {
  const link = await tx
    .selectFrom("platform_links")
    .select("telegram_user_id")
    .where("bot_identity", "=", bot)
    .where("account_ref", "=", accountRef)
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .executeTakeFirst();
  if (link) return link.telegram_user_id;
  if (!allowHistorical) return undefined;

  const transferred = await tx
    .selectFrom("platform_links")
    .select("account_ref")
    .where("bot_identity", "=", bot)
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .executeTakeFirst();
  if (transferred) return undefined;
  const historical = await tx
    .selectFrom("community_bindings")
    .select("telegram_user_id")
    .where("bot_identity", "=", bot)
    .where("account_ref", "=", accountRef)
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .executeTakeFirst();
  return historical?.telegram_user_id ?? undefined;
}

export function isOpen(state: CommunityEffectState): boolean {
  return state === "pending" || state === "started" || state === "unknown";
}

export function observedMembership(
  observed: ObservedState,
): ObservedMembership {
  return observed === "member" ? "member" : "not_member";
}

export function statusFor(
  desired: DesiredRow,
  observed: ObservedState,
  now: Date,
): CommunityStatus {
  const allows = accessAllows(desired.access, now);
  if (allows) return observed === "member" ? "applied" : "waiting_for_join";
  if (desired.access.kind === "finite") return "expired";
  // An `applied` denial is confirmed absence *and* a closed admission path.
  if (observed !== "member" && !openAdmissionPath(desired)) return "applied";
  return "accepted";
}

/** A known bot-owned link still lets the identity queue for the chat. */
export function openAdmissionPath(desired: DesiredRow): boolean {
  return desired.invite_state === "created" && desired.invite_link !== null;
}

/**
 * A stored link belongs to the revision and identity it was created for, so a
 * newer right never reuses it. A known URL stays revocable regardless.
 */
export function reusableInvite(desired: DesiredRow, now: Date): boolean {
  return (
    (desired.invite_state === "created" ||
      desired.invite_state === "unknown") &&
    desired.invite_revision !== null &&
    Number(desired.invite_revision) === Number(desired.entitlement_revision) &&
    desired.invite_expires_at !== null &&
    desired.invite_expires_at > now
  );
}

export function nextAction(
  effect: EffectRow,
  desired: DesiredRow,
  observed: ObservedState,
  now: Date,
): CommunityMutation | "wait" | "done" {
  if (effect.effect === "community.ensure_absence") {
    if (observed === "member") return "ban";
    // An invite whose URL was never observed has no address to revoke; it expires.
    return desired.invite_state === "created" && desired.invite_link
      ? "revoke_link"
      : "done";
  }
  if (observed === "member") return "done";
  if (observed === "banned") return "unban";
  if (effect.effect === "community.approve_join") return "approve";
  return reusableInvite(desired, now) ? "wait" : "create_invite";
}

import type { DurableMembershipEnvelope } from "../membership-evidence/membership-evidence-provider.js";
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { Database } from "../../database/database.js";
import { canonicalJson, digest } from "../../security/payload-digest.js";
import type { Clock } from "../identity-linking/clock.js";
import {
  accessAllows,
  accessValidUntil,
  assertCommunityResult,
  communityError,
  communityErrorStatus,
  COMMUNITY_CONTRACT_VERSION,
  COMMUNITY_V2,
  type CommunityVersion,
  DISPATCH_CONTRACT_VERSION,
  parseCommunityRequest,
  type CommunityResponse,
  type CommunityResult,
  type CommunitySetCommand,
  type CommunityStatus,
  type DispatchAuthorizationRequest,
  type DispatchDenialReason,
  type ObservedMembership,
} from "./community-contract.js";
import {
  closeEffect,
  deferEffect,
  desiredFor,
  isOpen,
  lapse,
  lockAccount,
  nextAction,
  observedMembership,
  openAbsence,
  openAdmissionPath,
  openEffect,
  resolveIdentity,
  reusableInvite,
  setDesired,
  statusFor,
  targetOf,
  type DesiredRow,
  type EffectRow,
  type ObservedState,
  type Tx,
} from "./community-ledger.js";
import type {
  CommunityDispatchAuthorization,
  CommunityObservation,
  CommunityReadmissionReplies,
  TelegramCommunityChat,
} from "./community-ports.js";
import {
  RESTORABLE_REMOVAL_ORIGINS,
  type CommunityMutation,
} from "./community-storage.js";

const ATTEMPT_BUDGET = 5;
const PERMIT_WINDOW_MILLISECONDS = 5000;
const ATTEMPT_LEASE_MILLISECONDS = 60_000;
const INVITE_WINDOW_MILLISECONDS = 600_000;
const CAPABILITY_CACHE_MILLISECONDS = 5000;

export interface CommunityJoinRequest {
  readonly botIdentity: string;
  readonly canonicalChatId: string;
  readonly telegramUserId: string;
  readonly requestedAt: Date;
  readonly updateId: string;
  readonly inviteLink?: string;
}

export interface CommunityHandled {
  readonly status: number;
  readonly body?: CommunityResponse;
}

export interface CommunitySnapshot {
  readonly dueStates: number;
  readonly oldestDueAgeMs: number;
  readonly effectBacklog: number;
  readonly unknownEffects: number;
  readonly restricted: number;
}

/** What the intended contact may be told when they ask to join themselves. */
export type CommunityAdmission =
  | { readonly kind: "link"; readonly inviteLink: string }
  | { readonly kind: "preparing" }
  | { readonly kind: "member" }
  | { readonly kind: "none" }
  | { readonly kind: "moderation_blocked" };

export interface CommunityProviderOptions {
  readonly reconciliationCadenceMs?: number;
  readonly contractVersion?: CommunityVersion;
  readonly removalsEnabled?: boolean;
  readonly botTelegramUserId?: string;
  /** Removals by this bot end the Tribute basis only; they are never moderation. */
  readonly tributeBotTelegramUserId?: string;
  readonly readmission?: {
    readonly replies: CommunityReadmissionReplies;
    readonly text: string;
  };
}

/**
 * Owns the durable community entitlement inbox, the desired state per Account and
 * every external membership effect in the canonical chat. Platform remains the
 * authority for the aggregate right; this provider never invents or extends one.
 */
export class CommunityProvider {
  private readonly cadence: number;
  private readonly version: CommunityVersion;
  private readonly removalsEnabled: boolean;
  private capability?: {
    readonly at: number;
    readonly diagnosticCode: string | null;
  };

  constructor(
    private readonly db: Database,
    private readonly bot: string,
    private readonly canonicalChatId: string,
    private readonly clock: Clock,
    private readonly authorization: CommunityDispatchAuthorization,
    private readonly chat: TelegramCommunityChat,
    private readonly options: CommunityProviderOptions = {},
  ) {
    this.cadence = options.reconciliationCadenceMs ?? 60_000;
    this.version = options.contractVersion ?? COMMUNITY_CONTRACT_VERSION;
    this.removalsEnabled =
      options.removalsEnabled ?? this.version === COMMUNITY_CONTRACT_VERSION;
  }

  // ---------------------------------------------------------------- inbound

  async handle(body: unknown): Promise<CommunityHandled> {
    const parsed = parseCommunityRequest(body, this.version);
    if (parsed.kind === "rejected") {
      // Without a parseable operationId there is no correlation to invent.
      if (!parsed.operationId)
        return { status: communityErrorStatus[parsed.error] };
      return {
        status: communityErrorStatus[parsed.error],
        body: communityError(parsed.operationId, parsed.error, this.version),
      };
    }
    if (parsed.kind === "status") {
      const stored = await this.db
        .selectFrom("community_operations")
        .select(["result", "bot_identity"])
        .where("operation_id", "=", parsed.operationId)
        .executeTakeFirst();
      if (!stored || stored.bot_identity !== this.bot)
        return {
          status: communityErrorStatus.not_found,
          body: communityError(parsed.operationId, "not_found", this.version),
        };
      return { status: 200, body: stored.result };
    }
    return this.applySet(parsed.command, parsed.payloadDigest);
  }

  private async applySet(
    command: CommunitySetCommand,
    payloadDigest: string,
  ): Promise<CommunityHandled> {
    return this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, command.binding.accountRef);
      const replay = await tx
        .selectFrom("community_operations")
        .selectAll()
        .where("operation_id", "=", command.operationId)
        .executeTakeFirst();
      if (replay) {
        if (
          replay.payload_digest !== payloadDigest ||
          replay.bot_identity !== this.bot
        )
          return conflict(
            command.operationId,
            "operation_conflict",
            this.version,
          );
        return { status: 200, body: replay.result };
      }

      const now = this.clock.now();
      const desired = await tx
        .selectFrom("community_desired_states")
        .selectAll()
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", command.binding.accountRef)
        .forUpdate()
        .executeTakeFirst();

      if (desired) {
        const current = Number(desired.entitlement_revision);
        if (command.entitlementRevision < current)
          // A lower revision never moves the desired state; it is recorded as stale.
          return this.recordOperation(
            tx,
            command,
            payloadDigest,
            "superseded",
            desired.observed_membership,
            now,
          );
        if (command.entitlementRevision === current) {
          if (!sameDesiredState(desired, command))
            return conflict(
              command.operationId,
              "revision_conflict",
              this.version,
            );
          const previous = await tx
            .selectFrom("community_operations")
            .select("command")
            .where("operation_id", "=", desired.latest_operation)
            .executeTakeFirstOrThrow();
          // A coordinated version upgrade replaces the effect target even at the same rights revision.
          if (previous.command.contractVersion === command.contractVersion)
            return this.recordOperation(
              tx,
              command,
              payloadDigest,
              desired.status,
              desired.observed_membership,
              now,
            );
        }
        await this.supersedePrevious(tx, command, now);
      }

      const observed: ObservedMembership =
        desired?.observed_membership ?? "unknown";
      const allows = accessAllows(command.access, now);
      const status: CommunityStatus =
        command.access.kind === "finite" && !allows ? "expired" : "accepted";
      const state = {
        entitlement_revision: command.entitlementRevision,
        latest_operation: command.operationId,
        telegram_identity_ref: command.binding.telegramIdentityRef,
        link_ref: command.binding.linkRef,
        link_revision: command.binding.linkRevision,
        access: command.access,
        valid_until: accessValidUntil(command.access),
        status,
        due_at: now,
        updated_at: now,
      };
      await tx
        .insertInto("community_desired_states")
        .values({
          bot_identity: this.bot,
          account_ref: command.binding.accountRef,
          observed_membership: observed,
          invite_link: null,
          invite_state: "none",
          invite_expires_at: null,
          invite_revision: null,
          ...state,
        })
        .onConflict((c) =>
          // A stored link keeps its own revision, so a newer right never reuses it.
          c.columns(["bot_identity", "account_ref"]).doUpdateSet(state),
        )
        .execute();

      await this.rememberBinding(tx, command, now);
      const recorded = await this.recordOperation(
        tx,
        command,
        payloadDigest,
        status,
        observed,
        now,
      );
      await openEffect(
        tx,
        this.bot,
        this.clock,
        {
          accountRef: command.binding.accountRef,
          telegramIdentityRef: command.binding.telegramIdentityRef,
          operationId: command.operationId,
          entitlementRevision: command.entitlementRevision,
        },
        allows ? "community.ensure_admission" : "community.ensure_absence",
      );
      return recorded;
    });
  }

  private async supersedePrevious(
    tx: Tx,
    command: CommunitySetCommand,
    now: Date,
  ): Promise<void> {
    const stale = await tx
      .selectFrom("community_operations")
      .selectAll()
      .where("bot_identity", "=", this.bot)
      .where("account_ref", "=", command.binding.accountRef)
      .where("entitlement_revision", "<", String(command.entitlementRevision))
      .where("status", "!=", "superseded")
      .execute();
    for (const row of stale) {
      const result = assertCommunityResult({
        ...row.result,
        status: "superseded",
        updatedAt: now.toISOString(),
      });
      await tx
        .updateTable("community_operations")
        .set({ result, status: "superseded", updated_at: now })
        .where("operation_id", "=", row.operation_id)
        .execute();
    }
    // An effect never outlives its own revision; a started attempt keeps its ledger row.
    await tx
      .updateTable("community_effects")
      .set({ state: "superseded", step: "done", updated_at: now })
      .where("bot_identity", "=", this.bot)
      .where("account_ref", "=", command.binding.accountRef)
      .where("state", "in", ["pending", "started", "unknown"])
      .execute();
  }

  private async rememberBinding(
    tx: Tx,
    command: CommunitySetCommand,
    now: Date,
  ): Promise<void> {
    const link = await tx
      .selectFrom("platform_links")
      .select("telegram_user_id")
      .where("bot_identity", "=", this.bot)
      .where("account_ref", "=", command.binding.accountRef)
      .where("telegram_identity_ref", "=", command.binding.telegramIdentityRef)
      .executeTakeFirst();
    await tx
      .insertInto("community_bindings")
      .values({
        bot_identity: this.bot,
        account_ref: command.binding.accountRef,
        telegram_identity_ref: command.binding.telegramIdentityRef,
        link_ref: command.binding.linkRef,
        link_revision: command.binding.linkRevision,
        telegram_user_id: link?.telegram_user_id ?? null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .onConflict((c) =>
        c
          .columns(["bot_identity", "account_ref", "telegram_identity_ref"])
          .doUpdateSet({
            link_ref: command.binding.linkRef,
            link_revision: command.binding.linkRevision,
            ...(link ? { telegram_user_id: link.telegram_user_id } : {}),
            last_seen_at: now,
          }),
      )
      .execute();
  }

  private async recordOperation(
    tx: Tx,
    command: CommunitySetCommand,
    payloadDigest: string,
    status: CommunityStatus,
    observed: ObservedMembership,
    now: Date,
  ): Promise<CommunityHandled> {
    const result = assertCommunityResult({
      contractVersion: command.contractVersion,
      ...(command.contractVersion === COMMUNITY_V2
        ? {
            admissionRestriction: (
              await desiredFor(tx, this.bot, command.binding.accountRef)
            ).admission_restriction,
          }
        : {}),
      operation: "entitlement.result",
      operationId: command.operationId,
      binding: command.binding,
      entitlementRevision: command.entitlementRevision,
      access: command.access,
      status,
      observedMembership: observed,
      updatedAt: now.toISOString(),
    } satisfies CommunityResult);
    await tx
      .insertInto("community_operations")
      .values({
        operation_id: command.operationId,
        bot_identity: this.bot,
        account_ref: command.binding.accountRef,
        entitlement_revision: command.entitlementRevision,
        payload_digest: payloadDigest,
        command,
        result,
        status,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { status: 200, body: result };
  }

  // ------------------------------------------------------------ join events

  /**
   * A verified join request is one effect for that exact update. A replayed update
   * reuses it; a later legitimate rejoin under the same right creates a new one.
   */
  async acceptJoinRequest(request: CommunityJoinRequest): Promise<void> {
    if (
      request.botIdentity !== this.bot ||
      request.canonicalChatId !== this.canonicalChatId
    )
      return;
    const now = this.clock.now();
    const intended = await this.db
      .selectFrom("platform_links")
      .innerJoin("community_desired_states", (join) =>
        join
          .onRef(
            "community_desired_states.bot_identity",
            "=",
            "platform_links.bot_identity",
          )
          .onRef(
            "community_desired_states.account_ref",
            "=",
            "platform_links.account_ref",
          )
          .onRef(
            "community_desired_states.telegram_identity_ref",
            "=",
            "platform_links.telegram_identity_ref",
          ),
      )
      .selectAll("community_desired_states")
      .where("platform_links.bot_identity", "=", this.bot)
      .where("platform_links.telegram_user_id", "=", request.telegramUserId)
      .executeTakeFirst();

    if (
      !intended ||
      !accessAllows(intended.access, now) ||
      (this.version === COMMUNITY_V2 &&
        (intended.admission_restriction !== "none" ||
          !reusableInvite(intended, now) ||
          !request.inviteLink ||
          request.inviteLink !== intended.invite_link ||
          request.requestedAt > now ||
          request.requestedAt <
            new Date(now.getTime() - INVITE_WINDOW_MILLISECONDS)))
    ) {
      // Declining a foreign or lapsed request is a local decision; it grants nothing.
      await this.chat.declineJoinRequest(
        this.canonicalChatId,
        request.telegramUserId,
      );
      return;
    }

    const key = `${this.bot}:${this.canonicalChatId}:${request.updateId}`;
    await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, intended.account_ref);
      const existing = await tx
        .selectFrom("community_effects")
        .select("effect_ref")
        .where("join_request_key", "=", key)
        .executeTakeFirst();
      if (existing) return;
      const current = await desiredFor(tx, this.bot, intended.account_ref);
      if (
        Number(current.entitlement_revision) !==
          Number(intended.entitlement_revision) ||
        !accessAllows(current.access, this.clock.now()) ||
        (this.version === COMMUNITY_V2 &&
          current.admission_restriction !== "none")
      )
        return;
      const effectRef = await openEffect(
        tx,
        this.bot,
        this.clock,
        targetOf(current),
        "community.approve_join",
        key,
      );
      if (this.version === COMMUNITY_V2)
        await tx
          .updateTable("community_effects")
          .set({
            join_invite_digest: digest(request.inviteLink),
            join_invite_expires_at: current.invite_expires_at,
          })
          .where("effect_ref", "=", effectRef)
          .execute();
    });
  }

  /**
   * Reads what the intended contact may be told about their own admission. It is
   * a query: a contact's message never opens an effect, and handing over the link
   * is not membership. Reconciliation is what makes a missing link appear.
   */
  async admissionFor(telegramUserId: string): Promise<CommunityAdmission> {
    const link = await this.db
      .selectFrom("platform_links")
      .select(["account_ref", "telegram_identity_ref"])
      .where("bot_identity", "=", this.bot)
      .where("telegram_user_id", "=", telegramUserId)
      .executeTakeFirst();
    if (!link) return { kind: "none" };
    const desired = await this.db
      .selectFrom("community_desired_states")
      .selectAll()
      .where("bot_identity", "=", this.bot)
      .where("account_ref", "=", link.account_ref)
      .where("telegram_identity_ref", "=", link.telegram_identity_ref)
      .executeTakeFirst();
    const now = this.clock.now();
    if (!desired || !accessAllows(desired.access, now)) return { kind: "none" };
    if (desired.admission_restriction !== "none")
      return { kind: "moderation_blocked" };
    if (desired.observed_membership === "member") return { kind: "member" };
    if (reusableInvite(desired, now) && desired.invite_link)
      return { kind: "link", inviteLink: desired.invite_link };
    return { kind: "preparing" };
  }

  /** Trusted canonical events distinguish moderator actions from our recorded removals. */
  async observeMembershipEvent(
    event: DurableMembershipEnvelope,
  ): Promise<void> {
    if (
      this.version !== COMMUNITY_V2 ||
      event.kind !== "subject" ||
      event.botIdentity !== this.bot ||
      event.canonicalChatId !== this.canonicalChatId
    )
      return;
    const link = await this.db
      .selectFrom("platform_links")
      .select(["account_ref", "telegram_identity_ref"])
      .where("bot_identity", "=", this.bot)
      .where("telegram_user_id", "=", event.subjectTelegramUserId)
      .executeTakeFirst();
    if (!link) return;
    await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, link.account_ref);
      const current = await tx
        .selectFrom("community_desired_states")
        .selectAll()
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", link.account_ref)
        .forUpdate()
        .executeTakeFirst();
      if (
        !current ||
        current.telegram_identity_ref !== link.telegram_identity_ref ||
        (current.last_membership_event_at &&
          (current.last_membership_event_at > event.eventAt ||
            (current.last_membership_event_at.getTime() ===
              event.eventAt.getTime() &&
              current.last_membership_update_id !== null &&
              BigInt(current.last_membership_update_id) >=
                BigInt(event.updateId)))) ||
        event.eventAt > this.clock.now()
      )
        return;
      let restriction = current.admission_restriction;
      let origin = current.removal_origin;
      let confirmedBanAttempt: string | null = null;
      let readmissionRequestedAt = current.readmission_requested_at;
      if (event.chatMember.status === "kicked") {
        if (this.removedByTribute(event)) {
          // Tribute ends only its own basis. A ban observed before this event arrived is lifted;
          // a restriction with a recorded actor or a moderator stays in force.
          if (
            restriction === "none" ||
            (restriction === "external_unknown" && origin === "unexplained_ban")
          ) {
            restriction = "none";
            origin = "tribute_expiry";
            readmissionRequestedAt = event.eventAt;
          }
        } else {
          const own =
            event.actorTelegramUserId !== undefined &&
            event.actorTelegramUserId === this.options.botTelegramUserId;
          const attempt = own
            ? await tx
                .selectFrom("community_effect_attempts")
                .innerJoin(
                  "community_effects",
                  "community_effects.effect_ref",
                  "community_effect_attempts.effect_ref",
                )
                .select([
                  "community_effect_attempts.outcome",
                  "community_effect_attempts.attempt_id",
                ])
                .where("community_effects.bot_identity", "=", this.bot)
                .where(
                  "community_effects.telegram_identity_ref",
                  "=",
                  current.telegram_identity_ref,
                )
                .where("community_effect_attempts.action", "=", "ban")
                .where(
                  "community_effect_attempts.started_at",
                  ">=",
                  new Date(event.eventAt.getTime() - 60_000),
                )
                .where(
                  "community_effect_attempts.started_at",
                  "<=",
                  new Date(event.eventAt.getTime() + 1000),
                )
                .orderBy("community_effect_attempts.started_at", "desc")
                .executeTakeFirst()
            : undefined;
          if (
            attempt &&
            ["succeeded", "started", "unknown"].includes(attempt.outcome) &&
            restriction === "none"
          ) {
            origin = "bot_expiry";
            confirmedBanAttempt = attempt.attempt_id;
          } else {
            restriction =
              !own && event.actorIsBot === false
                ? "moderation"
                : "external_unknown";
            origin = "external_unknown";
          }
        }
      } else if (
        ["left", "member", "administrator", "creator", "restricted"].includes(
          event.chatMember.status,
        )
      ) {
        origin = "none";
        // Tribute's unban leaves the person outside; only a return ends the request.
        if (event.chatMember.status !== "left") readmissionRequestedAt = null;
        else if (this.removedByTribute(event) && restriction === "none")
          readmissionRequestedAt ??= event.eventAt;
      }
      await tx
        .updateTable("community_desired_states")
        .set({
          admission_restriction: restriction,
          removal_origin: origin,
          readmission_requested_at: readmissionRequestedAt,
          restriction_revision: Number(current.restriction_revision) + 1,
          last_membership_event_at: event.eventAt,
          last_membership_update_id: event.updateId,
          confirmed_ban_attempt_id: confirmedBanAttempt,
          due_at: this.clock.now(),
        })
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", link.account_ref)
        .execute();
      await setDesired(
        tx,
        this.bot,
        this.clock,
        { ...current, admission_restriction: restriction },
        {},
        this.clock.now(),
      );
    });
  }

  // ----------------------------------------------------------------- worker

  async processDueEffects(limit = 10): Promise<void> {
    const due = await this.db
      .selectFrom("community_effects")
      .select("effect_ref")
      .where("bot_identity", "=", this.bot)
      .where("state", "in", ["pending", "started", "unknown"])
      .where("available_at", "<=", this.clock.now())
      .orderBy("available_at")
      .limit(limit)
      .execute();
    for (const row of due) await this.runEffect(row.effect_ref);
  }

  private async runEffect(effectRef: string): Promise<void> {
    const claimed = await this.claim(effectRef);
    if (!claimed) return;
    const { effect, desired, telegramUserId, payloadDigest } = claimed;

    const observation = await this.observe(telegramUserId);
    if (observation.kind === "unavailable") {
      await this.defer(effect.effect_ref, observation.diagnosticCode);
      return;
    }

    if (observation.state !== "banned" && desired.removal_origin !== "none") {
      const cleared = await this.db
        .updateTable("community_desired_states")
        .set({ removal_origin: "none" })
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", desired.account_ref)
        .where("entitlement_revision", "=", desired.entitlement_revision)
        .where("restriction_revision", "=", desired.restriction_revision)
        .where("telegram_identity_ref", "=", desired.telegram_identity_ref)
        .where("link_ref", "=", desired.link_ref)
        .where("link_revision", "=", desired.link_revision)
        .returning("account_ref")
        .executeTakeFirst();
      if (!cleared) return;
    }
    if (await this.blockUnsafeAdmission(effect, desired, observation.state))
      return;
    if (
      this.version === COMMUNITY_V2 &&
      effect.effect === "community.approve_join" &&
      !validJoinInvite(effect, desired, this.clock.now())
    ) {
      await this.db
        .transaction()
        .execute((tx) =>
          closeEffect(
            tx,
            this.clock,
            effect.effect_ref,
            "failed",
            "join_invite_expired",
          ),
        );
      return;
    }
    const action = nextAction(
      effect,
      desired,
      observation.state,
      this.clock.now(),
    );
    if (action === "wait") {
      await this.wait(effect, desired, observation.state);
      return;
    }
    if (action === "done") {
      await this.complete(effect, desired, observation.state);
      return;
    }
    if (action === "ban" && !this.removalsEnabled) {
      await this.defer(effect.effect_ref, "removals_disabled");
      return;
    }
    await this.dispatch(effect, desired, action, telegramUserId, payloadDigest);
  }

  /**
   * Capability and membership are read together: an unusable bot is not absence.
   * The capability answer is reused briefly so one sweep costs one capability read
   * rather than one per Account against the shared bot rate budget.
   */
  private async observe(telegramUserId: string): Promise<CommunityObservation> {
    const now = this.clock.now().getTime();
    if (
      !this.capability ||
      now - this.capability.at >= CAPABILITY_CACHE_MILLISECONDS
    ) {
      const read = await this.chat.readCapability(this.canonicalChatId);
      this.capability = {
        at: now,
        diagnosticCode: read.kind === "ready" ? null : read.diagnosticCode,
      };
    }
    const blocked = this.capability.diagnosticCode;
    if (blocked) return { kind: "unavailable", diagnosticCode: blocked };
    return this.chat.observeMember(this.canonicalChatId, telegramUserId);
  }

  private async claim(effectRef: string): Promise<
    | {
        effect: EffectRow;
        desired: DesiredRow;
        telegramUserId: string;
        payloadDigest: string;
      }
    | undefined
  > {
    return this.db.transaction().execute(async (tx) => {
      const found = await tx
        .selectFrom("community_effects")
        .select("account_ref")
        .where("effect_ref", "=", effectRef)
        .executeTakeFirst();
      if (!found) return;
      await lockAccount(tx, this.bot, found.account_ref);
      const effect = await tx
        .selectFrom("community_effects")
        .selectAll()
        .where("effect_ref", "=", effectRef)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const now = this.clock.now();
      if (!isOpen(effect.state) || effect.available_at > now) return;

      const desired = await tx
        .selectFrom("community_desired_states")
        .selectAll()
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", effect.account_ref)
        .forUpdate()
        .executeTakeFirst();
      if (!desired) {
        await closeEffect(
          tx,
          this.clock,
          effectRef,
          "failed",
          "missing_desired_state",
        );
        return;
      }
      if (
        Number(effect.entitlement_revision) !==
        Number(desired.entitlement_revision)
      ) {
        await closeEffect(
          tx,
          this.clock,
          effectRef,
          "superseded",
          "revision_advanced",
        );
        return;
      }
      const allows = accessAllows(desired.access, now);
      if (!allows && effect.effect !== "community.ensure_absence") {
        await lapse(tx, this.bot, this.clock, effectRef, desired, now);
        return;
      }
      if (allows && effect.effect === "community.ensure_absence") {
        await closeEffect(
          tx,
          this.clock,
          effectRef,
          "superseded",
          "right_restored",
        );
        return;
      }

      const telegramUserId = await resolveIdentity(
        tx,
        this.bot,
        desired.account_ref,
        effect.telegram_identity_ref,
        effect.effect === "community.ensure_absence",
      );
      if (!telegramUserId) {
        await closeEffect(
          tx,
          this.clock,
          effectRef,
          "failed",
          "unverified_binding",
        );
        await setDesired(
          tx,
          this.bot,
          this.clock,
          desired,
          { status: "failed" },
          now,
        );
        return;
      }
      const operation = await tx
        .selectFrom("community_operations")
        .select(["payload_digest", "command"])
        .where("operation_id", "=", effect.operation_id)
        .executeTakeFirstOrThrow();
      if (operation.command.contractVersion !== this.version) {
        await closeEffect(
          tx,
          this.clock,
          effectRef,
          "superseded",
          "contract_version_changed",
        );
        return;
      }
      return {
        effect,
        desired,
        telegramUserId,
        payloadDigest: operation.payload_digest,
      };
    });
  }

  private async blockUnsafeAdmission(
    effect: EffectRow,
    desired: DesiredRow,
    observed: ObservedState,
  ): Promise<boolean> {
    if (
      this.version !== COMMUNITY_V2 ||
      effect.effect === "community.ensure_absence"
    )
      return false;
    if (
      desired.admission_restriction === "none" &&
      (observed !== "banned" ||
        RESTORABLE_REMOVAL_ORIGINS.includes(desired.removal_origin))
    )
      return false;
    await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, effect.account_ref);
      const current = await desiredFor(tx, this.bot, effect.account_ref);
      if (!sameDesiredSnapshot(current, desired)) return;
      const unexplained = current.admission_restriction === "none";
      const restriction = unexplained
        ? "external_unknown"
        : current.admission_restriction;
      await tx
        .updateTable("community_desired_states")
        .set({
          admission_restriction: restriction,
          // No actor is known yet; a later trusted event may still explain this ban.
          ...(unexplained
            ? { removal_origin: "unexplained_ban" as const }
            : {}),
          restriction_revision: Number(current.restriction_revision) + 1,
        })
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", effect.account_ref)
        .execute();
      await setDesired(
        tx,
        this.bot,
        this.clock,
        { ...current, admission_restriction: restriction },
        { status: "failed", observed: observedMembership(observed) },
        this.clock.now(),
      );
      await closeEffect(
        tx,
        this.clock,
        effect.effect_ref,
        "failed",
        "admission_restricted",
      );
    });
    return true;
  }

  private async dispatch(
    effect: EffectRow,
    desired: DesiredRow,
    action: CommunityMutation,
    telegramUserId: string,
    payloadDigest: string,
  ): Promise<void> {
    const request: DispatchAuthorizationRequest = {
      contractVersion: DISPATCH_CONTRACT_VERSION,
      operation: "dispatch.authorize",
      operationId: randomUUID(),
      dispatchId: effect.operation_id,
      dispatchContractVersion: this.version,
      attemptId: randomUUID(),
      effectRef: effect.effect_ref,
      effect: effect.effect,
      payloadDigest,
    };
    let response;
    try {
      response = await this.authorization.authorize(request);
    } catch {
      response = undefined;
    }
    const receivedAt = this.clock.now();

    const started = await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, effect.account_ref);
      const current = await tx
        .selectFrom("community_effects")
        .selectAll()
        .where("effect_ref", "=", effect.effect_ref)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const state = await desiredFor(tx, this.bot, effect.account_ref);
      if (!sameDesiredSnapshot(state, desired)) return;
      const now = this.clock.now();
      if (
        !isOpen(current.state) ||
        // Another worker already leased this effect for its own attempt.
        current.available_at > now ||
        Number(current.entitlement_revision) !==
          Number(state.entitlement_revision)
      )
        return;
      if (
        current.effect !== "community.ensure_absence" &&
        !accessAllows(state.access, now)
      ) {
        await lapse(tx, this.bot, this.clock, current.effect_ref, state, now);
        return;
      }
      if (
        current.effect !== "community.ensure_absence" &&
        state.admission_restriction !== "none"
      )
        return;
      if (
        this.version === COMMUNITY_V2 &&
        action === "approve" &&
        !validJoinInvite(current, state, now)
      ) {
        await closeEffect(
          tx,
          this.clock,
          current.effect_ref,
          "failed",
          "join_invite_expired",
        );
        return;
      }
      if (
        !response ||
        response.contractVersion !== DISPATCH_CONTRACT_VERSION ||
        response.operation !== "dispatch.result" ||
        response.operationId !== request.operationId ||
        response.dispatchId !== request.dispatchId ||
        response.attemptId !== request.attemptId ||
        response.decision.status === "unavailable"
      ) {
        await deferEffect(tx, this.clock, current, "authorization_unavailable");
        return;
      }
      if (response.decision.status === "denied") {
        await this.denied(tx, current, state, response.decision.reason, now);
        return;
      }
      const until = Date.parse(response.decision.validUntil);
      if (!(
        until > now.getTime() &&
        until <= receivedAt.getTime() + PERMIT_WINDOW_MILLISECONDS
      )) {
        await deferEffect(tx, this.clock, current, "permit_out_of_window");
        return;
      }
      // The attempt is durable before any external call, under the same lock.
      await tx
        .insertInto("community_effect_attempts")
        .values({
          attempt_id: request.attemptId,
          restriction_revision: state.restriction_revision,
          effect_ref: current.effect_ref,
          permit_ref: response.decision.permitRef,
          action,
          started_at: now,
          outcome: "started",
          diagnostic_code: null,
        })
        .execute();
      await tx
        .updateTable("community_effects")
        .set({
          state: "started",
          step: action,
          attempt_count: current.attempt_count + 1,
          // The lease keeps a second worker out until this attempt settles or the
          // process dies; recovery then starts from a fresh observation.
          available_at: new Date(now.getTime() + ATTEMPT_LEASE_MILLISECONDS),
          diagnostic_code: null,
          updated_at: now,
        })
        .where("effect_ref", "=", current.effect_ref)
        .execute();
      const inviteExpiresAt =
        action === "create_invite" ? this.inviteExpiry(state) : undefined;
      if (inviteExpiresAt)
        await this.storeInvite(tx, state, {
          invite_state: "unknown",
          invite_expires_at: inviteExpiresAt,
        });
      return {
        until:
          action === "approve" && current.join_invite_expires_at
            ? Math.min(until, current.join_invite_expires_at.getTime())
            : until,
        inviteLink: state.invite_link,
        inviteExpiresAt,
      };
    });
    if (!started) return;

    // Commit and lock latency must never turn an expired permit into an external call.
    if (this.clock.now().getTime() >= started.until) {
      await this.settle(effect.effect_ref, request.attemptId, action, {
        kind: "not_started",
      });
      return;
    }
    const outcome = await this.call(
      action,
      telegramUserId,
      started.inviteLink,
      started.inviteExpiresAt,
    );
    await this.settle(effect.effect_ref, request.attemptId, action, outcome);
  }

  private async call(
    action: CommunityMutation,
    telegramUserId: string,
    inviteLink: string | null,
    expiry: Date | undefined,
  ): Promise<CallResult> {
    const chat = this.canonicalChatId;
    try {
      switch (action) {
        case "unban":
          return await this.chat.unbanMember(chat, telegramUserId);
        case "approve":
          return await this.chat.approveJoinRequest(chat, telegramUserId);
        case "ban":
          return await this.chat.banMember(chat, telegramUserId);
        case "revoke_link":
          return inviteLink
            ? await this.chat.revokeInviteLink(chat, inviteLink)
            : { kind: "succeeded" };
        case "create_invite": {
          const expiresAt = expiry!;
          const created = await this.chat.createJoinRequestLink(
            chat,
            expiresAt,
          );
          return { ...created, expiresAt };
        }
      }
    } catch {
      return { kind: "unknown", ...(expiry ? { expiresAt: expiry } : {}) };
    }
  }

  /** At most ten minutes and never past a finite right; a lifetime stays short too. */
  private inviteExpiry(desired: DesiredRow): Date {
    const bound = this.clock.now().getTime() + INVITE_WINDOW_MILLISECONDS;
    const validUntil = desired.valid_until?.getTime();
    return new Date(validUntil ? Math.min(bound, validUntil) : bound);
  }

  private async settle(
    effectRef: string,
    attemptId: string,
    action: CommunityMutation,
    outcome: CallResult,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const found = await tx
        .selectFrom("community_effects")
        .select("account_ref")
        .where("effect_ref", "=", effectRef)
        .executeTakeFirstOrThrow();
      await lockAccount(tx, this.bot, found.account_ref);
      const current = await tx
        .selectFrom("community_effects")
        .selectAll()
        .where("effect_ref", "=", effectRef)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const now = this.clock.now();
      const succeeded =
        outcome.kind === "succeeded" || outcome.kind === "created";
      await tx
        .updateTable("community_effect_attempts")
        .set({
          outcome:
            outcome.kind === "unknown"
              ? "unknown"
              : outcome.kind === "rejected"
                ? "rejected"
                : succeeded
                  ? "succeeded"
                  : "not_started",
          diagnostic_code:
            "providerErrorCode" in outcome
              ? `telegram_${outcome.providerErrorCode}`
              : null,
        })
        .where("attempt_id", "=", attemptId)
        .execute();
      if (!isOpen(current.state)) return;
      const desired = await desiredFor(tx, this.bot, current.account_ref);
      const attempt = await tx
        .selectFrom("community_effect_attempts")
        .select("restriction_revision")
        .where("attempt_id", "=", attemptId)
        .executeTakeFirstOrThrow();
      if (
        (action === "ban" || action === "unban") &&
        (succeeded || outcome.kind === "unknown") &&
        desired.entitlement_revision === current.entitlement_revision &&
        desired.latest_operation === current.operation_id &&
        desired.telegram_identity_ref === current.telegram_identity_ref &&
        (desired.restriction_revision === attempt.restriction_revision ||
          desired.confirmed_ban_attempt_id === attemptId)
      ) {
        await tx
          .updateTable("community_desired_states")
          .set({
            removal_origin:
              action === "ban" &&
              (succeeded || desired.confirmed_ban_attempt_id === attemptId)
                ? "bot_expiry"
                : succeeded
                  ? "none"
                  : "external_unknown",
          })
          .where("bot_identity", "=", this.bot)
          .where("account_ref", "=", current.account_ref)
          .execute();
      }

      if (outcome.kind === "created") {
        await tx
          .updateTable("community_effects")
          .set({
            state: "pending",
            step: "observe",
            attempt_count: 0,
            retry_count: 0,
            available_at: outcome.expiresAt,
            diagnostic_code: null,
            updated_at: now,
          })
          .where("effect_ref", "=", effectRef)
          .execute();
        // The link is the Account's, so removal can still revoke it later.
        await this.storeInvite(tx, desired, {
          invite_link: outcome.inviteLink,
          invite_state: "created",
          invite_expires_at: outcome.expiresAt,
        });
        await setDesired(
          tx,
          this.bot,
          this.clock,
          desired,
          { status: "waiting_for_join" },
          now,
        );
        await this.offerReadmission(
          tx,
          desired,
          effectRef,
          outcome.inviteLink,
          now,
        );
        return;
      }
      if (outcome.kind === "unknown") {
        // A lost response is never proof; no blind repeat before a fresh observation.
        const invite = action === "create_invite";
        await tx
          .updateTable("community_effects")
          .set({
            state: "unknown",
            step: "observe",
            available_at: invite && outcome.expiresAt ? outcome.expiresAt : now,
            diagnostic_code: `${action}_response_lost`,
            updated_at: now,
          })
          .where("effect_ref", "=", effectRef)
          .execute();
        if (invite)
          await this.storeInvite(tx, desired, {
            invite_state: "unknown",
            invite_expires_at: outcome.expiresAt ?? null,
          });
        await setDesired(
          tx,
          this.bot,
          this.clock,
          desired,
          { status: "unknown", observed: "unknown" },
          now,
        );
        return;
      }
      if (succeeded) {
        await tx
          .updateTable("community_effects")
          .set({
            state: "pending",
            step: "observe",
            attempt_count: 0,
            retry_count: 0,
            available_at: now,
            diagnostic_code: null,
            updated_at: now,
          })
          .where("effect_ref", "=", effectRef)
          .execute();
        if (action === "revoke_link")
          await tx
            .updateTable("community_desired_states")
            .set({
              invite_state: "revoked",
              invite_link: null,
              invite_expires_at: null,
              invite_revision: null,
            })
            .where("bot_identity", "=", this.bot)
            .where("account_ref", "=", current.account_ref)
            .execute();
        return;
      }
      if (
        outcome.kind === "rejected" &&
        current.attempt_count >= ATTEMPT_BUDGET
      ) {
        await closeEffect(
          tx,
          this.clock,
          effectRef,
          "failed",
          `${action}_rejected_${outcome.providerErrorCode}`,
        );
        await setDesired(
          tx,
          this.bot,
          this.clock,
          desired,
          { status: "failed" },
          now,
        );
        return;
      }
      await deferEffect(
        tx,
        this.clock,
        current,
        `${action}_${outcome.kind}`,
        "retryAfterSeconds" in outcome && outcome.retryAfterSeconds
          ? outcome.retryAfterSeconds * 1000
          : 0,
      );
    });
  }

  private async storeInvite(
    tx: Tx,
    desired: DesiredRow,
    invite: {
      invite_link?: string;
      invite_state: "created" | "unknown";
      invite_expires_at: Date | null;
    },
  ): Promise<void> {
    await tx
      .updateTable("community_desired_states")
      .set({ ...invite, invite_revision: desired.entitlement_revision })
      .where("bot_identity", "=", this.bot)
      .where("account_ref", "=", desired.account_ref)
      .execute();
  }

  private removedByTribute(event: {
    readonly actorIsBot?: boolean;
    readonly actorTelegramUserId?: string;
  }): boolean {
    return (
      this.options.tributeBotTelegramUserId !== undefined &&
      event.actorIsBot === true &&
      event.actorTelegramUserId === this.options.tributeBotTelegramUserId
    );
  }

  /**
   * A person removed by Tribute does not come back on their own, so the first link
   * created for them is also sent privately. Without a reachable BotContact the link
   * stays available through /community; either way the request is answered once.
   */
  private async offerReadmission(
    tx: Tx,
    desired: DesiredRow,
    effectRef: string,
    inviteLink: string,
    now: Date,
  ): Promise<void> {
    const readmission = this.options.readmission;
    if (!readmission || desired.readmission_requested_at === null) return;
    const telegramUserId = await resolveIdentity(
      tx,
      this.bot,
      desired.account_ref,
      desired.telegram_identity_ref,
      false,
    );
    const contact = telegramUserId
      ? await tx
          .selectFrom("bot_contacts")
          .select("private_chat_id")
          .where("bot_identity", "=", this.bot)
          .where("telegram_user_id", "=", telegramUserId)
          .where("contactability", "=", "reachable")
          .executeTakeFirst()
      : undefined;
    if (telegramUserId && contact)
      await readmission.replies.enqueue(
        {
          botIdentity: this.bot,
          telegramUserId,
          privateChatId: contact.private_chat_id,
          messageText: `${readmission.text}\n${inviteLink}`,
          sourceKey: `community-readmission:${this.bot}:${effectRef}`,
          ...(desired.last_membership_update_id
            ? { triggerUpdateId: desired.last_membership_update_id }
            : {}),
          now,
        },
        tx,
      );
    await tx
      .updateTable("community_desired_states")
      .set({ readmission_requested_at: null })
      .where("bot_identity", "=", this.bot)
      .where("account_ref", "=", desired.account_ref)
      .execute();
  }

  private async wait(
    effect: EffectRow,
    desired: DesiredRow,
    observed: ObservedState,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, effect.account_ref);
      const now = this.clock.now();
      const current = await desiredFor(tx, this.bot, effect.account_ref);
      if (!sameDesiredSnapshot(current, desired)) return;
      await tx
        .updateTable("community_effects")
        .set({
          state: "pending",
          step: "observe",
          available_at:
            current.invite_expires_at ?? new Date(now.getTime() + this.cadence),
          updated_at: now,
        })
        .where("effect_ref", "=", effect.effect_ref)
        .execute();
      await setDesired(
        tx,
        this.bot,
        this.clock,
        current,
        { status: "waiting_for_join", observed: observedMembership(observed) },
        now,
      );
    });
  }

  private async complete(
    effect: EffectRow,
    desired: DesiredRow,
    observed: ObservedState,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, effect.account_ref);
      const now = this.clock.now();
      const current = await desiredFor(tx, this.bot, effect.account_ref);
      if (!sameDesiredSnapshot(current, desired)) return;
      await closeEffect(tx, this.clock, effect.effect_ref, "completed", null);
      await setDesired(
        tx,
        this.bot,
        this.clock,
        current,
        {
          status: statusFor(current, observed, now),
          observed: observedMembership(observed),
        },
        now,
      );
    });
  }

  private async denied(
    tx: Tx,
    effect: EffectRow,
    desired: DesiredRow,
    reason: DispatchDenialReason,
    now: Date,
  ): Promise<void> {
    if (reason === "superseded") {
      await closeEffect(
        tx,
        this.clock,
        effect.effect_ref,
        "superseded",
        "dispatch_superseded",
      );
      await setDesired(
        tx,
        this.bot,
        this.clock,
        desired,
        { status: "superseded" },
        now,
      );
      return;
    }
    if (reason === "expired") {
      await closeEffect(
        tx,
        this.clock,
        effect.effect_ref,
        "superseded",
        "dispatch_expired",
      );
      await setDesired(
        tx,
        this.bot,
        this.clock,
        desired,
        { status: desired.access.kind === "finite" ? "expired" : "failed" },
        now,
      );
      if (effect.effect !== "community.ensure_absence")
        await openAbsence(tx, this.bot, this.clock, desired);
      return;
    }
    await closeEffect(
      tx,
      this.clock,
      effect.effect_ref,
      "failed",
      `dispatch_${reason}`,
    );
    await setDesired(
      tx,
      this.bot,
      this.clock,
      desired,
      { status: "failed" },
      now,
    );
  }

  private async defer(
    effectRef: string,
    diagnosticCode: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const found = await tx
        .selectFrom("community_effects")
        .select("account_ref")
        .where("effect_ref", "=", effectRef)
        .executeTakeFirstOrThrow();
      await lockAccount(tx, this.bot, found.account_ref);
      const current = await tx
        .selectFrom("community_effects")
        .selectAll()
        .where("effect_ref", "=", effectRef)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!isOpen(current.state)) return;
      await deferEffect(tx, this.clock, current, diagnosticCode);
    });
  }

  // --------------------------------------------------------- reconciliation

  /**
   * Known desired states are re-checked at least once per cadence, so a lapsed
   * right, a departure and a provider outage are visible without any event.
   */
  async reconcileDueStates(limit = 25): Promise<void> {
    const due = await this.db
      .selectFrom("community_desired_states")
      .select("account_ref")
      .where("bot_identity", "=", this.bot)
      .where("due_at", "<=", this.clock.now())
      .orderBy("due_at")
      .limit(limit)
      .execute();
    for (const row of due) await this.reconcileAccount(row.account_ref);
  }

  private async reconcileAccount(accountRef: string): Promise<void> {
    const claimed = await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, accountRef);
      const desired = await desiredFor(tx, this.bot, accountRef);
      const now = this.clock.now();
      if (desired.due_at > now) return;
      if (
        desired.access.kind === "finite" &&
        !accessAllows(desired.access, now)
      ) {
        if (desired.status !== "expired")
          await setDesired(
            tx,
            this.bot,
            this.clock,
            desired,
            { status: "expired" },
            now,
          );
        await openAbsence(tx, this.bot, this.clock, desired);
      }
      await tx
        .updateTable("community_desired_states")
        .set({
          due_at: new Date(now.getTime() + this.cadence),
          updated_at: now,
        })
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", accountRef)
        .execute();
      const inFlight = await tx
        .selectFrom("community_effects")
        .select("effect_ref")
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", accountRef)
        .where("state", "=", "started")
        .executeTakeFirst();
      if (inFlight) return;
      const telegramUserId = await resolveIdentity(
        tx,
        this.bot,
        accountRef,
        desired.telegram_identity_ref,
        true,
      );
      return telegramUserId ? { desired, telegramUserId } : undefined;
    });
    if (!claimed) return;

    const observation = await this.observe(claimed.telegramUserId);
    await this.db.transaction().execute(async (tx) => {
      await lockAccount(tx, this.bot, accountRef);
      const desired = await desiredFor(tx, this.bot, accountRef);
      const now = this.clock.now();
      if (!sameDesiredSnapshot(desired, claimed.desired)) return;
      if (observation.kind === "unavailable") {
        // An outage is never hidden behind an earlier applied status.
        await setDesired(
          tx,
          this.bot,
          this.clock,
          desired,
          { status: "unknown", observed: "unknown" },
          now,
        );
        return;
      }
      if (observation.state !== "banned" && desired.removal_origin !== "none")
        await tx
          .updateTable("community_desired_states")
          .set({ removal_origin: "none" })
          .where("bot_identity", "=", this.bot)
          .where("account_ref", "=", accountRef)
          .execute();
      const observed = observedMembership(observation.state);
      await setDesired(
        tx,
        this.bot,
        this.clock,
        desired,
        { status: statusFor(desired, observation.state, now), observed },
        now,
      );
      const allows = accessAllows(desired.access, now);
      const open = await tx
        .selectFrom("community_effects")
        .select("effect_ref")
        .where("bot_identity", "=", this.bot)
        .where("account_ref", "=", accountRef)
        .where("state", "in", ["pending", "started", "unknown"])
        .executeTakeFirst();
      if (open) return;
      if (allows && observed === "not_member")
        await openEffect(
          tx,
          this.bot,
          this.clock,
          targetOf(desired),
          "community.ensure_admission",
        );
      // A revoked right also has to close the admission path it left behind.
      if (!allows && (observed === "member" || openAdmissionPath(desired)))
        await openAbsence(tx, this.bot, this.clock, desired);
    });
  }

  async snapshot(): Promise<CommunitySnapshot> {
    const now = this.clock.now();
    const states = await sql<{ due_count: string; oldest_due_at: Date | null }>`
      select count(*)::text as due_count, min(due_at) as oldest_due_at
      from community_desired_states
      where bot_identity = ${this.bot} and due_at <= ${now}
    `.execute(this.db);
    const effects = await sql<{ backlog: string; unknown_count: string }>`
      select count(*)::text as backlog, count(*) filter (where state = 'unknown')::text as unknown_count from community_effects
      where bot_identity = ${this.bot}
        and state in ('pending', 'started', 'unknown')
    `.execute(this.db);
    const restrictions = await this.db
      .selectFrom("community_desired_states")
      .select(this.db.fn.countAll<string>().as("count"))
      .where("bot_identity", "=", this.bot)
      .where("admission_restriction", "!=", "none")
      .executeTakeFirstOrThrow();
    const oldest = states.rows[0]?.oldest_due_at;
    return {
      dueStates: Number(states.rows[0]?.due_count ?? 0),
      oldestDueAgeMs: oldest
        ? Math.max(0, now.getTime() - oldest.getTime())
        : 0,
      effectBacklog: Number(effects.rows[0]?.backlog ?? 0),
      unknownEffects: Number(effects.rows[0]?.unknown_count ?? 0),
      restricted: Number(restrictions.count),
    };
  }
}

type CallResult =
  | { kind: "succeeded" }
  | { kind: "created"; inviteLink: string; expiresAt: Date }
  | { kind: "rejected"; providerErrorCode: number; expiresAt?: Date }
  | {
      kind: "retryable";
      providerErrorCode: number;
      retryAfterSeconds?: number;
      expiresAt?: Date;
    }
  | { kind: "unknown"; expiresAt?: Date }
  | { kind: "not_started" };

function sameDesiredState(
  desired: DesiredRow,
  command: CommunitySetCommand,
): boolean {
  return (
    desired.telegram_identity_ref === command.binding.telegramIdentityRef &&
    desired.link_ref === command.binding.linkRef &&
    Number(desired.link_revision) === command.binding.linkRevision &&
    canonicalJson(desired.access) === canonicalJson(command.access)
  );
}

function conflict(
  operationId: string,
  error: "operation_conflict" | "revision_conflict",
  version: CommunityVersion,
): CommunityHandled {
  return {
    status: communityErrorStatus[error],
    body: communityError(operationId, error, version),
  };
}

function validJoinInvite(
  effect: EffectRow,
  desired: DesiredRow,
  now: Date,
): boolean {
  return (
    reusableInvite(desired, now) &&
    effect.join_invite_digest !== null &&
    desired.invite_link !== null &&
    digest(desired.invite_link) === effect.join_invite_digest &&
    effect.join_invite_expires_at !== null &&
    effect.join_invite_expires_at > now
  );
}

/** Observations cannot rewrite a newer binding, entitlement or operator decision. */
function sameDesiredSnapshot(
  current: DesiredRow,
  observed: DesiredRow,
): boolean {
  return (
    current.entitlement_revision === observed.entitlement_revision &&
    current.latest_operation === observed.latest_operation &&
    current.telegram_identity_ref === observed.telegram_identity_ref &&
    current.link_ref === observed.link_ref &&
    current.link_revision === observed.link_revision &&
    current.restriction_revision === observed.restriction_revision
  );
}

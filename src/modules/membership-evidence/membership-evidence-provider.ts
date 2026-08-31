import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
  type MembershipEventDisposition,
  type MembershipProviderState,
  type NormalizedMembershipState,
} from "../../database/database.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";
import {
  MEMBERSHIP_EVIDENCE_CONTRACT_VERSION,
  type MembershipEvidence,
  readStoredMembershipEvidence,
} from "./membership-evidence.js";
import {
  botHasMembershipPrerequisite,
  normalizeChatMember,
  type TelegramChatMember,
} from "./membership-normalization.js";
import { lockProviderStateChanges } from "./membership-provider-delivery-lock.js";
import {
  TELEGRAM_MEMBERSHIP,
  type TelegramChatMemberResult,
  type TelegramMembership,
} from "./telegram-membership.js";

const EVIDENCE_VALIDITY_MILLISECONDS = 5 * 60 * 1000;
const TELEGRAM_READ_TIMEOUT_MILLISECONDS = 5_000;

export interface LinkMembershipCheck {
  readonly checkRef: string;
  readonly telegramIdentityRef: string;
}

interface DurableMembershipEnvelopeBase {
  readonly botIdentity: string;
  readonly canonicalChatId: string;
  readonly chatMember: TelegramChatMember;
  readonly eventAt: Date;
  readonly updateId: string;
}

export type DurableMembershipEnvelope =
  | (DurableMembershipEnvelopeBase & {
      readonly actorIsSubject: boolean;
      readonly kind: "subject";
      readonly subjectTelegramUserId: string;
    })
  | (DurableMembershipEnvelopeBase & { readonly kind: "provider" });

export interface EvidenceOutcome {
  readonly evidence: MembershipEvidence;
  readonly providerState: MembershipProviderState;
  readonly responsePlanned: boolean;
}

@Injectable()
export class MembershipEvidenceProvider {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TELEGRAM_MEMBERSHIP)
    private readonly telegram: TelegramMembership,
  ) {}

  async validateReadiness(): Promise<MembershipProviderState> {
    if (this.config.membershipMode === "disabled") {
      return "ready";
    }
    const prerequisite = await this.readProviderPrerequisite();
    const checkedAt = this.clock.now();
    return this.database.transaction().execute(async (transaction) => {
      await lockProviderStateChanges(transaction, this.config.botIdentity);
      const observation = await recordProviderObservation(transaction, {
        botIdentity: this.config.botIdentity,
        canonicalChatId: this.config.canonicalChatId,
        diagnosticCode: prerequisite.diagnosticCode,
        observedAt: checkedAt,
        sourceKind: "direct",
        sourceRef: `readiness:${randomUUID()}`,
        sourceUpdateId: null,
        state: prerequisite.providerState,
      });
      return observation.currentState;
    });
  }

  async accept(
    envelope: DurableMembershipEnvelope,
  ): Promise<EvidenceOutcome | undefined> {
    assertMembershipEnvelope(envelope);
    if (
      envelope.botIdentity !== this.config.botIdentity ||
      envelope.canonicalChatId !== this.config.canonicalChatId
    ) {
      return undefined;
    }
    if (envelope.kind === "provider") {
      await this.acceptProviderEvent(envelope);
      return undefined;
    }

    const link = await this.database
      .selectFrom("platform_links")
      .select(["account_ref", "telegram_identity_ref"])
      .where("bot_identity", "=", envelope.botIdentity)
      .where("telegram_user_id", "=", envelope.subjectTelegramUserId)
      .executeTakeFirst();
    if (!link) {
      await recordMembershipEventAudit(this.database, envelope, {
        diagnosticCode: "unlinked_subject",
        disposition: "unlinked_subject",
        normalizedState: normalizeChatMember(envelope.chatMember),
        resultRef: null,
        subjectLinked: false,
      });
      return undefined;
    }

    const resultRef = `membership-event:${envelope.botIdentity}:${envelope.updateId}`;
    const existing = await this.existingOutcome(resultRef);
    if (existing) {
      return existing;
    }

    const observedState = normalizeChatMember(envelope.chatMember);

    return this.database.transaction().execute(async (transaction) => {
      await lockProviderStateChanges(transaction, envelope.botIdentity);
      const lockedLink = await transaction
        .selectFrom("platform_links")
        .select([
          "account_ref",
          "bot_identity",
          "evidence_version",
          "last_membership_observation_at",
          "last_membership_observation_update_id",
        ])
        .where("telegram_identity_ref", "=", link.telegram_identity_ref)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const storedProvider = await transaction
        .selectFrom("membership_provider_state")
        .select(["diagnostic_code", "state"])
        .where("bot_identity", "=", lockedLink.bot_identity)
        .forUpdate()
        .executeTakeFirst();
      let providerState: MembershipProviderState =
        storedProvider?.state ?? "unavailable";
      const alreadyStored = await transaction
        .selectFrom("membership_evidence_outbox")
        .select("envelope")
        .where("result_ref", "=", resultRef)
        .executeTakeFirst();
      if (alreadyStored) {
        return {
          evidence: readStoredMembershipEvidence(alreadyStored.envelope),
          providerState,
          responsePlanned: false,
        };
      }
      if (
        !isNewerMembershipEvent(
          envelope,
          lockedLink.last_membership_observation_at,
          lockedLink.last_membership_observation_update_id,
        )
      ) {
        await recordMembershipEventAudit(transaction, envelope, {
          diagnosticCode: "older_membership_event",
          disposition: "ignored_older",
          normalizedState: observedState,
          resultRef: null,
          subjectLinked: true,
        });
        return undefined;
      }
      let normalizedState = observedState;
      let diagnosticCode: string | null = null;
      if (observedState === "unavailable") {
        diagnosticCode = "unknown_chat_member_status";
        const providerObservation = await recordProviderObservation(
          transaction,
          {
            botIdentity: lockedLink.bot_identity,
            canonicalChatId: envelope.canonicalChatId,
            diagnosticCode,
            observedAt: envelope.eventAt,
            sourceKind: "event",
            sourceRef: `subject:${envelope.updateId}`,
            sourceUpdateId: envelope.updateId,
            state: "unavailable",
          },
        );
        providerState = providerObservation.currentState;
      } else if (observedState === "member" && providerState !== "ready") {
        normalizedState = "unavailable";
        diagnosticCode =
          storedProvider?.diagnostic_code ?? "bot_administrator_required";
      }

      const evidence = await recordEvidence(transaction, {
        accountRef: lockedLink.account_ref,
        diagnosticCode,
        event: envelope,
        normalizedState,
        observedAt: envelope.eventAt,
        rawChatMember: envelope.chatMember,
        resultRef,
        telegramIdentityRef: link.telegram_identity_ref,
      });
      await recordMembershipEventAudit(transaction, envelope, {
        diagnosticCode,
        disposition: "evidence",
        normalizedState,
        resultRef,
        subjectLinked: true,
      });

      return { evidence, providerState, responsePlanned: false };
    });
  }

  private async acceptProviderEvent(
    envelope: Extract<DurableMembershipEnvelope, { kind: "provider" }>,
  ): Promise<void> {
    const transition = providerTransition(envelope.chatMember);
    await this.database.transaction().execute(async (transaction) => {
      await lockProviderStateChanges(transaction, envelope.botIdentity);
      const observation = await recordProviderObservation(transaction, {
        botIdentity: envelope.botIdentity,
        canonicalChatId: envelope.canonicalChatId,
        diagnosticCode: transition.diagnosticCode,
        observedAt: envelope.eventAt,
        sourceKind: "event",
        sourceRef: `provider:${envelope.updateId}`,
        sourceUpdateId: envelope.updateId,
        state: transition.state,
      });
      if (transition.state !== "ready") {
        const recovery = await transaction
          .selectFrom("membership_provider_observations")
          .select(["observed_at", "source_update_id"])
          .where("bot_identity", "=", envelope.botIdentity)
          .where("state", "=", "ready")
          .where((expression) =>
            expression.or([
              expression("observed_at", ">", envelope.eventAt),
              expression.and([
                expression("observed_at", "=", envelope.eventAt),
                expression("source_update_id", ">", envelope.updateId),
              ]),
            ]),
          )
          .orderBy("observed_at")
          .orderBy("source_update_id")
          .orderBy("id")
          .executeTakeFirst();
        await rejectUnsafePositiveEvidence(
          transaction,
          { observedAt: envelope.eventAt, updateId: envelope.updateId },
          recovery
            ? {
                observedAt: recovery.observed_at,
                updateId: recovery.source_update_id,
              }
            : undefined,
        );
      }
      await recordMembershipEventAudit(transaction, envelope, {
        diagnosticCode: observation.acceptedAsCurrent
          ? transition.diagnosticCode
          : "older_provider_event",
        disposition: observation.acceptedAsCurrent
          ? "provider_state"
          : "ignored_older",
        normalizedState: normalizeChatMember(envelope.chatMember),
        resultRef: null,
        subjectLinked: null,
      });
    });
  }

  async observe(check: LinkMembershipCheck): Promise<EvidenceOutcome> {
    assertCheck(check);
    const existing = await this.existingOutcome(check.checkRef);
    if (existing) {
      return existing;
    }

    const link = await this.database
      .selectFrom("platform_links")
      .innerJoin("bot_contacts", (join) =>
        join
          .onRef(
            "bot_contacts.bot_identity",
            "=",
            "platform_links.bot_identity",
          )
          .onRef(
            "bot_contacts.telegram_user_id",
            "=",
            "platform_links.telegram_user_id",
          ),
      )
      .select([
        "platform_links.account_ref",
        "platform_links.bot_identity",
        "bot_contacts.private_chat_id",
        "platform_links.telegram_user_id",
      ])
      .where(
        "platform_links.telegram_identity_ref",
        "=",
        check.telegramIdentityRef,
      )
      .executeTakeFirst();
    if (!link) {
      throw new Error("Membership check has no linked Telegram identity");
    }

    const observed = await this.readMembership(link.telegram_user_id);
    const observedAt = this.clock.now();

    return this.database.transaction().execute(async (transaction) => {
      await lockProviderStateChanges(transaction, link.bot_identity);
      const lockedLink = await transaction
        .selectFrom("platform_links")
        .select([
          "account_ref",
          "bot_identity",
          "evidence_version",
          "last_membership_observation_at",
        ])
        .where("telegram_identity_ref", "=", check.telegramIdentityRef)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const alreadyStored = await transaction
        .selectFrom("membership_evidence_outbox")
        .select("envelope")
        .where("membership_evidence_outbox.result_ref", "=", check.checkRef)
        .executeTakeFirst();
      if (alreadyStored) {
        const providerState = await transaction
          .selectFrom("membership_provider_state")
          .select("state")
          .where("bot_identity", "=", lockedLink.bot_identity)
          .executeTakeFirstOrThrow();
        return {
          evidence: readStoredMembershipEvidence(alreadyStored.envelope),
          providerState: providerState.state,
          responsePlanned: false,
        };
      }
      const providerObservation = await recordProviderObservation(transaction, {
        botIdentity: lockedLink.bot_identity,
        canonicalChatId: this.config.canonicalChatId,
        diagnosticCode: observed.diagnosticCode,
        observedAt,
        sourceKind: "direct",
        sourceRef: `membership-check:${check.checkRef}`,
        sourceUpdateId: null,
        state: observed.providerState,
      });
      if (
        observed.normalizedState !== "unavailable" &&
        lockedLink.last_membership_observation_at !== null &&
        observedAt < lockedLink.last_membership_observation_at
      ) {
        return currentOutcome(
          transaction,
          check.telegramIdentityRef,
          lockedLink.bot_identity,
        );
      }

      const normalizedState =
        observed.normalizedState === "member" &&
        providerObservation.currentState !== "ready"
          ? "unavailable"
          : observed.normalizedState;
      const diagnosticCode =
        normalizedState === "unavailable" &&
        observed.normalizedState === "member"
          ? (providerObservation.currentDiagnosticCode ??
            "bot_administrator_required")
          : observed.diagnosticCode;

      const evidence = await recordEvidence(transaction, {
        accountRef: lockedLink.account_ref,
        diagnosticCode,
        normalizedState,
        observedAt,
        rawChatMember: observed.rawChatMember,
        resultRef: check.checkRef,
        telegramIdentityRef: check.telegramIdentityRef,
      });
      const response = await transaction
        .insertInto("start_response_deliveries")
        .values({
          attempt_count: 0,
          available_at: observedAt,
          bot_identity: link.bot_identity,
          created_at: observedAt,
          delivered_at: null,
          diagnostic_code: null,
          locked_at: null,
          message_text: responseText(this.config, normalizedState),
          private_chat_id: link.private_chat_id,
          source_key: `membership-check:${check.checkRef}`,
          state: "pending",
          telegram_user_id: link.telegram_user_id,
          trigger_update_id: null,
          updated_at: observedAt,
        })
        .onConflict((conflict) => conflict.column("source_key").doNothing())
        .returning("id")
        .executeTakeFirst();

      return {
        evidence,
        providerState: providerObservation.currentState,
        responsePlanned: response !== undefined,
      };
    });
  }

  private async existingOutcome(
    checkRef: string,
  ): Promise<EvidenceOutcome | undefined> {
    const stored = await this.database
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
      .innerJoin(
        "membership_provider_state",
        "membership_provider_state.bot_identity",
        "platform_links.bot_identity",
      )
      .select([
        "membership_evidence_outbox.envelope",
        "membership_provider_state.state",
      ])
      .where("membership_evidence_outbox.result_ref", "=", checkRef)
      .executeTakeFirst();
    return stored
      ? {
          evidence: readStoredMembershipEvidence(stored.envelope),
          providerState: stored.state,
          responsePlanned: false,
        }
      : undefined;
  }

  private async readMembership(
    telegramUserId: string,
  ): Promise<ObservedMembership> {
    const prerequisite = await this.readProviderPrerequisite();
    if (prerequisite.providerState !== "ready") {
      return unavailable(
        prerequisite.providerState,
        prerequisite.diagnosticCode,
        prerequisite.rawChatMember,
      );
    }

    const subject = await safeTelegramRead(() =>
      this.telegram.getChatMember(this.config.canonicalChatId, telegramUserId),
    );
    if (subject.kind === "unavailable") {
      return unavailable("unavailable", subject.diagnosticCode);
    }
    const normalizedState = normalizeChatMember(subject.value);
    if (normalizedState === "unavailable") {
      return unavailable(
        "unavailable",
        "unknown_chat_member_status",
        subject.value,
      );
    }
    return {
      diagnosticCode: null,
      normalizedState,
      providerState: "ready",
      rawChatMember: subject.value,
    };
  }

  private async readProviderPrerequisite(): Promise<ProviderPrerequisite> {
    const bot = await safeTelegramRead(() =>
      this.telegram.getBotChatMember(this.config.canonicalChatId),
    );
    if (bot.kind === "unavailable") {
      return {
        diagnosticCode: bot.diagnosticCode,
        providerState: "unavailable",
      };
    }
    if (!botHasMembershipPrerequisite(bot.value)) {
      return {
        diagnosticCode: "bot_administrator_required",
        providerState: "degraded",
        rawChatMember: bot.value,
      };
    }
    return {
      diagnosticCode: null,
      providerState: "ready",
      rawChatMember: bot.value,
    };
  }
}

interface ProviderPrerequisite {
  readonly diagnosticCode: string | null;
  readonly providerState: MembershipProviderState;
  readonly rawChatMember?: TelegramChatMember;
}

interface ObservedMembership {
  readonly diagnosticCode: string | null;
  readonly normalizedState: NormalizedMembershipState;
  readonly providerState: MembershipProviderState;
  readonly rawChatMember?: TelegramChatMember;
}

function unavailable(
  providerState: Exclude<MembershipProviderState, "ready">,
  diagnosticCode: string | null,
  rawChatMember?: TelegramChatMember,
): ObservedMembership {
  return {
    diagnosticCode,
    normalizedState: "unavailable",
    providerState,
    ...(rawChatMember ? { rawChatMember } : {}),
  };
}

async function safeTelegramRead(
  operation: () => Promise<TelegramChatMemberResult>,
): Promise<TelegramChatMemberResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<TelegramChatMemberResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              diagnosticCode: "telegram_timeout",
              kind: "unavailable",
            }),
          TELEGRAM_READ_TIMEOUT_MILLISECONDS,
        );
        timer.unref();
      }),
    ]);
  } catch {
    return {
      diagnosticCode: "telegram_api_unavailable",
      kind: "unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function recordEvidence(
  transaction: Transaction<DatabaseSchema>,
  record: {
    readonly accountRef: string;
    readonly diagnosticCode: string | null;
    readonly event?: Pick<
      DurableMembershipEnvelopeBase,
      "eventAt" | "updateId"
    >;
    readonly normalizedState: NormalizedMembershipState;
    readonly observedAt: Date;
    readonly rawChatMember?: TelegramChatMember;
    readonly resultRef: string;
    readonly telegramIdentityRef: string;
  },
): Promise<MembershipEvidence> {
  let evidenceVersion: number | undefined;
  let evidenceRef: string | undefined;
  if (record.normalizedState !== "unavailable") {
    const revision = record.event
      ? await transaction
          .updateTable("platform_links")
          .set({
            evidence_version: sql`evidence_version + 1`,
            last_membership_observation_at: record.event.eventAt,
            last_membership_observation_update_id: record.event.updateId,
          })
          .where("telegram_identity_ref", "=", record.telegramIdentityRef)
          .returning("evidence_version")
          .executeTakeFirstOrThrow()
      : await transaction
          .updateTable("platform_links")
          .set({
            evidence_version: sql`evidence_version + 1`,
            last_membership_observation_at: record.observedAt,
            last_membership_observation_update_id: null,
          })
          .where("telegram_identity_ref", "=", record.telegramIdentityRef)
          .returning("evidence_version")
          .executeTakeFirstOrThrow();
    evidenceVersion = Number(revision.evidence_version);
    if (!Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1) {
      throw new Error("Membership Evidence revision is outside JSON range");
    }
    evidenceRef = randomUUID();
  } else if (record.event) {
    await transaction
      .updateTable("platform_links")
      .set({
        last_membership_observation_at: record.event.eventAt,
        last_membership_observation_update_id: record.event.updateId,
      })
      .where("telegram_identity_ref", "=", record.telegramIdentityRef)
      .execute();
  }

  const evidence = createEvidence(
    record.accountRef,
    record.telegramIdentityRef,
    record.normalizedState,
    record.observedAt,
    evidenceVersion,
    evidenceRef,
  );
  await transaction
    .insertInto("membership_check_results")
    .values({
      diagnostic_code: record.diagnosticCode,
      evidence_ref: evidenceRef ?? null,
      evidence_version: evidenceVersion ?? null,
      normalized_state: record.normalizedState,
      observation_update_id: record.event?.updateId ?? null,
      result_ref: record.resultRef,
      observed_at: record.observedAt,
      raw_is_member: record.rawChatMember?.isMember ?? null,
      raw_status: record.rawChatMember?.status ?? null,
      telegram_identity_ref: record.telegramIdentityRef,
    })
    .execute();
  await transaction
    .insertInto("membership_evidence_outbox")
    .values({
      attempt_count: 0,
      available_at: record.observedAt,
      delivered_at: null,
      diagnostic_code: null,
      envelope: evidence,
      id: randomUUID(),
      locked_at: null,
      result_ref: record.resultRef,
      state: "pending",
      updated_at: record.observedAt,
    })
    .execute();
  return evidence;
}

async function currentOutcome(
  transaction: Transaction<DatabaseSchema>,
  telegramIdentityRef: string,
  botIdentity: string,
): Promise<EvidenceOutcome> {
  const stored = await transaction
    .selectFrom("membership_check_results")
    .innerJoin(
      "membership_evidence_outbox",
      "membership_evidence_outbox.result_ref",
      "membership_check_results.result_ref",
    )
    .select("membership_evidence_outbox.envelope")
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .orderBy("observed_at", "desc")
    .orderBy("membership_check_results.id", "desc")
    .executeTakeFirstOrThrow();
  const provider = await transaction
    .selectFrom("membership_provider_state")
    .select("state")
    .where("bot_identity", "=", botIdentity)
    .executeTakeFirstOrThrow();
  return {
    evidence: readStoredMembershipEvidence(stored.envelope),
    providerState: provider.state,
    responsePlanned: false,
  };
}

function createEvidence(
  principalRef: string,
  telegramIdentityRef: string,
  state: NormalizedMembershipState,
  observedAt: Date,
  evidenceVersion: number | undefined,
  evidenceRef: string | undefined,
): MembershipEvidence {
  if (state === "unavailable") {
    return {
      contractVersion: MEMBERSHIP_EVIDENCE_CONTRACT_VERSION,
      decision: "unavailable",
      principalRef,
      reasonCode: "provider_unavailable",
    };
  }
  if (evidenceVersion === undefined || evidenceRef === undefined) {
    throw new Error("Observed Membership Evidence has no revision");
  }
  return {
    checkedAt: observedAt.toISOString(),
    contractVersion: MEMBERSHIP_EVIDENCE_CONTRACT_VERSION,
    decision: state === "member" ? "member" : "not_member",
    evidenceRef,
    evidenceVersion,
    principalRef,
    reasonCode: state === "member" ? "chat_member" : "chat_not_member",
    telegramIdentityRef,
    validUntil: new Date(
      observedAt.getTime() + EVIDENCE_VALIDITY_MILLISECONDS,
    ).toISOString(),
  };
}

function responseText(
  config: ApplicationConfig,
  state: NormalizedMembershipState,
): string {
  if (state === "member") {
    return config.linkedMemberText;
  }
  if (state === "non_member") {
    return config.linkedNonMemberText;
  }
  return config.linkedUnavailableText;
}

function assertCheck(check: LinkMembershipCheck): void {
  if (
    !/^[A-Za-z0-9:_-]{1,256}$/.test(check.checkRef) ||
    !/^[A-Za-z0-9-]{1,256}$/.test(check.telegramIdentityRef)
  ) {
    throw new Error("Membership check reference is malformed");
  }
}

function assertMembershipEnvelope(envelope: DurableMembershipEnvelope): void {
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(envelope.botIdentity) ||
    !/^-?[1-9][0-9]{0,15}$/.test(envelope.canonicalChatId) ||
    !/^[0-9]{1,20}$/.test(envelope.updateId) ||
    Number.isNaN(envelope.eventAt.getTime()) ||
    (envelope.kind === "subject" &&
      (!/^[1-9][0-9]{0,15}$/.test(envelope.subjectTelegramUserId) ||
        typeof envelope.actorIsSubject !== "boolean"))
  ) {
    throw new Error("Durable Membership envelope is malformed");
  }
}

function isNewerMembershipEvent(
  envelope: Pick<DurableMembershipEnvelopeBase, "eventAt" | "updateId">,
  lastEventAt: Date | null,
  lastUpdateId: string | null,
): boolean {
  return isNewerObservation(
    envelope.eventAt,
    envelope.updateId,
    lastEventAt,
    lastUpdateId,
  );
}

function isNewerObservation(
  observedAt: Date,
  sourceUpdateId: string | null,
  lastObservedAt: Date | null,
  lastUpdateId: string | null,
): boolean {
  if (!lastObservedAt) {
    return true;
  }
  const timeDifference = observedAt.getTime() - lastObservedAt.getTime();
  if (timeDifference !== 0) {
    return timeDifference > 0;
  }
  if (sourceUpdateId === null) {
    return lastUpdateId === null;
  }
  return lastUpdateId === null || BigInt(sourceUpdateId) > BigInt(lastUpdateId);
}

function providerTransition(chatMember: TelegramChatMember): {
  readonly diagnosticCode: string | null;
  readonly state: MembershipProviderState;
} {
  if (botHasMembershipPrerequisite(chatMember)) {
    return { diagnosticCode: null, state: "ready" };
  }
  if (normalizeChatMember(chatMember) === "unavailable") {
    return {
      diagnosticCode: "unknown_provider_chat_member_status",
      state: "unavailable",
    };
  }
  return {
    diagnosticCode: "bot_administrator_required",
    state: "degraded",
  };
}

interface ProviderObservationRecord {
  readonly botIdentity: string;
  readonly canonicalChatId: string;
  readonly diagnosticCode: string | null;
  readonly observedAt: Date;
  readonly sourceKind: "direct" | "event";
  readonly sourceRef: string;
  readonly sourceUpdateId: string | null;
  readonly state: MembershipProviderState;
}

async function recordProviderObservation(
  transaction: Transaction<DatabaseSchema>,
  record: ProviderObservationRecord,
): Promise<{
  readonly acceptedAsCurrent: boolean;
  readonly currentDiagnosticCode: string | null;
  readonly currentState: MembershipProviderState;
}> {
  await transaction
    .insertInto("membership_provider_observations")
    .values({
      bot_identity: record.botIdentity,
      diagnostic_code: record.diagnosticCode,
      observed_at: record.observedAt,
      source_kind: record.sourceKind,
      source_ref: record.sourceRef,
      source_update_id: record.sourceUpdateId,
      state: record.state,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["bot_identity", "source_kind", "source_ref"])
        .doNothing(),
    )
    .execute();

  const inserted = await transaction
    .insertInto("membership_provider_state")
    .values({
      bot_identity: record.botIdentity,
      canonical_chat_id: record.canonicalChatId,
      diagnostic_code: record.diagnosticCode,
      last_provider_observation_at: record.observedAt,
      last_provider_observation_update_id: record.sourceUpdateId,
      state: record.state,
      updated_at: record.observedAt,
    })
    .onConflict((conflict) => conflict.column("bot_identity").doNothing())
    .returning("bot_identity")
    .executeTakeFirst();
  if (inserted) {
    return {
      acceptedAsCurrent: true,
      currentDiagnosticCode: record.diagnosticCode,
      currentState: record.state,
    };
  }

  const current = await transaction
    .selectFrom("membership_provider_state")
    .select([
      "diagnostic_code",
      "last_provider_observation_at",
      "last_provider_observation_update_id",
      "state",
    ])
    .where("bot_identity", "=", record.botIdentity)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    !isNewerObservation(
      record.observedAt,
      record.sourceUpdateId,
      current.last_provider_observation_at,
      current.last_provider_observation_update_id,
    )
  ) {
    return {
      acceptedAsCurrent: false,
      currentDiagnosticCode: current.diagnostic_code,
      currentState: current.state,
    };
  }

  await transaction
    .updateTable("membership_provider_state")
    .set({
      canonical_chat_id: record.canonicalChatId,
      diagnostic_code: record.diagnosticCode,
      last_provider_observation_at: record.observedAt,
      last_provider_observation_update_id: record.sourceUpdateId,
      state: record.state,
      updated_at: record.observedAt,
    })
    .where("bot_identity", "=", record.botIdentity)
    .execute();
  return {
    acceptedAsCurrent: true,
    currentDiagnosticCode: record.diagnosticCode,
    currentState: record.state,
  };
}

async function rejectUnsafePositiveEvidence(
  transaction: Transaction<DatabaseSchema>,
  providerLost: { readonly observedAt: Date; readonly updateId: string },
  providerRecovered?: {
    readonly observedAt: Date;
    readonly updateId: string | null;
  },
): Promise<void> {
  let unsafeResults = transaction
    .selectFrom("membership_check_results")
    .select("result_ref")
    .where("normalized_state", "=", "member").where(sql<boolean>`(
      observed_at > ${providerLost.observedAt}
      or (
        observed_at = ${providerLost.observedAt}
        and observation_update_id >= ${providerLost.updateId}
      )
    )`);
  if (providerRecovered) {
    unsafeResults = providerRecovered.updateId
      ? unsafeResults.where(sql<boolean>`(
          observed_at < ${providerRecovered.observedAt}
          or (
            observed_at = ${providerRecovered.observedAt}
            and (
              observation_update_id is null
              or observation_update_id < ${providerRecovered.updateId}
            )
          )
        )`)
      : unsafeResults.where("observed_at", "<", providerRecovered.observedAt);
  }
  await transaction
    .updateTable("membership_evidence_outbox")
    .set({
      diagnostic_code: "provider_lost_before_delivery",
      locked_at: null,
      state: "rejected",
      updated_at: providerLost.observedAt,
    })
    .where("state", "in", ["pending", "retry_scheduled", "delivering"])
    .where("result_ref", "in", unsafeResults)
    .execute();
}

async function recordMembershipEventAudit(
  database: Kysely<DatabaseSchema>,
  envelope: DurableMembershipEnvelope,
  record: {
    readonly diagnosticCode: string | null;
    readonly disposition: MembershipEventDisposition;
    readonly normalizedState: NormalizedMembershipState;
    readonly resultRef: string | null;
    readonly subjectLinked: boolean | null;
  },
): Promise<void> {
  await database
    .insertInto("membership_event_audit")
    .values({
      actor_is_subject:
        envelope.kind === "subject" ? envelope.actorIsSubject : null,
      bot_identity: envelope.botIdentity,
      canonical_chat_id: envelope.canonicalChatId,
      diagnostic_code: record.diagnosticCode,
      disposition: record.disposition,
      event_at: envelope.eventAt,
      event_kind: envelope.kind,
      normalized_state: record.normalizedState,
      result_ref: record.resultRef,
      subject_linked: record.subjectLinked,
      update_id: envelope.updateId,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

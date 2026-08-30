import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  DATABASE,
  type Database,
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
      const lockedLink = await transaction
        .selectFrom("platform_links")
        .select(["account_ref", "bot_identity", "evidence_version"])
        .where("telegram_identity_ref", "=", check.telegramIdentityRef)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const alreadyStored = await transaction
        .selectFrom("membership_evidence_outbox")
        .select("envelope")
        .where(
          "membership_evidence_outbox.observation_ref",
          "=",
          check.checkRef,
        )
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

      let evidenceVersion: number | undefined;
      let evidenceRef: string | undefined;
      if (observed.normalizedState !== "unavailable") {
        const revision = await transaction
          .updateTable("platform_links")
          .set({ evidence_version: sql`evidence_version + 1` })
          .where("telegram_identity_ref", "=", check.telegramIdentityRef)
          .returning("evidence_version")
          .executeTakeFirstOrThrow();
        evidenceVersion = Number(revision.evidence_version);
        if (!Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1) {
          throw new Error("Membership Evidence revision is outside JSON range");
        }
        evidenceRef = randomUUID();
      }

      const evidence = createEvidence(
        lockedLink.account_ref,
        check.telegramIdentityRef,
        observed.normalizedState,
        observedAt,
        evidenceVersion,
        evidenceRef,
      );
      const outboxId = randomUUID();

      await transaction
        .insertInto("membership_observations")
        .values({
          diagnostic_code: observed.diagnosticCode,
          evidence_ref: evidenceRef ?? null,
          evidence_version: evidenceVersion ?? null,
          normalized_state: observed.normalizedState,
          observation_ref: check.checkRef,
          observed_at: observedAt,
          raw_is_member: observed.rawChatMember?.isMember ?? null,
          raw_status: observed.rawChatMember?.status ?? null,
          telegram_identity_ref: check.telegramIdentityRef,
        })
        .execute();
      await transaction
        .insertInto("membership_evidence_outbox")
        .values({
          attempt_count: 0,
          available_at: observedAt,
          delivered_at: null,
          diagnostic_code: null,
          envelope: evidence,
          id: outboxId,
          locked_at: null,
          observation_ref: check.checkRef,
          state: "pending",
          updated_at: observedAt,
        })
        .execute();
      await transaction
        .insertInto("membership_provider_state")
        .values({
          bot_identity: lockedLink.bot_identity,
          canonical_chat_id: this.config.canonicalChatId,
          diagnostic_code: observed.diagnosticCode,
          state: observed.providerState,
          updated_at: observedAt,
        })
        .onConflict((conflict) =>
          conflict.column("bot_identity").doUpdateSet({
            canonical_chat_id: this.config.canonicalChatId,
            diagnostic_code: observed.diagnosticCode,
            state: observed.providerState,
            updated_at: observedAt,
          }),
        )
        .execute();
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
          message_text: responseText(this.config, observed.normalizedState),
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
        providerState: observed.providerState,
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
        "membership_observations",
        "membership_observations.observation_ref",
        "membership_evidence_outbox.observation_ref",
      )
      .innerJoin(
        "platform_links",
        "platform_links.telegram_identity_ref",
        "membership_observations.telegram_identity_ref",
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
      .where("membership_evidence_outbox.observation_ref", "=", checkRef)
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
    const bot = await safeTelegramRead(() =>
      this.telegram.getBotChatMember(this.config.canonicalChatId),
    );
    if (bot.kind === "unavailable") {
      return unavailable("unavailable", bot.diagnosticCode);
    }
    if (!botHasMembershipPrerequisite(bot.value)) {
      return unavailable("degraded", "bot_administrator_required", bot.value);
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
}

interface ObservedMembership {
  readonly diagnosticCode: string | null;
  readonly normalizedState: NormalizedMembershipState;
  readonly providerState: MembershipProviderState;
  readonly rawChatMember?: TelegramChatMember;
}

function unavailable(
  providerState: "degraded" | "unavailable",
  diagnosticCode: string,
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

import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Selectable } from "kysely";
import { DATABASE, type Database } from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";
import { reserveTelegramIdentity } from "../identity-linking/stable-telegram-identity.js";
import type { VerifiedPrivateStart } from "../bot-contacts/bot-contacts.js";
import { StartResponseDeliveryQueue } from "../outbound/start-response-delivery-queue.js";
import { CommunityProvider } from "../community/community-provider.js";
import {
  ACTIVATION_PLATFORM,
  type ActivationPlatform,
} from "./activation-ports.js";
import { SourceGroupProof } from "./source-group-proof.js";
import {
  ACTIVATION_VERSION,
  type ActivationEvidence,
  type ActivationResponse,
  type ActivationResult,
} from "./activation-contract.js";
import {
  accountPrompt,
  activationMenu,
  activationMessage,
  ownAccessText,
} from "./activation-view.js";
import type { ActivationTables } from "./activation-storage.js";

type Attempt = Selectable<ActivationTables["activation_attempts"]>;
const RETENTION = 30 * 24 * 60 * 60_000;
const CADENCE = 60_000;
// A known unfinished outcome may expire. Never discard an uncertain evidence write
// or a confirmed Enrollment receipt just because the user has not returned.
const expirableAttempt = sql<boolean>`coalesce(
  (evidence is null and result is null)
  or result->>'ok' = 'false'
  or result->'value'->>'state' in ('unavailable', 'checking', 'needs_account'), false)`;
export type AccessAction = "own" | "community" | "retry" | "help" | "platform";

/** Durable Telegram continuation; Account and every grant remain Platform-owned. */
@Injectable()
export class SubscriptionActivation {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ACTIVATION_PLATFORM) private readonly platform: ActivationPlatform,
    @Inject(SourceGroupProof) private readonly proof: SourceGroupProof,
    @Inject(StartResponseDeliveryQueue)
    private readonly replies: StartResponseDeliveryQueue,
    @Inject(CommunityProvider) private readonly community: CommunityProvider,
  ) {}

  async start(
    contact: VerifiedPrivateStart,
    code: string | null,
  ): Promise<void> {
    if (!this.config.activation?.enabled || !code) {
      await this.reply(
        contact,
        "Активация по этой ссылке сейчас недоступна. Обратитесь к владельцу.",
      );
      return;
    }
    const now = this.clock.now();
    await this.db.transaction().execute(async (tx) => {
      const identity = await reserveTelegramIdentity(
        tx,
        contact.botIdentity,
        contact.telegramUserId,
      );
      await tx
        .deleteFrom("activation_attempts")
        .where("bot_identity", "=", contact.botIdentity)
        .where("telegram_user_id", "=", contact.telegramUserId)
        .where("expires_at", "<=", now)
        .where("state", "in", ["pending", "needs_account", "retry"])
        .where(expirableAttempt)
        .where((eb) =>
          eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]),
        )
        .execute();
      await tx
        .insertInto("activation_attempts")
        .values({
          attempt_id: randomUUID(),
          bot_identity: contact.botIdentity,
          telegram_user_id: contact.telegramUserId,
          private_chat_id: contact.privateChatId,
          identity_ref: identity,
          code,
          trigger_update_id: contact.updateId,
          state: "pending",
          evidence: null,
          result: null,
          created_at: now,
          expires_at: new Date(now.getTime() + RETENTION),
          due_at: now,
          lease_token: null,
          lease_until: null,
          attempts: 0,
          diagnostic_code: null,
        })
        .onConflict((c) =>
          c
            .columns(["bot_identity", "telegram_user_id", "code"])
            .doUpdateSet({ due_at: now }),
        )
        .execute();
    });
    await this.action(contact, "retry");
  }

  async action(
    contact: VerifiedPrivateStart,
    action: AccessAction,
  ): Promise<void> {
    const config = this.config.activation;
    if (!config?.enabled) {
      await this.reply(
        contact,
        "Проверка доступов пока недоступна. Обратитесь к владельцу.",
      );
      return;
    }
    if (action === "help") {
      await this.reply(
        contact,
        "Если вы купили курс, но больше не состоите в его группе, обратитесь к владельцу для ручного подтверждения. При конфликте аккаунтов мы сохраняем историю и не переносим Telegram автоматически.",
      );
      return;
    }
    if (action === "platform") {
      const prompt = accountPrompt(config.accountUrl);
      await this.replies.enqueue({
        ...this.delivery(contact, prompt.text),
        buttons: prompt.buttons,
      });
      return;
    }
    const identity = await this.db
      .transaction()
      .execute((tx) =>
        reserveTelegramIdentity(
          tx,
          contact.botIdentity,
          contact.telegramUserId,
        ),
      );
    const lookup = await this.platform.binding(identity);
    if (!lookup || !lookup.ok) {
      await this.reply(
        contact,
        lookup && !lookup.ok && lookup.error.code === "identity_conflict"
          ? "Связь аккаунта требует помощи владельца. Проверка остановлена; аккаунты не объединяются."
          : "Платформа временно не отвечает. Повторите проверку позже.",
      );
      return;
    }
    if (lookup.value.state === "unlinked") {
      const prompt = accountPrompt(config.accountUrl);
      await this.replies.enqueue({
        ...this.delivery(contact, prompt.text),
        buttons: prompt.buttons,
      });
      return;
    }
    if (lookup.value.binding.identityRef !== identity) {
      await this.reply(contact, "Связь аккаунта требует проверки владельца.");
      return;
    }
    if (action === "retry") {
      await this.db.transaction().execute(async (tx) => {
        const rows = await tx
          .selectFrom("activation_attempts")
          .selectAll()
          .where("bot_identity", "=", contact.botIdentity)
          .where("telegram_user_id", "=", contact.telegramUserId)
          .forUpdate()
          .execute();
        for (const row of rows) {
          if (row.lease_until && row.lease_until > this.clock.now()) continue;
          const fresh = row.state === "rejected" && row.result !== null;
          await tx
            .updateTable("activation_attempts")
            .set({
              state: "pending",
              expires_at: new Date(this.clock.now().getTime() + RETENTION),
              due_at: this.clock.now(),
              ...(fresh
                ? { attempt_id: randomUUID(), evidence: null, result: null }
                : {}),
            })
            .where("attempt_id", "=", row.attempt_id)
            .execute();
        }
      });
      await this.reply(
        contact,
        "Проверка запланирована. После связывания она продолжится автоматически; «Мои доступы» показывает уже действующие права.",
      );
      return;
    }
    const access = await this.platform.own(lookup.value.binding);
    if (!access?.ok) {
      await this.reply(
        contact,
        access && !access.ok && access.error.code === "identity_conflict"
          ? "Связь аккаунта требует помощи владельца. Проверка остановлена; аккаунты не объединяются."
          : "Не удалось получить актуальные доступы. Повторите проверку; аккаунт и история сохраняются.",
      );
      return;
    }
    if (action === "own") {
      await this.reply(contact, ownAccessText(access.value));
      return;
    }
    if (access.value.admission.state !== "ready") {
      await this.reply(
        contact,
        access.value.admission.admissionRestriction === "moderation" ||
          access.value.admission.admissionRestriction === "external_unknown" ||
          access.value.admission.state === "moderation_blocked"
          ? "Вступление ограничено. Обратитесь к владельцу; право на материалы сохраняется."
          : access.value.admission.state === "checking"
            ? "Состояние сообщества уточняется. Повторите запрос через минуту."
            : "Сейчас нет действующего права на сообщество.",
      );
      return;
    }
    if (this.config.communityMode !== "live") {
      await this.reply(
        contact,
        "Вступление пока не включено. Открыть материалы можно на платформе.",
      );
      return;
    }
    const admission = await this.community.admissionFor(contact.telegramUserId);
    await this.reply(
      contact,
      admission.kind === "link"
        ? `Личная ссылка на вступление (действует несколько минут):\n${admission.inviteLink}`
        : admission.kind === "member"
          ? "Вы уже участник сообщества."
          : admission.kind === "moderation_blocked"
            ? "Вступление требует проверки владельца."
            : "Готовим вступление. Повторите запрос через минуту.",
    );
  }

  async processAvailable(limit = 10): Promise<void> {
    if (!this.config.activation?.enabled) return;
    for (let index = 0; index < limit; index++) {
      const now = this.clock.now();
      const attempt = await this.db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("activation_attempts")
          .selectAll()
          .where("bot_identity", "=", this.config.botIdentity)
          .where("state", "in", ["pending", "needs_account", "retry"])
          .where("due_at", "<=", now)
          .where((eb) =>
            eb.or([eb("expires_at", ">", now), eb.not(expirableAttempt)]),
          )
          .where((eb) =>
            eb.or([
              eb("lease_until", "is", null),
              eb("lease_until", "<=", now),
            ]),
          )
          .orderBy("due_at")
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return;
        const lease = randomUUID();
        await tx
          .updateTable("activation_attempts")
          .set({
            lease_token: lease,
            lease_until: new Date(now.getTime() + CADENCE),
            attempts: row.attempts + 1,
          })
          .where("attempt_id", "=", row.attempt_id)
          .execute();
        return { ...row, lease_token: lease };
      });
      if (!attempt) break;
      try {
        await this.process(attempt);
      } catch {
        await this.defer(attempt, "worker_unavailable");
      }
    }
    await this.db
      .deleteFrom("activation_attempts")
      .where("bot_identity", "=", this.config.botIdentity)
      .where("expires_at", "<=", this.clock.now())
      .where("state", "in", ["pending", "needs_account", "retry"])
      .where(expirableAttempt)
      .where((eb) =>
        eb.or([
          eb("lease_until", "is", null),
          eb("lease_until", "<=", this.clock.now()),
        ]),
      )
      .execute();
  }

  private async process(attempt: Attempt): Promise<void> {
    // An uncertain write is replayed byte-for-byte before considering new source evidence.
    if (attempt.evidence && attempt.result === null) {
      const replay = await this.platform.evidence(attempt.evidence);
      if (!replay) {
        await this.defer(attempt, "evidence_response_unknown");
        return;
      }
      if (!replay.ok && replay.error.code === "identity_conflict") {
        await this.finish(attempt, replay);
        return;
      }
      if (
        replay.ok ||
        (!["revision_conflict", "invalid_input"].includes(replay.error.code) &&
          !(
            replay.error.code === "source_not_confirmed" &&
            Date.parse(attempt.evidence.validUntil) <=
              this.clock.now().getTime()
          ))
      ) {
        await this.finish(attempt, replay);
        return;
      }
      const expired = attempt.expires_at <= this.clock.now();
      await this.db
        .updateTable("activation_attempts")
        .set({
          evidence: null,
          ...(expired ? { lease_token: null, lease_until: null } : {}),
        })
        .where("attempt_id", "=", attempt.attempt_id)
        .where("lease_token", "=", attempt.lease_token)
        .execute();
      if (expired) return; // The uncertain write is resolved; do not start fresh proof after retention.
    }
    if (
      attempt.result !== null &&
      (attempt.result.ok
        ? ["unavailable", "checking", "needs_account"].includes(
            attempt.result.value.state,
          )
        : attempt.result.error.code === "unavailable")
    ) {
      await this.db
        .updateTable("activation_attempts")
        .set({
          attempt_id: randomUUID(),
          evidence: null,
          result: null,
          state: "pending",
          lease_token: null,
          lease_until: null,
          due_at: this.clock.now(),
        })
        .where("attempt_id", "=", attempt.attempt_id)
        .where("lease_token", "=", attempt.lease_token)
        .execute();
      return;
    }
    const begun = await this.platform.begin({
      contractVersion: ACTIVATION_VERSION,
      attemptId: attempt.attempt_id,
      code: attempt.code,
      identityRef: attempt.identity_ref,
    });
    if (!begun) {
      await this.defer(attempt, "platform_unavailable");
      return;
    }
    if (!begun.ok) {
      await this.finish(attempt, begun);
      return;
    }
    if (
      begun.value.attemptId === attempt.attempt_id &&
      ["active", "already_active"].includes(begun.value.state)
    ) {
      await this.finish(attempt, begun);
      return;
    }
    if (begun.value.attemptId !== attempt.attempt_id || !begun.value.rule) {
      await this.defer(attempt, "invalid_attempt_response");
      return;
    }
    const lookup = await this.platform.binding(attempt.identity_ref);
    if (!lookup || !lookup.ok) {
      if (lookup && !lookup.ok && lookup.error.code === "identity_conflict")
        await this.finish(attempt, lookup);
      else await this.defer(attempt, "binding_unavailable");
      return;
    }
    if (lookup.value.state === "unlinked") {
      await this.defer(attempt, "needs_account", "needs_account");
      return;
    }
    const binding = lookup.value.binding;
    if (binding.identityRef !== attempt.identity_ref) {
      await this.finish(attempt, {
        ok: false,
        error: { code: "identity_conflict" },
      });
      return;
    }
    const rule = begun.value.rule;
    const checkedAt = this.clock.now();
    const proof = await this.proof.check(
      rule.sourceRef,
      binding.identityRef,
      attempt.telegram_user_id,
    );
    const evidence: ActivationEvidence = {
      contractVersion: ACTIVATION_VERSION,
      audience: "inside.platform.subscription-activation",
      evidenceRef: randomUUID(),
      attemptId: attempt.attempt_id,
      sourceRef: rule.sourceRef,
      ...binding,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      checkedAt: checkedAt.toISOString(),
      validUntil: new Date(checkedAt.getTime() + 300_000).toISOString(),
      decision: proof.decision,
    };
    const persisted = await this.db
      .updateTable("activation_attempts")
      .set({ evidence, result: null })
      .where("attempt_id", "=", attempt.attempt_id)
      .where("lease_token", "=", attempt.lease_token)
      .where("lease_until", ">", this.clock.now())
      .returning("attempt_id")
      .executeTakeFirst();
    if (!persisted) return;
    const response = await this.platform.evidence(evidence);
    if (!response) {
      await this.defer(attempt, "evidence_response_unknown");
      return;
    }
    await this.finish(
      attempt,
      response,
      Math.max(CADENCE, (proof.retryAfterSeconds ?? 0) * 1000),
    );
  }

  private async finish(
    attempt: Attempt,
    result: ActivationResult<ActivationResponse>,
    delay = CADENCE,
  ): Promise<void> {
    if (result.ok && result.value.attemptId !== attempt.attempt_id) {
      await this.defer(attempt, "invalid_attempt_response");
      return;
    }
    const retry = result.ok
      ? ["unavailable", "checking", "needs_account"].includes(
          result.value.state,
        )
      : result.error.code === "unavailable";
    await this.db.transaction().execute(async (tx) => {
      const stored = await tx
        .updateTable("activation_attempts")
        .set({
          result,
          state: retry
            ? "retry"
            : result.ok &&
                ["active", "already_active"].includes(result.value.state)
              ? "completed"
              : "rejected",
          due_at: new Date(this.clock.now().getTime() + delay),
          lease_token: null,
          lease_until: null,
          diagnostic_code: result.ok ? null : result.error.code,
        })
        .where("attempt_id", "=", attempt.attempt_id)
        .where("lease_token", "=", attempt.lease_token)
        .returning("attempt_id")
        .executeTakeFirst();
      if (!stored) return;
      await this.replies.enqueue(
        {
          ...this.delivery(this.contact(attempt), activationMessage(result)),
          sourceKey: `activation:${createHash("sha256")
            .update(
              JSON.stringify([
                attempt.identity_ref,
                attempt.code,
                attempt.created_at.toISOString(),
              ]),
            )
            .digest(
              "hex",
            )}:${result.ok ? result.value.state : result.error.code}`,
          buttons: activationMenu(this.config.activation!.accountUrl),
        },
        tx,
      );
    });
  }
  private async defer(
    attempt: Attempt,
    code: string,
    state: "retry" | "needs_account" = "retry",
  ): Promise<void> {
    await this.db
      .updateTable("activation_attempts")
      .set({
        state,
        diagnostic_code: code,
        lease_token: null,
        lease_until: null,
        due_at: new Date(this.clock.now().getTime() + CADENCE),
      })
      .where("attempt_id", "=", attempt.attempt_id)
      .where("lease_token", "=", attempt.lease_token)
      .execute();
  }
  private contact(attempt: Attempt): VerifiedPrivateStart {
    return {
      botIdentity: attempt.bot_identity,
      telegramUserId: attempt.telegram_user_id,
      privateChatId: attempt.private_chat_id,
      updateId: attempt.trigger_update_id,
      observedAt: this.clock.now(),
    };
  }
  private delivery(contact: VerifiedPrivateStart, messageText: string) {
    return {
      botIdentity: contact.botIdentity,
      telegramUserId: contact.telegramUserId,
      privateChatId: contact.privateChatId,
      triggerUpdateId: contact.updateId,
      now: this.clock.now(),
      sourceKey: `access:${contact.botIdentity}:${contact.updateId}`,
      messageText,
    };
  }
  private async reply(
    contact: VerifiedPrivateStart,
    text: string,
  ): Promise<void> {
    await this.replies.enqueue({
      ...this.delivery(contact, text),
      ...(this.config.activation
        ? { buttons: activationMenu(this.config.activation.accountUrl) }
        : {}),
    });
  }
  async snapshot(): Promise<{ pending: number; oldestSeconds: number }> {
    const result = await sql<{
      count: string;
      oldest: Date | null;
    }>`select count(*)::text as count, min(created_at) as oldest from activation_attempts where bot_identity=${this.config.botIdentity} and state in ('pending','needs_account','retry')`.execute(
      this.db,
    );
    return {
      pending: Number(result.rows[0]?.count ?? 0),
      oldestSeconds: result.rows[0]?.oldest
        ? Math.max(
            0,
            (this.clock.now().getTime() - result.rows[0].oldest.getTime()) /
              1000,
          )
        : 0,
    };
  }
}

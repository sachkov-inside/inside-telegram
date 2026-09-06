import { lockTelegramIdentity } from "../identity-linking/identity-link-account-lock.js";
import { createHash, randomInt, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { DATABASE, type Database } from "../../database/database.js";
import { credentialsMatch } from "../../security/credentials.js";
import type { VerifiedPrivateStart } from "../bot-contacts/bot-contacts.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";

export interface RegisterSignIn {
  readonly requestRef: string;
  readonly startTokenDigest: string;
  readonly browserSecretDigest: string;
  readonly expiresAt: Date;
}

export interface VerifiedSignInDecision {
  readonly botIdentity: string;
  readonly telegramUserId: string;
  readonly privateChatId: string;
  readonly requestRef: string;
  readonly decision: "approve" | "deny";
}

export type SignInResult =
  | {
      readonly status:
        | "disabled"
        | "unavailable"
        | "pending"
        | "approved"
        | "denied"
        | "expired"
        | "consumed";
    }
  | {
      readonly status: "registered";
      readonly confirmationCode: string;
      readonly expiresAt: string;
    }
  | {
      readonly status: "verified";
      readonly subjectRef: string;
      readonly approvedAt: string;
      readonly existingLink: {
        readonly accountRef: string;
        readonly telegramIdentityRef: string;
      } | null;
    };

export class MalformedSignInRequestError extends Error {}

/** Proves a private Telegram identity; never creates an Account or a website session. */
@Injectable()
export class BotSignIn {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async register(request: RegisterSignIn): Promise<SignInResult> {
    if (!this.config.signInEnabled) return { status: "disabled" };
    const now = this.clock.now();
    if (
      !isRequestRef(request.requestRef) ||
      !isDigest(request.startTokenDigest) ||
      !isDigest(request.browserSecretDigest) ||
      request.startTokenDigest === request.browserSecretDigest ||
      !Number.isFinite(request.expiresAt.getTime()) ||
      request.expiresAt <= now ||
      request.expiresAt.getTime() - now.getTime() > 300_000
    ) {
      throw new MalformedSignInRequestError();
    }
    await this.database
      .insertInto("sign_in_requests")
      .values({
        request_ref: request.requestRef,
        bot_identity: this.config.botIdentity,
        start_token_digest: request.startTokenDigest,
        browser_secret_digest: request.browserSecretDigest,
        confirmation_code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
        state: "pending",
        telegram_user_id: null,
        private_chat_id: null,
        created_at: now,
        expires_at: request.expiresAt,
        approved_at: null,
        consumed_at: null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const saved = await this.database
      .selectFrom("sign_in_requests")
      .selectAll()
      .where("request_ref", "=", request.requestRef)
      .executeTakeFirst();
    if (
      !saved ||
      saved.bot_identity !== this.config.botIdentity ||
      saved.start_token_digest !== request.startTokenDigest ||
      saved.browser_secret_digest !== request.browserSecretDigest ||
      saved.expires_at.getTime() !== request.expiresAt.getTime()
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "registered",
      confirmationCode: saved.confirmation_code,
      expiresAt: saved.expires_at.toISOString(),
    };
  }

  async acceptStart(
    contact: VerifiedPrivateStart,
    tokenDigest: string,
  ): Promise<void> {
    if (
      !this.config.signInEnabled ||
      contact.botIdentity !== this.config.botIdentity ||
      !isDigest(tokenDigest)
    )
      return;
    await this.database.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("sign_in_requests")
        .selectAll()
        .where("start_token_digest", "=", tokenDigest)
        .where("bot_identity", "=", contact.botIdentity)
        .forUpdate()
        .executeTakeFirst();
      const now = this.clock.now();
      if (!request || request.state !== "pending" || request.expires_at <= now)
        return;
      await transaction
        .updateTable("sign_in_requests")
        .set({
          state: "awaiting_approval",
          telegram_user_id: contact.telegramUserId,
          private_chat_id: contact.privateChatId,
        })
        .where("request_ref", "=", request.request_ref)
        .execute();
      // Commit the prompt with the identity receipt. Inbox retries cannot reassign it or enqueue another prompt.
      await transaction
        .insertInto("start_response_deliveries")
        .values({
          attempt_count: 0,
          available_at: now,
          bot_identity: contact.botIdentity,
          created_at: now,
          delivered_at: null,
          diagnostic_code: null,
          locked_at: null,
          message_text: `Вход в Sachkov Inside. Код запроса: ${request.confirmation_code}.\n\nСравните код с исходной вкладкой сайта. Подтверждайте только вход, который вы начали сами. Не подтверждайте запрос по чужой ссылке. После подтверждения вернитесь в исходную вкладку.`,
          private_chat_id: contact.privateChatId,
          source_key: `sign-in:${request.request_ref}`,
          state: "pending",
          telegram_user_id: contact.telegramUserId,
          trigger_update_id: contact.updateId,
          updated_at: now,
          sign_in_request_ref: request.request_ref,
        })
        .execute();
    });
  }

  async decide(decision: VerifiedSignInDecision): Promise<void> {
    if (
      !this.config.signInEnabled ||
      !isRequestRef(decision.requestRef) ||
      decision.botIdentity !== this.config.botIdentity
    )
      return;
    await this.database.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("sign_in_requests")
        .selectAll()
        .where("request_ref", "=", decision.requestRef)
        .forUpdate()
        .executeTakeFirst();
      const now = this.clock.now();
      if (
        !request ||
        request.bot_identity !== decision.botIdentity ||
        request.telegram_user_id !== decision.telegramUserId ||
        request.private_chat_id !== decision.privateChatId ||
        request.state !== "awaiting_approval" ||
        request.expires_at <= now
      )
        return;
      await transaction
        .updateTable("sign_in_requests")
        .set({
          state: decision.decision === "approve" ? "approved" : "denied",
          approved_at: decision.decision === "approve" ? now : null,
        })
        .where("request_ref", "=", decision.requestRef)
        .execute();
    });
  }

  async inspect(
    requestRef: string,
    browserSecret: string,
    consume = false,
  ): Promise<SignInResult> {
    if (!this.config.signInEnabled) return { status: "disabled" };
    if (!isRequestRef(requestRef) || !isDigest(browserSecret))
      return { status: "unavailable" };
    return this.database
      .transaction()
      .execute(async (transaction): Promise<SignInResult> => {
        const request = await transaction
          .selectFrom("sign_in_requests")
          .selectAll()
          .where("request_ref", "=", requestRef)
          .forUpdate()
          .executeTakeFirst();
        const now = this.clock.now();
        if (
          !request ||
          request.bot_identity !== this.config.botIdentity ||
          !credentialsMatch(
            digestSignInSecret(browserSecret),
            request.browser_secret_digest,
          )
        )
          return { status: "unavailable" };
        if (request.expires_at <= now) return { status: "expired" };
        if (
          request.state === "pending" ||
          request.state === "awaiting_approval"
        )
          return { status: "pending" };
        if (request.state !== "approved") return { status: request.state };
        if (!consume) return { status: "approved" };
        if (!request.telegram_user_id || !request.approved_at)
          return { status: "unavailable" };
        await lockTelegramIdentity(
          transaction,
          request.bot_identity,
          request.telegram_user_id,
        );
        await transaction
          .insertInto("sign_in_subjects")
          .values({
            subject_ref: randomUUID(),
            bot_identity: request.bot_identity,
            telegram_user_id: request.telegram_user_id,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        const subject = await transaction
          .selectFrom("sign_in_subjects")
          .select("subject_ref")
          .where("bot_identity", "=", request.bot_identity)
          .where("telegram_user_id", "=", request.telegram_user_id)
          .executeTakeFirstOrThrow();
        const link = await transaction
          .selectFrom("platform_links")
          .select(["account_ref", "telegram_identity_ref"])
          .where("bot_identity", "=", request.bot_identity)
          .where("telegram_user_id", "=", request.telegram_user_id)
          .executeTakeFirst();
        if (!link) {
          // Approval of independent registration reserves this subject even if the browser loses
          // the consume response. A fresh bot sign-in can repair it; email linking cannot take it.
          await transaction
            .updateTable("sign_in_subjects")
            .set({ reserved_for_sign_in: true })
            .where("subject_ref", "=", subject.subject_ref)
            .execute();
        }
        await transaction
          .updateTable("sign_in_requests")
          .set({ state: "consumed", consumed_at: now })
          .where("request_ref", "=", requestRef)
          .execute();
        return {
          status: "verified",
          subjectRef: subject.subject_ref,
          approvedAt: request.approved_at.toISOString(),
          existingLink: link
            ? {
                accountRef: link.account_ref,
                telegramIdentityRef: link.telegram_identity_ref,
              }
            : null,
        };
      });
  }
}

export function isRequestRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isDigest(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function digestSignInSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

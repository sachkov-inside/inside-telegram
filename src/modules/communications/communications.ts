import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Transaction } from "kysely";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import type { TemplateIntake } from "../../adapters/telegram/grammy-template-intake.adapter.js";
import {
  AUTHOR_AUTHORIZATION,
  type AuthorAuthorization,
  type AuthorSubject,
} from "./author-authorization.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
  type TemplateSnapshot,
  type TemplateContent,
  validateContent,
} from "./communications-contract.js";

@Injectable()
export class Communications {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(AUTHOR_AUTHORIZATION)
    private readonly authorization: AuthorAuthorization,
  ) {}

  async execute(request: CommunicationsRequest): Promise<TemplateSnapshot> {
    if (!("accountRef" in request.actor))
      throw new CommunicationsError("not_implemented");
    const actor = request.actor;
    await this.requireAuthor({ kind: "account", ...actor });
    if (
      request.operation !== "templates.save" &&
      request.operation !== "templates.read"
    )
      throw new CommunicationsError("not_implemented");
    const templateId = request.payload.templateId!;
    if (request.operation === "templates.save")
      validateContent(request.payload.content);
    return this.database.transaction().execute(async (tx) => {
      await lock(
        tx,
        `communications-operation:${this.config.botIdentity}:${request.operationId}`,
      );
      const prior = await tx
        .selectFrom("communication_operations")
        .selectAll()
        .where("bot_identity", "=", this.config.botIdentity)
        .where("operation_id", "=", request.operationId)
        .executeTakeFirst();
      if (prior) {
        if (
          prior.actor_account_ref !== actor.accountRef ||
          !isDeepStrictEqual(prior.request, request)
        )
          throw new CommunicationsError("operation_conflict");
        return prior.result as TemplateSnapshot;
      }
      await lock(tx, `communications-template:${templateId}`);
      const existing = await tx
        .selectFrom("communication_templates")
        .selectAll()
        .where("template_id", "=", templateId)
        .executeTakeFirst();
      if (
        existing &&
        (existing.owner_account_ref !== actor.accountRef ||
          existing.bot_identity !== this.config.botIdentity)
      )
        throw new CommunicationsError("not_found");
      if (request.operation === "templates.read") {
        if (!existing) throw new CommunicationsError("not_found");
        return {
          templateId,
          revision: existing.revision,
          botIdentity: existing.bot_identity,
          content: existing.content as TemplateContent,
        };
      }
      if ((existing?.revision ?? 0) !== request.expectedRevision)
        throw new CommunicationsError("revision_conflict");
      const now = new Date();
      const result: TemplateSnapshot = {
        templateId,
        revision: (existing?.revision ?? 0) + 1,
        botIdentity: this.config.botIdentity,
        content: request.payload.content!,
      };
      await tx
        .insertInto("communication_templates")
        .values({
          template_id: templateId,
          bot_identity: this.config.botIdentity,
          owner_account_ref: actor.accountRef,
          revision: result.revision,
          content: JSON.stringify(result.content),
          created_at: now,
          updated_at: now,
        })
        .onConflict((c) =>
          c.column("template_id").doUpdateSet({
            revision: result.revision,
            content: JSON.stringify(result.content),
            updated_at: now,
          }),
        )
        .execute();
      await tx
        .insertInto("communication_operations")
        .values({
          bot_identity: this.config.botIdentity,
          operation_id: request.operationId,
          actor_account_ref: actor.accountRef,
          request: JSON.stringify(request),
          result: JSON.stringify(result),
          created_at: now,
        })
        .execute();
      return result;
    });
  }

  async intake(input: TemplateIntake): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await lock(
        tx,
        `communications-intake:${input.botIdentity}:${input.telegramUserId}`,
      );
      const prior = await tx
        .selectFrom("communication_intake_receipts")
        .select("outcome")
        .where("bot_identity", "=", input.botIdentity)
        .where("update_id", "=", input.updateId)
        .executeTakeFirst();
      if (prior) return;
      // A second worker must not overtake an earlier command/media update for this sender.
      const earlier = await tx
        .selectFrom("telegram_updates")
        .select("update_id")
        .where("bot_identity", "=", input.botIdentity)
        .where("update_id", "<", input.updateId)
        .where("state", "in", ["pending", "processing"])
        .where(
          sql<boolean>`payload->'message'->'from'->>'id' = ${input.telegramUserId}`,
        )
        .executeTakeFirst();
      if (earlier) throw new Error("Earlier author update is still pending");
      const mode = await tx
        .selectFrom("communication_author_modes")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("telegram_user_id", "=", input.telegramUserId)
        .executeTakeFirst();
      if (
        input.action === "capture" &&
        (!mode?.enabled ||
          BigInt(input.updateId) <= BigInt(mode.last_update_id))
      ) {
        await receipt(tx, input, "outside_author_mode");
        return;
      }
      if (input.action === "close") {
        await tx
          .deleteFrom("communication_author_modes")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
        await receipt(tx, input, "closed");
        await reply(tx, input, "Режим заготовки закрыт.");
        return;
      }
      // Hold the persisted link against exceptional transfer until the authorization decision and save commit.
      const link = await tx
        .selectFrom("platform_links")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("telegram_user_id", "=", input.telegramUserId)
        .forShare()
        .executeTakeFirst();
      const permission = link
        ? await this.authorization.authorize({
            kind: "telegram",
            accountRef: link.account_ref,
            telegramIdentityRef: link.telegram_identity_ref,
            botIdentity: input.botIdentity,
          })
        : "denied";
      if (permission === "unavailable")
        throw new CommunicationsError("authorization_unavailable");
      if (
        permission !== "allowed" ||
        !link ||
        (input.action === "capture" && mode?.account_ref !== link.account_ref)
      ) {
        await tx
          .deleteFrom("communication_author_modes")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
        await receipt(tx, input, "forbidden");
        await reply(
          tx,
          input,
          "Нет доступа к авторским заготовкам. Проверьте связь с аккаунтом и разрешение на платформе.",
        );
        return;
      }
      if (input.action === "open") {
        await tx
          .insertInto("communication_author_modes")
          .values({
            bot_identity: input.botIdentity,
            telegram_user_id: input.telegramUserId,
            account_ref: link.account_ref,
            enabled: true,
            last_update_id: input.updateId,
          })
          .onConflict((c) =>
            c.columns(["bot_identity", "telegram_user_id"]).doUpdateSet({
              account_ref: link.account_ref,
              enabled: true,
              last_update_id: input.updateId,
            }),
          )
          .execute();
        await receipt(tx, input, "opened");
        await reply(
          tx,
          input,
          "Пришлите текст, фото, видео, кружок, голосовое сообщение или документ. /cancel — выйти.",
        );
        return;
      }
      try {
        validateContent(input.content);
      } catch (error) {
        if (!(error instanceof CommunicationsError)) throw error;
        await receipt(tx, input, "unsupported_content");
        await reply(
          tx,
          input,
          "Не удалось сохранить: формат или оформление не поддерживается. Альбомы и опросы не принимаются. Пришлите отдельное сообщение.",
        );
        return;
      }
      const templateId = randomUUID();
      const now = new Date();
      await tx
        .insertInto("communication_templates")
        .values({
          template_id: templateId,
          bot_identity: input.botIdentity,
          owner_account_ref: link.account_ref,
          revision: 1,
          content: JSON.stringify(input.content),
          created_at: now,
          updated_at: now,
        })
        .execute();
      await tx
        .deleteFrom("communication_author_modes")
        .where("bot_identity", "=", input.botIdentity)
        .where("telegram_user_id", "=", input.telegramUserId)
        .execute();
      await receipt(tx, input, "saved", templateId);
      await reply(
        tx,
        input,
        `Заготовка сохранена: ${templateId}\nВставьте ID в редактор на платформе. /template — новая заготовка.`,
      );
    });
  }
  private async requireAuthor(subject: AuthorSubject): Promise<void> {
    const result = await this.authorization.authorize(subject);
    if (result !== "allowed")
      throw new CommunicationsError(
        result === "denied" ? "forbidden" : "authorization_unavailable",
      );
  }
}
async function lock(tx: Transaction<DatabaseSchema>, key: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
    tx,
  );
}
async function receipt(
  tx: Transaction<DatabaseSchema>,
  input: TemplateIntake,
  outcome: string,
  templateId: string | null = null,
) {
  await tx
    .insertInto("communication_intake_receipts")
    .values({
      bot_identity: input.botIdentity,
      update_id: input.updateId,
      outcome,
      template_id: templateId,
    })
    .execute();
}
async function reply(
  tx: Transaction<DatabaseSchema>,
  input: TemplateIntake,
  text: string,
) {
  const now = new Date();
  await tx
    .insertInto("start_response_deliveries")
    .values({
      attempt_count: 0,
      available_at: now,
      bot_identity: input.botIdentity,
      created_at: now,
      delivered_at: null,
      diagnostic_code: null,
      locked_at: null,
      message_text: text,
      private_chat_id: input.privateChatId,
      source_key: `communications-intake:${input.botIdentity}:${input.updateId}`,
      state: "pending",
      telegram_user_id: input.telegramUserId,
      trigger_update_id: null,
      updated_at: now,
    })
    .execute();
}

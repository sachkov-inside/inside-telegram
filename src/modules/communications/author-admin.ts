import {
  AuthorComposer,
  type ComposerState,
  type ComposerResult,
  type MessageDestination,
} from "./author-composer.js";
import {
  AuthorBroadcastDrafts,
  broadcastNames,
  newBroadcast,
  retainBroadcast,
} from "./author-broadcast-drafts.js";
import { retainFunnelDraft } from "./author-drafts.js";
import { messageLabel, previewAuthorMessage } from "./author-message-view.js";
import { AuthorFunnels, type AuthorFunnelState } from "./author-funnels.js";
import { authorRequest } from "./author-request.js";
import { randomUUID } from "node:crypto";
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
import type { AuthorInput } from "../../adapters/telegram/grammy-author-admin.adapter.js";
import {
  AUTHOR_AUTHORIZATION,
  type AuthorAuthorization,
} from "./author-authorization.js";
import { Communications } from "./communications.js";
import { Funnels } from "./funnels.js";
import { AuthorDelivery, enqueueAuthorMessage } from "./author-delivery.js";
import {
  CommunicationsError,
  validateContent,
  type CommunicationsRequest,
  type TemplateSnapshot,
} from "./communications-contract.js";
import type { broadcastView } from "./broadcasts.js";
import { communicationLock } from "./communication-state.js";

type Broadcast = ReturnType<typeof broadcastView>;
export type Action = { kind: string; id?: string; value?: string };
export type State = {
  composing?: ComposerState;
  broadcastName?: string;
  libraryQuery?: string;
  token: string;
  actions: Action[];
  funnelAuthor?: AuthorFunnelState;
  template?: TemplateSnapshot;
  broadcast?: Broadcast;
  prompt?:
    | "capture"
    | "replace"
    | "button-title"
    | "button-url"
    | "button-row"
    | "schedule"
    | "broadcast-name"
    | "post-search";
  replacePart?: { broadcastId: string; partId: string };
  buttonTitle?: string;
  buttonUrl?: string;
};
type Tx = Transaction<DatabaseSchema>;
export type Context = {
  tx: Tx;
  input: AuthorInput;
  accountRef: string;
  identityRef: string;
  state: State;
};
const home: [string, Action][] = [
  ["Рассылки", { kind: "broadcasts" }],
  ["Воронки", { kind: "f:list" }],
  ["Статистика", { kind: "overview" }],
  ["Создать пост", { kind: "new" }],
  ["Мои посты", { kind: "posts" }],
];

@Injectable()
export class AuthorAdmin {
  private readonly composer: AuthorComposer;
  private readonly broadcastDrafts: AuthorBroadcastDrafts;
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(AUTHOR_AUTHORIZATION)
    private readonly authorization: AuthorAuthorization,
    @Inject(Communications) private readonly posts: Communications,
    @Inject(Funnels) private readonly funnels: Funnels,
    @Inject(AuthorDelivery) private readonly delivery: AuthorDelivery,
    @Inject(AuthorFunnels) private readonly authorFunnels: AuthorFunnels,
  ) {
    this.composer = new AuthorComposer(posts);
    this.broadcastDrafts = new AuthorBroadcastDrafts(funnels);
  }
  async handle(input: AuthorInput): Promise<boolean> {
    if (input.botIdentity !== this.config.botIdentity) return false;
    return this.database.transaction().execute(async (tx) => {
      await communicationLock(
        tx,
        `communications-intake:${input.botIdentity}:${input.telegramUserId}`,
      );
      const previous = await tx
        .selectFrom("communication_author_receipts")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("update_id", "=", input.updateId)
        .executeTakeFirst();
      if (previous) return true;
      const session = await tx
        .selectFrom("communication_author_sessions")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("telegram_user_id", "=", input.telegramUserId)
        .executeTakeFirst();
      if (/^\/template(?:@[A-Za-z0-9_]+)?$/.test(input.text)) {
        await tx
          .deleteFrom("communication_author_sessions")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
        return false;
      }
      const open = /^\/admin(?:@[A-Za-z0-9_]+)?$/.test(input.text);
      const close = /^\/cancel(?:@[A-Za-z0-9_]+)?$/.test(input.text);
      if (
        !open &&
        !input.callbackData &&
        (!session || (!close && /^\//.test(input.text)))
      )
        return false;
      const earlier = await tx
        .selectFrom("telegram_updates")
        .select("update_id")
        .where("bot_identity", "=", input.botIdentity)
        .where("update_id", "<", input.updateId)
        .where("state", "in", ["pending", "processing"])
        .where(
          sql<boolean>`coalesce(payload->'callback_query'->'from'->>'id', payload->'message'->'from'->>'id') = ${input.telegramUserId}`,
        )
        .executeTakeFirst();
      if (earlier) throw new Error("Earlier author update is still pending");
      const link = await tx
        .selectFrom("platform_links")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("telegram_user_id", "=", input.telegramUserId)
        .forShare()
        .executeTakeFirst();
      const allowed = link
        ? await this.authorization.authorize({
            kind: "telegram",
            accountRef: link.account_ref,
            telegramIdentityRef: link.telegram_identity_ref,
            botIdentity: input.botIdentity,
          })
        : "denied";
      if (allowed === "unavailable")
        throw new CommunicationsError("authorization_unavailable");
      if (
        allowed !== "allowed" ||
        !link ||
        (!open && session && session.account_ref !== link.account_ref)
      ) {
        await tx
          .deleteFrom("communication_author_sessions")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
        // Use the ordinary reply queue for a denial without exposing any author data.
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
            message_text:
              "Нет доступа к админке. Свяжите Telegram с аккаунтом, которому разрешено управление рассылками.",
            private_chat_id: input.telegramUserId,
            source_key: `author-denied:${input.botIdentity}:${input.updateId}`,
            state: "pending",
            telegram_user_id: input.telegramUserId,
            trigger_update_id: null,
            updated_at: now,
          })
          .execute();
      } else {
        const context: Context = {
          tx,
          input,
          accountRef: link.account_ref,
          identityRef: link.telegram_identity_ref,
          state: open ? empty() : ((session?.state as State) ?? empty()),
        };
        if (close && context.state.composing) {
          await this.composeResult(
            context,
            await this.composer.act(
              context,
              { kind: "compose:cancel" },
              (text, buttons) => this.reply(context, text, buttons),
            ),
          );
        } else if (open || close) {
          context.state = empty();
          await this.reply(
            context,
            "Админка коммуникаций. Текст и медиа готовьте здесь, в Telegram.",
            home,
          );
        } else if (input.callbackData) {
          const [, token, index] = input.callbackData.split(":");
          const action =
            token === context.state.token && /^\d+$/.test(index ?? "")
              ? context.state.actions[Number(index)]
              : undefined;
          if (!action) {
            context.state = empty();
            await this.reply(
              context,
              "Это меню уже устарело. Откройте пост, рассылку или воронку заново.",
              home,
            );
          } else await this.act(context, action);
        } else {
          try {
            await this.answer(context);
          } catch (error) {
            if (
              !(error instanceof CommunicationsError) ||
              ![
                "revision_conflict",
                "malformed",
                "unsupported_content",
                "not_found",
              ].includes(error.code)
            )
              throw error;
            context.state = empty();
            await this.reply(
              context,
              "Данные изменились. Откройте актуальный пост, рассылку или воронку и повторите правку.",
              home,
            );
          }
        }
        await retainFunnelDraft(context);
        await tx
          .insertInto("communication_author_sessions")
          .values({
            bot_identity: input.botIdentity,
            telegram_user_id: input.telegramUserId,
            account_ref: link.account_ref,
            state: JSON.stringify(context.state),
          })
          .onConflict((c) =>
            c.columns(["bot_identity", "telegram_user_id"]).doUpdateSet({
              account_ref: link.account_ref,
              state: JSON.stringify(context.state),
            }),
          )
          .execute();
        await tx
          .deleteFrom("communication_author_modes")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
      }
      await tx
        .insertInto("communication_author_receipts")
        .values({
          bot_identity: input.botIdentity,
          update_id: input.updateId,
        })
        .execute();
      return true;
    });
  }
  private request(
    c: Context,
    operation: string,
    payload: CommunicationsRequest["payload"],
    revision = 0,
  ): CommunicationsRequest {
    return authorRequest(c.accountRef, operation, payload, revision);
  }

  private async reply(
    c: Context,
    text: string,
    buttons: [string, Action][] = [["В меню", { kind: "home" }]],
  ) {
    c.state.token = randomUUID();
    c.state.actions = buttons.map(([, action]) => action);
    await enqueueAuthorMessage(c.tx, {
      deliveryId: randomUUID(),
      botIdentity: c.input.botIdentity,
      accountRef: c.accountRef,
      telegramUserId: c.input.telegramUserId,
      telegramIdentityRef: c.identityRef,
      message: {
        chatId: c.input.telegramUserId,
        content: { type: "text", text, entities: [], buttons: [] },
        authorButtons: buttons.map(([label], index) => ({
          text: label,
          callbackData: `author:${c.state.token}:${index}`,
        })),
      },
    });
  }
  private async post(c: Context) {
    const t = c.state.template!;
    c.state.prompt = undefined;
    await this.reply(
      c,
      `Пост · версия ${t.revision}\n${t.content.type} · ${t.content.buttons.length} кнопок\n${t.content.text.slice(0, 500) || "Медиа без подписи"}`,
      [
        ["Образец себе", { kind: "sample" }],
        ["Заменить сообщение", { kind: "replace" }],
        ["Добавить кнопку", { kind: "button" }],
        ...t.content.buttons.map((b, i): [string, Action] => [
          `Удалить: ${b.text}`,
          { kind: "remove-button", value: String(i) },
        ]),
        ["Создать рассылку", { kind: "create-broadcast" }],
        ["Мои посты", { kind: "posts" }],
      ],
    );
  }
  private async broadcast(c: Context) {
    c.state.replacePart = undefined;
    const b = c.state.broadcast!;
    c.state.prompt = undefined;
    const editable =
      !b.audienceSnapshotId &&
      ["draft", "scheduled", "paused"].includes(b.state);
    await this.reply(
      c,
      `${c.state.broadcastName ?? "Рассылка"}\n${broadcastNames[b.state]} · версия ${b.revision}\n${b.parts.length} сообщений\nАудитория: ${b.audience.kind === "all" ? "все доступные контакты" : `${b.audience.funnelIds.length} воронок (без дублей)`}\nВремя: ${b.scheduledAt ? new Date(b.scheduledAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " (Москва, UTC+3)" : "сразу после запуска"}\nКонтактов при запуске: ${b.snapshotSize}\n${b.parts.map((p, i) => `${i + 1}. ${messageLabel(p.content, 100)}`).join("\n")}`,
      [
        ["Образцы себе", { kind: "broadcast-sample" }],
        ...(editable
          ? ([
              ["Создать сообщение", { kind: "compose:broadcast" }],
              ["Добавить сохранённый пост", { kind: "pick-part" }],
              ["Название", { kind: "rename-broadcast" }],
              ["Сообщения и порядок", { kind: "parts" }],
              ["Аудитория", { kind: "audience" }],
              ["Время отправки", { kind: "schedule" }],
            ] as [string, Action][])
          : []),
        ...(b.state === "draft" && b.parts.length > 0
          ? ([["Перейти к запуску", { kind: "confirm-launch" }]] as [
              string,
              Action,
            ][])
          : []),
        ...(["scheduled", "running"].includes(b.state)
          ? ([["Приостановить", { kind: "pause" }]] as [string, Action][])
          : []),
        ...(b.state === "paused"
          ? ([["Продолжить", { kind: "resume" }]] as [string, Action][])
          : []),
        ...(!["cancelled", "completed"].includes(b.state)
          ? ([["Отменить рассылку", { kind: "confirm-cancel" }]] as [
              string,
              Action,
            ][])
          : []),
        ...(b.revision > 0
          ? [
              ["Результаты отправки", { kind: "statistics" }] as [
                string,
                Action,
              ],
            ]
          : []),
        ["Создать копию", { kind: "copy-broadcast" }],
        ["Обновить статус", { kind: "read-broadcast", id: b.broadcastId }],
        ["Все рассылки", { kind: "broadcasts" }],
      ],
    );
  }
  private async saveBroadcast(c: Context) {
    const b = c.state.broadcast!;
    if (!b.parts.length && b.revision === 0) {
      await retainBroadcast(c);
      return this.broadcast(c);
    }
    const result = await this.funnels.execute(
      this.request(
        c,
        "broadcasts.save",
        {
          broadcastId: b.broadcastId,
          parts: b.parts,
          audience: b.audience,
          scheduledAt: b.scheduledAt,
        },
        b.revision,
      ),
      c.tx,
    );
    if ("broadcast" in result) c.state.broadcast = result.broadcast;
    await retainBroadcast(c);
    await this.broadcast(c);
  }
  private async act(c: Context, a: Action): Promise<void> {
    // Expected revision is taken from the menu the author actually saw.
    try {
      await this.perform(c, a);
    } catch (error) {
      if (
        !(error instanceof CommunicationsError) ||
        ![
          "revision_conflict",
          "not_found",
          "unsupported_content",
          "malformed",
        ].includes(error.code)
      )
        throw error;
      c.state = empty();
      await this.reply(
        c,
        "Пост, рассылка или воронка изменились либо действие недоступно. Откройте актуальную версию.",
        home,
      );
    }
  }
  private async perform(c: Context, a: Action): Promise<void> {
    const reply = (text: string, buttons?: [string, Action][]) =>
      this.reply(c, text, buttons);
    if (
      [
        "compose:broadcast",
        "compose:funnel",
        "compose:edit-broadcast",
        "compose:edit-funnel",
        "pick-part",
        "f:posts",
      ].includes(a.kind)
    ) {
      let destination: MessageDestination;
      if (a.kind.includes("funnel") || a.kind === "f:posts") {
        const f = c.state.funnelAuthor;
        const id =
          f?.target === "intro" ? f.intro?.introId : f?.funnel?.funnelId;
        if (!id || !f?.target) throw new CommunicationsError("not_found");
        destination = {
          kind: "funnel",
          id,
          target: f.target,
          partId: a.id && a.kind === "compose:edit-funnel" ? a.id : a.value,
        };
      } else {
        const b = c.state.broadcast;
        if (!b) throw new CommunicationsError("not_found");
        destination = {
          kind: "broadcast",
          id: b.broadcastId,
          partId: a.id ?? c.state.replacePart?.partId,
        };
      }
      let content;
      if (a.kind === "compose:edit-broadcast")
        content = c.state.broadcast?.parts.find(
          (p) => p.partId === a.id,
        )?.content;
      if (a.kind === "compose:edit-funnel")
        content = this.authorFunnels
          .selectedParts(c)
          .find((p) => p.partId === a.id)?.content;
      if (a.kind === "pick-part" || a.kind === "f:posts") {
        c.state.composing = { destination };
        return this.composer.library(c, reply);
      }
      return this.composer.begin(c, destination, reply, content);
    }
    if (a.kind.startsWith("compose:"))
      return this.composeResult(c, await this.composer.act(c, a, reply));
    if (a.kind === "new-broadcast") {
      c.state.broadcast = newBroadcast();
      c.state.broadcastName = undefined;
      c.state.prompt = "broadcast-name";
      return reply("Напишите название рассылки (до 128 символов).", [
        ["Все рассылки", { kind: "broadcasts" }],
      ]);
    }
    if (a.kind === "rename-broadcast") {
      c.state.prompt = "broadcast-name";
      return reply("Напишите название рассылки (до 128 символов).", [
        [
          "К рассылке",
          { kind: "read-broadcast", id: c.state.broadcast!.broadcastId },
        ],
      ]);
    }
    if (a.kind === "copy-broadcast" && c.state.broadcast) {
      const source = c.state.broadcast;
      c.state.broadcast = newBroadcast(source.parts);
      c.state.broadcast.audience = structuredClone(source.audience);
      c.state.broadcastName =
        `Копия: ${c.state.broadcastName ?? "Рассылка"}`.slice(0, 128);
      return this.saveBroadcast(c);
    }
    if (a.kind === "overview") {
      const result = await this.funnels.execute(
        this.request(c, "statistics.read", {}),
        c.tx,
      );
      if (!("statistics" in result)) throw new CommunicationsError("malformed");
      const d = result.statistics.deliveries;
      return reply(
        `Статистика сообщений\nОтправлено: ${d.sent}\nОжидает: ${d.pending}\nПропущено: ${d.suppressed}\nОшибки: ${d.failed}\nНеизвестный результат: ${d.unknown}`,
        home,
      );
    }
    if (a.kind.startsWith("f:"))
      return this.authorFunnels.act(c, a, (text, buttons) =>
        this.reply(c, text, buttons),
      );
    const t = c.state.template;
    const b = c.state.broadcast;
    if (a.kind === "home") {
      await retainFunnelDraft(c);
      c.state = empty();
      return this.reply(c, "Админка коммуникаций", home);
    }
    if (a.kind === "new" || a.kind === "replace") {
      if (a.kind === "replace" && !t)
        return this.reply(c, "Выберите пост.", home);
      c.state.prompt = a.kind === "new" ? "capture" : "replace";
      return this.reply(
        c,
        "Пришлите одно сообщение: текст, фото, видео, кружок, голосовое или документ. Используйте форматирование Telegram. Альбомы и опросы пока не поддерживаются. /cancel — выйти.",
      );
    }
    if (a.kind === "posts" || a.kind === "posts-all") {
      if (a.kind === "posts-all") c.state.libraryQuery = undefined;
      const list = await this.posts.list(
        this.request(c, "templates.list", a.id ? { cursor: a.id } : {}),
        c.tx,
        { search: c.state.libraryQuery, limit: 10 },
      );
      c.state.prompt = undefined;
      return this.reply(
        c,
        c.state.libraryQuery
          ? `Поиск: ${c.state.libraryQuery}`
          : "Сохранённые посты",
        [
          ...list.templates.map((p): [string, Action] => [
            messageLabel(p.content),
            { kind: "read-post", id: p.templateId },
          ]),
          ...(list.nextCursor
            ? [
                ["Следующие", { kind: "posts", id: list.nextCursor }] as [
                  string,
                  Action,
                ],
              ]
            : []),
          ["Найти пост", { kind: "post-search" }],
          ["Все посты", { kind: "posts-all" }],
          ["Создать пост", { kind: "new" }],
          ["В меню", { kind: "home" }],
        ],
      );
    }
    if (a.kind === "post-search") {
      c.state.prompt = "post-search";
      return this.reply(c, "Напишите часть текста или тип сообщения.", [
        ["Мои посты", { kind: "posts" }],
      ]);
    }
    if (a.kind === "read-post") {
      c.state.template = await this.posts.execute(
        this.request(c, "templates.read", { templateId: a.id! }),
        c.tx,
      );
      return this.post(c);
    }
    if (a.kind === "sample" && t) {
      await this.delivery.testSend(
        this.request(
          c,
          "templates.testSend",
          { templateId: t.templateId },
          t.revision,
        ),
        c.tx,
      );
      return this.reply(
        c,
        "Образец поставлен в очередь только вам. При неизвестном результате отправки автоматического повтора не будет.",
        [["Вернуться к посту", { kind: "read-post", id: t.templateId }]],
      );
    }
    if (a.kind === "button" && t) {
      c.state.prompt = "button-title";
      return this.reply(c, "Напишите название кнопки (до 64 символов).");
    }
    if (a.kind === "remove-button" && t) {
      c.state.template = await this.posts.execute(
        this.request(
          c,
          "templates.save",
          {
            templateId: t.templateId,
            content: {
              ...t.content,
              buttons: t.content.buttons.filter(
                (_, i) => i !== Number(a.value),
              ),
            },
          },
          t.revision,
        ),
        c.tx,
      );
      return this.post(c);
    }
    if (a.kind === "create-broadcast" && t) {
      c.state.broadcast = newBroadcast([
        { partId: randomUUID(), content: t.content },
      ]);
      c.state.broadcastName = t.content.text.slice(0, 128) || "Рассылка";
      return this.saveBroadcast(c);
    }
    if (a.kind === "broadcasts") {
      c.state.composing = undefined;
      c.state.prompt = undefined;
      const list = await this.broadcastDrafts.list(c, a.id);
      return this.reply(c, "Рассылки", [
        ["Создать рассылку", { kind: "new-broadcast" }],
        ...list.items.map(({ broadcast: item, name }): [string, Action] => [
          `${name.slice(0, 35)} · ${broadcastNames[item.state]}`,
          { kind: "read-broadcast", id: item.broadcastId },
        ]),
        ...(list.nextCursor
          ? [
              ["Следующие", { kind: "broadcasts", id: list.nextCursor }] as [
                string,
                Action,
              ],
            ]
          : []),
        ["В меню", { kind: "home" }],
      ]);
    }
    if (a.kind === "read-broadcast" && a.id) {
      c.state.composing = undefined;
      await this.broadcastDrafts.read(c, a.id);
      return this.broadcast(c);
    }
    if (!b) return this.reply(c, "Выберите пост, рассылку или воронку.", home);
    if (a.kind === "broadcast-sample") {
      for (const part of b.parts)
        await enqueueAuthorMessage(c.tx, {
          deliveryId: randomUUID(),
          botIdentity: c.input.botIdentity,
          accountRef: c.accountRef,
          telegramUserId: c.input.telegramUserId,
          telegramIdentityRef: c.identityRef,
          message: { chatId: c.input.telegramUserId, content: part.content },
        });
      return this.reply(
        c,
        "Образцы выбранной версии поставлены в очередь только вам.",
        [["К рассылке", { kind: "read-broadcast", id: b.broadcastId }]],
      );
    }
    if (a.kind === "parts")
      return this.reply(
        c,
        "Сообщения отправятся в указанном порядке. Замена берёт выбранную сохранённую версию поста.",
        [
          ...b.parts.flatMap((part, index): [string, Action][] => [
            [
              `${index + 1}. ${messageLabel(part.content, 32)}`,
              { kind: "show-part", id: part.partId },
            ],
            ...(index > 0
              ? ([
                  [
                    `Поднять сообщение ${index + 1}`,
                    { kind: "move-part", value: String(index) },
                  ],
                ] as [string, Action][])
              : []),
            ...(b.parts.length > 1
              ? ([
                  [
                    `Удалить сообщение ${index + 1}`,
                    { kind: "remove-part", value: String(index) },
                  ],
                ] as [string, Action][])
              : []),
          ]),
          ["Назад", { kind: "read-broadcast", id: b.broadcastId }],
        ],
      );
    if (a.kind === "show-part") {
      const part = b.parts.find((p) => p.partId === a.id);
      if (!part) throw new CommunicationsError("not_found");
      await previewAuthorMessage(c, part.content);
      return this.reply(c, messageLabel(part.content, 300), [
        [
          "Изменить сообщение и кнопки",
          { kind: "compose:edit-broadcast", id: part.partId },
        ],
        [
          "Заменить из сохранённых",
          { kind: "replace-part", value: String(b.parts.indexOf(part)) },
        ],
        ["К рассылке", { kind: "read-broadcast", id: b.broadcastId }],
      ]);
    }
    if (a.kind === "replace-part") {
      const part = b.parts[Number(a.value)];
      if (!part) throw new CommunicationsError("revision_conflict");
      c.state.replacePart = { broadcastId: b.broadcastId, partId: part.partId };
      return this.perform(c, { kind: "pick-part" });
    }
    if (a.kind === "move-part") {
      const index = Number(a.value);
      const part = b.parts[index];
      const before = b.parts[index - 1];
      if (part && before) {
        b.parts[index] = before;
        b.parts[index - 1] = part;
      }
      return this.saveBroadcast(c);
    }
    if (a.kind === "remove-part") {
      if (b.parts.length > 1)
        b.parts = b.parts.filter((_, index) => index !== Number(a.value));
      return this.saveBroadcast(c);
    }
    if (a.kind === "statistics") {
      const result = await this.funnels.execute(
        this.request(c, "statistics.read", { broadcastId: b.broadcastId }),
        c.tx,
      );
      if (!("statistics" in result)) return;
      const counts = result.statistics.deliveries;
      return this.reply(
        c,
        `Результаты рассылки\nОтправлено: ${counts.sent}\nОжидает: ${counts.pending}\nПропущено: ${counts.suppressed}\nОшибки: ${counts.failed}\nНеизвестный результат: ${counts.unknown}\nЧастично отменено: ${counts.partialCancelled}\nОбновите статус, чтобы увидеть новые результаты.`,
        [["К рассылке", { kind: "read-broadcast", id: b.broadcastId }]],
      );
    }
    if (a.kind === "schedule") {
      c.state.prompt = "schedule";
      return this.reply(
        c,
        "Введите дату и время по Москве: ДД.ММ.ГГГГ ЧЧ:ММ (UTC+3). Или напишите «сразу». Сохранение времени ещё не запускает черновик.",
      );
    }
    if (a.kind === "audience") {
      const list = await this.funnels.execute(
        this.request(c, "funnels.list", a.id ? { cursor: a.id } : {}),
        c.tx,
      );
      if (!("funnels" in list)) return;
      const items = list.funnels.slice(0, 20);
      return this.reply(
        c,
        "Выберите все контакты или отметьте воронки. Пересечения исключаются при запуске.",
        [
          ["Все контакты", { kind: "all" }],
          ...items.map((f): [string, Action] => [
            `${b.audience.kind === "funnels" && b.audience.funnelIds.includes(f.funnelId) ? "✓ " : ""}${f.name.slice(0, 50)}`,
            { kind: "toggle-funnel", id: f.funnelId },
          ]),
          ...(list.funnels.length > 20 || list.nextCursor
            ? ([
                ["Следующие", { kind: "audience", id: items.at(-1)!.funnelId }],
              ] as [string, Action][])
            : []),
          ["Сохранить аудиторию", { kind: "save-audience" }],
        ],
      );
    }
    if (a.kind === "all") {
      b.audience = { kind: "all" };
      return this.saveBroadcast(c);
    }
    if (a.kind === "toggle-funnel" && a.id) {
      const ids =
        b.audience.kind === "funnels" ? [...b.audience.funnelIds] : [];
      b.audience = {
        kind: "funnels",
        funnelIds: ids.includes(a.id)
          ? ids.filter((id) => id !== a.id)
          : [...ids, a.id],
      };
      return this.perform(c, { kind: "audience" });
    }
    if (a.kind === "save-audience") {
      if (b.audience.kind === "funnels" && !b.audience.funnelIds.length)
        return this.reply(c, "Выберите хотя бы одну воронку.", [
          ["Выбрать", { kind: "audience" }],
        ]);
      return this.saveBroadcast(c);
    }
    if (a.kind === "confirm-launch" || a.kind === "confirm-cancel") {
      return this.reply(
        c,
        a.kind === "confirm-launch"
          ? `Запустить «${c.state.broadcastName ?? "Рассылка"}»?\n${b.parts.length} сообщений, версия ${b.revision}.\nКому: ${b.audience.kind === "all" ? "все доступные контакты" : `выбранные воронки: ${b.audience.funnelIds.length}, без дублей`}.\nКогда: ${b.scheduledAt ? new Date(b.scheduledAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " · Москва" : "сразу после подтверждения"}.`
          : "Отменить рассылку? Уже отправленные сообщения останутся у получателей.",
        [
          [
            a.kind === "confirm-launch" ? "Запустить рассылку" : "Да, отменить",
            { kind: a.kind === "confirm-launch" ? "launch" : "cancel" },
          ],
          ["Назад", { kind: "read-broadcast", id: b.broadcastId }],
        ],
      );
    }
    if (["launch", "pause", "resume", "cancel"].includes(a.kind)) {
      if (b.revision === 0) {
        if (a.kind === "cancel") {
          b.state = "cancelled";
          await retainBroadcast(c);
          return this.broadcast(c);
        }
        return this.reply(
          c,
          "Добавьте хотя бы одно сообщение перед запуском.",
          [["К рассылке", { kind: "read-broadcast", id: b.broadcastId }]],
        );
      }
      const result = await this.funnels.execute(
        this.request(
          c,
          a.kind === "launch" ? "broadcasts.launch" : "broadcasts.lifecycle",
          {
            broadcastId: b.broadcastId,
            ...(a.kind !== "launch"
              ? { action: a.kind as "pause" | "resume" | "cancel" }
              : {}),
          },
          b.revision,
        ),
        c.tx,
      );
      if ("broadcast" in result) c.state.broadcast = result.broadcast;
      return this.broadcast(c);
    }
    return this.reply(c, "Откройте меню заново.", home);
  }
  private async composeResult(
    c: Context,
    result: ComposerResult,
  ): Promise<void> {
    if (result.kind === "handled") return;
    const d = result.destination;
    if (d.kind === "broadcast") {
      const b = c.state.broadcast;
      if (!b || b.broadcastId !== d.id)
        throw new CommunicationsError("revision_conflict");
      if (result.kind === "accepted") {
        if (
          b.audienceSnapshotId ||
          !["draft", "scheduled", "paused"].includes(b.state)
        )
          throw new CommunicationsError("revision_conflict");
        if (d.partId) {
          if (!b.parts.some((p) => p.partId === d.partId))
            throw new CommunicationsError("revision_conflict");
          b.parts = b.parts.map((p) =>
            p.partId === d.partId ? { ...p, content: result.content } : p,
          );
        } else {
          if (b.parts.length >= 20)
            throw new CommunicationsError("unsupported_content");
          b.parts.push({ partId: randomUUID(), content: result.content });
        }
        await this.saveBroadcast(c);
      } else await this.broadcast(c);
    } else {
      await this.authorFunnels.compose(
        c,
        d,
        result.kind === "accepted" ? result.content : undefined,
        (text, buttons) => this.reply(c, text, buttons),
      );
    }
    c.state.composing = undefined;
  }
  private async answer(c: Context): Promise<void> {
    if (c.state.composing)
      return this.composer.answer(c, (text, buttons) =>
        this.reply(c, text, buttons),
      );
    if (c.state.prompt === "broadcast-name") {
      const name = c.input.text;
      if (!name || name.length > 128)
        return this.reply(c, "Введите от 1 до 128 символов.");
      c.state.broadcastName = name;
      return this.saveBroadcast(c);
    }
    if (c.state.prompt === "post-search") {
      if (!c.input.text || c.input.text.length > 128)
        return this.reply(c, "Введите от 1 до 128 символов.");
      c.state.libraryQuery = c.input.text;
      return this.perform(c, { kind: "posts" });
    }
    if (c.state.funnelAuthor?.prompt)
      return this.authorFunnels.answer(c, (text, buttons) =>
        this.reply(c, text, buttons),
      );
    const state = c.state;
    const text = c.input.text;
    if (state.prompt === "capture" || state.prompt === "replace") {
      try {
        validateContent(c.input.content);
      } catch {
        return this.reply(
          c,
          "Не удалось принять оформление. Пришлите отдельное поддерживаемое сообщение.",
        );
      }
      const prior = state.prompt === "replace" ? state.template : undefined;
      try {
        state.template = await this.posts.execute(
          this.request(
            c,
            "templates.save",
            {
              templateId: prior?.templateId ?? randomUUID(),
              content: {
                ...c.input.content,
                ...(prior ? { buttons: prior.content.buttons } : {}),
              },
            },
            prior?.revision ?? 0,
          ),
          c.tx,
        );
      } catch (error) {
        if (
          !(error instanceof CommunicationsError) ||
          error.code !== "revision_conflict"
        )
          throw error;
        c.state = empty();
        return this.reply(c, "Пост уже изменился. Откройте его заново.", home);
      }
      return this.post(c);
    }
    if (state.prompt === "button-title") {
      if (!text || text.length > 64)
        return this.reply(c, "Название должно содержать от 1 до 64 символов.");
      state.buttonTitle = text;
      state.prompt = "button-url";
      return this.reply(c, "Пришлите HTTPS-ссылку для кнопки.");
    }
    if (state.prompt === "button-url") {
      try {
        validateContent({
          type: "text",
          text: "Ссылка",
          entities: [],
          buttons: [{ text: state.buttonTitle, url: text }],
        });
      } catch {
        return this.reply(
          c,
          "Нужна корректная HTTPS-ссылка без пароля или служебного адреса Telegram.",
        );
      }
      state.buttonUrl = text;
      state.prompt = "button-row";
      return this.reply(
        c,
        "В каком ряду показать кнопку? Введите номер от 1 до 20. Кнопки одного ряда стоят рядом; в ряду не больше 8 кнопок.",
      );
    }
    if (state.prompt === "button-row" && state.template) {
      if (!/^([1-9]|1[0-9]|20)$/.test(text))
        return this.reply(c, "Введите номер ряда от 1 до 20.");
      const t = state.template;
      const content = {
        ...t.content,
        buttons: [
          ...t.content.buttons,
          {
            text: state.buttonTitle!,
            url: state.buttonUrl!,
            row: Number(text) - 1,
          },
        ],
      };
      try {
        validateContent(content);
      } catch {
        return this.reply(
          c,
          "Достигнут лимит: до 20 кнопок и до 8 кнопок в ряду. Удалите лишние или выберите другой ряд.",
        );
      }
      state.template = await this.posts.execute(
        this.request(
          c,
          "templates.save",
          { templateId: t.templateId, content },
          t.revision,
        ),
        c.tx,
      );
      return this.post(c);
    }
    if (state.prompt === "schedule" && state.broadcast) {
      const date = parseMoscowSchedule(text);
      if (date === undefined || (date !== null && new Date(date) <= new Date()))
        return this.reply(
          c,
          "Нужна будущая дата ДД.ММ.ГГГГ ЧЧ:ММ по Москве или слово «сразу».",
        );
      state.broadcast.scheduledAt = date;
      return this.saveBroadcast(c);
    }
    c.state = empty();
    return this.reply(
      c,
      "Выберите действие. Для нового поста нажмите «Создать пост».",
      home,
    );
  }
}
function empty(): State {
  return { token: randomUUID(), actions: [] };
}
export function parseMoscowSchedule(text: string): string | null | undefined {
  if (text.toLowerCase() === "сразу") return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(text);
  if (!m) return;
  const value = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+03:00`);
  if (!Number.isFinite(value.getTime())) return;
  const local = new Date(value.getTime() + 3 * 3600000).toISOString();
  if (local.slice(0, 16) !== `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`) return;
  return value.toISOString();
}

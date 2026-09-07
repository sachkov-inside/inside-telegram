import {
  validateAuthorButtonUrl,
  appendAuthorButton,
} from "./author-button.js";
import type { Action, Context } from "./author-admin.js";
import { authorRequest } from "./author-request.js";
import type { Communications } from "./communications.js";
import {
  CommunicationsError,
  validateContent,
  type TemplateContent,
} from "./communications-contract.js";
import { messageLabel, previewAuthorMessage } from "./author-message-view.js";

export type MessageDestination = { expectedRevision: number } & (
  | { kind: "broadcast"; id: string; partId?: string }
  | { kind: "funnel"; id: string; target: string; partId?: string }
);
export interface ComposerState {
  destination: MessageDestination;
  content?: TemplateContent;
  prompt?: "capture" | "search" | "button-title" | "button-url" | "button-row";
  buttonTitle?: string;
  buttonUrl?: string;
  query?: string;
  libraryCursor?: string;
}
type Reply = (text: string, buttons?: [string, Action][]) => Promise<void>;
export type ComposerResult =
  | { kind: "handled" }
  | { kind: "cancelled"; destination: MessageDestination }
  | {
      kind: "accepted";
      destination: MessageDestination;
      content: TemplateContent;
    };
const handled = { kind: "handled" } as const;
const cancel: [string, Action][] = [["Отмена", { kind: "compose:cancel" }]];

/** A pending message never mutates a saved post or its destination before explicit acceptance. */
export class AuthorComposer {
  constructor(private readonly posts: Communications) {}
  async begin(
    c: Context,
    destination: MessageDestination,
    reply: Reply,
    content?: TemplateContent,
  ) {
    c.state.prompt = undefined;
    if (c.state.funnelAuthor) c.state.funnelAuthor.prompt = undefined;
    c.state.composing = {
      destination,
      ...(content
        ? { content: structuredClone(content) }
        : { prompt: "capture" as const }),
    };
    if (content) return this.show(c, reply, true);
    await reply(
      "Пришлите сообщение для выбранной рассылки или блока воронки: текст, фото, видео, кружок, голосовое или документ. После просмотра подтвердите добавление. /cancel — вернуться без изменений.",
      cancel,
    );
  }
  async resume(c: Context, reply: Reply) {
    const s = c.state.composing!;
    const prompts = {
      capture: "Пришлите сообщение для выбранного объекта.",
      search: "Напишите часть текста или тип поста.",
      "button-title": "Напишите название кнопки (до 64 символов).",
      "button-url": "Пришлите HTTPS-ссылку для кнопки.",
      "button-row": "Введите номер ряда от 1 до 20.",
    };
    if (s.prompt) return reply(prompts[s.prompt], cancel);
    if (!s.content) return this.library(c, reply, s.libraryCursor);
    return this.show(c, reply, true);
  }
  private async show(c: Context, reply: Reply, native = false) {
    const s = c.state.composing!;
    if (!s.content) throw new CommunicationsError("malformed");
    s.prompt = undefined;
    if (native) await previewAuthorMessage(c, s.content);
    await reply(
      `${messageLabel(s.content, 400)}\nКнопок: ${s.content.buttons.length}\n${s.destination.partId ? "Изменения ещё не применены." : "Сообщение ещё не добавлено."}`,
      [
        [
          s.destination.partId
            ? "Заменить сообщение"
            : s.destination.kind === "broadcast"
              ? "Добавить в рассылку"
              : "Добавить в блок",
          { kind: "compose:accept" },
        ],
        ["Посмотреть сообщение", { kind: "compose:preview" }],
        ["Добавить кнопку", { kind: "compose:button" }],
        ...s.content.buttons.map((b, i): [string, Action] => [
          `Убрать кнопку: ${b.text}`,
          { kind: "compose:remove-button", value: String(i) },
        ]),
        ["Прислать другое", { kind: "compose:replace" }],
        ...cancel,
      ],
    );
  }
  async library(c: Context, reply: Reply, cursor?: string) {
    const s = c.state.composing!;
    s.prompt = undefined;
    s.libraryCursor = cursor;
    const list = await this.posts.list(
      authorRequest(c.accountRef, "templates.list", cursor ? { cursor } : {}),
      c.tx,
      { search: s.query, limit: 10 },
    );
    await reply(
      s.query
        ? `Поиск: ${s.query}\nВыберите пост для просмотра.`
        : "Сохранённые посты. Выберите сообщение, чтобы посмотреть его перед добавлением.",
      [
        ...list.templates.map((p): [string, Action] => [
          messageLabel(p.content),
          { kind: "compose:choose", id: p.templateId },
        ]),
        ...(list.nextCursor
          ? [
              [
                "Следующие посты",
                { kind: "compose:library", id: list.nextCursor },
              ] as [string, Action],
            ]
          : []),
        ["Найти пост", { kind: "compose:search" }],
        ...(s.query || cursor
          ? [["Все посты", { kind: "compose:all" }] as [string, Action]]
          : []),
        ["Создать сообщение", { kind: "compose:replace" }],
        ...cancel,
      ],
    );
  }
  async act(c: Context, a: Action, reply: Reply): Promise<ComposerResult> {
    const s = c.state.composing;
    if (!s) throw new CommunicationsError("not_found");
    if (a.kind === "compose:cancel") {
      delete c.state.composing;
      return { kind: "cancelled", destination: s.destination };
    }
    if (a.kind === "compose:accept" && s.content) {
      validateContent(s.content);
      return {
        kind: "accepted",
        destination: s.destination,
        content: s.content,
      };
    }
    if (a.kind === "compose:replace") {
      s.prompt = "capture";
      await reply(
        "Пришлите новое сообщение. Выбранная рассылка или блок останется прежним.",
        cancel,
      );
    } else if (a.kind === "compose:library" || a.kind === "compose:all") {
      if (a.kind === "compose:all") s.query = undefined;
      await this.library(c, reply, a.id);
    } else if (a.kind === "compose:search") {
      s.prompt = "search";
      await reply(
        "Напишите часть текста поста или тип: текст, фото, видео, кружок, голосовое, документ.",
        cancel,
      );
    } else if (a.kind === "compose:choose" && a.id) {
      const p = await this.posts.execute(
        authorRequest(c.accountRef, "templates.read", { templateId: a.id }),
        c.tx,
      );
      s.content = structuredClone(p.content);
      await this.show(c, reply, true);
    } else if (a.kind === "compose:button" && s.content) {
      s.prompt = "button-title";
      await reply("Напишите название кнопки (до 64 символов).", cancel);
    } else if (a.kind === "compose:remove-button" && s.content) {
      s.content = {
        ...s.content,
        buttons: s.content.buttons.filter((_, i) => i !== Number(a.value)),
      };
      await this.show(c, reply);
    } else if (a.kind === "compose:preview") await this.show(c, reply, true);
    return handled;
  }
  async answer(c: Context, reply: Reply): Promise<void> {
    const s = c.state.composing!;
    const text = c.input.text;
    if (s.prompt === "capture") {
      try {
        validateContent(c.input.content);
      } catch {
        await reply(
          "Не удалось принять сообщение. Пришлите один из поддерживаемых форматов; альбомы, стикеры и опросы не подходят.",
          cancel,
        );
        return;
      }
      s.content = structuredClone(c.input.content);
      return this.show(c, reply, true);
    }
    if (s.prompt === "search") {
      if (!text || text.length > 128)
        return reply("Введите от 1 до 128 символов.", cancel);
      s.query = text;
      return this.library(c, reply);
    }
    if (s.prompt === "button-title") {
      if (!text || text.length > 64)
        return reply("Введите от 1 до 64 символов.", cancel);
      s.buttonTitle = text;
      s.prompt = "button-url";
      return reply("Пришлите HTTPS-ссылку для кнопки.", cancel);
    }
    if (s.prompt === "button-url") {
      try {
        validateAuthorButtonUrl(s.buttonTitle, text);
      } catch {
        return reply(
          "Нужна корректная HTTPS-ссылка без пароля или служебного адреса Telegram.",
          cancel,
        );
      }
      s.buttonUrl = text;
      s.prompt = "button-row";
      return reply(
        "Введите номер ряда от 1 до 20. Кнопки одного ряда стоят рядом.",
        cancel,
      );
    }
    if (s.prompt === "button-row" && s.content) {
      if (!/^([1-9]|1[0-9]|20)$/.test(text))
        return reply("Введите номер ряда от 1 до 20.", cancel);
      let content: TemplateContent;
      try {
        content = appendAuthorButton(
          s.content,
          s.buttonTitle!,
          s.buttonUrl!,
          Number(text) - 1,
        );
      } catch {
        return reply(
          "Допустимо до 20 кнопок и до 8 в одном ряду. Выберите другой ряд или отмените правку.",
          cancel,
        );
      }
      s.content = content;
      return this.show(c, reply);
    }
    if (s.content) return this.show(c, reply);
    await reply("Пришлите сообщение или отмените добавление.", cancel);
  }
}

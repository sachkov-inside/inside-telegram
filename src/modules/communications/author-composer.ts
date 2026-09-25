import { unhandled } from "../../shared/unhandled.js";
import {
  validateAuthorButtonUrl,
  appendAuthorButton,
  nextAuthorButtonRow,
} from "./author-button.js";
import type {
  AuthorAction,
  AuthorButton,
  ComposeAction,
  MessageDestination,
} from "./author-dialog.js";
import { messageLabel } from "./author-message-view.js";
import type { AuthorEvent, Turn } from "./author-turn.js";
import {
  CommunicationsError,
  validateContent,
  type TemplateContent,
  type TemplateSnapshot,
} from "./communications-contract.js";

/** Buttons inside a message being composed; the admin starts or restores a composition. */
const COMPOSER_STEPS = [
  "compose:accept",
  "compose:all",
  "compose:button",
  "compose:cancel",
  "compose:choose",
  "compose:library",
  "compose:preview",
  "compose:remove-button",
  "compose:replace",
  "compose:search",
] as const;
export type ComposerStep = Extract<
  ComposeAction,
  { kind: (typeof COMPOSER_STEPS)[number] }
>;
export function isComposerStep(action: AuthorAction): action is ComposerStep {
  return (COMPOSER_STEPS as readonly string[]).includes(action.kind);
}
export type ComposerResult =
  | { kind: "handled" }
  | { kind: "cancelled"; destination: MessageDestination }
  | {
      kind: "accepted";
      destination: MessageDestination;
      content: TemplateContent;
    };
const handled = { kind: "handled" } as const;
const cancel: AuthorButton[] = [["Отмена", { kind: "compose:cancel" }]];

// A pending message never mutates a saved post or its destination before explicit acceptance.

export function beginComposer(
  t: Turn,
  destination: MessageDestination,
  content?: TemplateContent,
) {
  t.state.prompt = undefined;
  if (t.state.funnelAuthor) t.state.funnelAuthor.prompt = undefined;
  t.state.composing = {
    destination,
    ...(content
      ? { content: structuredClone(content) }
      : { prompt: "capture" as const }),
  };
  if (content) return show(t, true);
  t.reply(
    "Пришлите сообщение для выбранной рассылки или блока воронки: текст, фото, видео, кружок, голосовое или документ. После просмотра подтвердите добавление. /cancel — вернуться без изменений.",
    cancel,
  );
}

export function resumeComposer(t: Turn) {
  const s = composing(t);
  const prompts = {
    capture: "Пришлите сообщение для выбранного объекта.",
    search: "Напишите часть текста или тип поста.",
    "button-title": "Напишите название кнопки (до 64 символов).",
    "button-url": "Пришлите HTTPS-ссылку для кнопки.",
    "button-row": "Введите номер ряда от 1 до 20.",
  };
  if (s.prompt) return t.reply(prompts[s.prompt], cancel);
  if (!s.content) return openLibrary(t, s.libraryCursor);
  show(t, true);
}

function show(t: Turn, native = false) {
  const s = composing(t);
  if (!s.content) throw new CommunicationsError("malformed");
  s.prompt = undefined;
  if (native) t.preview(s.content);
  t.reply(
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
      ...s.content.buttons.map((b, i): AuthorButton => [
        `Убрать кнопку: ${b.text}`,
        { kind: "compose:remove-button", value: String(i) },
      ]),
      ["Прислать другое", { kind: "compose:replace" }],
      ...cancel,
    ],
  );
}

/** Asks for a page of saved posts; {@link showLibrary} renders the answer. */
export function openLibrary(t: Turn, cursor?: string) {
  const s = composing(t);
  s.prompt = undefined;
  s.libraryCursor = cursor;
  t.ask({ kind: "list-posts", purpose: "library", cursor, search: s.query });
}

export function showLibrary(
  t: Turn,
  list: Extract<AuthorEvent, { kind: "posts-listed" }>,
) {
  const s = composing(t);
  t.reply(
    s.query
      ? `Поиск: ${s.query}\nВыберите пост для просмотра.`
      : "Сохранённые посты. Выберите сообщение, чтобы посмотреть его перед добавлением.",
    [
      ...list.templates.map((p): AuthorButton => [
        messageLabel(p.content),
        { kind: "compose:choose", id: p.templateId },
      ]),
      ...(list.nextCursor
        ? [
            [
              "Следующие посты",
              { kind: "compose:library", id: list.nextCursor },
            ] as AuthorButton,
          ]
        : []),
      ["Найти пост", { kind: "compose:search" }],
      ...(s.query || list.cursor
        ? [["Все посты", { kind: "compose:all" }] as AuthorButton]
        : []),
      ["Создать сообщение", { kind: "compose:replace" }],
      ...cancel,
    ],
  );
}

/** The saved post the author chose from the library becomes the pending message. */
export function chooseLibraryPost(t: Turn, template: TemplateSnapshot) {
  composing(t).content = structuredClone(template.content);
  show(t, true);
}

export function actComposer(t: Turn, a: ComposerStep): ComposerResult {
  const s = composing(t);
  switch (a.kind) {
    case "compose:cancel":
      delete t.state.composing;
      return { kind: "cancelled", destination: s.destination };
    case "compose:accept":
      if (!s.content) return handled;
      validateContent(s.content);
      return {
        kind: "accepted",
        destination: s.destination,
        content: s.content,
      };
    case "compose:replace":
      s.prompt = "capture";
      t.reply(
        "Пришлите новое сообщение. Выбранная рассылка или блок останется прежним.",
        cancel,
      );
      return handled;
    case "compose:all":
      s.query = undefined;
      openLibrary(t);
      return handled;
    case "compose:library":
      openLibrary(t, a.id);
      return handled;
    case "compose:search":
      s.prompt = "search";
      t.reply(
        "Напишите часть текста поста или тип: текст, фото, видео, кружок, голосовое, документ.",
        cancel,
      );
      return handled;
    case "compose:choose":
      t.ask({ kind: "read-post", purpose: "library", templateId: a.id });
      return handled;
    case "compose:button":
      if (!s.content) return handled;
      s.prompt = "button-title";
      t.reply("Напишите название кнопки (до 64 символов).", cancel);
      return handled;
    case "compose:remove-button":
      if (!s.content) return handled;
      s.content = {
        ...s.content,
        buttons: s.content.buttons.filter((_, i) => i !== Number(a.value)),
      };
      show(t);
      return handled;
    case "compose:preview":
      show(t, true);
      return handled;
    default:
      return unhandled(a, "composer action");
  }
}

export function answerComposer(
  t: Turn,
  input: { text: string; content: unknown },
) {
  const s = composing(t);
  const text = input.text;
  switch (s.prompt) {
    case "capture":
      try {
        validateContent(input.content);
      } catch {
        return t.reply(
          "Не удалось принять сообщение. Пришлите один из поддерживаемых форматов; альбомы, стикеры и опросы не подходят.",
          cancel,
        );
      }
      s.content = structuredClone(input.content);
      return show(t, true);
    case "search":
      if (!text || text.length > 128)
        return t.reply("Введите от 1 до 128 символов.", cancel);
      s.query = text;
      return openLibrary(t);
    case "button-title":
      if (!text || text.length > 64)
        return t.reply("Введите от 1 до 64 символов.", cancel);
      s.buttonTitle = text;
      s.prompt = "button-url";
      return t.reply("Пришлите HTTPS-ссылку для кнопки.", cancel);
    case "button-url":
      try {
        validateAuthorButtonUrl(s.buttonTitle, text);
      } catch {
        return t.reply(
          "Нужна корректная HTTPS-ссылка без пароля или служебного адреса Telegram.",
          cancel,
        );
      }
      if (!s.content || s.buttonTitle === undefined)
        throw new CommunicationsError("malformed");
      s.content = appendAuthorButton(
        s.content,
        s.buttonTitle,
        text,
        nextAuthorButtonRow(s.content),
      );
      return show(t, true);
    case "button-row": {
      if (!s.content) break;
      if (!/^([1-9]|1[0-9]|20)$/.test(text))
        return t.reply("Введите номер ряда от 1 до 20.", cancel);
      if (s.buttonTitle === undefined || s.buttonUrl === undefined)
        throw new CommunicationsError("malformed");
      let content: TemplateContent;
      try {
        content = appendAuthorButton(
          s.content,
          s.buttonTitle,
          s.buttonUrl,
          Number(text) - 1,
        );
      } catch {
        return t.reply(
          "Допустимо до 20 кнопок и до 8 в одном ряду. Выберите другой ряд или отмените правку.",
          cancel,
        );
      }
      s.content = content;
      return show(t);
    }
    case undefined:
      break;
    default:
      return unhandled(s.prompt, "composer prompt");
  }
  if (s.content) return show(t);
  t.reply("Пришлите сообщение или отмените добавление.", cancel);
}

function composing(t: Turn) {
  const s = t.state.composing;
  if (!s) throw new CommunicationsError("not_found");
  return s;
}

import type { TemplateContent } from "../../modules/communications/communications-contract.js";
export interface TemplateIntake {
  readonly botIdentity: string;
  readonly updateId: string;
  readonly telegramUserId: string;
  readonly privateChatId: string;
  readonly action: "open" | "close" | "capture";
  readonly content: unknown;
}

// Called only after the existing update router returns ignored. No callback, edit or /start handling.
export function translateTemplateIntake(
  botIdentity: string,
  updateId: string,
  payload: unknown,
): TemplateIntake | undefined {
  if (!record(payload) || !record(payload.message)) return undefined;
  const message = payload.message;
  if (
    !record(message.from) ||
    message.from.is_bot !== false ||
    !record(message.chat) ||
    message.chat.type !== "private" ||
    !Number.isSafeInteger(message.from.id) ||
    Number(message.from.id) <= 0 ||
    message.chat.id !== message.from.id ||
    message.sender_chat
  )
    return undefined;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const action = /^\/template(?:@[A-Za-z0-9_]+)?$/.test(text)
    ? "open"
    : /^\/cancel(?:@[A-Za-z0-9_]+)?$/.test(text)
      ? "close"
      : "capture";
  if (action === "capture" && /^\//.test(text)) return undefined;
  return {
    botIdentity,
    updateId,
    telegramUserId: String(message.from.id),
    privateChatId: String(message.chat.id),
    action,
    content: snapshot(message),
  };
}
function snapshot(message: Record<string, unknown>): unknown {
  if (
    message.media_group_id ||
    message.poll ||
    message.animation ||
    message.audio ||
    message.sticker ||
    message.rich_message ||
    message.paid_media ||
    message.live_photo
  )
    return null;
  const kinds = [
    "text",
    "photo",
    "video",
    "video_note",
    "voice",
    "document",
  ] as const;
  const present = kinds.filter((kind) => message[kind] !== undefined);
  if (present.length !== 1) return null;
  const type = present[0]!;
  let fileId: unknown;
  if (type !== "text") {
    const media =
      type === "photo" && Array.isArray(message.photo)
        ? message.photo.at(-1)
        : message[type];
    if (!record(media)) return null;
    fileId = media.file_id;
  }
  let buttons: unknown[] = [];
  if (message.reply_markup !== undefined) {
    if (
      !record(message.reply_markup) ||
      !Array.isArray(message.reply_markup.inline_keyboard)
    )
      return null;
    // Do not silently discard callback/pay/login buttons or other unsupported markup.
    buttons = message.reply_markup.inline_keyboard.flat();
    if (
      buttons.some(
        (button) =>
          !record(button) ||
          Object.keys(button).some((key) => key !== "text" && key !== "url"),
      )
    )
      return null;
  }
  return {
    type,
    text: type === "text" ? message.text : (message.caption ?? ""),
    entities:
      (type === "text" ? message.entities : message.caption_entities) ?? [],
    buttons,
    ...(type !== "text" ? { fileId } : {}),
  } satisfies Omit<
    TemplateContent,
    "text" | "entities" | "buttons" | "fileId"
  > &
    Record<string, unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

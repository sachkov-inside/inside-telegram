import { snapshot } from "./grammy-template-intake.adapter.js";
export interface AuthorInput {
  botIdentity: string;
  updateId: string;
  telegramUserId: string;
  text: string;
  content: unknown;
  callbackData?: string;
  callbackQueryId?: string;
}
export function translateAuthorInput(
  botIdentity: string,
  updateId: string,
  payload: unknown,
): AuthorInput | undefined {
  if (!record(payload)) return;
  const callback = record(payload.callback_query)
    ? payload.callback_query
    : undefined;
  const message = callback ? callback.message : payload.message;
  if (!record(message)) return;
  const from = callback ? callback.from : message.from;
  if (
    !record(from) ||
    from.is_bot !== false ||
    !Number.isSafeInteger(from.id) ||
    Number(from.id) <= 0 ||
    !record(message.chat) ||
    message.chat.type !== "private" ||
    message.chat.id !== from.id ||
    message.sender_chat
  )
    return;
  if (
    callback &&
    (typeof callback.data !== "string" ||
      !callback.data.startsWith("author:") ||
      typeof callback.id !== "string")
  )
    return;
  return {
    botIdentity,
    updateId,
    telegramUserId: String(from.id),
    text:
      typeof message.text === "string" && !callback ? message.text.trim() : "",
    content: callback ? null : snapshot(message),
    ...(callback
      ? {
          callbackData: callback.data as string,
          callbackQueryId: callback.id as string,
        }
      : {}),
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";
import type { Context } from "./author-admin.js";
import type { TemplateContent } from "./communications-contract.js";
import { enqueueAuthorMessage } from "./author-delivery.js";
const labels = {
  text: "📝 Текст",
  photo: "🖼 Фото",
  video: "🎬 Видео",
  video_note: "🔵 Кружок",
  voice: "🎙 Голосовое",
  document: "📎 Документ",
};
export function messageLabel(content: TemplateContent, length = 45) {
  return `${labels[content.type]}${content.text ? ` · ${content.text.replace(/\s+/g, " ").slice(0, length)}` : " без подписи"}`;
}
export async function previewAuthorMessage(
  c: Context,
  content: TemplateContent,
) {
  c.state.freshMenu = true;
  await enqueueAuthorMessage(c.tx, {
    deliveryId: randomUUID(),
    botIdentity: c.input.botIdentity,
    accountRef: c.accountRef,
    telegramUserId: c.input.telegramUserId,
    telegramIdentityRef: c.identityRef,
    message: { chatId: c.input.telegramUserId, content },
  });
}

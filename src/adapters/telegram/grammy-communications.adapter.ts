import { buttonRows } from "../../modules/communications/button-rows.js";
import { type Api, GrammyError } from "grammy";
import type { MessageEntity } from "grammy/types";
import type {
  CommunicationTransport,
  CommunicationMessage,
} from "../../modules/communications/communication-delivery.js";
import type { TelegramDeliveryResult } from "../../modules/outbound/telegram-messages.js";
import { reportFailure } from "../../shared/failure-diagnostics.js";
export class GrammyCommunicationsAdapter implements CommunicationTransport {
  constructor(
    private readonly api: Pick<
      Api,
      | "sendMessage"
      | "sendPhoto"
      | "sendVideo"
      | "sendVideoNote"
      | "sendVoice"
      | "sendDocument"
    > &
      Partial<Pick<Api, "editMessageText">>,
  ) {}
  async send(message: CommunicationMessage): Promise<TelegramDeliveryResult> {
    const c = message.content;
    const reply_markup = message.offerStart
      ? {
          keyboard: [[{ text: "/start" }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      : {
          inline_keyboard: message.authorButtons
            ? message.authorButtons.map((b) => [
                { text: b.text, callback_data: b.callbackData },
              ])
            : buttonRows(c.buttons),
        };
    const entities = telegramEntities(c.entities);
    // Content validation admits neither case; a violation is rejected here, never sent.
    if (!entities || (c.type !== "text" && c.fileId === undefined))
      return { kind: "api_rejected", providerErrorCode: 400 };
    const file = c.fileId ?? "";
    const options = {
      caption: c.text,
      caption_entities: entities,
      reply_markup,
    };
    try {
      let sent: { message_id: number };
      switch (c.type) {
        case "text":
          if (
            message.authorMenu &&
            message.editMessageId &&
            this.api.editMessageText
          ) {
            try {
              const edited = await this.api.editMessageText(
                message.chatId,
                Number(message.editMessageId),
                c.text,
                {
                  entities,
                  ...(reply_markup.inline_keyboard
                    ? {
                        reply_markup: {
                          inline_keyboard: reply_markup.inline_keyboard,
                        },
                      }
                    : {}),
                },
              );
              return {
                kind: "delivered",
                providerMessageId:
                  typeof edited === "boolean"
                    ? message.editMessageId
                    : String(edited.message_id),
              };
            } catch (error) {
              if (!(error instanceof GrammyError) || error.error_code !== 400)
                throw error;
              if (error.description.includes("message is not modified"))
                return {
                  kind: "delivered",
                  providerMessageId: message.editMessageId,
                };
              // A definitive rejection means no edit was applied. Replace an unavailable menu.
            }
          }
          sent = await this.api.sendMessage(message.chatId, c.text, {
            entities,
            reply_markup,
          });
          break;
        case "photo":
          sent = await this.api.sendPhoto(message.chatId, file, options);
          break;
        case "video":
          sent = await this.api.sendVideo(message.chatId, file, options);
          break;
        case "video_note":
          sent = await this.api.sendVideoNote(message.chatId, file, {
            reply_markup,
          });
          break;
        case "voice":
          sent = await this.api.sendVoice(message.chatId, file, options);
          break;
        case "document":
          sent = await this.api.sendDocument(message.chatId, file, options);
          break;
      }
      return { kind: "delivered", providerMessageId: String(sent.message_id) };
    } catch (error) {
      if (!(error instanceof GrammyError)) {
        reportFailure("telegram.communications", error);
        return { kind: "transport_unknown" };
      }
      if (error.error_code === 429 || error.error_code >= 500)
        return {
          kind: "api_retryable",
          providerErrorCode: error.error_code,
          ...(Number.isSafeInteger(error.parameters.retry_after) &&
          (error.parameters.retry_after ?? 0) > 0
            ? { retryAfterSeconds: error.parameters.retry_after }
            : {}),
        };
      return { kind: "api_rejected", providerErrorCode: error.error_code };
    }
  }
}
export class DisabledCommunicationTransport implements CommunicationTransport {
  send(): Promise<TelegramDeliveryResult> {
    return Promise.reject(new Error("Marketing delivery is disabled"));
  }
}
const COMMON_ENTITY_TYPES: readonly MessageEntity.CommonMessageEntity["type"][] =
  [
    "mention",
    "hashtag",
    "cashtag",
    "bot_command",
    "url",
    "email",
    "phone_number",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "blockquote",
    "expandable_blockquote",
    "code",
  ];
// The contract schema admits exactly these entity types; content validation pairs url with
// text_link. Undefined means an entity outside the contract.
function telegramEntities(
  entities: CommunicationMessage["content"]["entities"],
): MessageEntity[] | undefined {
  const mapped: MessageEntity[] = [];
  for (const entity of entities) {
    const { offset, length } = entity;
    const type = COMMON_ENTITY_TYPES.find((common) => common === entity.type);
    if (entity.type === "pre")
      mapped.push({
        type: "pre",
        offset,
        length,
        ...(entity.language === undefined ? {} : { language: entity.language }),
      });
    else if (entity.type === "text_link" && entity.url !== undefined)
      mapped.push({ type: "text_link", offset, length, url: entity.url });
    else if (type !== undefined) mapped.push({ type, offset, length });
    else return undefined;
  }
  return mapped;
}

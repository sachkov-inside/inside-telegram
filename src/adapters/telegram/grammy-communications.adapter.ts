import { type Api, GrammyError } from "grammy";
import type { MessageEntity } from "grammy/types";
import type {
  CommunicationTransport,
  CommunicationMessage,
} from "../../modules/communications/communication-delivery.js";
import type { TelegramDeliveryResult } from "../../modules/outbound/telegram-messages.js";
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
    >,
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
          inline_keyboard: c.buttons.map((b) => [{ text: b.text, url: b.url }]),
        };
    const entities = c.entities as MessageEntity[];
    const options = {
      caption: c.text,
      caption_entities: entities,
      reply_markup,
    };
    try {
      let sent: { message_id: number };
      switch (c.type) {
        case "text":
          sent = await this.api.sendMessage(message.chatId, c.text, {
            entities,
            reply_markup,
          });
          break;
        case "photo":
          sent = await this.api.sendPhoto(message.chatId, c.fileId!, options);
          break;
        case "video":
          sent = await this.api.sendVideo(message.chatId, c.fileId!, options);
          break;
        case "video_note":
          sent = await this.api.sendVideoNote(message.chatId, c.fileId!, {
            reply_markup,
          });
          break;
        case "voice":
          sent = await this.api.sendVoice(message.chatId, c.fileId!, options);
          break;
        case "document":
          sent = await this.api.sendDocument(
            message.chatId,
            c.fileId!,
            options,
          );
          break;
      }
      return { kind: "delivered", providerMessageId: String(sent.message_id) };
    } catch (error) {
      if (!(error instanceof GrammyError)) return { kind: "transport_unknown" };
      if (error.error_code === 429 || error.error_code >= 500)
        return {
          kind: "api_retryable",
          providerErrorCode: error.error_code,
          ...(Number.isSafeInteger(error.parameters.retry_after) &&
          error.parameters.retry_after! > 0
            ? { retryAfterSeconds: error.parameters.retry_after }
            : {}),
        };
      return { kind: "api_rejected", providerErrorCode: error.error_code };
    }
  }
}
export class DisabledCommunicationTransport implements CommunicationTransport {
  async send(): Promise<TelegramDeliveryResult> {
    throw new Error("Marketing delivery is disabled");
  }
}

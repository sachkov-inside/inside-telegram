import { Api, GrammyError } from "grammy";

import type {
  TelegramDeliveryResult,
  TelegramMessages,
  TelegramTextMessage,
} from "../../modules/outbound/telegram-messages.js";

export class GrammyMessagesAdapter implements TelegramMessages {
  private readonly api: TelegramApi;

  constructor(token: string, api?: TelegramApi) {
    this.api = api ?? new Api(token);
  }

  async sendText(
    message: TelegramTextMessage,
  ): Promise<TelegramDeliveryResult> {
    const chatId = toSafeTelegramNumber(message.chatId);
    try {
      const sent = await this.api.sendMessage(chatId, message.text);
      return {
        kind: "delivered",
        providerMessageId: String(sent.message_id),
      };
    } catch (error) {
      if (error instanceof GrammyError) {
        if (error.error_code === 429 || error.error_code >= 500) {
          const retryAfterSeconds = positiveInteger(
            error.parameters.retry_after,
          );
          return {
            kind: "api_retryable",
            providerErrorCode: error.error_code,
            ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
          };
        }
        return {
          kind: "api_rejected",
          providerErrorCode: error.error_code,
        };
      }
      return { kind: "transport_unknown" };
    }
  }
}

interface TelegramApi {
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
}

export class DisabledMessagesAdapter implements TelegramMessages {
  async sendText(): Promise<TelegramDeliveryResult> {
    throw new Error("External Telegram delivery is disabled");
  }
}

function toSafeTelegramNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      "Persisted Telegram chat ID is outside the safe JSON range",
    );
  }
  return number;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

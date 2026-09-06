import { Api, GrammyError } from "grammy";

import type {
  TelegramDeliveryResult,
  TelegramMessages,
  TelegramMessageEdit,
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
      const sent = message.buttons
        ? await this.api.sendMessage(chatId, message.text, {
            reply_markup: {
              inline_keyboard: [
                message.buttons.map((button) => ({
                  text: button.text,
                  callback_data: button.callbackData,
                })),
              ],
            },
          })
        : await this.api.sendMessage(chatId, message.text);
      return {
        kind: "delivered",
        providerMessageId: String(sent.message_id),
      };
    } catch (error) {
      return deliveryFailure(error);
    }
  }

  async editText(
    message: TelegramMessageEdit,
  ): Promise<TelegramDeliveryResult> {
    try {
      await this.api.editMessageText(
        toSafeTelegramNumber(message.chatId),
        toSafeTelegramNumber(message.messageId),
        message.text,
        {
          reply_markup: { inline_keyboard: [] },
        },
      );
      return { kind: "delivered", providerMessageId: message.messageId };
    } catch (error) {
      // Repeating the same edit after an ambiguous response is already the intended result.
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        error.description.startsWith("Bad Request: message is not modified")
      ) {
        return { kind: "delivered", providerMessageId: message.messageId };
      }
      return deliveryFailure(error);
    }
  }
}

function deliveryFailure(error: unknown): TelegramDeliveryResult {
  if (error instanceof GrammyError) {
    if (error.error_code === 429 || error.error_code >= 500) {
      const retryAfterSeconds = positiveInteger(error.parameters.retry_after);
      return {
        kind: "api_retryable",
        providerErrorCode: error.error_code,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      };
    }
    return { kind: "api_rejected", providerErrorCode: error.error_code };
  }
  return { kind: "transport_unknown" };
}

interface TelegramApi {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: { reply_markup: { inline_keyboard: [] } },
  ): Promise<true | { message_id: number }>;
  sendMessage(
    chatId: number,
    text: string,
    options?: {
      reply_markup: {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
    },
  ): Promise<{ message_id: number }>;
}

export class DisabledMessagesAdapter implements TelegramMessages {
  async editText(): Promise<TelegramDeliveryResult> {
    throw new Error("External Telegram delivery is disabled");
  }
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

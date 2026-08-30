export interface TelegramTextMessage {
  readonly chatId: string;
  readonly text: string;
}

export type TelegramDeliveryResult =
  | { readonly kind: "api_rejected"; readonly providerErrorCode: number }
  | {
      readonly kind: "api_retryable";
      readonly providerErrorCode: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "delivered"; readonly providerMessageId: string }
  | { readonly kind: "transport_unknown" };

export interface TelegramMessages {
  sendText(message: TelegramTextMessage): Promise<TelegramDeliveryResult>;
}

export const TELEGRAM_MESSAGES = Symbol("TELEGRAM_MESSAGES");

import type { TelegramChatMember } from "./membership-normalization.js";

export type TelegramChatMemberResult =
  | { readonly kind: "observed"; readonly value: TelegramChatMember }
  | {
      readonly diagnosticCode: string;
      readonly retryAfterSeconds?: number;
      readonly kind: "unavailable";
    };

export interface TelegramMembership {
  getBotChatMember(chatId: string): Promise<TelegramChatMemberResult>;
  getChatMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatMemberResult>;
}

export const TELEGRAM_MEMBERSHIP = Symbol("TELEGRAM_MEMBERSHIP");

export class DisabledTelegramMembership implements TelegramMembership {
  getBotChatMember(): Promise<TelegramChatMemberResult> {
    return Promise.resolve({
      diagnosticCode: "telegram_membership_disabled",
      kind: "unavailable",
    });
  }

  getChatMember(): Promise<TelegramChatMemberResult> {
    return Promise.resolve({
      diagnosticCode: "telegram_membership_disabled",
      kind: "unavailable",
    });
  }
}

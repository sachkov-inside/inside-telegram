import { Api } from "grammy";

import type {
  TelegramChatMemberResult,
  TelegramMembership,
} from "../../modules/membership-evidence/telegram-membership.js";

export class GrammyMembershipAdapter implements TelegramMembership {
  private readonly api: TelegramApi;

  constructor(token: string, api?: TelegramApi) {
    this.api = api ?? new Api(token);
  }

  async getBotChatMember(chatId: string): Promise<TelegramChatMemberResult> {
    try {
      const bot = await this.api.getMe();
      return await this.read(chatId, String(bot.id));
    } catch {
      return unavailable();
    }
  }

  async getChatMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatMemberResult> {
    try {
      return await this.read(chatId, telegramUserId);
    } catch {
      return unavailable();
    }
  }

  private async read(
    chatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatMemberResult> {
    const member = await this.api.getChatMember(
      toSafeTelegramNumber(chatId),
      toSafeTelegramNumber(telegramUserId),
    );
    return {
      kind: "observed",
      value: toTelegramChatMember(member),
    };
  }
}

export function toTelegramChatMember(member: {
  readonly is_member?: boolean;
  readonly status: string;
}) {
  return {
    ...(typeof member.is_member === "boolean"
      ? { isMember: member.is_member }
      : {}),
    status: member.status,
  };
}

interface TelegramApi {
  getChatMember(
    chatId: number,
    userId: number,
  ): Promise<{ is_member?: boolean; status: string }>;
  getMe(): Promise<{ id: number }>;
}

function toSafeTelegramNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number === 0) {
    throw new Error("Telegram identifier is outside the safe JSON range");
  }
  return number;
}

function unavailable(): TelegramChatMemberResult {
  return {
    diagnosticCode: "telegram_api_unavailable",
    kind: "unavailable",
  };
}

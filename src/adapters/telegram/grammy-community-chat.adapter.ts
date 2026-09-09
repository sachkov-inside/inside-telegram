import { Api, GrammyError } from "grammy";

import type {
  CommunityCallOutcome,
  CommunityCapability,
  CommunityInviteOutcome,
  CommunityObservation,
  TelegramCommunityChat,
} from "../../modules/community/community-ports.js";
import { normalizeChatMember } from "../../modules/membership-evidence/membership-normalization.js";

interface CommunityChatMember {
  readonly status: string;
  readonly is_member?: boolean;
  readonly can_invite_users?: boolean;
  readonly can_restrict_members?: boolean;
}

interface CommunityApi {
  getMe(): Promise<{ id: number }>;
  getChatMember(chatId: number, userId: number): Promise<CommunityChatMember>;
  unbanChatMember(
    chatId: number,
    userId: number,
    options: { only_if_banned: boolean },
  ): Promise<unknown>;
  createChatInviteLink(
    chatId: number,
    options: { creates_join_request: boolean; expire_date: number },
  ): Promise<{ invite_link: string }>;
  approveChatJoinRequest(chatId: number, userId: number): Promise<unknown>;
  declineChatJoinRequest(chatId: number, userId: number): Promise<unknown>;
  banChatMember(chatId: number, userId: number): Promise<unknown>;
  revokeChatInviteLink(chatId: number, inviteLink: string): Promise<unknown>;
}

export class GrammyCommunityChatAdapter implements TelegramCommunityChat {
  private readonly api: CommunityApi;

  constructor(token: string, api?: CommunityApi) {
    this.api = api ?? (new Api(token, { timeoutSeconds: 10 }) as CommunityApi);
  }

  async observeMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityObservation> {
    try {
      const member = await this.api.getChatMember(
        toSafeTelegramNumber(chatId),
        toSafeTelegramNumber(telegramUserId),
      );
      // A ban is the only absence that also blocks a later rejoin, so it is distinct.
      if (member.status === "kicked")
        return { kind: "observed", state: "banned" };
      const normalized = normalizeChatMember({
        ...(typeof member.is_member === "boolean"
          ? { isMember: member.is_member }
          : {}),
        status: member.status,
      });
      if (normalized === "unavailable")
        return {
          kind: "unavailable",
          diagnosticCode: "unknown_chat_member_status",
        };
      return {
        kind: "observed",
        state: normalized === "member" ? "member" : "not_member",
      };
    } catch {
      return {
        kind: "unavailable",
        diagnosticCode: "telegram_api_unavailable",
      };
    }
  }

  /** Admission and removal both need an administrator bot with the exact rights. */
  async readCapability(chatId: string): Promise<CommunityCapability> {
    try {
      const bot = await this.api.getMe();
      const member = await this.api.getChatMember(
        toSafeTelegramNumber(chatId),
        bot.id,
      );
      if (member.status === "creator") return { kind: "ready" };
      if (member.status !== "administrator")
        return {
          kind: "degraded",
          diagnosticCode: "bot_administrator_required",
        };
      if (member.can_invite_users !== true)
        return {
          kind: "degraded",
          diagnosticCode: "bot_invite_right_required",
        };
      if (member.can_restrict_members !== true)
        return {
          kind: "degraded",
          diagnosticCode: "bot_restrict_right_required",
        };
      return { kind: "ready" };
    } catch {
      return {
        kind: "unavailable",
        diagnosticCode: "telegram_api_unavailable",
      };
    }
  }

  async unbanMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome> {
    return this.mutate(() =>
      this.api.unbanChatMember(
        toSafeTelegramNumber(chatId),
        toSafeTelegramNumber(telegramUserId),
        { only_if_banned: true },
      ),
    );
  }

  async createJoinRequestLink(
    chatId: string,
    expiresAt: Date,
  ): Promise<CommunityInviteOutcome> {
    try {
      const link = await this.api.createChatInviteLink(
        toSafeTelegramNumber(chatId),
        {
          creates_join_request: true,
          expire_date: Math.floor(expiresAt.getTime() / 1000),
        },
      );
      return { kind: "created", inviteLink: link.invite_link };
    } catch (error) {
      return callFailure(error);
    }
  }

  async approveJoinRequest(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome> {
    return this.mutate(() =>
      this.api.approveChatJoinRequest(
        toSafeTelegramNumber(chatId),
        toSafeTelegramNumber(telegramUserId),
      ),
    );
  }

  async declineJoinRequest(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome> {
    return this.mutate(() =>
      this.api.declineChatJoinRequest(
        toSafeTelegramNumber(chatId),
        toSafeTelegramNumber(telegramUserId),
      ),
    );
  }

  async banMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome> {
    return this.mutate(() =>
      this.api.banChatMember(
        toSafeTelegramNumber(chatId),
        toSafeTelegramNumber(telegramUserId),
      ),
    );
  }

  async revokeInviteLink(
    chatId: string,
    inviteLink: string,
  ): Promise<CommunityCallOutcome> {
    return this.mutate(() =>
      this.api.revokeChatInviteLink(toSafeTelegramNumber(chatId), inviteLink),
    );
  }

  private async mutate(
    call: () => Promise<unknown>,
  ): Promise<CommunityCallOutcome> {
    try {
      await call();
      return { kind: "succeeded" };
    } catch (error) {
      return callFailure(error);
    }
  }
}

function callFailure(
  error: unknown,
): Exclude<CommunityCallOutcome, { kind: "succeeded" }> {
  if (error instanceof GrammyError) {
    if (error.error_code === 429 || error.error_code >= 500) {
      const retryAfterSeconds = positiveInteger(error.parameters.retry_after);
      return {
        kind: "retryable",
        providerErrorCode: error.error_code,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      };
    }
    return { kind: "rejected", providerErrorCode: error.error_code };
  }
  // No answer reached us, so the effect stays unknown until it is observed.
  return { kind: "unknown" };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function toSafeTelegramNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number === 0) {
    throw new Error("Telegram identifier is outside the safe JSON range");
  }
  return number;
}

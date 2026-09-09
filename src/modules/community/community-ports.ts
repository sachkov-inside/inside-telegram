import type {
  DispatchAuthorizationRequest,
  DispatchAuthorizationResponse,
} from "./community-contract.js";

export interface CommunityDispatchAuthorization {
  authorize(
    request: DispatchAuthorizationRequest,
  ): Promise<DispatchAuthorizationResponse | undefined>;
}

export const COMMUNITY_DISPATCH_AUTHORIZATION = Symbol(
  "COMMUNITY_DISPATCH_AUTHORIZATION",
);

/** Telegram's own view of one identity in the canonical chat. */
export type CommunityObservation =
  | {
      readonly kind: "observed";
      readonly state: "member" | "not_member" | "banned";
    }
  | { readonly kind: "unavailable"; readonly diagnosticCode: string };

/** Whether the bot may still admit and remove members in the canonical chat. */
export type CommunityCapability =
  | { readonly kind: "ready" }
  | { readonly kind: "degraded"; readonly diagnosticCode: string }
  | { readonly kind: "unavailable"; readonly diagnosticCode: string };

export type CommunityCallOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "rejected"; readonly providerErrorCode: number }
  | {
      readonly kind: "retryable";
      readonly providerErrorCode: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "unknown" };

export type CommunityInviteOutcome =
  | { readonly kind: "created"; readonly inviteLink: string }
  | Exclude<CommunityCallOutcome, { kind: "succeeded" }>;

/**
 * Every mutation is one bounded Bot API call. The provider owns sequencing,
 * the permit ledger and the durable evidence; this port only performs a call.
 */
export interface TelegramCommunityChat {
  observeMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityObservation>;
  readCapability(chatId: string): Promise<CommunityCapability>;
  unbanMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome>;
  createJoinRequestLink(
    chatId: string,
    expiresAt: Date,
  ): Promise<CommunityInviteOutcome>;
  approveJoinRequest(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome>;
  declineJoinRequest(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome>;
  banMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<CommunityCallOutcome>;
  revokeInviteLink(
    chatId: string,
    inviteLink: string,
  ): Promise<CommunityCallOutcome>;
}

export const TELEGRAM_COMMUNITY_CHAT = Symbol("TELEGRAM_COMMUNITY_CHAT");

export class DisabledTelegramCommunityChat implements TelegramCommunityChat {
  async observeMember(): Promise<CommunityObservation> {
    return { kind: "unavailable", diagnosticCode: "community_chat_disabled" };
  }
  async readCapability(): Promise<CommunityCapability> {
    return { kind: "unavailable", diagnosticCode: "community_chat_disabled" };
  }
  async unbanMember(): Promise<CommunityCallOutcome> {
    return unavailableCall();
  }
  async createJoinRequestLink(): Promise<CommunityInviteOutcome> {
    return unavailableCall();
  }
  async approveJoinRequest(): Promise<CommunityCallOutcome> {
    return unavailableCall();
  }
  async declineJoinRequest(): Promise<CommunityCallOutcome> {
    return unavailableCall();
  }
  async banMember(): Promise<CommunityCallOutcome> {
    return unavailableCall();
  }
  async revokeInviteLink(): Promise<CommunityCallOutcome> {
    return unavailableCall();
  }
}

export class DisabledCommunityDispatchAuthorization implements CommunityDispatchAuthorization {
  async authorize(): Promise<undefined> {
    return undefined;
  }
}

function unavailableCall(): Extract<
  CommunityCallOutcome,
  { kind: "retryable" }
> {
  return { kind: "retryable", providerErrorCode: 503 };
}

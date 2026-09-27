import type { StartResponseDeliveryQueue } from "../outbound/start-response-delivery-queue.js";
import type {
  DispatchAuthorizationRequest,
  DispatchAuthorizationResponse,
} from "./community-contract.js";

/** The durable private-chat outbox; the provider enqueues inside its own transaction. */
export type CommunityReadmissionReplies = Pick<
  StartResponseDeliveryQueue,
  "enqueue"
>;

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
  observeMember(): Promise<CommunityObservation> {
    return Promise.resolve({
      kind: "unavailable",
      diagnosticCode: "community_chat_disabled",
    });
  }
  readCapability(): Promise<CommunityCapability> {
    return Promise.resolve({
      kind: "unavailable",
      diagnosticCode: "community_chat_disabled",
    });
  }
  unbanMember(): Promise<CommunityCallOutcome> {
    return Promise.resolve(unavailableCall());
  }
  createJoinRequestLink(): Promise<CommunityInviteOutcome> {
    return Promise.resolve(unavailableCall());
  }
  approveJoinRequest(): Promise<CommunityCallOutcome> {
    return Promise.resolve(unavailableCall());
  }
  declineJoinRequest(): Promise<CommunityCallOutcome> {
    return Promise.resolve(unavailableCall());
  }
  banMember(): Promise<CommunityCallOutcome> {
    return Promise.resolve(unavailableCall());
  }
  revokeInviteLink(): Promise<CommunityCallOutcome> {
    return Promise.resolve(unavailableCall());
  }
}

export class DisabledCommunityDispatchAuthorization implements CommunityDispatchAuthorization {
  authorize(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

function unavailableCall(): Extract<
  CommunityCallOutcome,
  { kind: "retryable" }
> {
  return { kind: "retryable", providerErrorCode: 503 };
}

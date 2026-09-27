import type {
  CommunityCallOutcome,
  CommunityCapability,
  CommunityInviteOutcome,
  CommunityObservation,
  TelegramCommunityChat,
} from "../../src/modules/community/community-ports.js";

export type ChatCall =
  | {
      readonly method: "unban" | "approve" | "decline" | "ban";
      readonly user: string;
    }
  | { readonly method: "create_invite"; readonly expiresAt: Date }
  | { readonly method: "revoke_link"; readonly inviteLink: string };

/**
 * A small canonical-chat simulator: it records every call and moves its own
 * membership exactly the way the Bot API would after a successful mutation.
 */
export class FakeCommunityChat implements TelegramCommunityChat {
  readonly calls: ChatCall[] = [];
  capability: CommunityCapability = { kind: "ready" };
  membership: "member" | "not_member" | "banned" | "unavailable" = "not_member";
  invite: CommunityInviteOutcome = {
    kind: "created",
    inviteLink: "https://t.me/+synthetic",
  };
  mutation: CommunityCallOutcome = { kind: "succeeded" };

  readCapability(): Promise<CommunityCapability> {
    return Promise.resolve(this.capability);
  }

  observeMember(): Promise<CommunityObservation> {
    return Promise.resolve(
      this.membership === "unavailable"
        ? { kind: "unavailable", diagnosticCode: "telegram_api_unavailable" }
        : { kind: "observed", state: this.membership },
    );
  }

  unbanMember(_chatId: string, user: string): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "unban", user });
    if (this.mutation.kind === "succeeded" && this.membership === "banned")
      this.membership = "not_member";
    return Promise.resolve(this.mutation);
  }

  createJoinRequestLink(
    _chatId: string,
    expiresAt: Date,
  ): Promise<CommunityInviteOutcome> {
    this.calls.push({ method: "create_invite", expiresAt });
    return Promise.resolve(this.invite);
  }

  approveJoinRequest(
    _chatId: string,
    user: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "approve", user });
    if (this.mutation.kind === "succeeded") this.membership = "member";
    return Promise.resolve(this.mutation);
  }

  declineJoinRequest(
    _chatId: string,
    user: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "decline", user });
    return Promise.resolve({ kind: "succeeded" });
  }

  banMember(_chatId: string, user: string): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "ban", user });
    if (this.mutation.kind === "succeeded") this.membership = "banned";
    return Promise.resolve(this.mutation);
  }

  revokeInviteLink(
    _chatId: string,
    inviteLink: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "revoke_link", inviteLink });
    return Promise.resolve(this.mutation);
  }

  reset(): void {
    this.calls.length = 0;
    this.capability = { kind: "ready" };
    this.membership = "not_member";
    this.invite = { kind: "created", inviteLink: "https://t.me/+synthetic" };
    this.mutation = { kind: "succeeded" };
  }

  count(method: ChatCall["method"]): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

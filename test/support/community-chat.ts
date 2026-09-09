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

  async readCapability(): Promise<CommunityCapability> {
    return this.capability;
  }

  async observeMember(): Promise<CommunityObservation> {
    return this.membership === "unavailable"
      ? { kind: "unavailable", diagnosticCode: "telegram_api_unavailable" }
      : { kind: "observed", state: this.membership };
  }

  async unbanMember(
    _chatId: string,
    user: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "unban", user });
    if (this.mutation.kind === "succeeded" && this.membership === "banned")
      this.membership = "not_member";
    return this.mutation;
  }

  async createJoinRequestLink(
    _chatId: string,
    expiresAt: Date,
  ): Promise<CommunityInviteOutcome> {
    this.calls.push({ method: "create_invite", expiresAt });
    return this.invite;
  }

  async approveJoinRequest(
    _chatId: string,
    user: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "approve", user });
    if (this.mutation.kind === "succeeded") this.membership = "member";
    return this.mutation;
  }

  async declineJoinRequest(
    _chatId: string,
    user: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "decline", user });
    return { kind: "succeeded" };
  }

  async banMember(
    _chatId: string,
    user: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "ban", user });
    if (this.mutation.kind === "succeeded") this.membership = "banned";
    return this.mutation;
  }

  async revokeInviteLink(
    _chatId: string,
    inviteLink: string,
  ): Promise<CommunityCallOutcome> {
    this.calls.push({ method: "revoke_link", inviteLink });
    return this.mutation;
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

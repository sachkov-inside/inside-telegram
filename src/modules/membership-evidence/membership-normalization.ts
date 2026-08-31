export interface TelegramChatMember {
  readonly isMember?: boolean;
  readonly status: string;
}

export type NormalizedMembership = "member" | "non_member" | "unavailable";

export function normalizeChatMember(
  chatMember: TelegramChatMember,
): NormalizedMembership {
  switch (chatMember.status) {
    case "creator":
    case "administrator":
    case "member":
      return "member";
    case "restricted":
      return chatMember.isMember === true ? "member" : "non_member";
    case "left":
    case "kicked":
      return "non_member";
    default:
      return "unavailable";
  }
}

export function botHasMembershipPrerequisite(
  chatMember: TelegramChatMember,
): boolean {
  return (
    chatMember.status === "creator" || chatMember.status === "administrator"
  );
}

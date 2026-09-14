import type { ActivationSource } from "../../config/activation-config.js";
import {
  botHasMembershipPrerequisite,
  normalizeChatMember,
} from "../membership-evidence/membership-normalization.js";
import type { TelegramMembership } from "../membership-evidence/telegram-membership.js";

/** Source evidence never enters the canonical MembershipEvidence pipeline. */
export class SourceGroupProof {
  constructor(
    private readonly sources: readonly ActivationSource[],
    private readonly telegram: TelegramMembership,
  ) {}
  async check(
    sourceRef: string,
    identityRef: string,
    telegramUserId: string,
  ): Promise<{
    decision: "member" | "not_member" | "unavailable";
    retryAfterSeconds?: number;
  }> {
    const source = this.sources.find((entry) => entry.sourceRef === sourceRef);
    if (!source) return { decision: "unavailable" };
    if (
      source.policy === "confirmed_list" &&
      !source.confirmedIdentityRefs?.includes(identityRef)
    )
      return { decision: "not_member" };
    try {
      const bot = await this.telegram.getBotChatMember(source.chatId);
      if (bot.kind !== "observed")
        return {
          decision: "unavailable",
          ...("retryAfterSeconds" in bot
            ? { retryAfterSeconds: bot.retryAfterSeconds }
            : {}),
        };
      if (!botHasMembershipPrerequisite(bot.value))
        return { decision: "unavailable" };
      const member = await this.telegram.getChatMember(
        source.chatId,
        telegramUserId,
      );
      if (member.kind !== "observed")
        return {
          decision: "unavailable",
          ...("retryAfterSeconds" in member
            ? { retryAfterSeconds: member.retryAfterSeconds }
            : {}),
        };
      const normalized = normalizeChatMember(member.value);
      return {
        decision: normalized === "non_member" ? "not_member" : normalized,
      };
    } catch {
      return { decision: "unavailable" };
    }
  }
}

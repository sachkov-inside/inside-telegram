import { describe, expect, it } from "vitest";

import { GrammyMembershipAdapter } from "../../src/adapters/telegram/grammy-membership.adapter.js";

describe("GrammyMembershipAdapter", () => {
  it("reads bot and subject ChatMember values without normalizing them", async () => {
    const api = new ControlledTelegramApi();
    const adapter = new GrammyMembershipAdapter("synthetic-token", api);

    await expect(adapter.getBotChatMember("-1000000000000")).resolves.toEqual({
      kind: "observed",
      value: { status: "administrator" },
    });
    await expect(
      adapter.getChatMember("-1000000000000", "42"),
    ).resolves.toEqual({
      kind: "observed",
      value: { isMember: true, status: "restricted" },
    });
    expect(api.requests).toEqual([
      { chatId: -1000000000000, userId: 99 },
      { chatId: -1000000000000, userId: 42 },
    ]);
  });

  it("maps provider errors to unavailable rather than non-member", async () => {
    const adapter = new GrammyMembershipAdapter("synthetic-token", {
      async getChatMember() {
        throw new Error("provider detail must not escape");
      },
      async getMe() {
        return { id: 99 };
      },
    });

    await expect(adapter.getChatMember("-100", "42")).resolves.toEqual({
      diagnosticCode: "telegram_api_unavailable",
      kind: "unavailable",
    });
  });
});

class ControlledTelegramApi {
  readonly requests: Array<{ chatId: number; userId: number }> = [];

  async getMe() {
    return { id: 99 };
  }

  async getChatMember(chatId: number, userId: number) {
    this.requests.push({ chatId, userId });
    return userId === 99
      ? { status: "administrator" }
      : { is_member: true, status: "restricted" };
  }
}

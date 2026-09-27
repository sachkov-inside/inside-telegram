import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";

import { GrammyCommunityChatAdapter } from "../../src/adapters/telegram/grammy-community-chat.adapter.js";

const CHAT = "-1000000000000";
const USER = "10001";

function grammyError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    "Call failed",
    {
      ok: false,
      error_code: code,
      description: "synthetic",
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    },
    "banChatMember",
    {},
  );
}

type CommunityApi = NonNullable<
  ConstructorParameters<typeof GrammyCommunityChatAdapter>[1]
>;

function api(overrides: Partial<CommunityApi> = {}): CommunityApi {
  return {
    getMe: () => Promise.resolve({ id: 7 }),
    getChatMember: () => Promise.resolve({ status: "member" }),
    unbanChatMember: () => Promise.resolve({}),
    createChatInviteLink: () =>
      Promise.resolve({ invite_link: "https://t.me/+link" }),
    approveChatJoinRequest: () => Promise.resolve({}),
    declineChatJoinRequest: () => Promise.resolve({}),
    banChatMember: () => Promise.resolve({}),
    revokeChatInviteLink: () => Promise.resolve({}),
    ...overrides,
  };
}

describe("canonical chat observation", () => {
  it.each([
    ["creator", "member"],
    ["administrator", "member"],
    ["member", "member"],
    ["left", "not_member"],
    ["kicked", "banned"],
  ])("classifies %s as %s", async (status, expected) => {
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({ getChatMember: () => Promise.resolve({ status }) }),
    );
    await expect(adapter.observeMember(CHAT, USER)).resolves.toEqual({
      kind: "observed",
      state: expected,
    });
  });

  it("treats a restricted non-member as absent and a restricted member as present", async () => {
    const restricted = (isMember: boolean) =>
      new GrammyCommunityChatAdapter(
        "token",
        api({
          getChatMember: () =>
            Promise.resolve({
              status: "restricted",
              is_member: isMember,
            }),
        }),
      );
    await expect(restricted(false).observeMember(CHAT, USER)).resolves.toEqual({
      kind: "observed",
      state: "not_member",
    });
    await expect(restricted(true).observeMember(CHAT, USER)).resolves.toEqual({
      kind: "observed",
      state: "member",
    });
  });

  it("never reports an unreachable API as absence", async () => {
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({
        getChatMember: () => {
          return Promise.reject(new Error("network"));
        },
      }),
    );
    await expect(adapter.observeMember(CHAT, USER)).resolves.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("canonical chat capability", () => {
  it.each([
    [{ status: "member" }, "bot_administrator_required"],
    [
      { status: "administrator", can_restrict_members: true },
      "bot_invite_right_required",
    ],
    [
      { status: "administrator", can_invite_users: true },
      "bot_restrict_right_required",
    ],
  ])("reports %j as degraded", async (member, diagnosticCode) => {
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({ getChatMember: () => Promise.resolve(member) }),
    );
    await expect(adapter.readCapability(CHAT)).resolves.toEqual({
      kind: "degraded",
      diagnosticCode,
    });
  });

  it("accepts an administrator holding both rights", async () => {
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({
        getChatMember: () =>
          Promise.resolve({
            status: "administrator",
            can_invite_users: true,
            can_restrict_members: true,
          }),
      }),
    );
    await expect(adapter.readCapability(CHAT)).resolves.toEqual({
      kind: "ready",
    });
  });
});

describe("canonical chat mutations", () => {
  it("unbans only a confirmed ban", async () => {
    const calls: unknown[] = [];
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({
        unbanChatMember: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(true);
        },
      }),
    );
    await adapter.unbanMember(CHAT, USER);
    expect(calls[0]).toEqual([
      -1_000_000_000_000,
      10_001,
      { only_if_banned: true },
    ]);
  });

  it("creates a join-request link with an expiry and no member limit", async () => {
    const calls: unknown[] = [];
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({
        createChatInviteLink: (chatId: number, options: unknown) => {
          calls.push([chatId, options]);
          return Promise.resolve({ invite_link: "https://t.me/+link" });
        },
      }),
    );
    const outcome = await adapter.createJoinRequestLink(
      CHAT,
      new Date("2026-09-08T09:10:00Z"),
    );
    expect(outcome).toEqual({
      kind: "created",
      inviteLink: "https://t.me/+link",
    });
    expect(calls[0]).toEqual([
      -1_000_000_000_000,
      {
        creates_join_request: true,
        expire_date: Date.parse("2026-09-08T09:10:00Z") / 1000,
      },
    ]);
  });

  it.each([
    [
      grammyError(429, 7),
      { kind: "retryable", providerErrorCode: 429, retryAfterSeconds: 7 },
    ],
    [grammyError(503), { kind: "retryable", providerErrorCode: 503 }],
    [grammyError(400), { kind: "rejected", providerErrorCode: 400 }],
    [new Error("socket hang up"), { kind: "unknown" }],
  ])("classifies a failing mutation", async (error, expected) => {
    const adapter = new GrammyCommunityChatAdapter(
      "token",
      api({
        banChatMember: () => {
          return Promise.reject(error);
        },
      }),
    );
    await expect(adapter.banMember(CHAT, USER)).resolves.toEqual(expected);
  });

  it("refuses a Telegram identifier outside the safe range", async () => {
    const adapter = new GrammyCommunityChatAdapter("token", api());
    await expect(adapter.banMember(CHAT, "9007199254740993")).resolves.toEqual({
      kind: "unknown",
    });
  });
});

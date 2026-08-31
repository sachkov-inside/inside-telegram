import { describe, expect, it } from "vitest";

import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";
import { TELEGRAM_WEBHOOK_ALLOWED_UPDATES } from "../../src/modules/webhook/telegram-webhook.js";
import {
  canonicalMembershipUpdate,
  canonicalProviderMembershipUpdate,
  privateContactabilityUpdate,
  privateStartUpdate,
} from "../support/synthetic-telegram-updates.js";

const observedAt = new Date("2026-08-30T12:00:00.000Z");

describe("GrammyUpdateAdapter", () => {
  const adapter = new GrammyUpdateAdapter();

  it("pins the explicit webhook update registration", () => {
    expect(TELEGRAM_WEBHOOK_ALLOWED_UPDATES).toEqual([
      "message",
      "chat_member",
      "my_chat_member",
    ]);
  });

  it("translates an ordinary private non-bot start to verified IDs", () => {
    const largestDocumentedSafeId = 4_503_599_627_370_495;
    const command = adapter.translate(
      "inside",
      "7",
      privateStartUpdate(7, largestDocumentedSafeId),
      observedAt,
    );

    expect(command).toEqual({
      kind: "start",
      value: {
        contact: {
          botIdentity: "inside",
          observedAt,
          privateChatId: String(largestDocumentedSafeId),
          telegramUserId: String(largestDocumentedSafeId),
          updateId: "7",
        },
      },
    });
  });

  it("replaces a valid link bearer with its digest before durable storage", () => {
    const rawToken = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
    const prepared = prepareTelegramUpdateForInbox(
      privateStartUpdate(8, 42, { text: `/start ${rawToken}` }),
    );

    expect(JSON.stringify(prepared)).not.toContain(rawToken);
    expect(adapter.translate("inside", "8", prepared, observedAt)).toEqual({
      kind: "start",
      value: {
        contact: {
          botIdentity: "inside",
          observedAt,
          privateChatId: "42",
          telegramUserId: "42",
          updateId: "8",
        },
        linkToken: {
          digest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
          kind: "digest",
        },
      },
    });
  });

  it.each([
    ["42 characters", "A".repeat(42), "malformed"],
    ["43 characters", "A".repeat(43), "digest"],
    ["64 characters", "A".repeat(64), "digest"],
    ["65 characters", "A".repeat(65), "malformed"],
    ["outside base64url", `${"A".repeat(42)}+`, "malformed"],
  ])("classifies a %s link bearer", (_name, token, expectedKind) => {
    const prepared = prepareTelegramUpdateForInbox(
      privateStartUpdate(9, 42, { text: `/start ${token}` }),
    );
    const command = adapter.translate("inside", "9", prepared, observedAt);

    expect(command).toMatchObject({
      kind: "start",
      value: { linkToken: { kind: expectedKind } },
    });
    expect(JSON.stringify(prepared)).not.toContain(token);
  });

  it("trusts only link metadata derived at Telegram ingress", () => {
    const update = privateStartUpdate(10, 42);
    const prepared = prepareTelegramUpdateForInbox({
      ...update,
      message: {
        ...update.message,
        _inside_link_token: {
          digest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
          kind: "digest",
        },
      },
    });

    expect(adapter.translate("inside", "10", prepared, observedAt)).toEqual({
      kind: "start",
      value: {
        contact: {
          botIdentity: "inside",
          observedAt,
          privateChatId: "42",
          telegramUserId: "42",
          updateId: "10",
        },
      },
    });
  });

  it.each([
    ["group start", privateStartUpdate(1, 42, { chatType: "group" })],
    ["bot sender", privateStartUpdate(2, 42, { isBot: true })],
    ["missing sender", privateStartUpdate(3, 42, { omitSender: true })],
    ["tokenized start", privateStartUpdate(4, 42, { text: "/start token" })],
    ["malformed message", { update_id: 5, message: {} }],
    ["old configured update variant", { update_id: 6, poll_answer: {} }],
  ])("ignores %s", (_name, update) => {
    expect(adapter.translate("inside", "1", update, observedAt)).toEqual({
      kind: "ignored",
    });
  });

  it("translates private block observations without creating a contact", () => {
    expect(
      adapter.translate(
        "inside",
        "8",
        privateContactabilityUpdate(8, 42, "kicked"),
        observedAt,
      ),
    ).toEqual({
      kind: "contactability",
      value: {
        botIdentity: "inside",
        contactability: "blocked",
        observedAt,
        telegramUserId: "42",
        updateId: "8",
      },
    });
  });

  it("uses new_chat_member subject instead of the event actor", () => {
    expect(
      adapter.translate(
        "inside",
        "9001",
        canonicalMembershipUpdate(9001, -1_000_000_000_000, 42, "left", {
          actorUserId: 777,
          date: 1_893_456_060,
        }),
        observedAt,
      ),
    ).toEqual({
      kind: "membership",
      value: {
        actorIsSubject: false,
        botIdentity: "inside",
        canonicalChatId: "-1000000000000",
        chatMember: { status: "left" },
        eventAt: new Date("2030-01-01T00:01:00.000Z"),
        kind: "subject",
        subjectTelegramUserId: "42",
        updateId: "9001",
      },
    });
  });

  it("translates canonical bot demotion as a provider event", () => {
    expect(
      adapter.translate(
        "inside",
        "9002",
        canonicalProviderMembershipUpdate(
          9002,
          -1_000_000_000_000,
          99,
          "member",
          { date: 1_893_456_120 },
        ),
        observedAt,
      ),
    ).toEqual({
      kind: "membership",
      value: {
        botIdentity: "inside",
        canonicalChatId: "-1000000000000",
        chatMember: { status: "member" },
        eventAt: new Date("2030-01-01T00:02:00.000Z"),
        kind: "provider",
        updateId: "9002",
      },
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";
import {
  privateContactabilityUpdate,
  privateStartUpdate,
} from "../support/synthetic-telegram-updates.js";

const observedAt = new Date("2026-08-30T12:00:00.000Z");

describe("GrammyUpdateAdapter", () => {
  const adapter = new GrammyUpdateAdapter();

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
        botIdentity: "inside",
        observedAt,
        privateChatId: String(largestDocumentedSafeId),
        telegramUserId: String(largestDocumentedSafeId),
        updateId: "7",
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
        botIdentity: "inside",
        linkToken: {
          digest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
          kind: "digest",
        },
        observedAt,
        privateChatId: "42",
        telegramUserId: "42",
        updateId: "8",
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

  it.each([
    ["group start", privateStartUpdate(1, 42, { chatType: "group" })],
    ["bot sender", privateStartUpdate(2, 42, { isBot: true })],
    ["missing sender", privateStartUpdate(3, 42, { omitSender: true })],
    ["tokenized start", privateStartUpdate(4, 42, { text: "/start token" })],
    ["malformed message", { update_id: 5, message: {} }],
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
});

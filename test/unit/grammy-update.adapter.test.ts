import { describe, expect, it } from "vitest";

import { GrammyUpdateAdapter } from "../../src/adapters/telegram/grammy-update.adapter.js";
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

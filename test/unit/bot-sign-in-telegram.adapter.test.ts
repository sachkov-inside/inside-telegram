import { describe, expect, it } from "vitest";

import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";
import { GrammyMessagesAdapter } from "../../src/adapters/telegram/grammy-messages.adapter.js";
import { GrammyCallbackAnswersAdapter } from "../../src/adapters/telegram/grammy-callback-answers.adapter.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";

describe("Telegram sign-in transport", () => {
  it("cancels a stuck cosmetic callback so the caller can process the next update", async () => {
    let aborted = false;
    const adapter = new GrammyCallbackAnswersAdapter("synthetic", {
      answerCallbackQuery(_id, _options, signal) {
        return new Promise((_resolve, reject) => {
          if (!signal) throw new Error("Expected bounded callback signal");
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("Synthetic timeout"));
            },
            { once: true },
          );
        });
      },
    });
    await adapter.answer("synthetic-id");
    expect(aborted).toBe(true);
  });

  it("discards provider-supplied internal markers instead of trusting them", () => {
    const update = privateStartUpdate(1, 42);
    const prepared = prepareTelegramUpdateForInbox({
      ...update,
      message: {
        ...update.message,
        _inside_sign_in_token: { kind: "digest", digest: "a".repeat(43) },
        _inside_link_token: { kind: "digest", digest: "b".repeat(43) },
      },
    });
    const translated = new GrammyUpdateAdapter().translate(
      "inside",
      "1",
      prepared,
      new Date(),
    );
    expect(translated.kind).toBe("start");
    if (translated.kind !== "start") throw new Error("Expected start");
    expect(translated.value.signInToken).toBeUndefined();
    expect(translated.value.linkToken).toBeUndefined();
  });

  it("keeps malformed sign-in tokens separate from Account linking", () => {
    const payload = prepareTelegramUpdateForInbox(
      privateStartUpdate(1, 42, { text: "/start signin_short" }),
    );
    const command = new GrammyUpdateAdapter().translate(
      "inside",
      "1",
      payload,
      new Date(),
    );
    expect(command).toMatchObject({
      kind: "start",
      value: { signInToken: { kind: "malformed" } },
    });
    expect(JSON.stringify(payload)).not.toContain("signin_short");
  });

  it("maps confirmation buttons to inline Telegram callback data", async () => {
    let received: unknown;
    const adapter = new GrammyMessagesAdapter("synthetic", {
      async sendMessage(_chatId, _text, options) {
        received = options;
        return { message_id: 1 };
      },
    });
    await adapter.sendText({
      chatId: "42",
      text: "Synthetic",
      buttons: [{ text: "Confirm", callbackData: "synthetic-callback" }],
    });
    expect(received).toEqual({
      reply_markup: {
        inline_keyboard: [
          [{ text: "Confirm", callback_data: "synthetic-callback" }],
        ],
      },
    });
  });

  it("does not undo a durable decision when callback acknowledgement expires", async () => {
    const adapter = new GrammyCallbackAnswersAdapter("synthetic", {
      async answerCallbackQuery() {
        throw new Error("Expired synthetic callback");
      },
    });
    await expect(adapter.answer("synthetic-id")).resolves.toBeUndefined();
  });
});

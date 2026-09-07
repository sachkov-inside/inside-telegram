import type { Api } from "grammy";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { GrammyCommunicationsAdapter } from "../../src/adapters/telegram/grammy-communications.adapter.js";
import type { TemplateContent } from "../../src/modules/communications/communications-contract.js";
import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";
import { relativeDue } from "../../src/modules/communications/funnel-scheduler.js";
describe("communication transport", () => {
  for (const [type, method] of [
    ["text", "sendMessage"],
    ["photo", "sendPhoto"],
    ["video", "sendVideo"],
    ["video_note", "sendVideoNote"],
    ["voice", "sendVoice"],
    ["document", "sendDocument"],
  ] as const)
    it(`translates ${type} snapshot, entities and buttons`, async () => {
      const send = vi.fn(async () => ({ message_id: 123 }));
      const adapter = new GrammyCommunicationsAdapter({
        [method]: send,
      } as unknown as Api);
      const content: TemplateContent = {
        type,
        text: type === "video_note" ? "" : "hello",
        entities:
          type === "video_note" ? [] : [{ type: "bold", offset: 0, length: 5 }],
        buttons: [{ text: "Open", url: "https://example.com/material" }],
        ...(type !== "text" ? { fileId: "synthetic_file" } : {}),
      };
      expect(await adapter.send({ chatId: "42", content })).toEqual({
        kind: "delivered",
        providerMessageId: "123",
      });
      const options = send.mock.calls[0] as unknown as unknown[];
      expect(options.slice(0, 2)).toEqual([
        "42",
        type === "text" ? "hello" : "synthetic_file",
      ]);
      expect(options[2]).toMatchObject({
        reply_markup: {
          inline_keyboard: [
            [{ text: "Open", url: "https://example.com/material" }],
          ],
        },
      });
      if (type !== "video_note")
        expect(options[2]).toMatchObject(
          type === "text"
            ? { entities: content.entities }
            : { caption_entities: content.entities, caption: "hello" },
        );
    });
  it("classifies 429, permanent rejection and transport ambiguity without retrying inside adapter", async () => {
    const send = vi.fn();
    const adapter = new GrammyCommunicationsAdapter({
      sendMessage: send,
    } as unknown as Api);
    const message = {
      chatId: "42",
      content: {
        type: "text" as const,
        text: "synthetic",
        entities: [],
        buttons: [],
      },
    };
    send.mockRejectedValueOnce(
      new GrammyError(
        "synthetic",
        {
          ok: false,
          error_code: 429,
          description: "synthetic",
          parameters: { retry_after: 17 },
        },
        "sendMessage",
        {},
      ),
    );
    expect(await adapter.send(message)).toEqual({
      kind: "api_retryable",
      providerErrorCode: 429,
      retryAfterSeconds: 17,
    });
    send.mockRejectedValueOnce(
      new GrammyError(
        "synthetic",
        { ok: false, error_code: 400, description: "synthetic" },
        "sendMessage",
        {},
      ),
    );
    expect(await adapter.send(message)).toEqual({
      kind: "api_rejected",
      providerErrorCode: 400,
    });
    send.mockRejectedValueOnce(new Error("connection lost"));
    expect(await adapter.send(message)).toEqual({ kind: "transport_unknown" });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("separates marketing from every legacy and sign-in-shaped auth payload", () => {
    const adapter = new GrammyUpdateAdapter();
    for (const [payload, lane] of [
      ["m_general", "marketing"],
      ["m_" + "x".repeat(40), "marketing"],
      ["m_" + "x".repeat(41), "link"],
      ["signin_" + "x".repeat(35), "sign-in"],
      ["signin_" + "x".repeat(36), "link"],
      ["signin_broken", "sign-in"],
      ["x".repeat(64), "link"],
    ] as const) {
      const raw = {
        message: {
          text: `/start ${payload}`,
          from: { id: 42, is_bot: false },
          chat: { id: 42, type: "private" },
          _inside_marketing_source: "m_forged",
        },
      };
      const result = adapter.translate(
        "inside",
        "1",
        prepareTelegramUpdateForInbox(raw),
        new Date(),
      );
      expect(result.kind).toBe("start");
      if (result.kind !== "start") throw new Error("unexpected");
      expect(result.value.marketingSource).toBe(
        lane === "marketing" ? payload : undefined,
      );
      expect(!!result.value.linkToken).toBe(lane === "link");
      expect(!!result.value.signInToken).toBe(lane === "sign-in");
    }
  });
  it("counts delay from the latest enrollment/publication/completion without catch-up acceleration", () => {
    const d = (seconds: number) => new Date(seconds * 1000);
    expect(relativeDue(d(1), d(100), d(10), 20)).toEqual(d(120));
    expect(relativeDue(d(1), d(100), d(500), 20)).toEqual(d(520));
  });
});

it("accepts only explicit private human stop/resume commands and leaves auth namespaces separate", () => {
  const adapter = new GrammyUpdateAdapter();
  for (const text of ["/stop", "/resume", "/stop@InsideBot"]) {
    const value = adapter.translate(
      "inside",
      "1",
      {
        message: {
          text,
          from: { id: 42, is_bot: false },
          chat: { id: 42, type: "private" },
        },
      },
      new Date(),
    );
    expect(value.kind).toBe("marketing_preference");
  }
  for (const message of [
    {
      text: "/stop",
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "group" },
    },
    {
      text: "/resume",
      from: { id: 42, is_bot: true },
      chat: { id: 42, type: "private" },
    },
    {
      text: "/stop extra",
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
    },
    {
      text: 123,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
    },
  ])
    expect(adapter.translate("inside", "1", { message }, new Date()).kind).toBe(
      "ignored",
    );
});

it("edits author menus and only replaces definitively unavailable messages", async () => {
  const editMessageText = vi.fn().mockResolvedValue({ message_id: 17 });
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 18 });
  const adapter = new GrammyCommunicationsAdapter({
    editMessageText,
    sendMessage,
  } as unknown as Api);
  const message = {
    chatId: "42",
    authorMenu: true,
    editMessageId: "17",
    authorButtons: [{ text: "Back", callbackData: "a:token:0" }],
    content: { type: "text" as const, text: "Menu", entities: [], buttons: [] },
  };
  expect(await adapter.send(message)).toEqual({
    kind: "delivered",
    providerMessageId: "17",
  });
  expect(editMessageText).toHaveBeenCalledWith("42", 17, "Menu", {
    entities: [],
    reply_markup: {
      inline_keyboard: [[{ text: "Back", callback_data: "a:token:0" }]],
    },
  });
  const rejection = (code: number, description: string) =>
    new GrammyError(
      "synthetic",
      { ok: false, error_code: code, description },
      "editMessageText",
      {},
    );
  editMessageText.mockRejectedValueOnce(
    rejection(400, "Bad Request: message is not modified"),
  );
  expect(await adapter.send(message)).toEqual({
    kind: "delivered",
    providerMessageId: "17",
  });
  editMessageText.mockRejectedValueOnce(new Error("response lost"));
  expect(await adapter.send(message)).toEqual({ kind: "transport_unknown" });
  editMessageText.mockRejectedValueOnce(rejection(429, "Too many requests"));
  expect(await adapter.send(message)).toMatchObject({ kind: "api_retryable" });
  expect(sendMessage).not.toHaveBeenCalled();
  editMessageText.mockRejectedValueOnce(
    rejection(400, "Bad Request: message to edit not found"),
  );
  expect(await adapter.send(message)).toEqual({
    kind: "delivered",
    providerMessageId: "18",
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

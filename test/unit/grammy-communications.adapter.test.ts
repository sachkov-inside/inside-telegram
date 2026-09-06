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
    for (const [payload, marketing] of [
      ["m_general", true],
      ["m_" + "x".repeat(40), true],
      ["m_" + "x".repeat(41), false],
      ["signin_" + "x".repeat(35), false],
      ["signin_broken", false],
      ["x".repeat(64), false],
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
        marketing ? payload : undefined,
      );
      expect(!!result.value.linkToken).toBe(!marketing);
    }
  });
  it("counts delay from the latest enrollment/publication/completion without catch-up acceleration", () => {
    const d = (seconds: number) => new Date(seconds * 1000);
    expect(relativeDue(d(1), d(100), d(10), 20)).toEqual(d(120));
    expect(relativeDue(d(1), d(100), d(500), 20)).toEqual(d(520));
  });
});

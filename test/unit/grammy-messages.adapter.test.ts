import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";

import { GrammyMessagesAdapter } from "../../src/adapters/telegram/grammy-messages.adapter.js";

describe("GrammyMessagesAdapter", () => {
  it("round-trips an int64-capable chat ID through the Telegram API seam", async () => {
    let receivedChatId: number | undefined;
    const adapter = new GrammyMessagesAdapter("synthetic", {
      async sendMessage(chatId) {
        receivedChatId = chatId;
        return { message_id: 99 };
      },
    });

    await expect(
      adapter.sendText({
        chatId: "4503599627370495",
        text: "Synthetic welcome",
      }),
    ).resolves.toEqual({ kind: "delivered", providerMessageId: "99" });
    expect(receivedChatId).toBe(4_503_599_627_370_495);
  });

  it("keeps a stable API rejection terminal", async () => {
    const adapter = adapterThrowing(grammyError(403));

    await expect(sendSynthetic(adapter)).resolves.toEqual({
      kind: "api_rejected",
      providerErrorCode: 403,
    });
  });

  it("classifies 429 and its retry_after as retryable", async () => {
    const adapter = adapterThrowing(grammyError(429, 2));

    await expect(sendSynthetic(adapter)).resolves.toEqual({
      kind: "api_retryable",
      providerErrorCode: 429,
      retryAfterSeconds: 2,
    });
  });

  it("classifies 5xx as retryable and transport failure as unknown", async () => {
    await expect(
      sendSynthetic(adapterThrowing(grammyError(500))),
    ).resolves.toEqual({
      kind: "api_retryable",
      providerErrorCode: 500,
    });
    await expect(
      sendSynthetic(adapterThrowing(new Error("Synthetic transport failure"))),
    ).resolves.toEqual({ kind: "transport_unknown" });
  });
});

function adapterThrowing(error: unknown): GrammyMessagesAdapter {
  return new GrammyMessagesAdapter("synthetic", {
    async sendMessage() {
      throw error;
    },
  });
}

function grammyError(errorCode: number, retryAfter?: number): GrammyError {
  const error: ConstructorParameters<typeof GrammyError>[1] = {
    description: "Synthetic API rejection",
    error_code: errorCode,
    ok: false,
    parameters: retryAfter ? { retry_after: retryAfter } : {},
  };
  return new GrammyError("Synthetic API rejection", error, "sendMessage", {});
}

async function sendSynthetic(adapter: GrammyMessagesAdapter) {
  return adapter.sendText({ chatId: "42", text: "Synthetic welcome" });
}

import { describe, expect, it } from "vitest";
import type { ActivationConfig } from "../../src/config/activation-config.js";
import {
  ACTIVATION_ANNOUNCEMENT_BUTTON,
  ACTIVATION_ANNOUNCEMENT_TEXT,
  announceActivation,
  type ActivationAnnouncementTelegram,
} from "../../src/modules/subscription-activation/activation-announcement.js";
import type {
  TelegramDeliveryResult,
  TelegramTextMessage,
} from "../../src/modules/outbound/telegram-messages.js";

const activation: ActivationConfig = {
  enabled: true,
  endpoint: "https://platform.example/activation",
  secret: "s".repeat(32),
  accountUrl: "https://platform.example/account",
  sources: [
    { sourceRef: "course", chatId: "-1000000000001", policy: "whole_group" },
    {
      sourceRef: "listed",
      chatId: "-1000000000002",
      policy: "confirmed_list",
      confirmedIdentityRefs: [],
    },
  ],
};

function telegram(
  delivery: TelegramDeliveryResult = {
    kind: "delivered",
    providerMessageId: "7",
  },
  /** Null stands for a bot Telegram reports without a username. */
  username: string | null = "inside_bot",
) {
  const sent: TelegramTextMessage[] = [];
  const port: ActivationAnnouncementTelegram = {
    botUsername: () => Promise.resolve(username ?? undefined),
    sendText(message) {
      sent.push(message);
      return Promise.resolve(delivery);
    },
  };
  return { port, sent };
}

describe("the owner's activation announcement", () => {
  const button = {
    text: ACTIVATION_ANNOUNCEMENT_BUTTON,
    url: "https://t.me/inside_bot?start=a_course64",
  };

  it("previews the text and the button link without sending", async () => {
    const { port, sent } = telegram();
    expect(
      await announceActivation(
        { activation, sourceRef: "course", code: "course64", send: false },
        port,
      ),
    ).toEqual({ status: "ready", text: ACTIVATION_ANNOUNCEMENT_TEXT, button });
    expect(ACTIVATION_ANNOUNCEMENT_TEXT).toContain(
      "Все участники курса получают доступ",
    );
    expect(sent).toEqual([]);
  });

  it("sends one message with the button to the course group", async () => {
    const { port, sent } = telegram();
    expect(
      await announceActivation(
        { activation, sourceRef: "course", code: "course64", send: true },
        port,
      ),
    ).toMatchObject({ status: "sent", button });
    expect(sent).toEqual([
      {
        chatId: "-1000000000001",
        text: ACTIVATION_ANNOUNCEMENT_TEXT,
        buttons: [button],
      },
    ]);
  });

  it.each([
    ["activation_disabled", { activation: undefined }],
    ["activation_disabled", { activation: { ...activation, enabled: false } }],
    ["invalid_code", { code: "a_course" + "!" }],
    ["invalid_code", { code: "x".repeat(41) }],
    ["unknown_source", { sourceRef: "canonical" }],
    ["not_whole_group", { sourceRef: "listed" }],
  ])("refuses with %s and sends nothing", async (reason, change) => {
    const { port, sent } = telegram();
    expect(
      await announceActivation(
        {
          activation,
          sourceRef: "course",
          code: "course64",
          send: true,
          ...change,
        },
        port,
      ),
    ).toEqual({ status: "refused", reason });
    expect(sent).toEqual([]);
  });

  it("refuses without a bot username to build the link from", async () => {
    const { port, sent } = telegram(undefined, null);
    expect(
      await announceActivation(
        { activation, sourceRef: "course", code: "course64", send: true },
        port,
      ),
    ).toEqual({ status: "refused", reason: "no_bot_username" });
    expect(sent).toEqual([]);
  });

  it("reports a Telegram refusal and an unknown outcome apart", async () => {
    const input = {
      activation,
      sourceRef: "course",
      code: "course64",
      send: true,
    };
    expect(
      await announceActivation(
        input,
        telegram({ kind: "api_rejected", providerErrorCode: 403 }).port,
      ),
    ).toEqual({ status: "not_sent", providerErrorCode: 403 });
    expect(
      await announceActivation(
        input,
        telegram({ kind: "transport_unknown" }).port,
      ),
    ).toEqual({ status: "unknown" });
  });
});

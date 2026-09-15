import { describe, expect, it } from "vitest";

import {
  planWebhookRegistration,
  webhookRegistrationApplied,
} from "../../src/operations/webhook-registration.js";

const relayUrl = "https://telegram.example.test:88/webhooks/telegram";
const secret = "synthetic_webhook_secret";
const required = [
  "message",
  "chat_member",
  "my_chat_member",
  "chat_join_request",
  "callback_query",
];
const relayInfo = {
  url: relayUrl,
  has_custom_certificate: false,
  pending_update_count: 0,
  ip_address: "192.0.2.10",
  max_connections: 40,
  allowed_updates: [
    "message",
    "chat_member",
    "my_chat_member",
    "callback_query",
  ],
};

describe("webhook registration plan", () => {
  it("adds chat_join_request while keeping the relay port, ip_address and connection limit", () => {
    const plan = planWebhookRegistration(relayInfo, relayUrl, secret);

    expect(plan).toEqual({
      kind: "update",
      request: {
        url: relayUrl,
        ip_address: "192.0.2.10",
        max_connections: 40,
        allowed_updates: required,
        secret_token: secret,
        drop_pending_updates: false,
      },
      summary: {
        port: "88",
        ipAddressPreserved: true,
        maxConnections: 40,
        addedUpdates: ["chat_join_request"],
        removedUpdates: [],
        pendingUpdateCount: 0,
      },
    });
  });

  it("reports a registration that already receives every required update", () => {
    const plan = planWebhookRegistration(
      { ...relayInfo, allowed_updates: [...required].reverse() },
      relayUrl,
      secret,
    );

    expect(plan.kind).toBe("current");
  });

  it.each([
    [{ ...relayInfo, url: "" }, "not_registered"],
    [
      { ...relayInfo, url: "https://telegram.example.test/webhooks/telegram" },
      "url_mismatch",
    ],
    [{ ...relayInfo, has_custom_certificate: true }, "custom_certificate"],
  ])("refuses to change an unexpected registration", (info, reason) => {
    expect(planWebhookRegistration(info, relayUrl, secret)).toEqual({
      kind: "refused",
      reason,
    });
  });

  it.each([
    "http://telegram.example.test:88/webhooks/telegram",
    "https://telegram.example.test:3002/webhooks/telegram",
    "https://telegram.example.test:88/webhooks/other",
    "https://telegram.example.test:88/webhooks/telegram?token=1",
  ])(
    "rejects an expected URL outside Telegram's webhook boundary: %s",
    (url) => {
      expect(() => planWebhookRegistration(relayInfo, url, secret)).toThrow(
        "TELEGRAM_WEBHOOK_URL",
      );
    },
  );

  it("confirms the applied registration only when every preserved field reads back", () => {
    const plan = planWebhookRegistration(relayInfo, relayUrl, secret);
    if (plan.kind !== "update") throw new Error("expected an update plan");
    const readBack = { ...relayInfo, allowed_updates: required };

    expect(webhookRegistrationApplied(plan.request, readBack)).toBe(true);
    expect(
      webhookRegistrationApplied(plan.request, {
        ...readBack,
        ip_address: "192.0.2.11",
      }),
    ).toBe(false);
    expect(webhookRegistrationApplied(plan.request, relayInfo)).toBe(false);
  });
});

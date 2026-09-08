import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HttpNotificationAuthorization } from "../../src/adapters/platform/http-notification-authorization.adapter.js";
import {
  parseNotification,
  digest,
  type DispatchRequest,
  type NotificationCommand,
} from "../../src/modules/notifications/notification-contract.js";
import { loadNotificationConfig } from "../../src/config/notification-config.js";
import fixtures from "../../docs/contracts/notifications-v1/fixtures.json" with { type: "json" };
const c = fixtures.find((f) => f.name === "subscription-telegram")!
  .value as NotificationCommand;
const envelope = {
  exchange: "inside.notifications.telegram.v1",
  routingKey: "subscription",
  contentType: "application/json",
  type: c.contractVersion,
  messageId: c.operationId,
  persistent: true,
};
it("runtime schema is byte-identical to the approved corpus", () => {
  expect(
    readFileSync("src/modules/notifications/contracts/schema.json"),
  ).toEqual(readFileSync("docs/contracts/notifications-v1/schema.json"));
});
it.each([
  { exchange: "inside.notifications.email.v1" },
  { routingKey: "material" },
  { type: "inside.notification-delivery.v2" },
  { messageId: randomUUID() },
  { persistent: false },
  { contentType: "text/plain" },
])("rejects wrong transport binding %j", (change) => {
  expect(
    parseNotification(
      Buffer.from(JSON.stringify(c)),
      { ...envelope, ...change },
      "subscription",
    ),
  ).toBeUndefined();
});
it.each([
  { binding: { ...c.binding, channel: "email" } },
  { text: "x".repeat(3001) },
  { injected: "actor" },
  { issuedAt: c.notAfter },
  { notAfter: "2026-09-09T12:00:00Z" },
  { commandRevision: Number.MAX_SAFE_INTEGER + 1 },
])("rejects invalid/foreign/deadline command %j", (change) => {
  expect(
    parseNotification(
      Buffer.from(JSON.stringify({ ...c, ...change })),
      envelope,
      "subscription",
    ),
  ).toBeUndefined();
});
it("lowercases UUID fields but preserves opaque references, text, wire times and key-independent digest", () => {
  const value = {
    ...c,
    operationId: randomUUID(),
    binding: {
      ...c.binding,
      accountRef: "UPPER-opaque",
      linkRef: randomUUID(),
    },
  };
  const uppercase = {
    ...value,
    operationId: value.operationId.toUpperCase(),
    binding: { ...value.binding, linkRef: value.binding.linkRef.toUpperCase() },
  };
  const parsed = parseNotification(
    Buffer.from(JSON.stringify(uppercase)),
    { ...envelope, messageId: uppercase.operationId },
    "subscription",
  );
  expect(parsed).toEqual(value);
  expect(digest(Object.fromEntries(Object.entries(value).reverse()))).toBe(
    digest(value),
  );
});
describe("HTTP notification dispatch authorization", () => {
  const request: DispatchRequest = {
    contractVersion: "inside.notification-dispatch.v1",
    operationId: randomUUID(),
    deliveryOperationId: c.operationId,
    deliveryRef: c.deliveryRef,
    commandRevision: 1,
    payloadDigest: digest(c),
    attemptRef: randomUUID(),
  };
  const allowed = {
    ...request,
    status: "allowed",
    permitRef: randomUUID(),
    validUntil: "2026-09-08T12:00:05Z",
  };
  it.each([
    [200, allowed, true],
    [503, allowed, false],
    [200, { ...allowed, attemptRef: randomUUID() }, false],
    [200, { ...allowed, contractVersion: "wrong" }, false],
    [200, { ...allowed, extra: true }, false],
    [503, { ...request, status: "error", code: "unavailable" }, true],
    [
      200,
      { ...request, status: "denied", reason: "preference_disabled" },
      true,
    ],
    [200, { ...allowed, extra: "x".repeat(17000) }, false],
  ])(
    "validates response and HTTP correlation %#",
    async (status, body, valid) => {
      const client = new HttpNotificationAuthorization(
        "https://platform.example/internal/notifications/dispatch/authorize",
        "synthetic",
        async (_url, options) => {
          expect(options?.redirect).toBe("error");
          expect(options?.signal).toBeDefined();
          expect(JSON.parse(String(options?.body))).toEqual(request);
          return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      );
      expect(Boolean(await client.authorize(request))).toBe(valid);
    },
  );
});
it("configuration is opt-in, TLS-bound, separately scoped and capacity-bounded", () => {
  expect(loadNotificationConfig({})).toBeUndefined();
  const env = {
    TELEGRAM_NOTIFICATIONS_ENABLED: "true",
    NOTIFICATION_AMQP_URL: "amqps://provider:synthetic@rabbit.example/inside",
    NOTIFICATION_AUTHORIZE_URL:
      "https://platform.example/internal/notifications/dispatch/authorize",
    NOTIFICATION_AUTHORIZE_SECRET: "a".repeat(32),
    NOTIFICATION_QUARANTINE_KEY: "b".repeat(64),
  };
  expect(loadNotificationConfig(env)?.prefetch).toBe(10);
  for (const change of [
    { NOTIFICATION_AMQP_URL: "amqp://rabbit.example/inside" },
    { NOTIFICATION_PREFETCH: "0" },
    { PLATFORM_AUTHOR_AUTHORIZATION_SECRET: env.NOTIFICATION_AUTHORIZE_SECRET },
    { NOTIFICATION_AUTHORIZE_URL: "https://platform.example/wrong" },
  ])
    expect(() => loadNotificationConfig({ ...env, ...change })).toThrow();
});

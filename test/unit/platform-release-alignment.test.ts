import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadApplicationConfig } from "../../src/config/application-config.js";
import topology from "../../docs/operations/notification-topology.json" with { type: "json" };

/**
 * Values owned by Platform and vendored here for the joint production release (Platform #527):
 * the public tracking route from `docs/integrations/communications-v1.md` ("Public tracking"),
 * `NOTIFICATION_QUEUE_CAPACITY` from `notification-transport/topology.ts` and
 * `NOTIFICATION_MESSAGE_MAX_BYTES` from `notification-transport/wire.ts`.
 */
const PLATFORM_TRACKING_VISIT_PATH = "/communications/visit";
const PLATFORM_NOTIFICATION_QUEUE_CAPACITY = 1_000;
const PLATFORM_NOTIFICATION_MESSAGE_MAX_BYTES = 16 * 1024;

const baseEnvironment = {
  DATABASE_URL: "postgresql://inside:inside@127.0.0.1:5432/inside",
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret_for_tests_only",
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret_for_tests_only",
  TELEGRAM_WELCOME_TEXT: "test",
  TELEGRAM_LINK_RECEIPT_TEXT: "test",
  TELEGRAM_LINKED_MEMBER_TEXT: "test",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "test",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "test",
};

/** Reads an optional, commented-out assignment from `.env.example`. */
function exampleValue(name: string): string {
  const match = readFileSync(".env.example", "utf8").match(
    new RegExp(`^# ${name}=(.+)$`, "m"),
  );
  if (!match?.[1]) throw new Error(`${name} is missing from .env.example`);
  return match[1];
}

describe("alignment with the Platform production release", () => {
  it("sends tracked links to the Platform communications visit route", () => {
    const config = loadApplicationConfig({
      ...baseEnvironment,
      PLATFORM_TRACKING_REDIRECT_URL: exampleValue(
        "PLATFORM_TRACKING_REDIRECT_URL",
      ),
      PLATFORM_TRACKING_TARGET_PREFIXES: exampleValue(
        "PLATFORM_TRACKING_TARGET_PREFIXES",
      ),
    });
    const redirect = new URL(config.platformTrackingRedirectUrl!);
    expect(redirect.pathname).toBe(PLATFORM_TRACKING_VISIT_PATH);
    expect(
      config.platformTrackingTargetPrefixes!.map(
        (prefix) => new URL(prefix).pathname,
      ),
    ).toEqual(["/materials/", "/series/"]);

    const production = readFileSync("docs/operations/production.md", "utf8");
    const row = production
      .split("\n")
      .find((line) => line.startsWith("| Переходы по ссылкам |"));
    expect(row).toContain(
      `\`PLATFORM_TRACKING_REDIRECT_URL=https://<platform>${PLATFORM_TRACKING_VISIT_PATH}\``,
    );
    expect(production).not.toMatch(/communications\/go\b/);
  });

  it("declares the notification queue capacity of the Platform topology generator", () => {
    for (const queue of topology.queues) {
      expect(queue.arguments["x-max-length"], queue.name).toBe(
        PLATFORM_NOTIFICATION_QUEUE_CAPACITY,
      );
      expect(queue.arguments["x-max-length-bytes"], queue.name).toBe(
        PLATFORM_NOTIFICATION_QUEUE_CAPACITY *
          PLATFORM_NOTIFICATION_MESSAGE_MAX_BYTES,
      );
    }
  });
});

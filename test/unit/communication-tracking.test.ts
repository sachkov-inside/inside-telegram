import { describe, expect, it } from "vitest";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { isTrackingDestination } from "../../src/modules/communications/communication-tracking.js";
const environment = {
  DATABASE_URL: "postgresql://inside:inside@127.0.0.1:5432/inside",
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_secret",
  TELEGRAM_WELCOME_TEXT: "test",
  TELEGRAM_LINK_RECEIPT_TEXT: "test",
  TELEGRAM_LINKED_MEMBER_TEXT: "test",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "test",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "test",
  PLATFORM_TRACKING_REDIRECT_URL: "https://platform.example/communications/go",
  PLATFORM_TRACKING_TARGET_PREFIXES:
    '["https://platform.example/materials/","https://platform.example/series/"]',
};
describe("tracking destination seam", () => {
  const config = loadApplicationConfig(environment);
  it("accepts configured content paths and rejects secret, arbitrary, lookalike and redirect destinations", () => {
    for (const url of [
      "https://platform.example/materials/test",
      "https://platform.example/series/test",
    ])
      expect(isTrackingDestination(url, config)).toBe(true);
    for (const url of [
      "https://platform.example/redirect?url=https://evil.example",
      "https://platform.example/materials/test?auth=secret",
      "https://platform.example/materials/test#secret",
      "https://platform.example/materials/../auth/secret",
      "https://platform.example.evil.test/materials/test",
      "https://platform.example@evil.test/materials/test",
      "https://user:secret@platform.example/materials/test",
      "https://platform.example/materials/",
      "https://platform.example/communications/go",
      "https://api.telegram.org/file/botSynthetic/example",
      "http://platform.example/materials/test",
      "javascript:alert(1)",
    ])
      expect(isTrackingDestination(url, config), url).toBe(false);
  });
  it("rejects partially configured and unrestricted target prefixes at startup", () => {
    for (const override of [
      { PLATFORM_TRACKING_TARGET_PREFIXES: "" },
      { PLATFORM_TRACKING_REDIRECT_URL: "" },
      { PLATFORM_TRACKING_TARGET_PREFIXES: '["https://platform.example/"]' },
      {
        PLATFORM_TRACKING_TARGET_PREFIXES:
          '["https://platform.example/materials"]',
      },
      {
        PLATFORM_TRACKING_TARGET_PREFIXES:
          '["https://platform.example/communications/"]',
      },
      {
        PLATFORM_TRACKING_REDIRECT_URL:
          "https://user:secret@platform.example/go",
      },
    ])
      expect(() =>
        loadApplicationConfig({ ...environment, ...override }),
      ).toThrow();
  });
});

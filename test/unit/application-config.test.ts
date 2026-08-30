import { describe, expect, it } from "vitest";

import { loadApplicationConfig } from "../../src/config/application-config.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://inside:inside@127.0.0.1:5432/inside",
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_LINK_RECEIPT_TEXT: "Synthetic link receipt",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_secret",
  TELEGRAM_WELCOME_TEXT: "Synthetic welcome",
};

describe("application configuration", () => {
  it("keeps external delivery disabled by default", () => {
    const config = loadApplicationConfig(validEnvironment);

    expect(config.deliveryMode).toBe("disabled");
    expect(config.workersEnabled).toBe(true);
  });

  it("requires a token before live external delivery can start", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_DELIVERY_MODE: "live",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is required");
  });

  it("rejects an invalid webhook secret alphabet", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_WEBHOOK_SECRET: "contains spaces",
      }),
    ).toThrow("TELEGRAM_WEBHOOK_SECRET");
  });

  it("requires a distinct Platform integration credential", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_INTEGRATION_SECRET: undefined,
      }),
    ).toThrow("PLATFORM_INTEGRATION_SECRET is required");
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { HttpSalesFunnelAdapter } from "../../src/adapters/platform/http-sales-funnel.adapter.js";
import { GrammyUpdateAdapter } from "../../src/adapters/telegram/grammy-update.adapter.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import fixtures from "../../src/contracts/inside-sales-funnel-events-v1/fixtures.json" with { type: "json" };
import provenance from "../../src/contracts/inside-sales-funnel-events-v1/provenance.json" with { type: "json" };
import schema from "../../src/contracts/inside-sales-funnel-events-v1/schema.json" with { type: "json" };
import {
  SALES_FUNNEL_EVENTS_VERSION,
  salesFunnelEventId,
  salesFunnelSourceCode,
  type SalesFunnelEvent,
} from "../../src/modules/sales-funnel/sales-funnel-events.js";
import { jsonRecord, requestBody, requestUrl } from "../support/json.js";

const ajv = new Ajv.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const validRequest = ajv.compile(schema.request);
const envelope = (event: unknown) => ({
  contractVersion: SALES_FUNNEL_EVENTS_VERSION,
  events: [event],
});

const event: SalesFunnelEvent = {
  eventId: salesFunnelEventId("bot_entered:inside:1"),
  contactRef: "0b7e4c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b",
  occurredAt: "2030-01-01T00:00:00.000Z",
  kind: "bot_entered",
  sourceCode: "m_survey",
};

describe("inside.sales-funnel-events.v1 contract", () => {
  it("keeps the vendored files as recorded in their provenance", () => {
    for (const [file, sha256] of Object.entries(provenance.files))
      expect(
        createHash("sha256")
          .update(
            readFileSync(`src/contracts/inside-sales-funnel-events-v1/${file}`),
          )
          .digest("hex"),
      ).toBe(sha256);
  });

  it.each(fixtures.valid)("Platform accepts $name", ({ event: value }) => {
    expect(validRequest(envelope(value))).toBe(true);
  });

  it.each(fixtures.invalid)("Platform rejects $name", ({ event: value }) => {
    expect(validRequest(envelope(value))).toBe(false);
  });

  it("derives a stable lowercase UUID per fact that Platform accepts as an event id", () => {
    const id = salesFunnelEventId("bot_entered:inside:1");
    expect(id).toBe(salesFunnelEventId("bot_entered:inside:1"));
    expect(id).not.toBe(salesFunnelEventId("bot_entered:inside:2"));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(validRequest(envelope(event))).toBe(true);
  });

  it("sends a source label Platform accepts and treats anything else as unlabelled", () => {
    expect(salesFunnelSourceCode("m_survey")).toBe("m_survey");
    expect(salesFunnelSourceCode(undefined)).toBeNull();
    expect(salesFunnelSourceCode("m_x y")).toBeNull();
    expect(salesFunnelSourceCode("m_бот")).toBeNull();
  });
});

describe("HttpSalesFunnelAdapter", () => {
  const url =
    "https://platform.example.test/integrations/telegram/v1/sales-funnel/events";
  const secret = "synthetic_sales_funnel_secret_for_tests";
  const receipt = (accepted: number, duplicates: number) =>
    new Response(
      JSON.stringify({
        contractVersion: SALES_FUNNEL_EVENTS_VERSION,
        accepted,
        duplicates,
      }),
      { status: 200 },
    );

  it("posts one versioned event with its credential and never follows redirects", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const adapter = new HttpSalesFunnelAdapter(url, secret, (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(receipt(1, 0));
    });
    await expect(adapter.deliver(event)).resolves.toEqual({
      kind: "delivered",
      duplicates: 0,
    });
    expect(calls[0]?.url).toBe(url);
    expect(calls[0]?.init).toMatchObject({
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
    });
    const body = jsonRecord(requestBody(calls[0]?.init));
    expect(body).toEqual(envelope(event));
    expect(validRequest(body)).toBe(true);
  });

  it("reads a repeated delivery as delivered with one duplicate", async () => {
    const adapter = new HttpSalesFunnelAdapter(url, secret, () =>
      Promise.resolve(receipt(0, 1)),
    );
    await expect(adapter.deliver(event)).resolves.toEqual({
      kind: "delivered",
      duplicates: 1,
    });
  });

  it("stops on a 409 conflict and retries every other answer", async () => {
    for (const [status, result] of [
      [409, { kind: "conflict" }],
      [400, { kind: "retryable", diagnosticCode: "platform_http_400" }],
      [401, { kind: "retryable", diagnosticCode: "platform_http_401" }],
      [503, { kind: "retryable", diagnosticCode: "platform_http_503" }],
    ] as const) {
      const adapter = new HttpSalesFunnelAdapter(url, secret, () =>
        Promise.resolve(new Response("{}", { status })),
      );
      await expect(adapter.deliver(event)).resolves.toEqual(result);
    }
  });

  it("retries a receipt that does not account for the event and a transport failure", async () => {
    const wrong = new HttpSalesFunnelAdapter(url, secret, () =>
      Promise.resolve(receipt(0, 0)),
    );
    await expect(wrong.deliver(event)).resolves.toEqual({
      kind: "retryable",
      diagnosticCode: "platform_receipt_invalid",
    });
    const down = new HttpSalesFunnelAdapter(url, secret, () =>
      Promise.reject(new Error("synthetic network failure")),
    );
    await expect(down.deliver(event)).resolves.toEqual({
      kind: "retryable",
      diagnosticCode: "platform_transport_unavailable",
    });
  });
});

describe("sales funnel configuration", () => {
  const base = {
    DATABASE_URL: "postgresql://inside:inside@127.0.0.1:5433/inside_telegram",
    TELEGRAM_BOT_IDENTITY: "inside",
    TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
    TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret_for_tests_only",
    PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret_for_tests_only",
    TELEGRAM_WELCOME_TEXT: "synthetic welcome",
    TELEGRAM_LINK_RECEIPT_TEXT: "synthetic receipt",
    TELEGRAM_LINKED_MEMBER_TEXT: "synthetic member",
    TELEGRAM_LINKED_NON_MEMBER_TEXT: "synthetic non-member",
    TELEGRAM_LINKED_UNAVAILABLE_TEXT: "synthetic unavailable",
  };
  const live = {
    PLATFORM_SALES_FUNNEL_DELIVERY_MODE: "live",
    PLATFORM_SALES_FUNNEL_EVENTS_URL:
      "https://platform.example.test/integrations/telegram/v1/sales-funnel/events",
    PLATFORM_SALES_FUNNEL_EVENTS_SECRET:
      "synthetic_sales_funnel_secret_for_tests",
  };

  it("keeps delivery and the consent prompt off by default", () => {
    expect(loadApplicationConfig(base).salesFunnel).toEqual({});
  });

  it("delivers only with a secure endpoint and its own credential", () => {
    expect(loadApplicationConfig({ ...base, ...live }).salesFunnel).toEqual({
      delivery: {
        url: live.PLATFORM_SALES_FUNNEL_EVENTS_URL,
        secret: live.PLATFORM_SALES_FUNNEL_EVENTS_SECRET,
      },
    });
    expect(() =>
      loadApplicationConfig({
        ...base,
        ...live,
        PLATFORM_SALES_FUNNEL_EVENTS_URL: "http://platform.example.test/x",
      }),
    ).toThrow("PLATFORM_SALES_FUNNEL_EVENTS_URL requires HTTPS");
    expect(() =>
      loadApplicationConfig({
        ...base,
        ...live,
        PLATFORM_SALES_FUNNEL_EVENTS_SECRET: base.PLATFORM_INTEGRATION_SECRET,
      }),
    ).toThrow("must be separate service secrets");
    expect(() =>
      loadApplicationConfig({
        ...base,
        PLATFORM_SALES_FUNNEL_DELIVERY_MODE: "live",
      }),
    ).toThrow("PLATFORM_SALES_FUNNEL_EVENTS_URL is required");
  });

  it("takes the consent wording as one complete set", () => {
    const texts = {
      TELEGRAM_MARKETING_CONSENT_TEXT: "prompt",
      TELEGRAM_MARKETING_CONSENT_BUTTON: "agree",
      TELEGRAM_MARKETING_CONSENT_CONFIRMATION: "thanks",
    };
    expect(loadApplicationConfig({ ...base, ...texts }).salesFunnel).toEqual({
      consent: { prompt: "prompt", button: "agree", confirmation: "thanks" },
    });
    expect(() =>
      loadApplicationConfig({
        ...base,
        TELEGRAM_MARKETING_CONSENT_TEXT: "prompt",
      }),
    ).toThrow("are set together");
  });
});

describe("consent button routing", () => {
  const adapter = new GrammyUpdateAdapter();
  const press = (from: number, chat: number, data = "marketing:consent") => ({
    update_id: 5,
    callback_query: {
      id: "callback-5",
      from: { id: from, is_bot: false },
      message: { message_id: 1, chat: { id: chat, type: "private" } },
      data,
    },
  });
  const observedAt = new Date("2030-01-01T00:00:00.000Z");

  it("reads the person's own press as an explicit consent", () => {
    expect(adapter.translate("inside", "5", press(42, 42), observedAt)).toEqual(
      {
        kind: "marketing_preference",
        value: {
          contact: {
            botIdentity: "inside",
            updateId: "5",
            observedAt,
            telegramUserId: "42",
            privateChatId: "42",
          },
          enabled: true,
          via: "consent",
        },
        callbackQueryId: "callback-5",
      },
    );
  });

  it("ignores a press outside the person's own chat or with other data", () => {
    expect(
      adapter.translate("inside", "5", press(42, 43), observedAt).kind,
    ).not.toBe("marketing_preference");
    expect(
      adapter.translate(
        "inside",
        "5",
        press(42, 42, "marketing:other"),
        observedAt,
      ).kind,
    ).not.toBe("marketing_preference");
  });
});

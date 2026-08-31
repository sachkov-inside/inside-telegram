import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../src/app.module.js";
import type { ApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const config: ApplicationConfig = {
  botIdentity: "inside",
  canonicalChatId: "-1000000000000",
  databaseUrl,
  deliveryMode: "disabled",
  evidenceDeliveryMode: "disabled",
  host: "127.0.0.1",
  linkReceiptText: "Synthetic link receipt",
  linkedMemberText: "Synthetic member status",
  linkedNonMemberText: "Synthetic non-member status",
  linkedUnavailableText: "Synthetic unavailable status",
  membershipMode: "disabled",
  membershipReconciliationCadenceMilliseconds: 240_000,
  platformIntegrationSecret: "synthetic_platform_secret",
  port: 3002,
  webhookSecret: "synthetic_webhook_secret",
  welcomeText: "Synthetic welcome",
  workersEnabled: false,
};

let application: NestFastifyApplication;
let database: Database;
let fastify: FastifyInstance;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
  application = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
    { logger: false },
  );
  await application.init();
  fastify = application.getHttpAdapter().getInstance() as FastifyInstance;
  await fastify.ready();
});

beforeEach(async () => {
  await sql`
    truncate table
      identity_link_events,
      platform_links,
      link_transactions,
      start_response_delivery_attempts,
      start_response_deliveries,
      bot_contact_events,
      bot_contacts,
      telegram_updates
    restart identity cascade
  `.execute(database);
});

afterAll(async () => {
  await application.close();
  await database.destroy();
});

describe("Platform identity-linking HTTP contract", () => {
  it("rejects missing and wrong integration credentials before registration", async () => {
    const body = beginLinkBody();
    const missing = await fastify.inject({
      method: "POST",
      payload: body,
      url: "/integrations/platform/v1/identity-links",
    });
    const wrong = await fastify.inject({
      headers: { authorization: "Bearer wrong_platform_secret" },
      method: "POST",
      payload: body,
      url: "/integrations/platform/v1/identity-links",
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    const count = await database
      .selectFrom("link_transactions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);
  });

  it("rejects unsupported or expanded wire envelopes", async () => {
    const unsupported = await fastify.inject({
      headers: platformAuthorization(),
      method: "POST",
      payload: {
        ...beginLinkBody(),
        contractVersion: "inside.identity-linking.v2",
      },
      url: "/integrations/platform/v1/identity-links",
    });
    const expanded = await fastify.inject({
      headers: platformAuthorization(),
      method: "POST",
      payload: {
        ...beginLinkBody(),
        email: "must-not-cross-the-seam@example.test",
      },
      url: "/integrations/platform/v1/identity-links",
    });

    expect(unsupported.statusCode).toBe(400);
    expect(expanded.statusCode).toBe(400);
    expect(expanded.json()).toEqual({
      contractVersion: "inside.identity-linking.v1",
      status: "malformed",
    });
  });

  it("links through durable private start without storing the raw bearer", async () => {
    const rawToken = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
    const registration = await fastify.inject({
      headers: platformAuthorization(),
      method: "POST",
      payload: beginLinkBody(),
      url: "/integrations/platform/v1/identity-links",
    });
    expect(registration.statusCode).toBe(201);
    const challenge = registration.json<{
      linkTransactionRef: string;
      status: string;
    }>();
    expect(challenge.status).toBe("pending");

    const webhook = await fastify.inject({
      headers: {
        "x-telegram-bot-api-secret-token": config.webhookSecret,
      },
      method: "POST",
      payload: privateStartUpdate(80, 42, {
        text: `/start ${rawToken}`,
      }),
      url: "/webhooks/telegram",
    });
    expect(webhook.statusCode).toBe(202);
    const inbox = await database
      .selectFrom("telegram_updates")
      .select("payload")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(inbox.payload)).not.toContain(rawToken);

    await application.get(TelegramUpdateProcessor).processAvailable();
    await fastify.inject({
      headers: {
        "x-telegram-bot-api-secret-token": config.webhookSecret,
      },
      method: "POST",
      payload: privateStartUpdate(81, 42, {
        text: `/start ${rawToken}`,
      }),
      url: "/webhooks/telegram",
    });
    await application.get(TelegramUpdateProcessor).processAvailable();
    const transactionalResponses = await database
      .selectFrom("start_response_deliveries")
      .select("message_text")
      .orderBy("trigger_update_id")
      .execute();
    expect(transactionalResponses).toEqual([
      { message_text: config.linkReceiptText },
      { message_text: config.linkReceiptText },
    ]);
    const linksBeforeConfirmation = await database
      .selectFrom("platform_links")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(linksBeforeConfirmation.count)).toBe(0);

    const confirmation = await confirm(
      challenge.linkTransactionRef,
      "account-ref-a",
      "return-ref-a",
    );
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.json()).toEqual({
      contractVersion: "inside.identity-linking.v1",
      linkTransactionRef: challenge.linkTransactionRef,
      returnCorrelation: "return-ref-a",
      status: "linked",
      telegramIdentityRef: expect.any(String),
    });
  });
});

function beginLinkBody() {
  return {
    accountRef: "account-ref-a",
    contractVersion: "inside.identity-linking.v1",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    returnCorrelation: "return-ref-a",
    tokenDigest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
  };
}

function platformAuthorization() {
  return {
    authorization: `Bearer ${config.platformIntegrationSecret}`,
  };
}

async function confirm(
  linkTransactionRef: string,
  accountRef: string,
  returnCorrelation: string,
) {
  return fastify.inject({
    headers: platformAuthorization(),
    method: "POST",
    payload: {
      accountRef,
      contractVersion: "inside.identity-linking.v1",
      returnCorrelation,
    },
    url: `/integrations/platform/v1/identity-links/${linkTransactionRef}/confirm`,
  });
}

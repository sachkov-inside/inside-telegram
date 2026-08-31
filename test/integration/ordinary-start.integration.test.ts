import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../src/app.module.js";
import type { ApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateDown, migrateToLatest } from "../../src/database/migrator.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import type {
  TelegramDeliveryResult,
  TelegramMessages,
  TelegramTextMessage,
} from "../../src/modules/outbound/telegram-messages.js";
import { StartResponseDeliveryProcessor } from "../../src/modules/outbound/start-response-delivery-processor.js";
import { StartResponseDeliveryQueue } from "../../src/modules/outbound/start-response-delivery-queue.js";
import { TelegramUpdateInbox } from "../../src/modules/update-inbox/telegram-update-inbox.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { RuntimeMetrics } from "../../src/operations/runtime-metrics.js";
import {
  privateContactabilityUpdate,
  privateStartUpdate,
} from "../support/synthetic-telegram-updates.js";

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
  platformIntegrationSecret: "synthetic_platform_secret",
  port: 3002,
  webhookSecret: "synthetic_secret",
  welcomeText: "Synthetic welcome",
  workersEnabled: false,
};

let application: NestFastifyApplication;
let database: Database;
let fastify: FastifyInstance;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
  await migrateDown(database);
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

describe("database foundation", () => {
  it("rebuilds the identity-linking migration down and forward", async () => {
    await migrateDown(database);
    const membershipRemoved = await sql<{ exists: boolean }>`
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'membership_evidence_outbox'
      ) as exists
    `.execute(database);
    expect(membershipRemoved.rows[0]?.exists).toBe(false);

    await migrateDown(database);
    const removed = await sql<{ exists: boolean }>`
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public' and table_name = 'link_transactions'
      ) as exists
    `.execute(database);
    expect(removed.rows[0]?.exists).toBe(false);

    await migrateToLatest(database);
    const restored = await sql<{ exists: boolean }>`
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public' and table_name = 'link_transactions'
      ) as exists
    `.execute(database);
    expect(restored.rows[0]?.exists).toBe(true);
  });
});

describe("BotContacts", () => {
  it("atomically creates one contact and one welcome for a replayed update", async () => {
    const contacts = new BotContacts(database, config);
    const start = verifiedStart("4503599627370495", "1");

    await expect(contacts.observeStart(start)).resolves.toEqual({
      contact: "created",
      responsePlanned: true,
    });
    await expect(contacts.observeStart(start)).resolves.toEqual({
      contact: "refreshed",
      responsePlanned: false,
    });

    const stored = await database
      .selectFrom("bot_contacts")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(stored.telegram_user_id).toBe("4503599627370495");
    expect(stored.private_chat_id).toBe("4503599627370495");
    await expect(tableCount("bot_contacts")).resolves.toBe(1);
    await expect(tableCount("bot_contact_events")).resolves.toBe(1);
    await expect(tableCount("start_response_deliveries")).resolves.toBe(1);
  });

  it("reactivates a blocked contact without replacing its history", async () => {
    const contacts = new BotContacts(database, config);
    await contacts.observeStart(verifiedStart("42", "1"));
    await contacts.observeContactability({
      botIdentity: "inside",
      contactability: "blocked",
      observedAt: new Date("2026-08-30T12:01:00.000Z"),
      telegramUserId: "42",
      updateId: "2",
    });

    await expect(
      contacts.observeStart(
        verifiedStart("42", "3", "2026-08-30T12:02:00.000Z"),
      ),
    ).resolves.toEqual({
      contact: "reactivated",
      responsePlanned: true,
    });

    const stored = await database
      .selectFrom("bot_contacts")
      .select(["contactability", "first_started_at", "last_started_at"])
      .executeTakeFirstOrThrow();
    expect(stored.contactability).toBe("reachable");
    expect(stored.first_started_at.toISOString()).toBe(
      "2026-08-30T12:00:00.000Z",
    );
    expect(stored.last_started_at.toISOString()).toBe(
      "2026-08-30T12:02:00.000Z",
    );
    await expect(tableCount("bot_contacts")).resolves.toBe(1);
    await expect(tableCount("bot_contact_events")).resolves.toBe(3);
    await expect(tableCount("start_response_deliveries")).resolves.toBe(2);
  });
});

describe("Telegram webhook contract", () => {
  it("reports liveness, database readiness and redacted counters", async () => {
    const health = await fastify.inject({ method: "GET", url: "/health" });
    const ready = await fastify.inject({ method: "GET", url: "/ready" });
    const metrics = await fastify.inject({ method: "GET", url: "/metrics" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("inside_telegram_webhook_accepted_total");
    expect(metrics.body).not.toContain(config.webhookSecret);
  });

  it("rejects missing/wrong secrets and malformed bodies before durable insert", async () => {
    const payload = privateStartUpdate(10, 42);

    const missing = await injectWebhook(payload);
    const wrong = await injectWebhook(payload, "wrong_secret");
    const malformed = await fastify.inject({
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": config.webhookSecret,
      },
      method: "POST",
      payload: '{"update_id":',
      url: "/webhooks/telegram",
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(400);
    await expect(tableCount("telegram_updates")).resolves.toBe(0);
  });

  it("commits an authenticated update before 2xx and acknowledges replay", async () => {
    const payload = privateStartUpdate(11, 42);

    const first = await injectWebhook(payload, config.webhookSecret);
    const replay = await injectWebhook(payload, config.webhookSecret);

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    await expect(tableCount("telegram_updates")).resolves.toBe(1);
    await expect(tableCount("bot_contacts")).resolves.toBe(0);
    const inbox = await database
      .selectFrom("telegram_updates")
      .select(["state", "update_id"])
      .executeTakeFirstOrThrow();
    expect(inbox).toEqual({ state: "pending", update_id: "11" });
  });

  it("ignores starts that cannot prove a private human sender", async () => {
    const payloads = [
      privateStartUpdate(20, 42, { chatType: "group" }),
      privateStartUpdate(21, 42, { isBot: true }),
      privateStartUpdate(22, 42, { omitSender: true }),
      { update_id: 24, message: {} },
    ];
    for (const payload of payloads) {
      const response = await injectWebhook(payload, config.webhookSecret);
      expect(response.statusCode).toBe(202);
    }

    const processor = application.get(TelegramUpdateProcessor);
    await expect(processor.processAvailable()).resolves.toBe(4);

    await expect(tableCount("bot_contacts")).resolves.toBe(0);
    await expect(tableCount("start_response_deliveries")).resolves.toBe(0);
    const updates = await database
      .selectFrom("telegram_updates")
      .select(["payload", "state"])
      .execute();
    expect(updates).toHaveLength(4);
    expect(updates.every((update) => update.state === "processed")).toBe(true);
    expect(updates.every((update) => update.payload === null)).toBe(true);
  });

  it("creates a BotContact for a malformed tokenized start without linking", async () => {
    const rawToken = "not+a+base64url+token";
    await injectWebhook(
      privateStartUpdate(25, 42, { text: `/start ${rawToken}` }),
      config.webhookSecret,
    );

    const storedInbox = await database
      .selectFrom("telegram_updates")
      .select("payload")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(storedInbox.payload)).not.toContain(rawToken);
    await application.get(TelegramUpdateProcessor).processAvailable();

    await expect(tableCount("bot_contacts")).resolves.toBe(1);
    await expect(tableCount("start_response_deliveries")).resolves.toBe(1);
    const response = await database
      .selectFrom("start_response_deliveries")
      .select("message_text")
      .executeTakeFirstOrThrow();
    expect(response.message_text).toBe(config.linkReceiptText);
    const links = await database
      .selectFrom("platform_links")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(links.count)).toBe(0);
  });

  it("runs ordinary start through durable processing and restores contactability", async () => {
    const processor = application.get(TelegramUpdateProcessor);
    await injectWebhook(privateStartUpdate(30, 42), config.webhookSecret);
    await processor.processAvailable();
    await injectWebhook(
      privateContactabilityUpdate(31, 42, "kicked"),
      config.webhookSecret,
    );
    await processor.processAvailable();

    const blocked = await database
      .selectFrom("bot_contacts")
      .select("contactability")
      .executeTakeFirstOrThrow();
    expect(blocked.contactability).toBe("blocked");

    await injectWebhook(privateStartUpdate(32, 42), config.webhookSecret);
    await processor.processAvailable();

    const restored = await database
      .selectFrom("bot_contacts")
      .select("contactability")
      .executeTakeFirstOrThrow();
    expect(restored.contactability).toBe("reachable");
    await expect(tableCount("bot_contacts")).resolves.toBe(1);
    await expect(tableCount("bot_contact_events")).resolves.toBe(3);
    await expect(tableCount("start_response_deliveries")).resolves.toBe(2);
  });

  it("recovers an update whose worker lease expired", async () => {
    const acceptedAt = new Date("2026-08-30T12:00:00.000Z");
    const inbox = application.get(TelegramUpdateInbox);
    await inbox.accept("inside", "40", privateStartUpdate(40, 42), acceptedAt);
    await inbox.claimNext(acceptedAt);

    const processor = application.get(TelegramUpdateProcessor);
    await expect(
      processor.processAvailable(1, new Date(acceptedAt.getTime() + 60_001)),
    ).resolves.toBe(1);

    const update = await database
      .selectFrom("telegram_updates")
      .select(["process_attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(update).toEqual({ process_attempt_count: 2, state: "processed" });
    await expect(tableCount("bot_contacts")).resolves.toBe(1);
  });
});

describe("durable start response delivery", () => {
  it("persists successful and stable API-rejected outcomes without retry", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const success = await prepareDelivery(
      [{ kind: "delivered", providerMessageId: "4503599627370495" }],
      now,
    );
    await success.processor.processAvailable(1, now);

    let delivery = await database
      .selectFrom("start_response_deliveries")
      .select(["attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(delivery).toEqual({ attempt_count: 1, state: "delivered" });
    const attempt = await database
      .selectFrom("start_response_delivery_attempts")
      .select(["outcome", "provider_message_id"])
      .executeTakeFirstOrThrow();
    expect(attempt).toEqual({
      outcome: "delivered",
      provider_message_id: "4503599627370495",
    });

    await resetTables();
    const rejected = await prepareDelivery(
      [{ kind: "api_rejected", providerErrorCode: 403 }],
      now,
    );
    await rejected.processor.processAvailable(1, now);

    delivery = await database
      .selectFrom("start_response_deliveries")
      .select(["attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(delivery).toEqual({ attempt_count: 1, state: "rejected" });
    const rejectedAttempt = await database
      .selectFrom("start_response_delivery_attempts")
      .select(["outcome", "provider_error_code"])
      .executeTakeFirstOrThrow();
    expect(rejectedAttempt).toEqual({
      outcome: "api_rejected",
      provider_error_code: 403,
    });
    await expect(rejected.processor.processAvailable(1, now)).resolves.toBe(0);
  });

  it("retries unknown transport outcomes with a bounded, diagnosable duplicate risk", async () => {
    const startedAt = new Date("2026-08-30T12:00:00.000Z");
    const delivery = await prepareDelivery(
      [
        { kind: "transport_unknown" },
        { kind: "delivered", providerMessageId: "99" },
      ],
      startedAt,
    );

    await delivery.processor.processAvailable(1, startedAt);
    await expect(
      delivery.processor.processAvailable(
        1,
        new Date(startedAt.getTime() + 999),
      ),
    ).resolves.toBe(0);
    await delivery.processor.processAvailable(
      1,
      new Date(startedAt.getTime() + 1000),
    );

    const stored = await database
      .selectFrom("start_response_deliveries")
      .select(["attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ attempt_count: 2, state: "delivered" });
    const attempts = await database
      .selectFrom("start_response_delivery_attempts")
      .select(["attempt_number", "diagnostic_code", "outcome"])
      .orderBy("attempt_number")
      .execute();
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        diagnostic_code: "transport_unknown",
        outcome: "transport_unknown",
      },
      {
        attempt_number: 2,
        diagnostic_code: null,
        outcome: "delivered",
      },
    ]);
    expect(delivery.messages.sent).toHaveLength(2);
  });

  it("retries a transient API rejection after the provider delay", async () => {
    const startedAt = new Date("2026-08-30T12:00:00.000Z");
    const delivery = await prepareDelivery(
      [
        {
          kind: "api_retryable",
          providerErrorCode: 429,
          retryAfterSeconds: 2,
        },
        { kind: "delivered", providerMessageId: "99" },
      ],
      startedAt,
    );

    await delivery.processor.processAvailable(1, startedAt);
    await expect(
      delivery.processor.processAvailable(
        1,
        new Date(startedAt.getTime() + 1999),
      ),
    ).resolves.toBe(0);
    await delivery.processor.processAvailable(
      1,
      new Date(startedAt.getTime() + 2000),
    );

    const stored = await database
      .selectFrom("start_response_deliveries")
      .select(["attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ attempt_count: 2, state: "delivered" });
    const attempts = await database
      .selectFrom("start_response_delivery_attempts")
      .select(["attempt_number", "outcome", "provider_error_code"])
      .orderBy("attempt_number")
      .execute();
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        outcome: "api_retryable",
        provider_error_code: 429,
      },
      {
        attempt_number: 2,
        outcome: "delivered",
        provider_error_code: null,
      },
    ]);
  });

  it("stops after three unknown transport outcomes", async () => {
    const startedAt = new Date("2026-08-30T12:00:00.000Z");
    const delivery = await prepareDelivery(
      [
        { kind: "transport_unknown" },
        { kind: "transport_unknown" },
        { kind: "transport_unknown" },
      ],
      startedAt,
    );

    await delivery.processor.processAvailable(1, startedAt);
    await delivery.processor.processAvailable(
      1,
      new Date(startedAt.getTime() + 1000),
    );
    await delivery.processor.processAvailable(
      1,
      new Date(startedAt.getTime() + 3000),
    );
    await expect(
      delivery.processor.processAvailable(
        1,
        new Date(startedAt.getTime() + 10_000),
      ),
    ).resolves.toBe(0);

    const stored = await database
      .selectFrom("start_response_deliveries")
      .select(["attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ attempt_count: 3, state: "unknown_exhausted" });
    await expect(tableCount("start_response_delivery_attempts")).resolves.toBe(
      3,
    );
  });
});

function verifiedStart(
  telegramUserId: string,
  updateId: string,
  observedAt = "2026-08-30T12:00:00.000Z",
) {
  return {
    botIdentity: "inside",
    observedAt: new Date(observedAt),
    privateChatId: telegramUserId,
    telegramUserId,
    updateId,
  };
}

async function injectWebhook(payload: unknown, secret?: string) {
  return await fastify.inject({
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    method: "POST",
    payload: JSON.stringify(payload),
    url: "/webhooks/telegram",
  });
}

async function tableCount(
  table:
    | "bot_contact_events"
    | "bot_contacts"
    | "telegram_updates"
    | "start_response_deliveries"
    | "start_response_delivery_attempts",
): Promise<number> {
  const result = await database
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

async function resetTables(): Promise<void> {
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
}

class ControlledMessages implements TelegramMessages {
  readonly sent: TelegramTextMessage[] = [];

  constructor(private readonly results: TelegramDeliveryResult[]) {}

  async sendText(
    message: TelegramTextMessage,
  ): Promise<TelegramDeliveryResult> {
    this.sent.push(message);
    const result = this.results.shift();
    if (!result) {
      throw new Error("Controlled Telegram result is missing");
    }
    return result;
  }
}

async function prepareDelivery(
  results: TelegramDeliveryResult[],
  observedAt: Date,
) {
  const contacts = new BotContacts(database, config);
  await contacts.observeStart({
    ...verifiedStart("42", "1"),
    observedAt,
  });
  const messages = new ControlledMessages(results);
  const processor = new StartResponseDeliveryProcessor(
    new StartResponseDeliveryQueue(database),
    messages,
    new RuntimeMetrics(),
  );
  return { messages, processor };
}

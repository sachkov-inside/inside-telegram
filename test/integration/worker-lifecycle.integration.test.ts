import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../../src/app.module.js";
import type { ApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { AUTHOR_TRANSPORT } from "../../src/modules/communications/author-delivery.js";
import { PLATFORM_EVIDENCE_DELIVERY } from "../../src/modules/membership-evidence/platform-evidence-delivery.js";
import { TELEGRAM_MEMBERSHIP } from "../../src/modules/membership-evidence/telegram-membership.js";
import { StartResponseDeliveryQueue } from "../../src/modules/outbound/start-response-delivery-queue.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramDeliveryResult,
} from "../../src/modules/outbound/telegram-messages.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

// Every background cycle that runs without external services is live.
const config: ApplicationConfig = {
  botIdentity: "inside",
  botToken: "synthetic-token",
  canonicalChatId: "-1000000000000",
  communityMode: "disabled",
  communityReconciliationCadenceMilliseconds: 60_000,
  communityTexts: {
    invite: "Synthetic community invite",
    preparing: "Synthetic community preparing",
    member: "Synthetic community member",
    unavailable: "Synthetic community unavailable",
    readmission: "Synthetic community readmission",
  },
  databaseUrl,
  deliveryMode: "live",
  evidenceDeliveryMode: "live",
  host: "127.0.0.1",
  linkReceiptText: "Synthetic link receipt",
  linkedMemberText: "Synthetic member status",
  linkedNonMemberText: "Synthetic non-member status",
  linkedUnavailableText: "Synthetic unavailable status",
  marketingEnabled: false,
  membershipMode: "live",
  membershipReconciliationCadenceMilliseconds: 240_000,
  notifications: {
    // Nothing listens here: the broker stays unavailable while durable work continues.
    brokerUrl: "amqp://synthetic:synthetic@127.0.0.1:9",
    authorizeUrl: "http://127.0.0.1:9/notifications/authorize",
    authorizeSecret: "synthetic_notification_secret",
    quarantineKey: "00".repeat(32),
    prefetch: 10,
    batchSize: 10,
  },
  platformEvidenceDeliverySecret: "synthetic_evidence_secret",
  platformEvidenceDeliveryUrl: "http://127.0.0.1:9/evidence",
  platformIntegrationSecret: "synthetic_platform_secret",
  port: 3002,
  webhookSecret: "synthetic_secret",
  welcomeText: "Synthetic welcome",
  workersEnabled: true,
};

let database: Database;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
});

beforeEach(async () => {
  await sql`
    truncate table
      start_response_delivery_attempts,
      start_response_deliveries,
      telegram_updates
    restart identity cascade
  `.execute(database);
});

afterAll(async () => {
  await database.destroy();
});

describe("background worker lifecycle", () => {
  it("settles an in-flight send before the database pool closes", async () => {
    let release!: (result: TelegramDeliveryResult) => void;
    const sendText = vi.fn(
      () =>
        new Promise<TelegramDeliveryResult>((resolve) => {
          release = resolve;
        }),
    );
    const app = await start({ sendText, editText: sendText });
    let closed = false;
    try {
      await app.get(StartResponseDeliveryQueue).enqueue({
        botIdentity: "inside",
        telegramUserId: "42",
        privateChatId: "42",
        messageText: "Synthetic reply",
        sourceKey: "lifecycle:1",
        now: new Date(),
      });
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      const closing = app.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closed).toBe(false);

      release({ kind: "delivered", providerMessageId: "7" });
      await closing;
    } finally {
      if (!closed) await app.close();
    }

    const delivery = await database
      .selectFrom("start_response_deliveries")
      .select(["attempt_count", "state"])
      .executeTakeFirstOrThrow();
    expect(delivery).toEqual({ attempt_count: 1, state: "delivered" });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("queries an idle database rarely", async () => {
    let statements = 0;
    const app = await start(
      {
        sendText: async () => ({ kind: "delivered", providerMessageId: "1" }),
        editText: async () => ({ kind: "delivered", providerMessageId: "1" }),
      },
      () => {
        statements += 1;
      },
    );
    try {
      // Let every cycle reach its idle pace before measuring.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      const before = statements;
      const windowMs = 10_000;
      await new Promise((resolve) => setTimeout(resolve, windowMs));
      const perSecond = ((statements - before) * 1000) / windowMs;
      process.stdout.write(`idle SQL statements per second: ${perSecond}\n`);
      expect(perSecond).toBeLessThan(20);
    } finally {
      await app.close();
    }
  }, 45_000);
});

async function start(
  messages: {
    sendText: () => Promise<TelegramDeliveryResult>;
    editText: () => Promise<TelegramDeliveryResult>;
  },
  onStatement?: () => void,
): Promise<NestFastifyApplication> {
  const counted = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl, max: 10 }),
    }),
    log: (event) => {
      if (event.level === "query") onStatement?.();
    },
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(DATABASE)
    .useValue(counted)
    .overrideProvider(TELEGRAM_MESSAGES)
    .useValue(messages)
    .overrideProvider(AUTHOR_TRANSPORT)
    .useValue({
      send: async () => ({ kind: "delivered", providerMessageId: "1" }),
    })
    .overrideProvider(TELEGRAM_MEMBERSHIP)
    .useValue({
      getBotChatMember: async () => ({
        kind: "observed",
        value: { status: "administrator" },
      }),
      getChatMember: async () => ({
        kind: "observed",
        value: { status: "member" },
      }),
    })
    .overrideProvider(PLATFORM_EVIDENCE_DELIVERY)
    .useValue({
      deliver: async () => ({ kind: "delivered" }),
    })
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return app;
}

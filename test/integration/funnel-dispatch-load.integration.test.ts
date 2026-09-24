import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { AUTHOR_AUTHORIZATION } from "../../src/modules/communications/author-authorization.js";
import { AUTHOR_CONTENT_VALIDATION } from "../../src/modules/communications/author-content-validation.js";
import {
  COMMUNICATION_TRANSPORT,
  type CommunicationMessage,
} from "../../src/modules/communications/communication-delivery.js";
import {
  COMMUNICATIONS_VERSION,
  type CommunicationsRequest,
} from "../../src/modules/communications/communications-contract.js";
import { FunnelScheduler } from "../../src/modules/communications/funnel-scheduler.js";
import type {
  FunnelDraft,
  MessagePart,
} from "../../src/modules/communications/funnel-types.js";
import { Funnels } from "../../src/modules/communications/funnels.js";
import { MarketingEntry } from "../../src/modules/communications/marketing-entry.js";
import { communicationLock } from "../../src/modules/communications/communication-state.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import { CLOCK } from "../../src/modules/identity-linking/clock.js";
import { TELEGRAM_MESSAGES } from "../../src/modules/outbound/telegram-messages.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { TelegramWebhook } from "../../src/modules/webhook/telegram-webhook.js";

// A due funnel backlog for the whole audience must not delay a new /start: its processing and
// its first reply stay within these bounds while the marketing worker drains the backlog.
const AUDIENCE = 5000;
const START_PROCESSING_LIMIT_MS = 1000;
const START_REPLY_LIMIT_MS = 3000;
const MEASUREMENT_CAP_MS = 60_000;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");
const database = createDatabase(databaseUrl);
const config = loadApplicationConfig({
  DATABASE_URL: databaseUrl,
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook",
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
  TELEGRAM_WELCOME_TEXT: "synthetic welcome",
  TELEGRAM_LINK_RECEIPT_TEXT: "synthetic receipt",
  TELEGRAM_LINKED_MEMBER_TEXT: "synthetic member",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "synthetic non-member",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "synthetic unavailable",
  WORKERS_ENABLED: "false",
  TELEGRAM_MARKETING_ENABLED: "true",
});
const sent: { message: CommunicationMessage; at: number }[] = [];
let app: Awaited<ReturnType<typeof compile>>;

async function compile() {
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    // Real time lets the shared 40 ms transport lane advance while the backlog drains.
    .overrideProvider(CLOCK)
    .useValue({ now: () => new Date() })
    .overrideProvider(AUTHOR_AUTHORIZATION)
    .useValue({ authorize: async () => "allowed" })
    .overrideProvider(AUTHOR_CONTENT_VALIDATION)
    .useValue({ validate: async () => ({ status: "ok", targetErrors: [] }) })
    .overrideProvider(COMMUNICATION_TRANSPORT)
    .useValue({
      send: async (message: CommunicationMessage) => {
        sent.push({ message, at: performance.now() });
        return { kind: "delivered", providerMessageId: "synthetic" };
      },
    })
    .overrideProvider(TELEGRAM_MESSAGES)
    .useValue({
      sendText: async () => ({ kind: "delivered", providerMessageId: "1" }),
    })
    .compile();
  const nest = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await nest.init();
  return nest;
}
beforeAll(async () => {
  await migrateToLatest(database);
  app = await compile();
});
beforeEach(async () => {
  await sql`truncate communication_funnels, communication_intro, communication_operations, telegram_transport_slots, bot_contacts, bot_contact_events, telegram_updates, start_response_deliveries cascade`.execute(
    database,
  );
  sent.length = 0;
});
afterAll(async () => {
  await app?.close();
  await database.destroy();
});

function part(text: string): MessagePart {
  return {
    partId: randomUUID(),
    content: { type: "text", text, entities: [], buttons: [] },
  };
}
function command(
  operation: string,
  payload: CommunicationsRequest["payload"],
  expectedRevision = 0,
): CommunicationsRequest {
  return {
    contractVersion: COMMUNICATIONS_VERSION,
    operation,
    operationId: randomUUID(),
    expectedRevision,
    actor: { accountRef: "synthetic-author" },
    payload,
  };
}
function sentParts(parts: readonly MessagePart[], at: Date) {
  return JSON.stringify(
    parts.map((p) => ({
      partId: p.partId,
      state: "sent",
      diagnosticCode: null,
      attempts: [
        {
          attemptId: randomUUID(),
          attemptedAt: at.toISOString(),
          outcome: "sent",
          diagnosticCode: null,
          duplicateRiskAccepted: false,
        },
      ],
    })),
  );
}

// Every contact already received the intro and entry; the first step is due for all of them.
async function seedDueAudience(size = AUDIENCE): Promise<FunnelDraft> {
  const funnels = app.get(Funnels);
  const intro = [part("intro")];
  const value: FunnelDraft = {
    funnelId: randomUUID(),
    name: "general",
    isDefault: true,
    sources: [{ sourceId: randomUUID(), code: "m_general", name: "general" }],
    entryResponse: { stepId: randomUUID(), parts: [part("entry")] },
    steps: [
      { stepId: randomUUID(), delaySeconds: 60, parts: [part("step1")] },
      { stepId: randomUUID(), delaySeconds: 60, parts: [part("step2")] },
    ],
  };
  await funnels.execute(
    command("intro.save", { introId: randomUUID(), parts: intro }),
  );
  await funnels.execute(command("funnels.save", value));
  await funnels.execute(
    command("funnels.publish", { funnelId: value.funnelId }, 1),
  );
  const enrolledAt = new Date(Date.now() - 3600_000);
  const due = new Date(Date.now() - 1000);
  const rows = Array.from({ length: size }, (_, i) => ({
    user: String(1_000_000 + i),
    contactId: randomUUID(),
    enrollmentId: randomUUID(),
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await database
      .insertInto("bot_contacts")
      .values(
        chunk.map((r) => ({
          bot_identity: "inside",
          telegram_user_id: r.user,
          private_chat_id: r.user,
          contactability: "reachable" as const,
          first_started_at: enrolledAt,
          last_started_at: enrolledAt,
          updated_at: enrolledAt,
        })),
      )
      .execute();
    await database
      .insertInto("communication_contacts")
      .values(
        chunk.map((r) => ({
          contact_id: r.contactId,
          bot_identity: "inside",
          telegram_user_id: r.user,
          marketing_enabled: true,
        })),
      )
      .execute();
    await database
      .insertInto("communication_enrollments")
      .values(
        chunk.map((r) => ({
          enrollment_id: r.enrollmentId,
          contact_id: r.contactId,
          funnel_id: value.funnelId,
          enrolled_at: enrolledAt,
          initial_entry_key: `entry:inside:${r.user}`,
        })),
      )
      .execute();
    const common = {
      bot_identity: "inside",
      revision: 2,
      created_at: enrolledAt,
      cancel_requested: false,
      attempt_id: null,
      locked_at: null,
    };
    await database
      .insertInto("communication_deliveries")
      .values(
        chunk.flatMap((r) => [
          {
            ...common,
            delivery_id: randomUUID(),
            dedup_key: `intro:${r.contactId}`,
            contact_id: r.contactId,
            funnel_id: null,
            step_id: null,
            kind: "intro" as const,
            published_revision: 1,
            snapshot: JSON.stringify(intro),
            parts: sentParts(intro, enrolledAt),
            due_at: enrolledAt,
            completed_at: enrolledAt,
          },
          {
            ...common,
            delivery_id: randomUUID(),
            dedup_key: `entry:inside:${r.user}`,
            contact_id: r.contactId,
            funnel_id: value.funnelId,
            step_id: value.entryResponse.stepId,
            kind: "entry" as const,
            published_revision: 2,
            snapshot: JSON.stringify(value.entryResponse.parts),
            parts: sentParts(value.entryResponse.parts, enrolledAt),
            due_at: enrolledAt,
            completed_at: enrolledAt,
          },
          {
            ...common,
            delivery_id: randomUUID(),
            dedup_key: `step:${r.enrollmentId}:${value.steps[0]!.stepId}`,
            contact_id: r.contactId,
            funnel_id: value.funnelId,
            step_id: value.steps[0]!.stepId,
            kind: "step" as const,
            published_revision: 2,
            snapshot: JSON.stringify(value.steps[0]!.parts),
            parts: JSON.stringify(
              value.steps[0]!.parts.map((p) => ({
                partId: p.partId,
                state: "pending",
                diagnosticCode: null,
                attempts: [],
              })),
            ),
            due_at: due,
            completed_at: null,
          },
        ]),
      )
      .execute();
  }
  await sql`analyze`.execute(database);
  return value;
}

// Measures real latency, but stops waiting at the cap so a regression reports a bound, not a hang.
async function elapsed(
  work: () => Promise<unknown>,
  cap = MEASUREMENT_CAP_MS,
): Promise<number> {
  const started = performance.now();
  const done = await Promise.race([
    work().then(() => true),
    delay(cap).then(() => false),
  ]);
  return done ? performance.now() - started : Number.POSITIVE_INFINITY;
}

it(`answers /start within bounds while a funnel dispatches to ${AUDIENCE} contacts`, async () => {
  await seedDueAudience();
  const scheduler = app.get(FunnelScheduler);
  let dispatching = true;
  const worker = (async () => {
    while (dispatching) {
      await scheduler.processAvailable();
      await delay(20);
    }
  })();
  let measurements: string | undefined;
  try {
    await delay(300);
    // A contact inside the dispatched audience and a new visitor both press /start.
    const enrolledMs = await elapsed(() =>
      app.get(BotContacts).observeStart(
        {
          botIdentity: "inside",
          telegramUserId: "1000000",
          privateChatId: "1000000",
          updateId: "900",
          observedAt: new Date(),
        },
        "none",
      ),
    );
    const started = performance.now();
    const processingMs = await elapsed(async () => {
      await app.get(TelegramWebhook).accept(config.webhookSecret, {
        update_id: 901,
        message: {
          message_id: 901,
          date: 1,
          chat: { id: 777, type: "private" },
          from: { id: 777, is_bot: false },
          text: "/start",
        },
      });
      await app.get(TelegramUpdateProcessor).processAvailable(1, new Date());
    });
    await elapsed(async () => {
      while (!sent.some((s) => s.message.chatId === "777")) await delay(10);
    });
    const reply = sent.find((s) => s.message.chatId === "777");
    const replyMs = reply ? reply.at - started : Number.POSITIVE_INFINITY;
    measurements = `audience=${AUDIENCE} enrolled /start=${Math.round(enrolledMs)}ms new /start=${Math.round(processingMs)}ms first reply=${Math.round(replyMs)}ms backlog sent=${sent.length}`;
    console.info(`funnel dispatch load: ${measurements}`);

    expect(enrolledMs).toBeLessThan(START_PROCESSING_LIMIT_MS);
    expect(processingMs).toBeLessThan(START_PROCESSING_LIMIT_MS);
    expect(replyMs).toBeLessThan(START_REPLY_LIMIT_MS);
    expect(reply!.message.content.text).toBe("intro");
  } finally {
    dispatching = false;
    await Promise.race([worker, delay(MEASUREMENT_CAP_MS)]);
  }
  const backlog = sent.filter((s) => s.message.chatId !== "777");
  expect(backlog.length, measurements).toBeGreaterThan(0);
  expect(backlog.every((s) => s.message.content.text === "step1")).toBe(true);
}, 300_000);

// Fitness for the lock seam: the bot-wide scheduler lock belongs to dispatch and audience-wide
// planning; no subscriber command may wait for it.
it("completes every subscriber command while the bot scheduler lock is held", async () => {
  await seedDueAudience(1);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = database.transaction().execute(async (tx) => {
    await communicationLock(tx, "communications-scheduler:inside");
    held();
    await released;
  });
  await holding;
  const subscriber = (updateId: string, user = "555") => ({
    botIdentity: "inside",
    telegramUserId: user,
    privateChatId: user,
    updateId,
    observedAt: new Date(),
  });
  try {
    const commands = [
      () => app.get(BotContacts).observeStart(subscriber("1"), "welcome"),
      () => app.get(MarketingEntry).enter(subscriber("2")),
      () => app.get(MarketingEntry).setPreference(subscriber("3"), false),
      () => app.get(MarketingEntry).setPreference(subscriber("4"), true),
      () =>
        app.get(BotContacts).observeContactability({
          ...subscriber("5", "1000000"),
          contactability: "blocked",
        }),
      () => app.get(BotContacts).observeStart(subscriber("6", "1000000")),
    ];
    for (const command of commands)
      expect(await elapsed(command, 5000)).toBeLessThan(5000);
  } finally {
    release();
    await holder;
  }
});

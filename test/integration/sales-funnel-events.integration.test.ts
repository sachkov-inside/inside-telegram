import { createHash, randomUUID } from "node:crypto";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prepareTelegramUpdateForInbox } from "../../src/adapters/telegram/grammy-update.adapter.js";
import { HttpSalesFunnelAdapter } from "../../src/adapters/platform/http-sales-funnel.adapter.js";
import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateTo, migrateToLatest } from "../../src/database/migrator.js";
import {
  COMMUNICATIONS_VERSION,
  type CommunicationsRequest,
} from "../../src/modules/communications/communications-contract.js";
import { AUTHOR_AUTHORIZATION } from "../../src/modules/communications/author-authorization.js";
import { AUTHOR_CONTENT_VALIDATION } from "../../src/modules/communications/author-content-validation.js";
import { COMMUNICATION_TRANSPORT } from "../../src/modules/communications/communication-delivery.js";
import type { FunnelDraft } from "../../src/modules/communications/funnel-types.js";
import { Funnels } from "../../src/modules/communications/funnels.js";
import { IdentityLinkRecovery } from "../../src/modules/identity-linking/identity-link-recovery.js";
import { IdentityLinking } from "../../src/modules/identity-linking/identity-linking.js";
import { TELEGRAM_CALLBACK_ANSWERS } from "../../src/modules/bot-sign-in/telegram-callback-answers.js";
import { TelegramUpdateInbox } from "../../src/modules/update-inbox/telegram-update-inbox.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { SALES_FUNNEL_DELIVERY } from "../../src/modules/sales-funnel/sales-funnel-delivery.js";
import { SalesFunnelDeliveryProcessor } from "../../src/modules/sales-funnel/sales-funnel-delivery-processor.js";
import {
  salesFunnelEventId,
  type SalesFunnelEvent,
} from "../../src/modules/sales-funnel/sales-funnel-events.js";
import { TELEGRAM_MESSAGES } from "../../src/modules/outbound/telegram-messages.js";
import { CLOCK } from "../../src/shared/clock.js";
import {
  startSalesFunnelPlatform,
  type SalesFunnelPlatform,
} from "../support/sales-funnel-platform.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");
const database = createDatabase(databaseUrl);
const config = {
  ...loadApplicationConfig({
    DATABASE_URL: databaseUrl,
    TELEGRAM_BOT_IDENTITY: "inside",
    TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
    TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret_for_tests_only",
    PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret_for_tests_only",
    PLATFORM_COMMUNICATIONS_SECRET: "synthetic_communications_secret_for_tests",
    TELEGRAM_WELCOME_TEXT: "synthetic welcome",
    TELEGRAM_LINK_RECEIPT_TEXT: "synthetic receipt",
    TELEGRAM_LINKED_MEMBER_TEXT: "synthetic member",
    TELEGRAM_LINKED_NON_MEMBER_TEXT: "synthetic non-member",
    TELEGRAM_LINKED_UNAVAILABLE_TEXT: "synthetic unavailable",
    WORKERS_ENABLED: "false",
    TELEGRAM_MARKETING_ENABLED: "true",
    TELEGRAM_MARKETING_CONSENT_TEXT: "synthetic consent prompt",
    TELEGRAM_MARKETING_CONSENT_BUTTON: "synthetic agree",
    TELEGRAM_MARKETING_CONSENT_CONFIRMATION: "synthetic consent thanks",
  }),
  // Scripted conversations exceed the per-user limit, which ordinary-start covers.
  senderRate: { requests: 10_000, windowMs: 10_000 },
};
let now = new Date("2030-01-01T00:00:00.000Z");
const clock = { now: () => new Date(now) };
const answered: string[] = [];
let app: NestFastifyApplication;
let platform: SalesFunnelPlatform;
let nextUpdate = 1000;

beforeAll(async () => {
  await migrateToLatest(database);
  platform = await startSalesFunnelPlatform();
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(AUTHOR_AUTHORIZATION)
    .useValue({ authorize: () => Promise.resolve("allowed") })
    .overrideProvider(AUTHOR_CONTENT_VALIDATION)
    .useValue({
      validate: () => Promise.resolve({ status: "ok", targetErrors: [] }),
    })
    .overrideProvider(COMMUNICATION_TRANSPORT)
    .useValue({
      send: () =>
        Promise.resolve({ kind: "delivered", providerMessageId: "1" }),
    })
    .overrideProvider(TELEGRAM_MESSAGES)
    .useValue({
      sendText: () =>
        Promise.resolve({ kind: "delivered", providerMessageId: "1" }),
    })
    .overrideProvider(TELEGRAM_CALLBACK_ANSWERS)
    .useValue({
      answer: (id: string) => {
        answered.push(id);
        return Promise.resolve();
      },
    })
    .overrideProvider(SALES_FUNNEL_DELIVERY)
    .useValue(new HttpSalesFunnelAdapter(platform.url, platform.secret))
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
});

beforeEach(async () => {
  await sql`truncate sales_funnel_event_outbox, communication_funnels, communication_intro, communication_operations, communication_contacts, communication_preferences, communication_entries, telegram_transport_slots, bot_contacts, bot_contact_events, telegram_updates, start_response_deliveries, identity_link_recoveries, identity_link_events, platform_links, link_transactions, telegram_identity_reservations cascade`.execute(
    database,
  );
  now = new Date("2030-01-01T00:00:00.000Z");
  platform.events.clear();
  platform.answers.length = 0;
  platform.failWith = undefined;
  answered.length = 0;
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
  await database.destroy();
});

async function publishDefaultFunnel(): Promise<void> {
  const part = (text: string) => ({
    partId: randomUUID(),
    content: { type: "text" as const, text, entities: [], buttons: [] },
  });
  const funnel: FunnelDraft = {
    funnelId: randomUUID(),
    name: "survey",
    isDefault: true,
    sources: [{ sourceId: randomUUID(), code: "m_survey", name: "survey" }],
    entryResponse: { stepId: randomUUID(), parts: [part("entry")] },
    steps: [],
  };
  const command = (
    operation: string,
    payload: CommunicationsRequest["payload"],
    expectedRevision = 0,
  ): CommunicationsRequest => ({
    contractVersion: COMMUNICATIONS_VERSION,
    operation,
    operationId: randomUUID(),
    expectedRevision,
    actor: { accountRef: "synthetic-author" },
    payload,
  });
  const funnels = app.get(Funnels);
  await funnels.execute(
    command("intro.save", { introId: randomUUID(), parts: [part("intro")] }),
  );
  await funnels.execute(command("funnels.save", funnel));
  await funnels.execute(
    command("funnels.publish", { funnelId: funnel.funnelId }, 1),
  );
}

/** Sends one private update through the webhook path's preparation, inbox and processor. */
async function send(payload: unknown, updateId = nextUpdate++): Promise<void> {
  await app
    .get(TelegramUpdateInbox)
    .accept(
      "inside",
      String(updateId),
      prepareTelegramUpdateForInbox(payload),
      now,
    );
  await app.get(TelegramUpdateProcessor).processAvailable(50, now);
}

function text(value: string, user = 42, updateId = nextUpdate++) {
  return send(privateStartUpdate(updateId, user, { text: value }), updateId);
}

function consentPress(user = 42) {
  const updateId = nextUpdate++;
  return send(
    {
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: user, is_bot: false },
        message: { message_id: 1, chat: { id: user, type: "private" } },
        data: "marketing:consent",
      },
    },
    updateId,
  );
}

async function queued(): Promise<SalesFunnelEvent[]> {
  const rows = await database
    .selectFrom("sales_funnel_event_outbox")
    .select("event")
    .orderBy("sequence_id")
    .execute();
  return rows.map((row) => row.event);
}

async function contactRef(user = "42"): Promise<string> {
  const row = await database
    .selectFrom("communication_contacts")
    .select("contact_id")
    .where("telegram_user_id", "=", user)
    .executeTakeFirstOrThrow();
  return row.contact_id;
}

async function link(user: string, account = "account-ref-a") {
  const linking = app.get(IdentityLinking);
  const token = createHash("sha256")
    .update(`token-${user}-${account}`)
    .digest("base64url");
  const challenge = await linking.register({
    accountRef: account,
    expiresAt: new Date(now.getTime() + 600_000),
    returnCorrelation: `return-${user}`,
    tokenDigest: token,
  });
  await linking.acceptStart({
    botIdentity: "inside",
    linkToken: { digest: token, kind: "digest" },
    observedAt: now,
    telegramUserId: user,
  });
  return linking.confirm({
    accountRef: account,
    linkTransactionRef: challenge.linkTransactionRef,
    returnCorrelation: `return-${user}`,
  });
}

describe("sales funnel events", () => {
  it("reports a labelled and an unlabelled /start once each, even when an update replays", async () => {
    await publishDefaultFunnel();
    await text("/start m_survey", 42, 1);
    await send(privateStartUpdate(1, 42, { text: "/start m_survey" }), 1);
    await text("/start", 42, 2);
    const contact = await contactRef();
    expect(await queued()).toEqual([
      {
        eventId: salesFunnelEventId("bot_entered:inside:1"),
        contactRef: contact,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "bot_entered",
        sourceCode: "m_survey",
      },
      {
        eventId: salesFunnelEventId("bot_entered:inside:2"),
        contactRef: contact,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "bot_entered",
        sourceCode: null,
      },
    ]);
  });

  it("reports /stop as withdrawn and /resume and the consent button as granted", async () => {
    await publishDefaultFunnel();
    await text("/start");
    await text("/stop");
    await text("/resume");
    await consentPress();
    const consents = (await queued()).filter(
      (event) => event.kind === "marketing_consent",
    );
    expect(
      consents.map(
        (event) => event.kind === "marketing_consent" && event.granted,
      ),
    ).toEqual([false, true, true]);
    expect(answered).toHaveLength(1);
  });

  it("asks for consent after an entry until the contact consents, and the default is no consent", async () => {
    await publishDefaultFunnel();
    await text("/start m_survey");
    const prompts = () =>
      database
        .selectFrom("start_response_deliveries")
        .select(["message_text", "buttons"])
        .where("message_text", "in", [
          "synthetic consent prompt",
          "synthetic consent thanks",
        ])
        .orderBy("id")
        .execute();
    expect(await prompts()).toEqual([
      {
        message_text: "synthetic consent prompt",
        buttons: [
          { text: "synthetic agree", callbackData: "marketing:consent" },
        ],
      },
    ]);
    expect(
      (await queued()).some((event) => event.kind === "marketing_consent"),
    ).toBe(false);
    await consentPress();
    await text("/start");
    expect((await prompts()).map((row) => row.message_text)).toEqual([
      "synthetic consent prompt",
      "synthetic consent thanks",
    ]);
  });

  it("reports a confirmed link, including one of a bot contact from before communication records", async () => {
    await publishDefaultFunnel();
    await text("/start", 42);
    const linked = await link("42");
    if (linked.status !== "linked") throw new Error("not linked");
    await database
      .insertInto("bot_contacts")
      .values({
        bot_identity: "inside",
        contactability: "reachable",
        first_started_at: now,
        last_started_at: now,
        private_chat_id: "43",
        telegram_user_id: "43",
        updated_at: now,
      })
      .execute();
    expect((await link("43", "account-ref-b")).status).toBe("linked");
    expect(
      (await queued()).filter((event) => event.kind === "account_linked"),
    ).toEqual([
      {
        eventId: salesFunnelEventId(
          `account_linked:${linked.linkTransactionRef}`,
        ),
        contactRef: await contactRef("42"),
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "account_linked",
        telegramIdentityRef: linked.telegramIdentityRef,
      },
      expect.objectContaining({
        contactRef: await contactRef("43"),
        kind: "account_linked",
      }),
    ]);
  });

  it("reports an owner transfer of the link to another Account", async () => {
    await text("/start", 42);
    const first = await link("42", "account-ref-a");
    if (first.status !== "linked") throw new Error("not linked");
    const target = await link("42", "account-ref-b");
    expect(target.status).toBe("recovery-required");
    if (target.status !== "recovery-required")
      throw new Error("no recovery case");
    const transferred = await app.get(IdentityLinkRecovery).execute({
      confirmedSourceAccountRef: "account-ref-a",
      confirmedTargetAccountRef: "account-ref-b",
      recoveryRef: "recovery-ref-a",
      operatorRef: "operator-ref-a",
      reasonRef: "reason-ref-a",
      telegramIdentityRef: first.telegramIdentityRef,
      sourceAccountRef: "account-ref-a",
      targetAccountRef: "account-ref-b",
      targetLinkTransactionRef: target.linkTransactionRef,
    });
    expect(transferred.ok).toBe(true);
    expect(
      (await queued())
        .filter((event) => event.kind === "account_linked")
        .map((event) => event.eventId),
    ).toEqual([
      salesFunnelEventId(`account_linked:${first.linkTransactionRef}`),
      salesFunnelEventId(`account_linked:${target.linkTransactionRef}`),
    ]);
  });

  it("delivers every event to Platform once, retries through a Platform failure and never sends Telegram ids", async () => {
    await publishDefaultFunnel();
    await text("/start m_survey", 987654321);
    await text("/stop", 987654321);
    await link("987654321");
    const delivery = app.get(SalesFunnelDeliveryProcessor);

    platform.failWith = 503;
    await expect(delivery.processNext(now)).resolves.toBe("retryable");
    platform.failWith = undefined;
    await expect(delivery.processAvailable(50, now)).resolves.toBe(2);
    now = new Date(now.getTime() + 60_000);
    await expect(delivery.processAvailable(50, now)).resolves.toBe(1);

    expect(platform.events.size).toBe(3);
    expect(
      platform.answers.filter((answer) => answer.status === 200),
    ).toHaveLength(3);
    const states = await database
      .selectFrom("sales_funnel_event_outbox")
      .select("state")
      .execute();
    expect(states.every((row) => row.state === "delivered")).toBe(true);
    const wire = JSON.stringify([...platform.events.values()]);
    expect(wire).not.toContain("987654321");
  });

  it("recognises a repeated delivery as a duplicate and logs a changed one as a contract conflict", async () => {
    await publishDefaultFunnel();
    await text("/start m_survey");
    const delivery = app.get(SalesFunnelDeliveryProcessor);
    await expect(delivery.processNext(now)).resolves.toBe("delivered");

    await database
      .updateTable("sales_funnel_event_outbox")
      .set({ state: "pending" })
      .execute();
    await expect(delivery.processNext(now)).resolves.toBe("delivered");
    expect(platform.answers.at(-1)).toEqual({
      status: 200,
      body: {
        contractVersion: "inside.sales-funnel-events.v1",
        accepted: 0,
        duplicates: 1,
      },
    });

    const [event] = await queued();
    await database
      .updateTable("sales_funnel_event_outbox")
      .set({
        state: "pending",
        event: JSON.stringify({ ...event, sourceCode: "m_other" }),
      })
      .execute();
    await expect(delivery.processNext(now)).resolves.toBe("conflict");
    expect(platform.answers.at(-1)?.status).toBe(409);
    const row = await database
      .selectFrom("sales_funnel_event_outbox")
      .select(["state", "diagnostic_code"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      state: "rejected",
      diagnostic_code: "platform_event_conflict",
    });
    await expect(delivery.processNext(now)).resolves.toBeUndefined();
  });
});

describe("migration 029 backfill", () => {
  afterAll(() => migrateToLatest(database));

  it("queues past entries, explicit preferences and links under the application's event ids", async () => {
    await publishDefaultFunnel();
    await text("/start m_survey", 42, 7);
    await text("/stop", 42, 8);
    const linked = await link("42");
    if (linked.status !== "linked") throw new Error("not linked");
    const expected = await queued();
    expect(expected).toHaveLength(3);

    await migrateTo(database, "027-owner-link-activation");
    await migrateToLatest(database);

    expect(
      (await queued()).sort((a, b) => a.eventId.localeCompare(b.eventId)),
    ).toEqual(expected.sort((a, b) => a.eventId.localeCompare(b.eventId)));
  });
});

import { randomUUID } from "node:crypto";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
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
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { AUTHOR_AUTHORIZATION } from "../../src/modules/communications/author-authorization.js";
import {
  COMMUNICATIONS_VERSION,
  contractValidator,
  type CommunicationsRequest,
} from "../../src/modules/communications/communications-contract.js";
import {
  COMMUNICATION_TRANSPORT,
  type CommunicationMessage,
} from "../../src/modules/communications/communication-delivery.js";
import { Funnels } from "../../src/modules/communications/funnels.js";
import { FunnelScheduler } from "../../src/modules/communications/funnel-scheduler.js";
import { MarketingEntry } from "../../src/modules/communications/marketing-entry.js";
import type {
  FunnelDraft,
  MessagePart,
} from "../../src/modules/communications/funnel-types.js";
import { CLOCK } from "../../src/modules/identity-linking/clock.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";

import {
  TELEGRAM_MESSAGES,
  type TelegramDeliveryResult,
} from "../../src/modules/outbound/telegram-messages.js";
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
  PLATFORM_TRACKING_REDIRECT_URL: "https://platform.example/communications/go",
  PLATFORM_TRACKING_TARGET_PREFIXES:
    '["https://platform.example/materials/","https://platform.example/series/"]',
});
let now = new Date("2030-01-01T00:00:00Z");
const clock = { now: () => new Date(now) };
const sent: CommunicationMessage[] = [];
const transport = {
  send: vi.fn(
    async (message: CommunicationMessage): Promise<TelegramDeliveryResult> => {
      sent.push(message);
      return { kind: "delivered", providerMessageId: "synthetic-message" };
    },
  ),
};
const authorization = {
  authorize: vi.fn(async () => "allowed" as "allowed" | "denied"),
};
let app: NestFastifyApplication;
let funnels: Funnels;
let scheduler: FunnelScheduler;
let entry: MarketingEntry;
const responseValidator = contractValidator("response");
beforeAll(async () => {
  await migrateToLatest(database);
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(AUTHOR_AUTHORIZATION)
    .useValue(authorization)
    .overrideProvider(COMMUNICATION_TRANSPORT)
    .useValue(transport)
    .overrideProvider(TELEGRAM_MESSAGES)
    .useValue({
      sendText: async () => ({
        kind: "delivered",
        providerMessageId: "123",
      }),
    })
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  funnels = app.get(Funnels);
  scheduler = app.get(FunnelScheduler);
  entry = app.get(MarketingEntry);
});
beforeEach(async () => {
  await sql`truncate communication_broadcasts, communication_funnels, communication_intro, communication_operations, telegram_transport_slots, bot_contacts, bot_contact_events, telegram_updates, start_response_deliveries cascade`.execute(
    database,
  );
  now = new Date("2030-01-01T00:00:00Z");
  sent.length = 0;
  transport.send.mockClear();
  authorization.authorize.mockResolvedValue("allowed");
});
afterAll(async () => {
  await sql`truncate communication_broadcasts cascade`.execute(database);
  await app?.close();
  await database.destroy();
});
function part(text: string): MessagePart {
  return {
    partId: randomUUID(),
    content: { type: "text", text, entities: [], buttons: [] },
  };
}
function draft(name = "general", isDefault = true): FunnelDraft {
  return {
    funnelId: randomUUID(),
    name,
    isDefault,
    sources: [{ sourceId: randomUUID(), code: `m_${name}`, name }],
    entryResponse: { stepId: randomUUID(), parts: [part(`${name}:entry`)] },
    steps: [
      {
        stepId: randomUUID(),
        delaySeconds: 10,
        parts: [part(`${name}:step1`)],
      },
      {
        stepId: randomUUID(),
        delaySeconds: 10,
        parts: [part(`${name}:step2`)],
      },
    ],
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
async function http(
  request: CommunicationsRequest,
  secret = config.platformIntegrationSecret,
) {
  return app.inject({
    method: "POST",
    url: "/integrations/platform/v1/communications",
    headers: { authorization: `Bearer ${secret}` },
    payload: request,
  });
}
async function setup(value = draft()) {
  await funnels.execute(
    command("intro.save", { introId: randomUUID(), parts: [part("intro")] }),
  );
  await funnels.execute(command("funnels.save", value));
  await funnels.execute(
    command("funnels.publish", { funnelId: value.funnelId }, 1),
  );
  return value;
}
async function start(updateId = "1", source?: string, user = "42") {
  const value = {
    botIdentity: "inside",
    telegramUserId: user,
    privateChatId: user,
    updateId,
    observedAt: clock.now(),
  };
  await app.get(BotContacts).observeStart(value, "none");
  await entry.enter(value, source);
}
async function tick(seconds = 1) {
  now = new Date(now.getTime() + seconds * 1000);
  return scheduler.processAvailable();
}

function broadcast(
  parts = [part("broadcast")],
  scheduledAt: string | null = null,
  audience: NonNullable<CommunicationsRequest["payload"]["audience"]> = {
    kind: "all",
  },
) {
  return { broadcastId: randomUUID(), parts, scheduledAt, audience };
}
async function launch(value = broadcast()) {
  const saved = await http(command("broadcasts.save", value));
  expect(saved.statusCode).toBe(200);
  const request = command(
    "broadcasts.launch",
    { broadcastId: value.broadcastId },
    1,
  );
  const launched = await http(request);
  expect(launched.statusCode).toBe(200);
  expect(responseValidator(launched.json())).toBe(true);
  return { value, request, result: launched.json().broadcast };
}
async function broadcastDeliveries(id: string) {
  return database
    .selectFrom("communication_deliveries")
    .selectAll()
    .where("broadcast_id", "=", id)
    .orderBy("contact_id")
    .execute();
}
async function preference(enabled: boolean, updateId = "900", user = "42") {
  await entry.setPreference(
    {
      botIdentity: "inside",
      telegramUserId: user,
      privateChatId: user,
      updateId,
      observedAt: clock.now(),
    },
    enabled,
  );
  await sql`delete from start_response_deliveries`.execute(database);
}
async function oldContact(user = "42") {
  await app.get(BotContacts).observeStart(
    {
      botIdentity: "inside",
      telegramUserId: user,
      privateChatId: user,
      updateId: user,
      observedAt: clock.now(),
    },
    "none",
  );
}

describe("broadcast audience and lifecycle", () => {
  it("takes scheduled union snapshot only at actual launch; replay, late joiner and pause preserve it", async () => {
    const a = await setup();
    const b = draft("other", false);
    await funnels.execute(command("funnels.save", b));
    await funnels.execute(
      command("funnels.publish", { funnelId: b.funnelId }, 1),
    );
    await start("1", a.sources[0]!.code);
    await start("2", b.sources[0]!.code);
    const { value, request, result } = await launch(
      broadcast([part("broadcast")], new Date(+now + 60_000).toISOString(), {
        kind: "funnels",
        funnelIds: [a.funnelId, b.funnelId],
      }),
    );
    expect(result.state).toBe("scheduled");
    expect(result.audienceSnapshotId).toBeNull();
    await start("3", a.sources[0]!.code, "43");
    await scheduler.processAvailable(0);
    expect(await broadcastDeliveries(value.broadcastId)).toHaveLength(0);
    now = new Date(+now + 60_000);
    await Promise.all([
      scheduler.processAvailable(1),
      scheduler.processAvailable(1),
    ]);
    const recipients = await broadcastDeliveries(value.broadcastId);
    expect(recipients).toHaveLength(2);
    expect((await http(request)).json().broadcast).toEqual(result);
    const current = (
      await http(command("broadcasts.read", { broadcastId: value.broadcastId }))
    ).json().broadcast;
    expect(current.snapshotSize).toBe(2);
    await http(
      command(
        "broadcasts.lifecycle",
        { broadcastId: value.broadcastId, action: "pause" },
        current.revision,
      ),
    );
    await start("4", a.sources[0]!.code, "44");
    await http(
      command(
        "broadcasts.lifecycle",
        { broadcastId: value.broadcastId, action: "resume" },
        current.revision + 1,
      ),
    );
    expect(await broadcastDeliveries(value.broadcastId)).toHaveLength(2);
    expect(
      (
        await http(
          command(
            "broadcasts.save",
            { ...value, parts: [part("changed")] },
            current.revision + 2,
          ),
        )
      ).statusCode,
    ).toBe(409);
  });
  it("includes legacy contacts without enrollment, excludes stopped and blocked, and deduplicates concurrent launch", async () => {
    await oldContact();
    await oldContact("43");
    await oldContact("44");
    await preference(false, "901", "43");
    await app.get(BotContacts).observeContactability({
      botIdentity: "inside",
      telegramUserId: "44",
      updateId: "902",
      observedAt: clock.now(),
      contactability: "blocked",
    });
    const value = broadcast();
    await http(command("broadcasts.save", value));
    const request = command(
      "broadcasts.launch",
      { broadcastId: value.broadcastId },
      1,
    );
    const responses = await Promise.all([http(request), http(request)]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(responses[0]!.json().broadcast.snapshotSize).toBe(1);
    expect(
      await database
        .selectFrom("communication_enrollments")
        .selectAll()
        .execute(),
    ).toHaveLength(0);
    await scheduler.processAvailable();
    expect(sent.map((m) => m.chatId)).toEqual(["42"]);
    const current = (
      await http(command("broadcasts.read", { broadcastId: value.broadcastId }))
    ).json().broadcast;
    expect(current.state).toBe("completed");
    expect(
      (
        await http(
          command(
            "broadcasts.launch",
            { broadcastId: value.broadcastId },
            current.revision,
          ),
        )
      ).statusCode,
    ).toBe(409);
  });
  it("suppresses delayed retry permanently across stop/resume; a new broadcast can include the contact", async () => {
    await oldContact();
    const { value } = await launch();
    transport.send.mockResolvedValueOnce({
      kind: "api_retryable",
      providerErrorCode: 429,
      retryAfterSeconds: 60,
    });
    await scheduler.processAvailable();
    await preference(false);
    await preference(true, "901");
    now = new Date(+now + 61_000);
    await scheduler.processAvailable();
    const [delivery] = await broadcastDeliveries(value.broadcastId);
    expect(delivery!.parts).toMatchObject([
      {
        state: "suppressed",
        diagnosticCode: "marketing_unavailable",
        attempts: [{ outcome: "retryable" }],
      },
    ]);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const next = await launch();
    await tick(1);
    expect(
      (await broadcastDeliveries(next.value.broadcastId))[0]!.parts,
    ).toMatchObject([{ state: "sent" }]);
  });
  it("serializes stop versus launch and two dispatchers", async () => {
    await oldContact();
    const value = broadcast();
    await http(command("broadcasts.save", value));
    await Promise.all([
      http(command("broadcasts.launch", { broadcastId: value.broadcastId }, 1)),
      preference(false),
    ]);
    await preference(true, "901");
    await Promise.all([
      scheduler.processAvailable(),
      scheduler.processAvailable(),
    ]);
    expect(sent).toHaveLength(0);
    await launch();
    await Promise.all([
      scheduler.processAvailable(),
      scheduler.processAvailable(),
    ]);
    expect(sent).toHaveLength(1);
  });
  it("preserves in-flight unknown evidence, suppresses pending parts, forbids retry after stop and accepts explicit skip", async () => {
    await oldContact();
    const value = broadcast([part("circle"), part("text")]);
    await launch(value);
    let release!: (r: TelegramDeliveryResult) => void;
    transport.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const sending = scheduler.processAvailable(1);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await preference(false);
    await preference(true, "901");
    release({ kind: "transport_unknown" });
    await sending;
    let [delivery] = await broadcastDeliveries(value.broadcastId);
    expect(delivery!.parts).toMatchObject([
      { state: "unknown" },
      { state: "suppressed" },
    ]);
    expect(delivery!.completed_at).toBeNull();
    expect(
      (
        await http(
          command(
            "delivery.resolve",
            {
              deliveryId: delivery!.delivery_id,
              partId: value.parts[0]!.partId,
              action: "retry",
              duplicateRiskAccepted: true,
            },
            delivery!.revision,
          ),
        )
      ).statusCode,
    ).toBe(409);
    const result = await http(
      command(
        "delivery.resolve",
        {
          deliveryId: delivery!.delivery_id,
          partId: value.parts[0]!.partId,
          action: "skip",
          duplicateRiskAccepted: false,
        },
        delivery!.revision,
      ),
    );
    expect(result.statusCode).toBe(200);
    await tick(120);
    [delivery] = await broadcastDeliveries(value.broadcastId);
    expect(delivery!.completed_at).not.toBeNull();
    expect(transport.send).toHaveBeenCalledTimes(1);
    const history = await http(
      command("deliveries.read", { broadcastId: value.broadcastId }),
    );
    expect(responseValidator(history.json())).toBe(true);
    expect(history.json().deliveries).toHaveLength(1);
  });
  it("cancel waits for already claimed result and never launches another part or recipient", async () => {
    await oldContact();
    const { value, result } = await launch(
      broadcast([part("first"), part("second")]),
    );
    let release!: (r: TelegramDeliveryResult) => void;
    transport.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const sending = scheduler.processAvailable();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(
      (
        await http(
          command(
            "broadcasts.lifecycle",
            { broadcastId: value.broadcastId, action: "cancel" },
            result.revision,
          ),
        )
      ).statusCode,
    ).toBe(200);
    release({ kind: "delivered", providerMessageId: "test" });
    await sending;
    expect(
      (await broadcastDeliveries(value.broadcastId))[0]!.parts,
    ).toMatchObject([{ state: "sent" }, { state: "cancelled" }]);
    const current = (
      await http(command("broadcasts.read", { broadcastId: value.broadcastId }))
    ).json().broadcast;
    expect(
      (
        await http(
          command(
            "broadcasts.launch",
            { broadcastId: value.broadcastId },
            current.revision,
          ),
        )
      ).statusCode,
    ).toBe(409);
  });
  it("persists blocked failure and suppresses all remaining broadcast parts through unblock", async () => {
    await oldContact();
    const { value } = await launch(broadcast([part("first"), part("second")]));
    transport.send.mockResolvedValueOnce({
      kind: "api_rejected",
      providerErrorCode: 403,
    });
    await scheduler.processAvailable();
    await oldContact();
    await tick(60);
    expect(
      (await broadcastDeliveries(value.broadcastId))[0]!.parts,
    ).toMatchObject([
      { state: "suppressed", attempts: [{ outcome: "api_rejected" }] },
      { state: "suppressed" },
    ]);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});

describe("communication analytics and tracking", () => {
  it("creates stable opaque delivery links, safely resolves and ingests idempotent hits separately from automation", async () => {
    await oldContact();
    const content = part("Read");
    const value = broadcast([
      {
        ...content,
        content: {
          ...content.content,
          buttons: [
            { text: "Read", url: "https://platform.example/materials/example" },
            {
              text: "Elsewhere",
              url: "https://other.example/materials/example",
            },
          ],
        },
      },
    ]);
    await launch(value);
    transport.send.mockResolvedValueOnce({
      kind: "api_retryable",
      providerErrorCode: 429,
      retryAfterSeconds: 1,
    });
    await scheduler.processAvailable();
    await tick(2);
    const first = transport.send.mock.calls[0]![0].content.buttons;
    const second = transport.send.mock.calls[1]![0].content.buttons;
    expect(first).toEqual(second);
    expect(first[1]!.url).toBe("https://other.example/materials/example");
    const token = new URL(first[0]!.url).searchParams.get("token")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tracking = (
      operation: string,
      payload: CommunicationsRequest["payload"],
    ) => ({
      ...command(operation, payload),
      actor: { serviceRef: "platform-tracking" as const },
    });
    const resolve = tracking("tracking.resolve", { token });
    expect((await http(resolve)).json().safeUrl).toBe(
      "https://platform.example/materials/example",
    );
    expect((await http(resolve, "wrong")).statusCode).toBe(401);
    expect(
      (await http({ ...resolve, actor: { accountRef: "forged" } })).statusCode,
    ).toBe(400);
    expect(
      (await http(tracking("tracking.resolve", { token: "x".repeat(43) })))
        .statusCode,
    ).toBe(404);
    const event = tracking("tracking.recordHit", {
      token,
      eventId: randomUUID(),
      occurredAt: clock.now().toISOString(),
      traffic: "unknown",
    });
    const races = await Promise.all([
      http(event),
      http({ ...event, operationId: randomUUID() }),
    ]);
    expect(races.map((r) => r.json().outcome).sort()).toEqual([
      "duplicate",
      "recorded",
    ]);
    expect(
      (
        await http({
          ...event,
          payload: { ...event.payload, traffic: "known_automation" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await http({
          ...event,
          payload: { ...event.payload, eventId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    await http(
      tracking("tracking.recordHit", {
        ...event.payload,
        eventId: randomUUID(),
      }),
    );
    await http(
      tracking("tracking.recordHit", {
        ...event.payload,
        eventId: randomUUID(),
        traffic: "known_automation",
      }),
    );
    const stats = await http(
      command("statistics.read", { broadcastId: value.broadcastId }),
    );
    expect(stats.statusCode).toBe(200);
    expect(responseValidator(stats.json())).toBe(true);
    expect(stats.json().statistics).toMatchObject({
      totalBotContacts: 1,
      trackingHits: 2,
      uniqueTokensWithHits: 1,
      knownAutomationHits: 1,
      deliveries: { sent: 1 },
    });
    expect(
      (
        await http({
          ...command("statistics.read", {}),
          actor: { serviceRef: "platform-tracking" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("keeps webhook duplicates separate from deliberate entries and pages complete source history", async () => {
    const value = await setup();
    await start("1", value.sources[0]!.code);
    await start("1", value.sources[0]!.code);
    await start("2", value.sources[0]!.code);
    await start("3");
    let stats = (
      await http(command("statistics.read", { funnelId: value.funnelId }))
    ).json().statistics;
    expect(stats.uniqueParticipants).toBe(1);
    expect(stats.contacts[0].entries).toHaveLength(3);
    expect(stats.contacts[0].firstSourceId).toBe(value.sources[0]!.sourceId);
    expect(stats.contacts[0].latestSourceId).toBeNull();
    await seedEntryPage(4, 104, value);
    const response = await http(command("statistics.read", {}));
    expect(responseValidator(response.json())).toBe(true);
    stats = response.json().statistics;
    expect(stats.contacts[0].entries).toHaveLength(100);
    expect(stats.contacts[0].nextEntryCursor).not.toBeNull();
    const page = await http(
      command("entries.read", {
        contactId: stats.contacts[0].contactId,
        cursor: stats.contacts[0].nextEntryCursor,
      }),
    );
    expect(page.statusCode).toBe(200);
    expect(responseValidator(page.json())).toBe(true);
    expect(page.json().entries).toHaveLength(4);
    expect(page.json().nextCursor).toBeNull();
    expect(
      (
        await http(
          command("entries.read", {
            contactId: stats.contacts[0].contactId,
            cursor: "bad",
          }),
        )
      ).statusCode,
    ).toBe(400);
  });
  it("checks fresh author permission, revision and actor on replay, and isolates foreign broadcasts", async () => {
    await oldContact();
    const { value, request } = await launch();
    authorization.authorize.mockResolvedValueOnce("denied");
    expect((await http(request)).statusCode).toBe(403);
    const foreign = { accountRef: "another-author" };
    for (const op of [
      "broadcasts.read",
      "statistics.read",
      "deliveries.read",
    ]) {
      const res = await http({
        ...command(op, { broadcastId: value.broadcastId }),
        actor: foreign,
      });
      expect(
        op === "deliveries.read" ? res.json().deliveries : res.statusCode,
      ).toEqual(op === "deliveries.read" ? [] : 404);
    }
    const list = await http(command("broadcasts.list", {}));
    expect(responseValidator(list.json())).toBe(true);
    expect(list.json().broadcasts).toHaveLength(1);
  });
});

describe("broadcast crash boundaries", () => {
  it("rolls back a failed audience snapshot and records exactly one snapshot after retry", async () => {
    await oldContact();
    await oldContact("43");
    const value = broadcast();
    await http(command("broadcasts.save", value));
    const request = command(
      "broadcasts.launch",
      { broadcastId: value.broadcastId },
      1,
    );
    await sql`create function synthetic_broadcast_snapshot_fault() returns trigger language plpgsql as $$ begin raise exception 'synthetic snapshot failure'; end $$;
      create trigger synthetic_broadcast_snapshot_fault before insert on communication_deliveries for each row execute function synthetic_broadcast_snapshot_fault()`.execute(
      database,
    );
    try {
      expect((await http(request)).statusCode).toBe(500);
    } finally {
      await sql`drop trigger synthetic_broadcast_snapshot_fault on communication_deliveries; drop function synthetic_broadcast_snapshot_fault()`.execute(
        database,
      );
    }
    expect(await broadcastDeliveries(value.broadcastId)).toHaveLength(0);
    const row = await database
      .selectFrom("communication_broadcasts")
      .selectAll()
      .where("broadcast_id", "=", value.broadcastId)
      .executeTakeFirstOrThrow();
    expect(row.audience_snapshot_id).toBeNull();
    expect(row.state).toBe("draft");
    const responses = await Promise.all([http(request), http(request)]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(responses[0]!.json().broadcast.snapshotSize).toBe(2);
  });
  it("keeps sent after lost acknowledgement and never retries an external effect whose result rolled back", async () => {
    await oldContact();
    await launch();
    const record = scheduler.record.bind(scheduler);
    const spy = vi
      .spyOn(scheduler, "record")
      .mockImplementationOnce(async (...args) => {
        await record(...args);
        throw new Error("synthetic lost ack");
      });
    try {
      await expect(scheduler.processAvailable()).rejects.toThrow(
        "synthetic lost ack",
      );
    } finally {
      spy.mockRestore();
    }
    await tick(120);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const { value } = await launch();
    await sql`create function synthetic_broadcast_record_fault() returns trigger language plpgsql as $$ begin if new.completed_at is not null then raise exception 'synthetic record failure'; end if; return new; end $$;
      create trigger synthetic_broadcast_record_fault before update on communication_deliveries for each row execute function synthetic_broadcast_record_fault()`.execute(
      database,
    );
    try {
      await expect(scheduler.processAvailable()).rejects.toThrow(
        "synthetic record failure",
      );
    } finally {
      await sql`drop trigger synthetic_broadcast_record_fault on communication_deliveries; drop function synthetic_broadcast_record_fault()`.execute(
        database,
      );
    }
    await tick(120);
    await tick(120);
    expect(
      (await broadcastDeliveries(value.broadcastId))[0]!.parts,
    ).toMatchObject([
      { state: "unknown", attempts: [{ diagnosticCode: "worker_lost" }] },
    ]);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });
  it("pause before the scheduled time prevents snapshot until resume and cancelled schedules never launch", async () => {
    await oldContact();
    const { value, result } = await launch(
      broadcast([part("scheduled")], new Date(+now + 60_000).toISOString()),
    );
    await http(
      command(
        "broadcasts.lifecycle",
        { broadcastId: value.broadcastId, action: "pause" },
        result.revision,
      ),
    );
    await tick(120);
    expect(await broadcastDeliveries(value.broadcastId)).toHaveLength(0);
    await oldContact("43");
    await http(
      command(
        "broadcasts.lifecycle",
        { broadcastId: value.broadcastId, action: "resume" },
        result.revision + 1,
      ),
    );
    await tick();
    expect(await broadcastDeliveries(value.broadcastId)).toHaveLength(2);
    const cancelled = await launch(
      broadcast([part("cancelled")], new Date(+now + 60_000).toISOString()),
    );
    await http(
      command(
        "broadcasts.lifecycle",
        { broadcastId: cancelled.value.broadcastId, action: "cancel" },
        cancelled.result.revision,
      ),
    );
    await tick(120);
    expect(await broadcastDeliveries(cancelled.value.broadcastId)).toHaveLength(
      0,
    );
  });
});

it("orders first/latest and continuation by entry time when a later Telegram update ID is lower", async () => {
  const value = await setup();
  await start("100", value.sources[0]!.code);
  await seedEntryPage(101, 200, value);
  const initial = (await http(command("statistics.read", {}))).json().statistics
    .contacts[0];
  now = new Date(+now + 8 * 24 * 60 * 60 * 1000);
  await start("1");
  const current = (await http(command("statistics.read", {}))).json().statistics
    .contacts[0];
  expect(current.firstSourceId).toBe(value.sources[0]!.sourceId);
  expect(current.latestSourceId).toBeNull();
  const page = (
    await http(
      command("entries.read", {
        contactId: initial.contactId,
        cursor: initial.nextEntryCursor,
      }),
    )
  ).json();
  expect(page.entries).toHaveLength(2);
  expect(page.entries[1].sourceId).toBeNull();
});

async function seedEntryPage(first: number, last: number, funnel: FunnelDraft) {
  const contact = await database
    .selectFrom("communication_contacts")
    .select("contact_id")
    .where("telegram_user_id", "=", "42")
    .executeTakeFirstOrThrow();
  await database
    .insertInto("communication_entries")
    .values(
      Array.from({ length: last - first + 1 }, (_, offset) => ({
        bot_identity: "inside",
        update_id: String(first + offset),
        contact_id: contact.contact_id,
        funnel_id: funnel.funnelId,
        source_id: funnel.sources[0]!.sourceId,
        source_code: funnel.sources[0]!.code,
        entered_at: clock.now(),
        outcome: "entered",
      })),
    )
    .execute();
}

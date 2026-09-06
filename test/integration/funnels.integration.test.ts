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
  DeliveryPart,
} from "../../src/modules/communications/funnel-types.js";
import { CLOCK } from "../../src/modules/identity-linking/clock.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import { TelegramWebhook } from "../../src/modules/webhook/telegram-webhook.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { StartResponseDeliveryProcessor } from "../../src/modules/outbound/start-response-delivery-processor.js";
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
  await sql`truncate communication_funnels, communication_intro, communication_operations, telegram_transport_slots, bot_contacts, bot_contact_events, telegram_updates, start_response_deliveries cascade`.execute(
    database,
  );
  now = new Date("2030-01-01T00:00:00Z");
  sent.length = 0;
  transport.send.mockClear();
  authorization.authorize.mockResolvedValue("allowed");
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
async function deliveries() {
  return database
    .selectFrom("communication_deliveries")
    .selectAll()
    .orderBy("created_at")
    .execute();
}

describe("funnel author contract", () => {
  it("publishes immutable snapshots with competing revisions and replay after edits", async () => {
    const value = await setup();
    const publish = command("funnels.publish", { funnelId: value.funnelId }, 2);
    const responses = await Promise.all([http(publish), http(publish)]);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(responseValidator(res.json())).toBe(true);
    }
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    const changed = {
      ...value,
      name: "edited",
      entryResponse: { ...value.entryResponse, parts: [part("edited")] },
    };
    const races = await Promise.all([
      http(command("funnels.save", changed, 3)),
      http(command("funnels.save", changed, 3)),
    ]);
    expect(races.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await http(publish)).json()).toEqual(responses[0]!.json());
    const persisted = await database
      .selectFrom("communication_publications")
      .select("snapshot")
      .where("funnel_id", "=", value.funnelId)
      .where("revision", "=", 3)
      .executeTakeFirstOrThrow();
    expect(persisted.snapshot).toEqual(value);
    authorization.authorize.mockResolvedValue("denied");
    expect((await http(publish)).statusCode).toBe(403);
  });
  it("rejects foreign owners, duplicated IDs, source reuse and auth-shaped source codes", async () => {
    const value = await setup();
    expect(
      (
        await http({
          ...command("funnels.read", { funnelId: value.funnelId }),
          actor: { accountRef: "other" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await http(
          command(
            "funnels.save",
            { ...value, steps: [value.steps[0]!, value.steps[0]!] },
            2,
          ),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await http(
          command("funnels.save", {
            ...draft("other", false),
            sources: value.sources,
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await http(
          command("funnels.save", {
            ...draft(),
            sources: [
              {
                sourceId: randomUUID(),
                name: "bad",
                code: "m_" + "a".repeat(41),
              },
            ],
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await http(
          command("funnels.read", { funnelId: value.funnelId }),
          "forged-secret",
        )
      ).statusCode,
    ).toBe(401);
  });
});
describe("durable marketing entry and scheduling", () => {
  it("serializes two sources, intro once and update replay, while explicit reentry returns the material", async () => {
    const value = draft();
    const second = { sourceId: randomUUID(), code: "m_second", name: "second" };
    await setup({ ...value, sources: [...value.sources, second] });
    await Promise.all([
      start("1", value.sources[0]!.code),
      start("2", second.code),
    ]);
    await start("1", value.sources[0]!.code);
    expect(
      await database.selectFrom("communication_entries").selectAll().execute(),
    ).toHaveLength(2);
    expect(
      await database
        .selectFrom("communication_enrollments")
        .selectAll()
        .execute(),
    ).toHaveLength(1);
    expect((await deliveries()).filter((d) => d.kind === "intro")).toHaveLength(
      1,
    );
    await scheduler.processAvailable();
    await tick();
    await tick();
    expect(sent.map((m) => m.content.text)).toEqual([
      "intro",
      "general:entry",
      "general:entry",
    ]);
    await start("3", value.sources[0]!.code);
    await tick();
    expect(sent.filter((m) => m.content.text === "general:entry")).toHaveLength(
      3,
    );
    expect((await deliveries()).filter((d) => d.kind === "intro")).toHaveLength(
      1,
    );
  });
  it("advances from actual multipart completion across restarts and has no shared funnel daily cap", async () => {
    const a = await setup();
    const b = draft("topic", false);
    await funnels.execute(command("funnels.save", b));
    await funnels.execute(
      command("funnels.publish", { funnelId: b.funnelId }, 1),
    );
    await start("1");
    await start("2", "m_topic");
    await scheduler.processAvailable();
    await tick();
    await tick();
    await tick(30);
    const secondWorker = new FunnelScheduler(
      database,
      config,
      clock,
      transport,
    );
    await Promise.all([
      scheduler.processAvailable(),
      secondWorker.processAvailable(),
    ]);
    await tick();
    expect(sent.filter((m) => m.content.text.endsWith("step1"))).toHaveLength(
      2,
    );
    await tick(9);
    expect(sent.filter((m) => m.content.text.endsWith("step2"))).toHaveLength(
      1,
    );
    await tick();
    expect(sent.filter((m) => m.content.text.endsWith("step2"))).toHaveLength(
      2,
    );
    expect(
      (await deliveries()).filter((d) => d.step_id === a.steps[0]!.stepId),
    ).toHaveLength(1);
  });
  it("waits for all parts, preserves confirmed parts on 429 and never retries unknown", async () => {
    const value = draft();
    const circle: MessagePart = {
      partId: randomUUID(),
      content: {
        type: "video_note",
        fileId: "synthetic_file",
        text: "",
        entities: [],
        buttons: [],
      },
    };
    await setup({
      ...value,
      entryResponse: {
        ...value.entryResponse,
        parts: [circle, part("explanation")],
      },
    });
    await start();
    await scheduler.processAvailable();
    await tick();
    transport.send.mockResolvedValueOnce({
      kind: "api_retryable",
      providerErrorCode: 429,
      retryAfterSeconds: 20,
    });
    await tick();
    await tick(19);
    expect(sent.filter((m) => m.content.type === "video_note")).toHaveLength(1);
    await tick();
    expect(sent.at(-1)?.content.text).toBe("explanation");
    await tick(9);
    expect(sent.some((m) => m.content.text === "general:step1")).toBe(false);
    transport.send.mockResolvedValueOnce({ kind: "transport_unknown" });
    await tick();
    const calls = transport.send.mock.calls.length;
    await tick(86400);
    expect(transport.send).toHaveBeenCalledTimes(calls);
    expect(
      (await deliveries()).some((d) =>
        (d.parts as DeliveryPart[]).some((p) => p.state === "unknown"),
      ),
    ).toBe(true);
  });
  it("keeps auth and malformed sign-in out of marketing and offers a fallback without enrollment", async () => {
    await setup();
    const webhook = app.get(TelegramWebhook);
    const processor = app.get(TelegramUpdateProcessor);
    for (const [i, payload] of [
      "a".repeat(43),
      "m_" + "a".repeat(41),
      "signin_" + "a".repeat(35),
      "signin_broken",
      "bad+token",
    ].entries()) {
      await webhook.accept(config.webhookSecret, {
        update_id: 100 + i,
        message: {
          message_id: 100 + i,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false },
          text: `/start ${payload}`,
        },
      });
    }
    await processor.processAvailable(20, new Date("2031-01-01"));
    expect(
      await database.selectFrom("communication_entries").selectAll().execute(),
    ).toHaveLength(0);
    await database.deleteFrom("start_response_deliveries").execute();
    await start("200", "m_missing");
    await scheduler.processAvailable();
    expect(sent.at(-1)?.offerStart).toBe(true);
    expect(
      await database
        .selectFrom("communication_enrollments")
        .selectAll()
        .execute(),
    ).toHaveLength(0);
  });
  it("archives a source without resetting its enrollment history", async () => {
    const value = await setup();
    await start();
    await scheduler.processAvailable();
    await tick();
    await funnels.execute(
      command(
        "funnels.lifecycle",
        { funnelId: value.funnelId, action: "archive" },
        2,
      ),
    );
    await start("2", "m_general");
    await tick(100);
    expect(sent.at(-1)?.offerStart).toBe(true);
    expect(sent.some((m) => m.content.text === "general:step1")).toBe(false);
    expect(
      await database
        .selectFrom("communication_enrollments")
        .selectAll()
        .execute(),
    ).toHaveLength(1);
  });
  it("prioritizes service responses and rechecks stopped and blocked contacts", async () => {
    await setup();
    await start();
    await app.get(BotContacts).observeStart({
      botIdentity: "inside",
      telegramUserId: "43",
      privateChatId: "43",
      updateId: "2",
      observedAt: now,
    });
    expect(await scheduler.processAvailable()).toBe(0);
    await app.get(StartResponseDeliveryProcessor).processAvailable(1, now);
    expect(await scheduler.processAvailable()).toBe(0); // shared global slot
    await tick();
    expect(sent).toHaveLength(1);
    await database
      .updateTable("communication_contacts")
      .set({ marketing_enabled: false })
      .execute();
    await start("3");
    await tick(100);
    expect(sent).toHaveLength(2);
    await database
      .updateTable("communication_contacts")
      .set({ marketing_enabled: true })
      .execute();
    await app.get(BotContacts).observeContactability({
      botIdentity: "inside",
      telegramUserId: "42",
      contactability: "blocked",
      observedAt: now,
      updateId: "4",
    });
    await tick(100);
    expect(sent).toHaveLength(2);
  });
  it("a crash after claim is unknown; competing workers and DB acknowledgement faults never redispatch", async () => {
    await setup();
    await start();
    // A persisted claim can outlive its worker without gaining automatic permission to send again.
    const pending = (await deliveries()).find((d) => d.kind === "intro")!;
    const parts = pending.parts as DeliveryPart[];
    parts[0]!.state = "in_flight";
    await database
      .updateTable("communication_deliveries")
      .set({
        parts: JSON.stringify(parts),
        attempt_id: randomUUID(),
        locked_at: now,
      })
      .where("delivery_id", "=", pending.delivery_id)
      .execute();
    await tick(61);
    expect(sent).toHaveLength(0);
    expect(
      (
        (await deliveries()).find((d) => d.kind === "intro")!
          .parts as DeliveryPart[]
      )[0]!.state,
    ).toBe("unknown");
  });
});

describe("external dispatch crash boundaries", () => {
  it("competing live claims do not repeat a possible effect, even after the worker timeout", async () => {
    await setup();
    await start();
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (result: TelegramDeliveryResult) => void;
    transport.send.mockImplementationOnce(async (message) => {
      sent.push(message);
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const running = scheduler.processAvailable(1);
    await sending;
    const other = new FunnelScheduler(database, config, clock, transport);
    expect(await other.processAvailable()).toBe(0);
    now = new Date(now.getTime() + 61_000);
    expect(await other.processAvailable()).toBe(0);
    expect(sent).toHaveLength(1);
    finish({ kind: "delivered", providerMessageId: "123" });
    await running;
    const intro = (await deliveries()).find((d) => d.kind === "intro")!;
    expect(intro.completed_at).not.toBeNull();
    expect(
      (intro.parts as DeliveryPart[])[0]!.attempts.map((a) => a.outcome),
    ).toEqual(["unknown", "sent"]);
  });
  it("preserves sent after a commit-then-error acknowledgement and blocks an unrecorded external result", async () => {
    await setup();
    await start();
    const record = scheduler.record.bind(scheduler);
    const fault = vi
      .spyOn(scheduler, "record")
      .mockImplementationOnce(async (...args) => {
        await record(...args);
        throw new Error("synthetic lost DB acknowledgement");
      });
    await expect(scheduler.processAvailable()).rejects.toThrow(
      "synthetic lost DB acknowledgement",
    );
    fault.mockRestore();
    await tick();
    expect(sent.filter((m) => m.content.text === "intro")).toHaveLength(1);
    // A result transaction rollback after the external effect leaves the durable claim intact.
    await sql`create function synthetic_marketing_ack_fault() returns trigger language plpgsql as $$ begin if new.completed_at is not null then raise exception 'synthetic ack failure'; end if; return new; end $$;
    create trigger synthetic_marketing_ack_fault before update on communication_deliveries for each row execute function synthetic_marketing_ack_fault()`.execute(
      database,
    );
    try {
      now = new Date(now.getTime() + 10_000);
      await expect(scheduler.processAvailable()).rejects.toThrow(
        "synthetic ack failure",
      );
    } finally {
      await sql`drop trigger synthetic_marketing_ack_fault on communication_deliveries; drop function synthetic_marketing_ack_fault()`.execute(
        database,
      );
    }
    const count = sent.length;
    await tick(61);
    expect(sent).toHaveLength(count);
    expect(
      (await deliveries()).some((d) =>
        (d.parts as DeliveryPart[]).some((p) => p.state === "unknown"),
      ),
    ).toBe(true);
  });
  it("rolls back a failed claim before external I/O and resumes safely", async () => {
    await setup();
    await start();
    await sql`create function synthetic_marketing_claim_fault() returns trigger language plpgsql as $$ begin if new.attempt_id is not null then raise exception 'synthetic claim failure'; end if; return new; end $$;
   create trigger synthetic_marketing_claim_fault before update on communication_deliveries for each row execute function synthetic_marketing_claim_fault()`.execute(
      database,
    );
    try {
      await expect(scheduler.processAvailable()).rejects.toThrow(
        "synthetic claim failure",
      );
      expect(sent).toHaveLength(0);
    } finally {
      await sql`drop trigger synthetic_marketing_claim_fault on communication_deliveries; drop function synthetic_marketing_claim_fault()`.execute(
        database,
      );
    }
    await Promise.all([
      scheduler.processAvailable(),
      new FunnelScheduler(
        database,
        config,
        clock,
        transport,
      ).processAvailable(),
    ]);
    expect(sent).toHaveLength(1);
  });
  it("exposes intro and multipart results through the versioned owner query and rejects a foreign actor", async () => {
    await setup();
    await start();
    await scheduler.processAvailable();
    await tick();
    const request = command("deliveries.read", {});
    const res = await http(request);
    expect(res.statusCode).toBe(200);
    expect(responseValidator(res.json())).toBe(true);
    expect(res.json().deliveries).toHaveLength(3);
    const other = await http({
      ...request,
      operationId: randomUUID(),
      actor: { accountRef: "other" },
    });
    expect(other.json().deliveries).toEqual([]);
  });
});

describe("recovery and completion serialization", () => {
  it("does not overwrite a confirmed part when stale recovery overlaps record", async () => {
    await setup();
    await start();
    const pending = (await deliveries()).find((d) => d.kind === "intro")!;
    const parts = pending.parts as DeliveryPart[];
    parts[0]!.state = "in_flight";
    const attemptId = randomUUID();
    await database
      .updateTable("communication_deliveries")
      .set({
        parts: JSON.stringify(parts),
        attempt_id: attemptId,
        locked_at: now,
      })
      .where("delivery_id", "=", pending.delivery_id)
      .execute();
    now = new Date(now.getTime() + 61_000);
    let staleRead!: () => void;
    const hasRead = new Promise<void>((resolve) => {
      staleRead = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = new Set<unknown>();
    let armed = true;
    const recoveryDatabase = database.withPlugin({
      transformQuery(args) {
        if (
          armed &&
          args.node.kind === "SelectQueryNode" &&
          JSON.stringify(args.node).includes(
            '"column":{"kind":"IdentifierNode","name":"locked_at"}',
          )
        ) {
          intercepted.add(args.queryId);
          armed = false;
        }
        return args.node;
      },
      async transformResult(args) {
        if (intercepted.has(args.queryId)) {
          staleRead();
          await barrier;
        }
        return args.result;
      },
    });
    const recovery = new FunnelScheduler(
      recoveryDatabase,
      config,
      clock,
      transport,
    ).processAvailable(1);
    await hasRead;
    const completing = scheduler.record(pending.delivery_id, attemptId, {
      kind: "delivered",
      providerMessageId: "123",
    });
    try {
      await vi.waitFor(
        async () => {
          const waiting = await sql<{
            count: string;
          }>`select count(*) from pg_stat_activity where datname=current_database() and wait_event='advisory'`.execute(
            database,
          );
          expect(Number(waiting.rows[0]!.count)).toBeGreaterThan(0);
        },
        { timeout: 1500, interval: 10 },
      );
    } finally {
      release();
      await Promise.all([recovery, completing]);
    }
    const saved = (await deliveries()).find(
      (d) => d.delivery_id === pending.delivery_id,
    )!;
    expect((saved.parts as DeliveryPart[])[0]!.state).toBe("sent");
    expect(saved.completed_at).not.toBeNull();
    expect(
      (saved.parts as DeliveryPart[])[0]!.attempts.map((a) => a.outcome),
    ).toEqual(["unknown", "sent"]);
  });
  it("filters delivery history by its exact ID instead of returning unrelated deliveries", async () => {
    await setup();
    await start();
    const initial = (await deliveries()).find((d) => d.kind === "intro")!;
    const response = await http(
      command("deliveries.read", { deliveryId: initial.delivery_id }),
    );
    expect(
      response
        .json()
        .deliveries.map((d: { deliveryId: string }) => d.deliveryId),
    ).toEqual([initial.delivery_id]);
    expect(
      (
        await http(command("deliveries.read", { broadcastId: randomUUID() }))
      ).json().deliveries,
    ).toEqual([]);
    expect(
      (await http(command("deliveries.read", { cursor: "-".repeat(36) })))
        .statusCode,
    ).toBe(400);
  });
});

async function publish(value: FunnelDraft) {
  const current = await database
    .selectFrom("communication_funnels")
    .select("revision")
    .where("funnel_id", "=", value.funnelId)
    .executeTakeFirstOrThrow();
  await funnels.execute(command("funnels.save", value, current.revision));
  return funnels.execute(
    command(
      "funnels.publish",
      { funnelId: value.funnelId },
      current.revision + 1,
    ),
  );
}
async function preference(enabled: boolean, updateId: string) {
  await entry.setPreference(
    {
      botIdentity: "inside",
      telegramUserId: "42",
      privateChatId: "42",
      updateId,
      observedAt: now,
    },
    enabled,
  );
  // Timeline tests isolate subscriber time from the separately tested service transport lane.
  await database
    .updateTable("start_response_deliveries")
    .set({ state: "delivered", delivered_at: now })
    .execute();
}
async function initialComplete(value = draft()) {
  await setup(value);
  await start();
  await scheduler.processAvailable();
  await tick();
  return value;
}
async function resolve(
  deliveryId: string,
  action: "retry" | "skip",
  duplicateRiskAccepted = false,
) {
  const d = (await deliveries()).find((d) => d.delivery_id === deliveryId)!;
  const p = (d.parts as DeliveryPart[]).find((p) =>
    ["unknown", "failed"].includes(p.state),
  )!;
  return http(
    command(
      "delivery.resolve",
      { deliveryId, partId: p.partId, action, duplicateRiskAccepted },
      d.revision,
    ),
  );
}

describe("published audience updates and subscriber preferences #29", () => {
  it("backfills ongoing and completed audiences from publication, once across restarts", async () => {
    const value = await initialComplete();
    await tick(10);
    await tick(10);
    const firstPublished = await database
      .selectFrom("communication_step_ids")
      .selectAll()
      .execute();
    now = new Date(+now + 30 * 86400000);
    await start("2", undefined, "43");
    await scheduler.processAvailable();
    await tick();
    const added = {
      stepId: randomUUID(),
      delaySeconds: 86400,
      parts: [part("added")],
    };
    const publishedAt = new Date(now);
    await publish({ ...value, steps: [...value.steps, added] });
    await tick(100);
    await tick(100);
    await tick(86000);
    expect(sent.filter((m) => m.content.text === "added")).toHaveLength(0);
    now = new Date(+publishedAt + 86400000);
    const second = new FunnelScheduler(database, config, clock, transport);
    await Promise.all([
      scheduler.processAvailable(),
      second.processAvailable(),
    ]);
    await tick();
    expect(sent.filter((m) => m.content.text === "added")).toHaveLength(1);
    await tick(200);
    expect(sent.filter((m) => m.content.text === "added")).toHaveLength(2);
    await tick(86400);
    expect(sent.filter((m) => m.content.text === "added")).toHaveLength(2);
    expect(
      (await deliveries()).filter((d) => d.step_id === added.stepId),
    ).toHaveLength(2);
    for (const old of firstPublished)
      expect(
        await database
          .selectFrom("communication_step_ids")
          .select("first_published_at")
          .where("step_id", "=", old.step_id)
          .executeTakeFirst(),
      ).toEqual({ first_published_at: old.first_published_at });
  });
  it("edits pending snapshots, inserts/reorders before pending and uses the last actual completion", async () => {
    const value = await initialComplete();
    const inserted = {
      stepId: randomUUID(),
      delaySeconds: 5,
      parts: [part("inserted")],
    };
    await publish({
      ...value,
      steps: [
        inserted,
        { ...value.steps[0]!, parts: [part("edited")] },
        value.steps[1]!,
      ],
    });
    await tick(5);
    expect(sent.at(-1)?.content.text).toBe("inserted");
    await tick(9);
    expect(sent.at(-1)?.content.text).toBe("inserted");
    await tick();
    expect(sent.at(-1)?.content.text).toBe("edited");
    await publish({
      ...value,
      steps: [value.steps[1]!, inserted, value.steps[0]!],
    });
    await tick(9);
    expect(sent.at(-1)?.content.text).toBe("edited");
    await tick();
    expect(sent.at(-1)?.content.text).toBe("general:step2");
    await tick(100);
    expect(sent).toHaveLength(5);
  });
  it("deletes pending, preserves terminal history and rollback restores only unattempted deletion", async () => {
    const value = await initialComplete();
    await publish({ ...value, steps: [value.steps[1]!] });
    const deleted = (await deliveries()).find(
      (d) => d.step_id === value.steps[0]!.stepId,
    )!;
    expect(deleted.completed_at).toEqual(now);
    expect((deleted.parts as DeliveryPart[])[0]!.state).toBe("cancelled");
    const res = await http(
      command(
        "funnels.rollback",
        { funnelId: value.funnelId, publishedRevision: 2 },
        4,
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(responseValidator(res.json())).toBe(true);
    await tick(10);
    expect(sent.at(-1)?.content.text).toBe("general:step1");
    await tick(10);
    expect(sent.at(-1)?.content.text).toBe("general:step2");
    const first = (await deliveries()).find(
      (d) => d.step_id === value.steps[0]!.stepId,
    )!;
    expect(first.delivery_id).toBe(deleted.delivery_id);
    expect((first.parts as DeliveryPart[])[0]!.state).toBe("sent");
  });
  it("finishes partial cancellation at the terminal timestamp, never before unknown resolution", async () => {
    const value = draft();
    const circle: MessagePart = {
      partId: randomUUID(),
      content: {
        type: "video_note",
        fileId: "synthetic",
        text: "",
        entities: [],
        buttons: [],
      },
    };
    const first = {
      ...value.steps[0]!,
      parts: [circle, part("text"), part("tail")],
    };
    await initialComplete({ ...value, steps: [first, value.steps[1]!] });
    await tick(10);
    transport.send.mockResolvedValueOnce({ kind: "transport_unknown" });
    await tick();
    const before = (await deliveries()).find(
      (d) => d.step_id === first.stepId,
    )!;
    const evidence = (before.parts as DeliveryPart[])[1]!.attempts;
    await publish({ ...value, steps: [value.steps[1]!] });
    const cancelled = (await deliveries()).find(
      (d) => d.step_id === first.stepId,
    )!;
    expect(cancelled.cancel_requested).toBe(true);
    expect(cancelled.completed_at).toBeNull();
    expect((cancelled.parts as DeliveryPart[]).map((p) => p.state)).toEqual([
      "sent",
      "unknown",
      "cancelled",
    ]);
    await tick(100);
    expect(sent.at(-1)?.content.type).toBe("video_note");
    expect((await resolve(before.delivery_id, "retry", true)).statusCode).toBe(
      409,
    );
    const skipped = await resolve(before.delivery_id, "skip");
    expect(skipped.statusCode).toBe(200);
    expect(responseValidator(skipped.json())).toBe(true);
    const resolved = (await deliveries()).find(
      (d) => d.delivery_id === before.delivery_id,
    )!;
    expect((resolved.parts as DeliveryPart[])[1]!.attempts).toEqual(evidence);
    expect(resolved.completed_at).toEqual(now);
    await tick(9);
    expect(sent.at(-1)?.content.type).toBe("video_note");
    await tick();
    expect(sent.at(-1)?.content.text).toBe("general:step2");
  });
  it("explicit retry requires accepting unknown risk, preserves evidence, dedupes the decision and rechecks permission", async () => {
    await initialComplete();
    transport.send.mockResolvedValueOnce({ kind: "transport_unknown" });
    await tick(10);
    const d = (await deliveries()).find((d) => d.kind === "step")!;
    expect((await resolve(d.delivery_id, "retry")).statusCode).toBe(409);
    const request = command(
      "delivery.resolve",
      {
        deliveryId: d.delivery_id,
        partId: (d.parts as DeliveryPart[])[0]!.partId,
        action: "retry",
        duplicateRiskAccepted: true,
      },
      d.revision,
    );
    const responses = await Promise.all([http(request), http(request)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    await tick();
    const sentPart = (
      (await deliveries()).find((x) => x.delivery_id === d.delivery_id)!
        .parts as DeliveryPart[]
    )[0]!;
    expect(sentPart.attempts[0]!.outcome).toBe("unknown");
    expect(sentPart.attempts[1]!.duplicateRiskAccepted).toBe(true);
    authorization.authorize.mockResolvedValueOnce("denied");
    expect((await http(request)).statusCode).toBe(403);
  });
  it.each([5, 15])(
    "stop at %is suppresses virtual due <= resume and preserves the first future deadline",
    async (stopAt) => {
      const value = await initialComplete();
      now = new Date(+now + stopAt * 1000);
      await preference(false, "10");
      now = new Date("2030-01-01T00:00:16Z");
      await preference(true, "11");
      const first = (await deliveries()).find(
        (d) => d.step_id === value.steps[0]!.stepId,
      )!;
      expect((first.parts as DeliveryPart[])[0]!.state).toBe("suppressed");
      const second = (await deliveries()).find(
        (d) => d.step_id === value.steps[1]!.stepId,
      )!;
      expect(second.due_at).toEqual(new Date("2030-01-01T00:00:21Z"));
      await tick(4);
      expect(sent.some((m) => m.content.text.includes("step"))).toBe(false);
      await tick();
      expect(sent.at(-1)?.content.text).toBe("general:step2");
      await start("12");
      await tick(100);
      expect(sent.some((m) => m.content.text === "general:step1")).toBe(false);
    },
  );
  it("resume before any due preserves the existing deadline; stop does not remove themes or block requested navigation", async () => {
    const a = await initialComplete();
    const b = draft("topic", false);
    await funnels.execute(command("funnels.save", b));
    await funnels.execute(
      command("funnels.publish", { funnelId: b.funnelId }, 1),
    );
    await preference(false, "10");
    await start("11", "m_topic");
    await tick();
    expect(sent.at(-1)?.content.text).toBe("topic:entry");
    expect(
      (
        await database
          .selectFrom("communication_contacts")
          .select("marketing_enabled")
          .executeTakeFirstOrThrow()
      ).marketing_enabled,
    ).toBe(false);
    await preference(true, "12");
    const pending = (await deliveries()).find(
      (d) => d.step_id === a.steps[0]!.stepId,
    )!;
    expect(pending.due_at).toEqual(new Date("2030-01-01T00:00:11Z"));
    expect(
      await database
        .selectFrom("communication_enrollments")
        .selectAll()
        .execute(),
    ).toHaveLength(2);
  });
  it("recomputes edits while stopped and rollback never revives suppressed markers", async () => {
    const value = await initialComplete();
    await preference(false, "10");
    now = new Date(+now + 100000);
    const inserted = {
      stepId: randomUUID(),
      delaySeconds: 20,
      parts: [part("inserted")],
    };
    await publish({
      ...value,
      steps: [inserted, value.steps[1]!, value.steps[0]!],
    });
    now = new Date(+now + 25000);
    await preference(true, "11");
    const added = (await deliveries()).find(
      (d) => d.step_id === inserted.stepId,
    )!;
    expect((added.parts as DeliveryPart[])[0]!.state).toBe("suppressed");
    expect(
      (await deliveries()).find((d) => d.step_id === value.steps[1]!.stepId)!
        .due_at,
    ).toEqual(new Date("2030-01-01T00:02:11Z"));
    const rollback = await http(
      command(
        "funnels.rollback",
        { funnelId: value.funnelId, publishedRevision: 4 },
        4,
      ),
    );
    expect(rollback.statusCode).toBe(200);
    await tick(5);
    expect(sent.at(-1)?.content.text).toBe("general:step2");
    expect(sent.some((m) => m.content.text === "inserted")).toBe(false);
  });
  it("block/unblock suppresses missed work while operator pause retains overdue work and explicit stop survives unblock", async () => {
    const value = await initialComplete();
    await app.get(BotContacts).observeContactability({
      botIdentity: "inside",
      telegramUserId: "42",
      contactability: "blocked",
      observedAt: now,
      updateId: "10",
    });
    await tick(15);
    await app.get(BotContacts).observeContactability({
      botIdentity: "inside",
      telegramUserId: "42",
      contactability: "reachable",
      observedAt: now,
      updateId: "11",
    });
    expect(
      (
        (await deliveries()).find((d) => d.step_id === value.steps[0]!.stepId)!
          .parts as DeliveryPart[]
      )[0]!.state,
    ).toBe("suppressed");
    await funnels.execute(
      command(
        "funnels.lifecycle",
        { funnelId: value.funnelId, action: "pause" },
        2,
      ),
    );
    await tick(100);
    expect(sent).toHaveLength(2);
    await funnels.execute(
      command(
        "funnels.lifecycle",
        { funnelId: value.funnelId, action: "resume" },
        3,
      ),
    );
    await scheduler.processAvailable();
    expect(sent.at(-1)?.content.text).toBe("general:step2");
    await preference(false, "12");
    await start("13");
    expect(
      (
        await database
          .selectFrom("communication_contacts")
          .select("marketing_enabled")
          .executeTakeFirstOrThrow()
      ).marketing_enabled,
    ).toBe(false);
  });
});

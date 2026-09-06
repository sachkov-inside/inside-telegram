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
    expect(sent).toHaveLength(1);
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
    expect(sent).toHaveLength(1);
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

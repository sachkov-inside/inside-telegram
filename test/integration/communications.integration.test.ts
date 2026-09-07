import { FunnelScheduler } from "../../src/modules/communications/funnel-scheduler.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import type { CommunicationMessage } from "../../src/modules/communications/communication-delivery.js";
import {
  AUTHOR_CONTENT_VALIDATION,
  type AuthorContentValidationResult,
} from "../../src/modules/communications/author-content-validation.js";
import type { MessagePart } from "../../src/modules/communications/funnel-types.js";
import {
  AuthorAdmin,
  type State,
} from "../../src/modules/communications/author-admin.js";
import { AuthorDelivery } from "../../src/modules/communications/author-delivery.js";
import { translateAuthorInput } from "../../src/adapters/telegram/grammy-author-admin.adapter.js";
import { randomUUID } from "node:crypto";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import {
  AUTHOR_AUTHORIZATION,
  type AuthorAuthorization,
  type AuthorSubject,
} from "../../src/modules/communications/author-authorization.js";
import { Communications } from "../../src/modules/communications/communications.js";
import {
  COMMUNICATIONS_VERSION,
  contractValidator,
  type CommunicationsRequest,
} from "../../src/modules/communications/communications-contract.js";
import { translateTemplateIntake } from "../../src/adapters/telegram/grammy-template-intake.adapter.js";
import { TelegramUpdateInbox } from "../../src/modules/update-inbox/telegram-update-inbox.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { StartResponseDeliveryProcessor } from "../../src/modules/outbound/start-response-delivery-processor.js";
import { TELEGRAM_MESSAGES } from "../../src/modules/outbound/telegram-messages.js";
import scenarios from "../../src/modules/communications/contracts/inside-communications-v1/scenarios.json" with { type: "json" };
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const database = createDatabase(databaseUrl);
const config = loadApplicationConfig({
  DATABASE_URL: databaseUrl,
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
  TELEGRAM_WELCOME_TEXT: "Synthetic welcome",
  TELEGRAM_LINK_RECEIPT_TEXT: "Synthetic receipt",
  TELEGRAM_LINKED_MEMBER_TEXT: "Synthetic member",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "Synthetic non-member",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "Synthetic unavailable",
  WORKERS_ENABLED: "false",
});
class FakeAuthorization implements AuthorAuthorization {
  result: "allowed" | "denied" | "unavailable" = "allowed";
  subjects: AuthorSubject[] = [];
  async authorize(subject: AuthorSubject) {
    this.subjects.push(subject);
    return this.result;
  }
}
const authorization = new FakeAuthorization();
const contentValidation = {
  result: { status: "ok", targetErrors: [] } as AuthorContentValidationResult,
  snapshots: [] as (readonly MessagePart[])[],
  async validate(_subject: AuthorSubject, parts: readonly MessagePart[]) {
    this.snapshots.push(structuredClone(parts));
    return this.result;
  },
};
const sent: unknown[] = [];
let app: NestFastifyApplication;
let communications: Communications;
beforeAll(async () => {
  await migrateToLatest(database);
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(AUTHOR_AUTHORIZATION)
    .useValue(authorization)
    .overrideProvider(AUTHOR_CONTENT_VALIDATION)
    .useValue(contentValidation)
    .overrideProvider(TELEGRAM_MESSAGES)
    .useValue({
      sendText: async (message: unknown) => {
        sent.push(message);
        return { kind: "delivered", providerMessageId: "123" };
      },
    })
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  communications = app.get(Communications);
});
beforeEach(async () => {
  await sql`truncate communication_author_compositions, communication_author_drafts, communication_funnels, communication_intro, communication_sources, communication_author_sessions, communication_author_receipts, communication_author_outbox, communication_broadcasts, telegram_transport_slots, communication_intake_receipts, communication_operations, communication_templates, communication_author_modes,
    link_transactions, platform_links, telegram_updates, bot_contacts, bot_contact_events, start_response_deliveries restart identity cascade`.execute(
    database,
  );
  contentValidation.result = { status: "ok", targetErrors: [] };
  contentValidation.snapshots = [];
  authorization.result = "allowed";
  authorization.subjects = [];
  sent.length = 0;
});
afterAll(async () => {
  await sql`truncate communication_author_compositions, communication_author_drafts, communication_broadcasts cascade`.execute(
    database,
  );
  await app?.close();
  await database.destroy();
});
const content = {
  type: "text" as const,
  text: "Synthetic snapshot",
  entities: [],
  buttons: [],
};
function request(): CommunicationsRequest {
  return {
    contractVersion: COMMUNICATIONS_VERSION,
    operation: "templates.save",
    operationId: randomUUID(),
    expectedRevision: 0,
    actor: { accountRef: "synthetic-author" },
    payload: { templateId: randomUUID(), content },
  };
}
async function http(
  body: unknown,
  secret: string | undefined = config.platformIntegrationSecret,
) {
  return app.inject({
    method: "POST",
    url: "/integrations/platform/v1/communications",
    payload: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
  });
}
async function seedLink() {
  const now = new Date();
  await database
    .insertInto("link_transactions")
    .values({
      account_ref: "synthetic-author",
      bot_identity: "inside",
      candidate_telegram_user_id: "42",
      confirmed_at: now,
      expires_at: now,
      link_transaction_ref: "synthetic-link",
      received_at: now,
      registered_at: now,
      return_correlation: "synthetic-return",
      state: "linked",
      token_digest: "a".repeat(43),
    })
    .execute();
  await database
    .insertInto("platform_links")
    .values({
      account_ref: "synthetic-author",
      bot_identity: "inside",
      evidence_version: 0,
      last_membership_observation_at: null,
      last_membership_observation_update_id: null,
      link_transaction_ref: "synthetic-link",
      linked_at: now,
      telegram_identity_ref: "synthetic-identity",
      telegram_user_id: "42",
    })
    .execute();
}
function update(id: number, body: Record<string, unknown>) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1788696000,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      ...body,
    },
  };
}
async function intake(id: number, body: Record<string, unknown>) {
  await communications.intake(
    translateTemplateIntake("inside", String(id), update(id, body))!,
  );
}
async function rows() {
  return database.selectFrom("communication_templates").selectAll().execute();
}

describe("versioned HTTP scenarios shared with consumer", () => {
  for (const scenario of scenarios)
    it(scenario.name, async () => {
      for (const step of scenario.steps) {
        authorization.result = step.authorization as "allowed" | "denied";
        const response = await http(step.request);
        expect(response.statusCode).toBe(step.status);
        expect(contractValidator("response")(response.json())).toBe(true);
        if ("revision" in step)
          expect(response.json().template.revision).toBe(step.revision);
      }
    });
  it("rejects untrusted service callers and forged actor properties before permission lookup", async () => {
    expect((await http(request(), "wrong")).statusCode).toBe(401);
    expect(
      (
        await http({
          ...request(),
          actor: {
            accountRef: "synthetic-author",
            permissions: ["communications:manage"],
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(authorization.subjects).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
  it("serializes duplicate operation IDs and competing revisions on independent connections", async () => {
    const command = request();
    const independent = new Communications(database, config, authorization);
    const results = await Promise.all([
      communications.execute(command),
      independent.execute(command),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await rows()).toHaveLength(1);
    const edits = await Promise.allSettled([
      communications.execute({
        ...command,
        operationId: randomUUID(),
        expectedRevision: 1,
      }),
      independent.execute({
        ...command,
        operationId: randomUUID(),
        expectedRevision: 1,
      }),
    ]);
    expect(edits.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await rows())[0]?.revision).toBe(2);
    expect(
      (
        await http({
          ...command,
          payload: {
            ...command.payload,
            content: { ...content, text: "changed" },
          },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("keeps a saved operation result through lost commit acknowledgement and later edits", async () => {
    const command = request();
    await communications.execute(command); // caller loses this committed response
    await communications.execute({
      ...command,
      operationId: randomUUID(),
      expectedRevision: 1,
      payload: { ...command.payload, content: { ...content, text: "edited" } },
    });
    const recovered = await new Communications(
      database,
      config,
      authorization,
    ).execute(command);
    expect(recovered.revision).toBe(1);
    expect(recovered.content.text).toBe(content.text);
    expect((await rows())[0]?.revision).toBe(2);
  });
  it("fails closed on unavailable authorization and hides missing rollback targets", async () => {
    authorization.result = "unavailable";
    expect((await http(request())).statusCode).toBe(503);
    expect(await rows()).toHaveLength(0);
    authorization.result = "allowed";
    expect(
      (
        await http({
          ...request(),
          operation: "funnels.rollback",
          payload: { funnelId: randomUUID(), publishedRevision: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });
});
describe("durable author intake", () => {
  it("requires explicit mode, a real link and fresh permission; username and forward origin do not authorize", async () => {
    await intake(1, { text: "Ordinary message" });
    await intake(2, {
      text: "/template",
      forward_origin: { type: "user", sender_user: { id: 42 } },
      username: "owner",
    });
    expect(await rows()).toHaveLength(0);
    expect(authorization.subjects).toHaveLength(0);
    await seedLink();
    await intake(3, { text: "/template" });
    authorization.result = "denied";
    await intake(4, { text: "Not allowed after revocation" });
    expect(await rows()).toHaveLength(0);
    expect(authorization.subjects.at(-1)).toEqual({
      kind: "telegram",
      accountRef: "synthetic-author",
      telegramIdentityRef: "synthetic-identity",
      botIdentity: "inside",
    });
  });
  for (const type of [
    "text",
    "photo",
    "video",
    "video_note",
    "voice",
    "document",
  ])
    it(`snapshots ${type} independently of source edits/deletion`, async () => {
      await seedLink();
      await intake(1, { text: "/template" });
      const message =
        type === "text"
          ? {
              text: "Synthetic formatted text",
              entities: [{ type: "bold", offset: 0, length: 9 }],
            }
          : {
              [type]:
                type === "photo"
                  ? [
                      { file_id: "synthetic_small" },
                      { file_id: "synthetic_large" },
                    ]
                  : { file_id: "synthetic_file" },
              ...(type !== "video_note"
                ? {
                    caption: "Synthetic caption",
                    caption_entities: [
                      { type: "italic", offset: 0, length: 9 },
                    ],
                  }
                : {}),
            };
      await Promise.all([intake(2, message), intake(2, message)]);
      const saved = await rows();
      expect(saved).toHaveLength(1);
      const inbox = app.get(TelegramUpdateInbox);
      await inbox.accept(
        "inside",
        "3",
        {
          update_id: 3,
          edited_message: { ...update(2, message).message, text: "changed" },
        },
        new Date(),
      );
      await app.get(TelegramUpdateProcessor).processAvailable();
      expect(await rows()).toEqual(saved);
      const read = await http({
        ...request(),
        operation: "templates.read",
        payload: { templateId: saved[0]!.template_id },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().template.content.type).toBe(type);
      if (type === "photo")
        expect(read.json().template.content.fileId).toBe("synthetic_large");
      expect(read.body).not.toContain("api.telegram.org");
    });
  it("rolls back template + reply + receipt together on a database fault, then recovers once", async () => {
    await seedLink();
    await intake(1, { text: "/template" });
    await sql`create function synthetic_reject_intake_receipt() returns trigger language plpgsql as $$ begin raise exception 'synthetic crash'; end; $$;
      create trigger synthetic_intake_crash before insert on communication_intake_receipts for each row execute function synthetic_reject_intake_receipt()`.execute(
      database,
    );
    try {
      await expect(
        intake(2, { text: "Synthetic atomic snapshot" }),
      ).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    } finally {
      await sql`drop trigger synthetic_intake_crash on communication_intake_receipts; drop function synthetic_reject_intake_receipt()`.execute(
        database,
      );
    }
    await intake(2, { text: "Synthetic atomic snapshot" });
    await intake(2, { text: "Synthetic atomic snapshot" });
    expect(await rows()).toHaveLength(1);
    const replies = await database
      .selectFrom("start_response_deliveries")
      .selectAll()
      .execute();
    expect(replies).toHaveLength(2);
  });
  it("runs authenticated webhook dedup through inbox and fake Telegram replies", async () => {
    await seedLink();
    for (const [id, text] of [
      [1, "/template"],
      [2, "Synthetic webhook snapshot"],
    ] as const) {
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/webhooks/telegram",
              headers: {
                "x-telegram-bot-api-secret-token": config.webhookSecret,
              },
              payload: update(id, { text }),
            })
          ).statusCode,
        ).toBe(202);
      await app.get(TelegramUpdateProcessor).processAvailable();
    }
    expect(await rows()).toHaveLength(1);
    await app.get(StartResponseDeliveryProcessor).processAvailable();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent)).toContain((await rows())[0]!.template_id);
    const inbox = await database
      .selectFrom("telegram_updates")
      .selectAll()
      .execute();
    expect(
      inbox.every((r) => r.payload === null && r.state === "processed"),
    ).toBe(true);
  });
  it("does not overtake a pending mode command on another worker", async () => {
    await seedLink();
    const inbox = app.get(TelegramUpdateInbox);
    await inbox.accept(
      "inside",
      "1",
      update(1, { text: "/template" }),
      new Date(),
    );
    await expect(
      intake(2, { text: "Synthetic delayed capture" }),
    ).rejects.toThrow("Earlier author update");
    await app.get(TelegramUpdateProcessor).processAvailable();
    await intake(2, { text: "Synthetic delayed capture" });
    expect(await rows()).toHaveLength(1);
  });
  it("rejects unsupported content explicitly, permits correction, and closes mode after one capture", async () => {
    await seedLink();
    await intake(1, { text: "/template" });
    await intake(2, { poll: {} });
    expect(await rows()).toHaveLength(0);
    await intake(3, { text: "Corrected" });
    await intake(4, { text: "Outside mode" });
    expect(await rows()).toHaveLength(1);
    const result = await database
      .selectFrom("communication_intake_receipts")
      .selectAll()
      .where("update_id", "=", "2")
      .executeTakeFirstOrThrow();
    expect(result.outcome).toBe("unsupported_content");
  });
});

afterEach(async () => {
  await sql`truncate communication_author_sessions, communication_author_receipts, communication_author_outbox`.execute(
    database,
  );
});
async function authorMessage(
  id: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  id = Math.round(id * 10);
  const payload = update(id, { text, ...extra });
  await app
    .get(TelegramUpdateInbox)
    .accept("inside", String(id), payload, new Date());
  await app.get(TelegramUpdateProcessor).processAvailable();
  expect(
    (
      await database
        .selectFrom("telegram_updates")
        .select("state")
        .where("update_id", "=", String(id))
        .executeTakeFirst()
    )?.state,
  ).toBe("processed");
}
let navigationId = 1000000;
async function authorClick(id: number, label: string, depth = 0) {
  id = Math.round(id * 10);
  const messages = await database
    .selectFrom("communication_author_outbox")
    .select("message")
    .orderBy("sequence_id", "desc")
    .execute();
  const menu = messages
    .map(
      (r) =>
        r.message as {
          authorButtons?: { text: string; callbackData: string }[];
        },
    )
    .find((m) => m.authorButtons);
  const data = menu?.authorButtons?.find((b) => b.text === label)?.callbackData;
  if (!data && depth < 8) {
    const state = await sessionState();
    const next = state.menu?.buttons.some(([text]) => text === label)
      ? "Ещё →"
      : menu?.authorButtons?.some((b) => b.text === "Настройки")
        ? "Настройки"
        : "Ещё →";
    if (menu?.authorButtons?.some((b) => b.text === next)) {
      await authorClick(++navigationId, next);
      return authorClick(id / 10, label, depth + 1);
    }
  }
  expect(
    data,
    `${label}: ${menu?.authorButtons?.map((b) => b.text).join(", ")}`,
  ).toBeDefined();
  const payload = {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: 42, is_bot: false },
      message: { chat: { id: 42, type: "private" } },
      data,
    },
  };
  const input = translateAuthorInput("inside", String(id), payload)!;
  await Promise.all([
    app.get(AuthorAdmin).handle(input),
    app.get(AuthorAdmin).handle(input),
  ]);
  return input;
}
async function lastAuthorText() {
  const row = await database
    .selectFrom("communication_author_outbox")
    .select("message")
    .orderBy("sequence_id", "desc")
    .executeTakeFirstOrThrow();
  return (row.message as { content: { text: string } }).content.text;
}

async function sessionState() {
  const row = await database
    .selectFrom("communication_author_sessions")
    .select("state")
    .where("telegram_user_id", "=", "42")
    .executeTakeFirstOrThrow();
  return row.state as State;
}

async function broadcastRows() {
  return database.selectFrom("communication_broadcasts").selectAll().execute();
}

describe("author transport and API", () => {
  it("lists only the current bot owner and checks current authorization before replay", async () => {
    const own = request();
    await communications.execute(own);
    await communications.execute({
      ...request(),
      actor: { accountRef: "another-author" },
    });
    const response = await http({
      ...request(),
      operation: "templates.list",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .templates.map((t: { templateId: string }) => t.templateId),
    ).toEqual([own.payload.templateId]);
    expect(contractValidator("response")(response.json())).toBe(true);
    await seedLink();
    const sample = {
      ...request(),
      operation: "templates.testSend",
      expectedRevision: 1,
      payload: own.payload.templateId
        ? { templateId: own.payload.templateId }
        : {},
    };
    expect((await http(sample)).statusCode).toBe(200);
    authorization.result = "denied";
    expect((await http(sample)).statusCode).toBe(403);
  });
  it("does not resend unknown author samples after worker restart and rejects revoked recipients", async () => {
    await seedLink();
    const post = request();
    await communications.execute(post);
    const sample = {
      ...request(),
      operation: "templates.testSend",
      expectedRevision: 1,
      payload: { templateId: post.payload.templateId! },
    };
    await http(sample);
    let calls = 0;
    const worker = () =>
      new AuthorDelivery(
        database,
        { ...config, deliveryMode: "live" },
        authorization,
        {
          send: async () => {
            calls++;
            return { kind: "transport_unknown" };
          },
        },
      );
    await worker().processAvailable();
    await worker().processAvailable(new Date(Date.now() + 120_000));
    expect(calls).toBe(1);
    expect(
      (
        await database
          .selectFrom("communication_author_outbox")
          .select("state")
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("unknown");
    await http({ ...sample, operationId: randomUUID() });
    authorization.result = "denied";
    await worker().processAvailable(new Date(Date.now() + 240_000));
    expect(calls).toBe(1);
    expect(
      await database
        .selectFrom("communication_author_outbox")
        .select("state")
        .where("state", "=", "rejected")
        .execute(),
    ).toHaveLength(1);
  });
  it("honors known retry_after and keeps samples for one chat ordered across workers", async () => {
    await seedLink();
    const post = request();
    await communications.execute(post);
    const sample = {
      ...request(),
      operation: "templates.testSend",
      expectedRevision: 1,
      payload: { templateId: post.payload.templateId! },
    };
    await http(sample);
    await http({ ...sample, operationId: randomUUID() });
    const time = new Date(Date.now() + 1000);
    let calls = 0;
    const worker = new AuthorDelivery(
      database,
      { ...config, deliveryMode: "live" },
      authorization,
      {
        send: async () => {
          calls++;
          return calls === 1
            ? {
                kind: "api_retryable",
                providerErrorCode: 429,
                retryAfterSeconds: 20,
              }
            : { kind: "delivered", providerMessageId: String(calls) };
        },
      },
    );
    await Promise.all([
      worker.processAvailable(time),
      worker.processAvailable(time),
    ]);
    expect(calls).toBe(1);
    await worker.processAvailable(new Date(time.getTime() + 19_000));
    expect(calls).toBe(1);
    await worker.processAvailable(new Date(time.getTime() + 20_000));
    expect(calls).toBe(2);
    await worker.processAvailable(new Date(time.getTime() + 21_000));
    expect(calls).toBe(3);
    const states = await database
      .selectFrom("communication_author_outbox")
      .select(["state", "attempt_count"])
      .orderBy("sequence_id")
      .execute();
    expect(states).toEqual([
      { state: "delivered", attempt_count: 2 },
      { state: "delivered", attempt_count: 1 },
    ]);
  });
  it("starts a new menu after an unknown edit so a late completion cannot overwrite it", async () => {
    await seedLink();
    const sent: CommunicationMessage[] = [];
    const worker = new AuthorDelivery(
      database,
      { ...config, deliveryMode: "live" },
      authorization,
      {
        send: async (message) => {
          sent.push(message);
          return sent.length === 2
            ? { kind: "transport_unknown" }
            : { kind: "delivered", providerMessageId: String(sent.length) };
        },
      },
    );
    const time = Date.now() + 1000;
    await authorMessage(100, "/admin");
    await worker.processAvailable(new Date(time));
    const stale = await authorClick(101, "Рассылки");
    await worker.processAvailable(new Date(time + 2000));
    expect(sent[1]!.editMessageId).toBe("1");
    // The author retries an old visible button after the edit response was lost.
    await app.get(AuthorAdmin).handle({ ...stale, updateId: "1020" });
    await worker.processAvailable(new Date(time + 4000));
    expect(sent[2]!.editMessageId).toBeUndefined();
    // A late edit of message 1 cannot modify the newly sent message 3.
    expect(sent[2]!.authorMenu).toBe(true);
    expect(
      await database
        .selectFrom("communication_author_outbox")
        .selectAll()
        .where("state", "=", "unknown")
        .execute(),
    ).toHaveLength(1);
  });
});

async function beginSequence(kind: "Рассылки" | "Воронки") {
  await seedLink();
  await authorMessage(100, "/admin");
  await authorClick(101, kind);
  await authorClick(
    102,
    kind === "Рассылки" ? "Создать рассылку" : "Создать воронку",
  );
}
async function acceptPost(
  id: number,
  text: string,
  time: string,
  extra: Record<string, unknown> = {},
) {
  await authorMessage(id, text, extra);
  await authorMessage(id + 0.1, time);
}
describe("simple sequential authoring", () => {
  it("takes one native message and its offset at a time, preserving order and exposing the saved draft to a terminal agent", async () => {
    await beginSequence("Рассылки");
    await authorMessage(103, "Первое", {
      entities: [{ type: "bold", offset: 0, length: 6 }],
    });
    await authorMessage(103, "Первое", {
      entities: [{ type: "bold", offset: 0, length: 6 }],
    });
    expect(await broadcastRows()).toHaveLength(0);
    await authorClick(104, "Сразу");
    await acceptPost(105, "", "1 ЧАС", {
      text: undefined,
      voice: { file_id: "prepared-voice" },
    });
    await acceptPost(106, "Третье", "через 2 часа");
    await authorClick(107, "Готово");
    const b = (await sessionState()).broadcast!;
    expect(b.parts.map((p) => p.sendAfterSeconds)).toEqual([0, 3600, 7200]);
    expect(b.parts[0]!.content.entities).toEqual([
      { type: "bold", offset: 0, length: 6 },
    ]);
    expect(b.parts[1]!.content).toMatchObject({
      type: "voice",
      fileId: "prepared-voice",
    });
    expect(b.audience).toEqual({ kind: "all" });
    const labels = (await sessionState()).menu!.buttons.map(([label]) => label);
    expect(labels).toEqual([
      "Добавить сообщение",
      "Запустить",
      "Отменить рассылку",
      "Посмотреть сообщения",
      "Все рассылки",
    ]);
    const response = await http({
      ...request(),
      operation: "broadcasts.read",
      payload: { broadcastId: b.broadcastId },
    });
    expect(response.statusCode).toBe(200);
    expect(contractValidator("response")(response.json())).toBe(true);
    expect(response.json().broadcast.parts).toEqual(b.parts);
    await authorClick(108, "Запустить");
    expect((await broadcastRows())[0]!.state).toBe("draft");
    expect(
      await database
        .selectFrom("communication_deliveries")
        .selectAll()
        .execute(),
    ).toHaveLength(0);
    expect(await lastAuthorText()).toContain("Запустить");
  });
  it.each([
    ["text", {}],
    [
      "photo",
      { text: undefined, photo: [{ file_id: "photo", width: 10, height: 10 }] },
    ],
    ["video", { text: undefined, video: { file_id: "video" } }],
    ["video_note", { text: undefined, video_note: { file_id: "circle" } }],
    ["voice", { text: undefined, voice: { file_id: "voice" } }],
    ["document", { text: undefined, document: { file_id: "document" } }],
  ])(
    "saves %s and resumes its pending time after leaving the menu",
    async (type, media) => {
      await beginSequence("Рассылки");
      await acceptPost(103, "Начало", "сразу");
      await authorMessage(104, "Текст", media);
      await authorMessage(105, "/admin");
      await authorClick(106, "Рассылки");
      await authorClick(107, "Начало · Черновик");
      await authorClick(108, "Продолжить сообщение");
      await authorMessage(109, "1 день");
      await authorClick(110, "Готово");
      expect((await broadcastRows())[0]!.parts).toMatchObject([
        { content: { text: "Начало" } },
        { sendAfterSeconds: 86400, content: { type } },
      ]);
      expect(
        await database
          .selectFrom("communication_author_compositions")
          .selectAll()
          .execute(),
      ).toHaveLength(0);
    },
  );
  it("rejects unsupported media and decreasing times without losing the pending message; cancellation drops only that message", async () => {
    await beginSequence("Рассылки");
    await authorMessage(103, "", { sticker: { file_id: "unsupported" } });
    expect(await broadcastRows()).toHaveLength(0);
    await acceptPost(104, "Первый", "2 часа");
    await acceptPost(105, "Второй", "1 час");
    expect((await broadcastRows())[0]!.parts).toHaveLength(1);
    expect((await sessionState()).composing!.content!.text).toBe("Второй");
    await authorMessage(106, "/cancel");
    expect((await broadcastRows())[0]!.parts).toHaveLength(1);
    await authorClick(107, "Добавить сообщение");
    await authorMessage(108, "Без доступа");
    authorization.result = "denied";
    await authorMessage(109, "3 часа");
    expect((await broadcastRows())[0]!.parts).toHaveLength(1);
  });
  it("keeps a pending message on concurrent terminal edits and reopens current provider content", async () => {
    await beginSequence("Рассылки");
    await acceptPost(103, "Начало", "сразу");
    await authorMessage(104, "Не потерять");
    const b = (await sessionState()).broadcast!;
    const parts = b.parts.map((p) => ({
      ...p,
      content: { ...p.content, text: "Правка агента" },
    }));
    expect(
      (
        await http({
          ...request(),
          operation: "broadcasts.save",
          expectedRevision: b.revision,
          payload: {
            broadcastId: b.broadcastId,
            parts,
            audience: b.audience,
            scheduledAt: null,
          },
        })
      ).statusCode,
    ).toBe(200);
    await authorMessage(105, "1 час");
    expect(await lastAuthorText()).toContain("изменились");
    expect((await broadcastRows())[0]!.parts).toEqual(parts);
    await authorClick(106, "Рассылки");
    await authorClick(107, "Начало · Черновик");
    await authorClick(108, "Продолжить сообщение");
    expect((await sessionState()).composing!.content!.text).toBe("Не потерять");
    await authorMessage(109, "/cancel");
    expect((await sessionState()).broadcast!.parts).toEqual(parts);
  });
  it("saves a funnel as entry plus offsets from enrollment and allows a terminal agent to configure the same draft", async () => {
    await beginSequence("Воронки");
    await authorMessage(103, "Вход");
    await authorMessage(104, "1 час");
    expect((await sessionState()).funnelAuthor!.funnel!.revision).toBe(0);
    await authorClick(105, "Сразу");
    await acceptPost(106, "Урок", "1 час");
    await acceptPost(107, "Предложение", "2 часа");
    await authorClick(108, "Готово");
    const f = (await sessionState()).funnelAuthor!.funnel!;
    expect(f.entryResponse.parts).toHaveLength(1);
    expect(f.steps.map((s) => [s.delayAnchor, s.delaySeconds])).toEqual([
      ["entry", 3600],
      ["entry", 7200],
    ]);
    expect(f.publishedRevision).toBeNull();
    const r = await http({
      ...request(),
      operation: "funnels.read",
      payload: { funnelId: f.funnelId },
    });
    expect(r.statusCode).toBe(200);
    expect(contractValidator("response")(r.json())).toBe(true);
    const saved = await http({
      ...request(),
      operation: "funnels.save",
      expectedRevision: f.revision,
      payload: {
        funnelId: f.funnelId,
        name: f.name,
        sources: f.sources,
        isDefault: f.isDefault,
        entryResponse: f.entryResponse,
        steps: f.steps.map((s) => ({ ...s, delaySeconds: 7200 })),
      },
    });
    expect(saved.statusCode).toBe(200);
    await authorMessage(109, "/admin");
    await authorClick(110, "Воронки");
    await authorClick(111, "Вход · Черновик");
    expect(
      (await sessionState()).funnelAuthor!.funnel!.steps.map(
        (s) => s.delaySeconds,
      ),
    ).toEqual([7200, 7200]);
    await authorClick(112, "Отменить воронку");
    await authorClick(113, "Да, отменить");
    expect((await sessionState()).funnelAuthor!.funnel!.lifecycle).toBe(
      "archived",
    );
  });
});

it("restores the author menu below the delivered broadcast messages and never exposes it to subscribers", async () => {
  await beginSequence("Рассылки");
  for (const user of ["42", "43"])
    await app.get(BotContacts).observeStart(
      {
        botIdentity: "inside",
        telegramUserId: user,
        privateChatId: user,
        updateId: "99",
        observedAt: new Date(),
      },
      "none",
    );
  await acceptPost(103, "First delivered post", "сразу");
  await acceptPost(104, "Second delivered post", "сразу");
  await authorClick(105, "Готово");
  await authorClick(106, "Запустить");
  await authorClick(108, "Запустить рассылку");
  let now = Date.now() + 1000;
  const observed: CommunicationMessage[] = [];
  const transport = {
    send: async (message: CommunicationMessage) => {
      observed.push(message);
      return {
        kind: "delivered" as const,
        providerMessageId: String(observed.length),
      };
    },
  };
  const author = new AuthorDelivery(
    database,
    { ...config, deliveryMode: "live" },
    authorization,
    transport,
  );
  const marketing = new FunnelScheduler(
    database,
    { ...config, marketingEnabled: true },
    { now: () => new Date(now) },
    transport,
  );
  for (let i = 0; i < 20; i++)
    await author.processAvailable(new Date((now += 2000)));
  for (let i = 0; i < 4; i++) {
    now += 2000;
    await marketing.processAvailable(1);
  }
  for (let i = 0; i < 5; i++)
    await author.processAvailable(new Date((now += 2000)));
  const own = observed.filter((m) => m.chatId === "42");
  expect(own.filter((m) => !m.authorMenu).map((m) => m.content.text)).toEqual([
    "First delivered post",
    "Second delivered post",
  ]);
  expect(own.at(-1)!.authorMenu).toBe(true);
  expect(own.at(-1)!.editMessageId).toBeUndefined();
  expect(
    observed.filter((m) => m.chatId === "43").map((m) => m.authorMenu),
  ).toEqual([undefined, undefined]);
  const input = translateAuthorInput("inside", "9999", {
    callback_query: {
      id: "footer",
      from: { id: 42, is_bot: false },
      message: { chat: { id: 42, type: "private" } },
      data: own.at(-1)!.authorButtons![0]!.callbackData,
    },
  })!;
  await app.get(AuthorAdmin).handle(input);
  expect((await sessionState()).broadcast!.state).toBe("completed");
});

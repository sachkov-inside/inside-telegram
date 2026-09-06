import {
  AUTHOR_CONTENT_VALIDATION,
  type AuthorContentValidationResult,
} from "../../src/modules/communications/author-content-validation.js";
import { Funnels } from "../../src/modules/communications/funnels.js";
import type {
  MessagePart,
  FunnelSnapshot,
} from "../../src/modules/communications/funnel-types.js";
import { AuthorAdmin } from "../../src/modules/communications/author-admin.js";
import { AuthorDelivery } from "../../src/modules/communications/author-delivery.js";
import { translateAuthorInput } from "../../src/adapters/telegram/grammy-author-admin.adapter.js";
import { randomUUID } from "node:crypto";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { DatabaseSchema } from "../../src/database/database.js";
import { Funnels } from "../../src/modules/communications/funnels.js";
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
  await sql`truncate communication_funnels, communication_intro, communication_sources, communication_author_sessions, communication_author_receipts, communication_author_outbox, communication_broadcasts, telegram_transport_slots, communication_intake_receipts, communication_operations, communication_templates, communication_author_modes,
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
async function authorClick(id: number, label: string) {
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
  expect(data, label).toBeDefined();
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
describe("author admin shared post and broadcast flow", () => {
  it("preserves native entities, saves button rows, samples only the author and snapshots a scheduled broadcast", async () => {
    await seedLink();
    await authorMessage(100, "/admin");
    await authorClick(101, "Создать пост");
    await authorMessage(102, "😀 Native post", {
      entities: [{ type: "bold", offset: 3, length: 6 }],
    });
    await authorClick(103, "Добавить кнопку");
    await authorMessage(104, "Открыть Inside");
    await authorMessage(105, "https://inside.test/material");
    await authorMessage(106, "1");
    const post = (await rows())[0]!;
    expect(post.revision).toBe(2);
    expect(post.content).toMatchObject({
      entities: [{ type: "bold", offset: 3, length: 6 }],
      buttons: [{ row: 0 }],
    });
    await authorClick(107, "Образец себе");
    const samples = await database
      .selectFrom("communication_author_outbox")
      .selectAll()
      .execute();
    expect(samples.every((s) => s.telegram_user_id === "42")).toBe(true);
    expect(
      samples.filter(
        (s) =>
          (s.message as { content: { text: string } }).content.text ===
          "😀 Native post",
      ),
    ).toHaveLength(1);
    const sampleRequest = {
      ...request(),
      operation: "templates.testSend",
      expectedRevision: 2,
      payload: { templateId: post.template_id },
    };
    const sampleResponses = await Promise.all([
      http(sampleRequest),
      http(sampleRequest),
    ]);
    expect(sampleResponses[0]!.statusCode).toBe(200);
    expect(sampleResponses[0]!.json()).toEqual(sampleResponses[1]!.json());
    expect(contractValidator("response")(sampleResponses[0]!.json())).toBe(
      true,
    );
    expect(
      (
        await http({
          ...sampleRequest,
          operationId: randomUUID(),
          payload: { ...sampleRequest.payload, chatId: "666" },
        })
      ).statusCode,
    ).toBe(400);
    await authorClick(108, "Вернуться к посту");
    await authorClick(109, "Создать рассылку");
    await authorClick(110, "Время отправки");
    await authorMessage(111, "01.01.2099 12:00");
    await authorClick(112, "Перейти к запуску");
    await authorClick(113, "Запустить рассылку");
    const before = await database
      .selectFrom("communication_broadcasts")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(before.state).toBe("scheduled");
    expect(before.scheduled_at?.toISOString()).toBe("2099-01-01T09:00:00.000Z");
    await communications.execute({
      ...request(),
      expectedRevision: 2,
      payload: {
        templateId: post.template_id,
        content: { ...content, text: "Changed source" },
      },
    });
    expect(
      (
        await database
          .selectFrom("communication_broadcasts")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).parts,
    ).toEqual(before.parts);
    await authorClick(114, "Приостановить");
    await authorClick(115, "Продолжить");
    await authorClick(116, "Отменить рассылку");
    await authorClick(117, "Да, отменить");
    expect(
      (
        await database
          .selectFrom("communication_broadcasts")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("cancelled");
  });
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
  it("lists posts within the existing transaction even with one available connection", async () => {
    await seedLink();
    await authorMessage(100, "/admin");
    const single = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: databaseUrl,
          max: 1,
          connectionTimeoutMillis: 500,
        }),
      }),
    });
    try {
      const admin = new AuthorAdmin(
        single,
        config,
        authorization,
        new Communications(single, config, authorization),
        app.get(Funnels),
        app.get(AuthorDelivery),
      );
      const session = await database
        .selectFrom("communication_author_sessions")
        .select("state")
        .executeTakeFirstOrThrow();
      const state = session.state as {
        token: string;
        actions: { kind: string }[];
      };
      await expect(
        admin.handle({
          botIdentity: "inside",
          updateId: "101",
          telegramUserId: "42",
          text: "",
          content: null,
          callbackData: `author:${state.token}:${state.actions.findIndex((a) => a.kind === "posts")}`,
        }),
      ).resolves.toBe(true);
    } finally {
      await single.destroy();
    }
  });
  it("discards a cancelled replacement when a stale menu opens a different broadcast", async () => {
    await seedLink();
    await communications.execute({
      ...request(),
      payload: {
        templateId: randomUUID(),
        content: { ...content, text: "Saved C" },
      },
    });
    for (const name of ["Broadcast A", "Broadcast B"])
      await app.get(Funnels).execute({
        ...request(),
        operation: "broadcasts.save",
        payload: {
          broadcastId: randomUUID(),
          parts: [
            { partId: randomUUID(), content: { ...content, text: name } },
          ],
          audience: { kind: "all" },
          scheduledAt: null,
        },
      });
    await authorMessage(100, "/admin");
    await authorClick(101, "Рассылки");
    const old = await authorClick(102, "Broadcast A · v1");
    await authorClick(103, "Сообщения и порядок");
    await authorClick(104, "Заменить 1: Broadcast A");
    await app.get(AuthorAdmin).handle({ ...old, updateId: "105" });
    await authorClick(106, "Рассылки");
    await authorClick(107, "Broadcast B · v1");
    await authorClick(108, "Добавить сохранённый пост");
    await authorClick(109, "Saved C");
    const broadcasts = await database
      .selectFrom("communication_broadcasts")
      .select("parts")
      .execute();
    expect(
      broadcasts.map((row) =>
        (row.parts as { content: { text: string } }[]).map(
          (p) => p.content.text,
        ),
      ),
    ).toContainEqual(["Broadcast B", "Saved C"]);
    expect(
      broadcasts.map((row) =>
        (row.parts as { content: { text: string } }[]).map(
          (p) => p.content.text,
        ),
      ),
    ).toContainEqual(["Broadcast A"]);
  });
  it("rejects stale menus without overwriting a newer web edit", async () => {
    await seedLink();
    await authorMessage(100, "/admin");
    await authorClick(101, "Создать пост");
    await authorMessage(102, "First");
    const post = (await rows())[0]!;
    await authorClick(103, "Заменить сообщение");
    await communications.execute({
      ...request(),
      expectedRevision: 1,
      payload: {
        templateId: post.template_id,
        content: { ...content, text: "Web edit" },
      },
    });
    await authorMessage(104, "Stale replacement");
    expect((await rows())[0]?.content).toMatchObject({ text: "Web edit" });
  });
});

async function lastAuthorText() {
  const row = await database
    .selectFrom("communication_author_outbox")
    .select("message")
    .orderBy("sequence_id", "desc")
    .executeTakeFirstOrThrow();
  return (row.message as { content: { text: string } }).content.text;
}
async function currentFunnel() {
  const row = await database
    .selectFrom("communication_funnels")
    .select("draft")
    .executeTakeFirstOrThrow();
  return row.draft as FunnelSnapshot;
}

describe("Telegram-first funnel authoring with real persisted sessions", () => {
  async function startFunnel() {
    await seedLink();
    const saved = await communications.execute({
      ...request(),
      payload: {
        templateId: randomUUID(),
        content: {
          ...content,
          text: "😀 Native funnel",
          entities: [{ type: "bold", offset: 3, length: 6 }],
          buttons: [{ text: "Inside", url: "https://inside.test", row: 0 }],
        },
      },
    });
    await authorMessage(100, "/admin");
    await authorClick(101, "Воронки");
    await authorClick(102, "Общий вводный блок");
    await authorClick(103, "Добавить сохранённый пост");
    await authorClick(104, "😀 Native funnel");
    await authorClick(105, "Сохранить общий блок");
    await authorClick(106, "Все воронки");
    await authorClick(107, "Создать воронку");
    await authorMessage(108, "Инженерная практика");
    await authorClick(109, "Первый ответ");
    await authorClick(110, "Добавить сохранённый пост");
    await authorClick(111, "😀 Native funnel");
    await authorClick(112, "К воронке");
    await authorClick(113, "Выбрать для /start");
    await authorClick(114, "Сохранить черновик");
    return saved;
  }
  it("composes native saved posts, delays and sources, publishes once and preserves snapshots and part identity", async () => {
    const saved = await startFunnel();
    await authorClick(115, "Шаги и задержки");
    await authorClick(116, "Добавить шаг");
    await authorClick(117, "Задержка");
    await authorMessage(118, "2 ч");
    await authorClick(119, "Сообщения шага");
    await authorClick(120, "Добавить сохранённый пост");
    await authorClick(121, "😀 Native funnel");
    await authorClick(122, "Образцы себе");
    expect(
      (
        await database
          .selectFrom("communication_author_outbox")
          .selectAll()
          .execute()
      ).every((row) => row.telegram_user_id === "42"),
    ).toBe(true);
    await authorClick(123, "К сообщениям");
    await authorClick(124, "К воронке");
    await authorClick(125, "Источники");
    await authorClick(126, "Добавить источник");
    await authorMessage(127, "Канал");
    await authorMessage(128, "m_channel");
    await authorClick(129, "К воронке");
    await authorClick(130, "Сохранить черновик");
    const before = await currentFunnel();
    expect(before.steps[0]?.delaySeconds).toBe(7200);
    expect(before.sources[0]?.code).toBe("m_channel");
    const part = before.steps[0]!.parts[0]!;
    expect(part.content).toEqual(saved.content);
    await communications.execute({
      ...request(),
      expectedRevision: saved.revision,
      payload: {
        templateId: saved.templateId,
        content: { ...content, text: "Edited saved post" },
      },
    });
    expect((await currentFunnel()).steps[0]?.parts).toEqual(
      before.steps[0]?.parts,
    );
    await authorClick(131, "Проверить публикацию");
    expect(await lastAuthorText()).toContain("Новых шагов: 1");
    await authorClick(132, "Опубликовать воронку");
    const published = await database
      .selectFrom("communication_funnels")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(published.published_revision).toBe(3);
    expect(published.lifecycle).toBe("published");
    expect(contentValidation.snapshots.at(-1)?.at(-1)?.content).toEqual(
      saved.content,
    );
    await authorClick(133, "Шаги и задержки");
    await authorClick(134, "Шаг 1 · 2 ч");
    await authorClick(135, "Сообщения шага");
    await authorClick(136, "Сообщение 1");
    await authorClick(137, "Заменить из сохранённых");
    await authorClick(138, "Edited saved post");
    await authorClick(139, "К воронке");
    await authorClick(140, "Сохранить черновик");
    const replaced = (await currentFunnel()).steps[0]!.parts[0]!;
    expect(replaced.partId).toBe(part.partId);
    expect(replaced.content.text).toBe("Edited saved post");
    expect(
      (
        await database
          .selectFrom("communication_funnels")
          .select("published")
          .executeTakeFirstOrThrow()
      ).published,
    ).toEqual(published.published);
    await authorClick(141, "Приостановить");
    await authorClick(142, "Продолжить");
    expect(
      (
        await database
          .selectFrom("communication_funnels")
          .select("lifecycle")
          .executeTakeFirstOrThrow()
      ).lifecycle,
    ).toBe("published");
  });
  it("blocks unavailable or invalid Platform content checks and stale publication revisions", async () => {
    await startFunnel();
    contentValidation.result = { status: "unavailable" };
    await authorClick(115, "Проверить публикацию");
    expect(await lastAuthorText()).toContain("публикации не было");
    await authorClick(116, "К воронке");
    contentValidation.result = {
      status: "ok",
      targetErrors: [
        {
          url: "https://inside.test/materials/missing",
          targetId: null,
          reason: "not_found",
        },
      ],
    };
    await authorClick(117, "Проверить публикацию");
    expect(await lastAuthorText()).toContain("не найдено");
    await authorClick(118, "К воронке");
    contentValidation.result = { status: "ok", targetErrors: [] };
    await authorClick(119, "Проверить публикацию");
    const row = await database
      .selectFrom("communication_funnels")
      .selectAll()
      .executeTakeFirstOrThrow();
    const draft = row.draft as FunnelSnapshot;
    await app.get(Funnels).execute({
      ...request(),
      operation: "funnels.save",
      expectedRevision: row.revision,
      payload: {
        funnelId: draft.funnelId,
        name: "Changed in web",
        isDefault: draft.isDefault,
        steps: draft.steps,
        sources: draft.sources,
        entryResponse: draft.entryResponse,
      },
    });
    await authorClick(120, "Опубликовать воронку");
    expect(await lastAuthorText()).toContain("изменились");
    expect(
      (
        await database
          .selectFrom("communication_funnels")
          .select("published_revision")
          .executeTakeFirstOrThrow()
      ).published_revision,
    ).toBeNull();
  });
  it("rolls back a source reservation conflict completely and keeps current definitions intact", async () => {
    await startFunnel();
    const row = await database
      .selectFrom("communication_funnels")
      .selectAll()
      .executeTakeFirstOrThrow();
    const reservedId = randomUUID();
    await database
      .insertInto("communication_sources")
      .values({
        bot_identity: "inside",
        code: "m_reserved",
        funnel_id: row.funnel_id,
        source_id: reservedId,
      })
      .execute();
    await authorClick(115, "Источники");
    await authorClick(116, "Добавить источник");
    await authorMessage(117, "Занятый источник");
    await authorMessage(118, "m_reserved");
    await authorClick(119, "К воронке");
    await authorClick(120, "Сохранить черновик");
    expect(await lastAuthorText()).toContain("изменились");
    const after = await database
      .selectFrom("communication_funnels")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(after.revision).toBe(row.revision);
    expect(after.draft).toEqual(row.draft);
  });
});

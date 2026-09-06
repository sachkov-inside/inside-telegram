import { randomUUID } from "node:crypto";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  await sql`truncate communication_intake_receipts, communication_operations, communication_templates, communication_author_modes,
    link_transactions, platform_links, telegram_updates, bot_contacts, bot_contact_events, start_response_deliveries restart identity cascade`.execute(
    database,
  );
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

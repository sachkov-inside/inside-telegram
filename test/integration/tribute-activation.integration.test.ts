import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { DATABASE, type Database } from "../../src/database/database.js";
import { CLOCK } from "../../src/shared/clock.js";
import { SourceGroupProof } from "../../src/modules/subscription-activation/source-group-proof.js";
import { SubscriptionActivation } from "../../src/modules/subscription-activation/subscription-activation.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import {
  ACTIVATION_VERSION,
  type ActivationBinding,
  type ActivationEvidence,
} from "../../src/modules/subscription-activation/activation-contract.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";
import fixtures from "../../docs/contracts/subscription-activation-v1/fixtures.json" with { type: "json" };

// This HTTP authority returns controlled wire examples; it does not simulate or prove
// Platform's registry/grant policy. Real Telegram AppModule, HTTP codec and PG own the assertions.
const provider = Fastify();
const bot = `tribute-${randomUUID()}`;
const clock = {
  value: new Date(),
  now() {
    return new Date(this.value);
  },
};
const bindings = new Map<string, ActivationBinding>();
const requests: { path: string; body: Record<string, unknown> }[] = [];
const evidenceBodies: string[] = [];
provider.removeContentTypeParser("application/json");
provider.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (request, body, done) => {
    try {
      if (request.url.endsWith("/evidence")) evidenceBodies.push(String(body));
      done(null, JSON.parse(String(body)));
    } catch (error) {
      done(error as Error);
    }
  },
);
const receipts = new Map<string, unknown>();
let replyFixture = "tribute-nonpaid-pending-review";
let mode: string | undefined = "tribute_registry";
let loseResponse = false;
let beginPending = false;
let outcomeState: string | undefined;
let sourceCalls = 0;
let user = 660100;
let update = 660100;
let app: NestFastifyApplication;
let db: Database;
let worker: SubscriptionActivation;
const ruleId = randomUUID();
function example(name: string): Record<string, unknown> {
  const fixture = fixtures.find((f) => f.name === name);
  if (!fixture) throw new Error(`Missing wire example ${name}`);
  return structuredClone(fixture.value);
}
function outcome(name: string, attemptId: unknown) {
  const fixture = example(name);
  return {
    ...fixture,
    value: {
      ...(fixture.value as Record<string, unknown>),
      attemptId,
      ...(outcomeState ? { state: outcomeState } : {}),
    },
  };
}
provider.post<{ Params: { operation: string }; Body: Record<string, unknown> }>(
  "/activation/:operation",
  async (request, reply) => {
    expect(request.headers.authorization).toBe(`Bearer ${"t".repeat(32)}`);
    reply.header("cache-control", "private, no-store");
    const body = request.body;
    const path = request.params.operation;
    requests.push({ path, body: structuredClone(body) });
    if (path === "binding") {
      const binding = bindings.get(String(body.identityRef));
      return {
        ok: true,
        value: {
          contractVersion: ACTIVATION_VERSION,
          ...(binding ? { state: "linked", binding } : { state: "unlinked" }),
        },
      };
    }
    if (path === "attempts") {
      if (beginPending)
        return outcome("tribute-nonpaid-pending-review", body.attemptId);
      return {
        ok: true,
        value: {
          contractVersion: ACTIVATION_VERSION,
          attemptId: body.attemptId,
          state: "checking",
          enrollment: null,
          rule: {
            id: ruleId,
            revision: 7,
            sourceRef:
              mode === "tribute_registry"
                ? "tribute-approved-roster"
                : "course",
            ...(mode === undefined ? {} : { verificationMode: mode }),
          },
        },
      };
    }
    if (path === "evidence") {
      const key = String(body.evidenceRef);
      let result = receipts.get(key);
      if (!result) {
        result = outcome(replyFixture, body.attemptId);
        receipts.set(key, result);
      }
      if (loseResponse) {
        loseResponse = false;
        return reply.code(503).send({ ok: false });
      }
      return result;
    }
    throw new Error(`Unexpected HTTP operation ${path}`);
  },
);
beforeAll(async () => {
  const address = await provider.listen({ host: "127.0.0.1", port: 0 });
  const config = loadApplicationConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    TELEGRAM_BOT_IDENTITY: bot,
    TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
    TELEGRAM_WEBHOOK_SECRET: "synthetic-tribute-webhook-secret-for-tests",
    PLATFORM_INTEGRATION_SECRET: "synthetic-link-secret-for-tests-only",
    TELEGRAM_LINK_RECEIPT_TEXT: "Link receipt",
    TELEGRAM_LINKED_MEMBER_TEXT: "member",
    TELEGRAM_LINKED_NON_MEMBER_TEXT: "not member",
    TELEGRAM_LINKED_UNAVAILABLE_TEXT: "unavailable",
    TELEGRAM_WELCOME_TEXT: "Welcome",
    WORKERS_ENABLED: "false",
    TELEGRAM_ACTIVATION_ENABLED: "true",
    PLATFORM_ACTIVATION_SECRET: "t".repeat(32),
    PLATFORM_ACTIVATION_URL: `${address}/activation`,
    PLATFORM_ACCOUNT_URL: "https://platform.example/account",
    TELEGRAM_ACTIVATION_SOURCES: JSON.stringify([
      { sourceRef: "course", chatId: "-1000000000001", policy: "whole_group" },
    ]),
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(SourceGroupProof)
    .useValue(
      new SourceGroupProof(config.activation!.sources, {
        async getBotChatMember() {
          sourceCalls++;
          return { kind: "observed", value: { status: "administrator" } };
        },
        async getChatMember() {
          sourceCalls++;
          return { kind: "observed", value: { status: "member" } };
        },
      }),
    )
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DATABASE);
  worker = app.get(SubscriptionActivation);
});
beforeEach(async () => {
  await db
    .deleteFrom("activation_attempts")
    .where("bot_identity", "=", bot)
    .execute();
  bindings.clear();
  requests.length = 0;
  evidenceBodies.length = 0;
  receipts.clear();
  mode = "tribute_registry";
  loseResponse = false;
  beginPending = false;
  outcomeState = undefined;
  sourceCalls = 0;
  replyFixture = "tribute-nonpaid-pending-review";
  clock.value = new Date();
});
afterAll(async () => {
  await app?.close();
  await provider.close();
});
async function start(recipient: number) {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/telegram",
    headers: {
      "x-telegram-bot-api-secret-token":
        "synthetic-tribute-webhook-secret-for-tests",
    },
    payload: privateStartUpdate(++update, recipient, {
      text: "/start a_tribute_existing",
    }),
  });
  expect(response.statusCode).toBe(202);
  await app.get(TelegramUpdateProcessor).processAvailable();
}
async function row(recipient: number) {
  return db
    .selectFrom("activation_attempts")
    .selectAll()
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", String(recipient))
    .executeTakeFirstOrThrow();
}
async function linked() {
  const recipient = ++user;
  await start(recipient);
  const attempt = await row(recipient);
  const binding = {
    accountRef: `synthetic-${recipient}`,
    identityRef: attempt.identity_ref,
    linkRef: randomUUID(),
    linkRevision: 3,
  };
  bindings.set(attempt.identity_ref, binding);
  return { recipient, binding };
}
async function messages(recipient: number) {
  return db
    .selectFrom("start_response_deliveries")
    .select("message_text")
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", String(recipient))
    .where("source_key", "like", "activation:%")
    .execute();
}
function advance(days = 0) {
  clock.value = new Date(
    clock.now().getTime() + (days ? days * 86400_000 : 61_000),
  );
}

describe("Tribute registry consumer with real HTTP and PostgreSQL", () => {
  it("continues private unlinked start with exact registry evidence after binding, without membership lookup", async () => {
    const recipient = ++user;
    await start(recipient);
    await worker.processAvailable();
    expect((await row(recipient)).state).toBe("needs_account");
    expect(evidenceBodies).toHaveLength(0);
    const attempt = await row(recipient);
    const binding = {
      accountRef: "synthetic-account",
      identityRef: attempt.identity_ref,
      linkRef: randomUUID(),
      linkRevision: 4,
    };
    bindings.set(attempt.identity_ref, binding);
    advance();
    await worker.processAvailable();
    expect(evidenceBodies).toHaveLength(1);
    expect(sourceCalls).toBe(0);
    const proof = JSON.parse(evidenceBodies[0]!) as ActivationEvidence;
    expect(proof).toEqual({
      contractVersion: ACTIVATION_VERSION,
      audience: "inside.platform.subscription-activation",
      attemptId: attempt.attempt_id,
      evidenceRef: expect.any(String),
      sourceRef: "tribute-approved-roster",
      ruleId,
      ruleRevision: 7,
      ...binding,
      checkedAt: clock.now().toISOString(),
      validUntil: new Date(clock.now().getTime() + 300_000).toISOString(),
      decision: "registry_lookup",
    });
    expect((await row(recipient)).state).toBe("pending_review");
  });
  it.each([
    "tribute-nonpaid-pending-review",
    "tribute-unknown-period-pending-review",
    "tribute-forwarded-link-no-source-pending-review",
  ])(
    "keeps %s pending and uses the recipient's private identity",
    async (name) => {
      replyFixture = name;
      const first = await linked();
      await worker.processAvailable();
      const second = await linked();
      await worker.processAvailable();
      expect(first.binding.identityRef).not.toBe(second.binding.identityRef);
      expect(evidenceBodies.map((s) => JSON.parse(s).identityRef)).toEqual([
        first.binding.identityRef,
        second.binding.identityRef,
      ]);
      expect((await row(second.recipient)).state).toBe("pending_review");
      expect(
        (await messages(second.recipient)).some((m) =>
          m.message_text.includes("Назначение тарифа подтверждено"),
        ),
      ).toBe(false);
      expect(sourceCalls).toBe(0);
    },
  );
  it("retries a known pending response with fresh binding/evidence and preserves the confirmed period returned by HTTP", async () => {
    const { recipient, binding } = await linked();
    await worker.processAvailable();
    const first = JSON.parse(evidenceBodies[0]!) as ActivationEvidence;
    advance();
    await worker.processAvailable();
    expect(evidenceBodies).toHaveLength(1);
    const updated = { ...binding, linkRef: randomUUID(), linkRevision: 5 };
    bindings.set(binding.identityRef, updated);
    replyFixture = "tribute-confirmed-period-active";
    await start(recipient);
    await worker.processAvailable();
    const second = JSON.parse(evidenceBodies[1]!) as ActivationEvidence;
    expect(second).toMatchObject(updated);
    expect(second.evidenceRef).not.toBe(first.evidenceRef);
    expect((await row(recipient)).result).toEqual(
      outcome(replyFixture, second.attemptId),
    );
    expect((await row(recipient)).state).toBe("completed");
    expect(sourceCalls).toBe(0);
  });
  it("replays a lost response byte-for-byte before any new binding or begin, even after retention and relink", async () => {
    const { recipient, binding } = await linked();
    replyFixture = "tribute-confirmed-period-active";
    loseResponse = true;
    await worker.processAvailable();
    const first = evidenceBodies[0];
    const count = requests.length;
    bindings.set(binding.identityRef, {
      ...binding,
      linkRef: randomUUID(),
      linkRevision: 10,
    });
    advance(31);
    await worker.processAvailable();
    expect(evidenceBodies).toEqual([first, first]);
    expect(requests.slice(count).map((r) => r.path)).toEqual(["evidence"]);
    expect((await row(recipient)).state).toBe("completed");
    expect(sourceCalls).toBe(0);
  });
  it("resolves an uncertain pending result before a later explicit retry uses fresh evidence", async () => {
    const { recipient } = await linked();
    loseResponse = true;
    await worker.processAvailable();
    const first = evidenceBodies[0];
    replyFixture = "tribute-confirmed-period-active";
    advance();
    await worker.processAvailable();
    expect(evidenceBodies).toEqual([first, first]);
    expect((await row(recipient)).state).toBe("pending_review");
    await start(recipient);
    await worker.processAvailable();
    expect(evidenceBodies[2]).not.toBe(first);
    expect((await row(recipient)).state).toBe("completed");
  });
  it("expires known pending and late-resolved uncertain pending work without fresh registry lookup", async () => {
    const { recipient } = await linked();
    loseResponse = true;
    await worker.processAvailable();
    const first = evidenceBodies[0];
    advance(31);
    await worker.processAvailable();
    expect(evidenceBodies).toEqual([first, first]);
    expect(
      await db
        .selectFrom("activation_attempts")
        .selectAll()
        .where("bot_identity", "=", bot)
        .execute(),
    ).toEqual([]);
    await start(recipient);
    await worker.processAvailable();
    expect(evidenceBodies).toHaveLength(3);
    advance(31);
    await worker.processAvailable();
    expect(evidenceBodies).toHaveLength(3);
    expect(
      await db
        .selectFrom("activation_attempts")
        .selectAll()
        .where("bot_identity", "=", bot)
        .execute(),
    ).toEqual([]);
  });
  it.each([undefined, "course_membership"])(
    "preserves course membership verification for mode %s",
    async (value) => {
      mode = value;
      await linked();
      await worker.processAvailable();
      expect(sourceCalls).toBe(2);
      expect(JSON.parse(evidenceBodies[0]!).decision).toBe("member");
    },
  );
  it("rejects unknown mode before membership or evidence", async () => {
    mode = "unknown";
    const { recipient } = await linked();
    await worker.processAvailable();
    expect(sourceCalls).toBe(0);
    expect(evidenceBodies).toHaveLength(0);
    expect((await row(recipient)).diagnostic_code).toBe("platform_unavailable");
  });
  it("presents a pending begin outcome without inventing a rule or evidence", async () => {
    beginPending = true;
    const { recipient } = await linked();
    await worker.processAvailable();
    expect((await row(recipient)).state).toBe("pending_review");
    expect(evidenceBodies).toHaveLength(0);
    expect(sourceCalls).toBe(0);
  });
  it.each(["pending_verification", "suspended_source"])(
    "presents nonactive %s Enrollment on pending_review",
    async (state) => {
      replyFixture = `nested-enrollment-${state}`;
      outcomeState = "pending_review";
      const { recipient } = await linked();
      await worker.processAvailable();
      expect((await row(recipient)).state).toBe("pending_review");
      const replies = await messages(recipient);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.message_text).toContain("Активация не подтверждена");
      expect(replies[0]?.message_text).toContain(
        state === "pending_verification"
          ? "Ожидает подтверждения Tribute"
          : "Источник Tribute завершён",
      );
      expect(replies[0]?.message_text).not.toContain(
        "Назначение тарифа подтверждено",
      );
    },
  );
  it("gets fresh bound evidence on explicit retry of known unavailable", async () => {
    outcomeState = "unavailable";
    const { recipient, binding } = await linked();
    await worker.processAvailable();
    const first = JSON.parse(evidenceBodies[0]!) as ActivationEvidence;
    bindings.set(binding.identityRef, { ...binding, linkRevision: 6 });
    outcomeState = undefined;
    replyFixture = "tribute-confirmed-period-active";
    await start(recipient);
    await worker.processAvailable();
    const second = JSON.parse(evidenceBodies[1]!) as ActivationEvidence;
    expect(second.linkRevision).toBe(6);
    expect(second.evidenceRef).not.toBe(first.evidenceRef);
    expect((await row(recipient)).state).toBe("completed");
    expect(sourceCalls).toBe(0);
  });
  it("delivers a changed nonactive state on explicit retry instead of suppressing it as the same pending outcome", async () => {
    outcomeState = "pending_review";
    replyFixture = "nested-enrollment-pending_verification";
    const { recipient } = await linked();
    await worker.processAvailable();
    replyFixture = "nested-enrollment-suspended_source";
    await start(recipient);
    await worker.processAvailable();
    const replies = await messages(recipient);
    expect(replies).toHaveLength(2);
    expect(
      replies.some((m) =>
        m.message_text.includes("Ожидает подтверждения Tribute"),
      ),
    ).toBe(true);
    expect(
      replies.some((m) => m.message_text.includes("Источник Tribute завершён")),
    ).toBe(true);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { DATABASE, type Database } from "../../src/database/database.js";
import { CLOCK } from "../../src/shared/clock.js";
import { IdentityLinking } from "../../src/modules/identity-linking/identity-linking.js";
import { SourceGroupProof } from "../../src/modules/subscription-activation/source-group-proof.js";
import {
  ACTIVATION_PLATFORM,
  type ActivationPlatform,
} from "../../src/modules/subscription-activation/activation-ports.js";
import {
  ACTIVATION_VERSION,
  type ActivationBinding,
  type ActivationEvidence,
  type ActivationResponse,
  type ActivationResult,
} from "../../src/modules/subscription-activation/activation-contract.js";
import { SubscriptionActivation } from "../../src/modules/subscription-activation/subscription-activation.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";
import { StartResponseDeliveryQueue } from "../../src/modules/outbound/start-response-delivery-queue.js";

const bot = `activation-${randomUUID()}`;
const clock = {
  value: new Date(),
  now() {
    return new Date(this.value);
  },
};
const config = loadApplicationConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  TELEGRAM_BOT_IDENTITY: bot,
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-for-tests-only",
  PLATFORM_INTEGRATION_SECRET: "synthetic-link-secret-for-tests-only",
  TELEGRAM_LINK_RECEIPT_TEXT: "Link receipt",
  TELEGRAM_LINKED_MEMBER_TEXT: "member",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "not member",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "unavailable",
  TELEGRAM_WELCOME_TEXT: "Welcome",
  WORKERS_ENABLED: "false",
  TELEGRAM_ACTIVATION_ENABLED: "true",
  PLATFORM_ACTIVATION_SECRET: "s".repeat(32),
  PLATFORM_ACTIVATION_URL: "http://127.0.0.1:1/activation",
  PLATFORM_ACCOUNT_URL: "https://platform.example/account",
  TELEGRAM_ACTIVATION_SOURCES: JSON.stringify([
    { sourceRef: "course", chatId: "-1000000000001", policy: "whole_group" },
  ]),
});
let app: NestFastifyApplication;
let db: Database;
let worker: SubscriptionActivation;
const bindings = new Map<string, ActivationBinding>();
const proofs: ActivationEvidence[] = [];
const begins: string[] = [];
const granted = new Set<string>();
const results = new Map<string, ActivationResult<ActivationResponse>>();
const receipts = new Map<string, ActivationResult<ActivationResponse>>();
let loseResponse = false;
let dropBeforeAccept = false;
let evidenceConflict = false;
let onSourceCheck: (() => Promise<void>) | undefined;
let source: "member" | "not_member" | "unavailable" = "member";
let bindingUnavailable = false;
const rule = { id: randomUUID(), revision: 1, sourceRef: "course" };
const platform: ActivationPlatform = {
  async binding(identityRef) {
    return bindingUnavailable
      ? { ok: false, error: { code: "unavailable" } }
      : {
          ok: true,
          value: {
            contractVersion: ACTIVATION_VERSION,
            ...(bindings.has(identityRef)
              ? { state: "linked", binding: bindings.get(identityRef)! }
              : { state: "unlinked" }),
          },
        };
  },
  async begin(input) {
    begins.push(input.attemptId);
    if (results.has(input.attemptId))
      return structuredClone(results.get(input.attemptId)!);
    return {
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        attemptId: input.attemptId,
        state: "needs_account",
        enrollment: null,
        rule,
      },
    };
  },
  async evidence(input) {
    proofs.push(structuredClone(input));
    if (dropBeforeAccept) {
      dropBeforeAccept = false;
      return;
    }
    if (evidenceConflict)
      return { ok: false, error: { code: "identity_conflict" } };
    if (receipts.has(input.evidenceRef))
      return structuredClone(receipts.get(input.evidenceRef)!);
    if (Date.parse(input.validUntil) <= clock.now().getTime())
      return { ok: false, error: { code: "source_not_confirmed" } };
    if (input.decision === "member")
      granted.add(`${input.sourceRef}:${input.identityRef}`);
    const result: ActivationResult<ActivationResponse> = {
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        attemptId: input.attemptId,
        state:
          input.decision === "member"
            ? "active"
            : input.decision === "not_member"
              ? "rejected"
              : "unavailable",
        enrollment: null,
      },
    };
    results.set(input.attemptId, structuredClone(result));
    receipts.set(input.evidenceRef, structuredClone(result));
    if (loseResponse) {
      loseResponse = false;
      return;
    }
    return result;
  },
  async own() {
    return {
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        enrollments: [],
        grounds: [],
        admission: { state: "no_access", admissionRestriction: "none" },
      },
    };
  },
};
beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(ACTIVATION_PLATFORM)
    .useValue(platform)
    .overrideProvider(SourceGroupProof)
    .useValue({
      async check() {
        const hook = onSourceCheck;
        onSourceCheck = undefined;
        if (hook) await hook();
        return { decision: source };
      },
    })
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
afterAll(async () => {
  await app.close();
});
let updateId = 300000;
async function ingress(user: number, text: string) {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/telegram",
    headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
    payload: privateStartUpdate(++updateId, user, { text }),
  });
  expect(response.statusCode).toBe(202);
  await app.get(TelegramUpdateProcessor).processAvailable();
}
async function identity(user: number) {
  return (
    await db
      .selectFrom("telegram_identity_reservations")
      .select("identity_ref")
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", String(user))
      .executeTakeFirstOrThrow()
  ).identity_ref;
}
async function link(user: number) {
  const linking = app.get(IdentityLinking);
  const accountRef = `account-${bot}-${user}`;
  const token = randomUUID();
  const challenge = await linking.register({
    accountRef,
    expiresAt: new Date(clock.now().getTime() + 300_000),
    returnCorrelation: randomUUID(),
    tokenDigest: createHash("sha256")
      .update(`${token}${user}`)
      .digest("base64url"),
  });
  await linking.acceptStart({
    botIdentity: bot,
    telegramUserId: String(user),
    observedAt: clock.now(),
    linkToken: {
      kind: "digest",
      digest: createHash("sha256")
        .update(`${token}${user}`)
        .digest("base64url"),
    },
  });
  const confirmed = await linking.confirm({
    accountRef,
    linkTransactionRef: challenge.linkTransactionRef,
    returnCorrelation: challenge.returnCorrelation,
  });
  expect(confirmed).toMatchObject({
    status: "linked",
    telegramIdentityRef: await identity(user),
  });
  const id = await identity(user);
  bindings.set(id, {
    accountRef,
    identityRef: id,
    linkRef: randomUUID(),
    linkRevision: 3,
  });
}
describe("durable activation ingress, identity and continuation", () => {
  it("keeps the same source identity across linking, two links and concurrent workers", async () => {
    await ingress(70001, "/start a_course");
    await worker.processAvailable();
    expect(
      await db
        .selectFrom("activation_attempts")
        .select("state")
        .where("bot_identity", "=", bot)
        .where("telegram_user_id", "=", "70001")
        .executeTakeFirst(),
    ).toEqual({ state: "needs_account" });
    expect(granted.size).toBe(0);
    await link(70001);
    clock.value = new Date(clock.now().getTime() + 60_000);
    await Promise.all([worker.processAvailable(), worker.processAvailable()]);
    expect(granted.size).toBe(1);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({
      ...bindings.get(await identity(70001)),
      ruleId: rule.id,
      ruleRevision: 1,
    });
    await ingress(70001, "/start a_second_code");
    await worker.processAvailable();
    expect(granted.size).toBe(1);
    const prompt = await db
      .selectFrom("start_response_deliveries")
      .select(["buttons", "message_text"])
      .where("bot_identity", "=", bot)
      .where("source_key", "like", "activation:%")
      .execute();
    expect(
      prompt.some((row) =>
        row.buttons?.some((button) => button.text === "Мои доступы"),
      ),
    ).toBe(true);
    expect(
      await db
        .selectFrom("membership_check_results")
        .selectAll()
        .where("telegram_identity_ref", "=", await identity(70001))
        .execute(),
    ).toHaveLength(0);
  });
  it("replays exactly the persisted evidence after a lost response and restart", async () => {
    await ingress(70002, "/start a_course");
    await link(70002);
    loseResponse = true;
    await worker.processAvailable();
    const first = proofs.at(-1)!;
    expect(first.identityRef).toBe(await identity(70002));
    clock.value = new Date(clock.now().getTime() + 31 * 24 * 60 * 60_000);
    const restarted = new SubscriptionActivation(
      db,
      config,
      clock,
      platform,
      new SourceGroupProof([], {
        async getBotChatMember() {
          throw new Error("must replay before recheck");
        },
        async getChatMember() {
          throw new Error("must replay before recheck");
        },
      }),
      app.get(StartResponseDeliveryQueue),
      app.get(
        (await import("../../src/modules/community/community-provider.js"))
          .CommunityProvider,
      ),
    );
    await restarted.processAvailable();
    expect(proofs.at(-1)).toEqual(first);
  });
  it("replays an expired unaccepted payload before creating fresh evidence", async () => {
    await ingress(70007, "/start a_course");
    await link(70007);
    dropBeforeAccept = true;
    await worker.processAvailable();
    const first = proofs.at(-1)!;
    clock.value = new Date(clock.now().getTime() + 301_000);
    await worker.processAvailable();
    expect(proofs.at(-2)).toEqual(first);
    expect(proofs.at(-1)!.evidenceRef).not.toBe(first.evidenceRef);
    expect(granted.has(`course:${await identity(70007)}`)).toBe(true);
  });
  it("stops identity conflict until an explicit user retry", async () => {
    await ingress(70008, "/start a_course");
    await link(70008);
    dropBeforeAccept = true;
    await worker.processAvailable();
    evidenceConflict = true;
    clock.value = new Date(clock.now().getTime() + 60_000);
    await worker.processAvailable();
    const count = proofs.length;
    evidenceConflict = false;
    clock.value = new Date(clock.now().getTime() + 60_000);
    await worker.processAvailable();
    expect(proofs).toHaveLength(count);
    expect(granted.has(`course:${await identity(70008)}`)).toBe(false);
    await ingress(70008, "/start a_course");
    await worker.processAvailable();
    expect(granted.has(`course:${await identity(70008)}`)).toBe(true);
  });
  it("prevents a stale worker from submitting after another worker takes its lease", async () => {
    await ingress(70009, "/start a_course");
    await link(70009);
    onSourceCheck = async () => {
      clock.value = new Date(clock.now().getTime() + 61_000);
      await worker.processAvailable();
    };
    await worker.processAvailable();
    const id = await identity(70009);
    expect(proofs.filter((p) => p.identityRef === id)).toHaveLength(1);
  });
  it("distinguishes unavailable binding from missing Account and rejects nonmembers", async () => {
    bindingUnavailable = true;
    await ingress(70003, "/start a_course");
    await worker.processAvailable();
    expect(
      await db
        .selectFrom("activation_attempts")
        .select(["state", "diagnostic_code"])
        .where("bot_identity", "=", bot)
        .where("telegram_user_id", "=", "70003")
        .executeTakeFirst(),
    ).toEqual({ state: "retry", diagnostic_code: "binding_unavailable" });
    bindingUnavailable = false;
    await link(70003);
    source = "not_member";
    clock.value = new Date(clock.now().getTime() + 60_000);
    await worker.processAvailable();
    expect(granted.has(`course:${await identity(70003)}`)).toBe(false);
    source = "member";
  });
  it("recovers saved unavailable without a rule and suppresses unchanged automatic replies", async () => {
    source = "unavailable";
    await ingress(70005, "/start a_course");
    await link(70005);
    await worker.processAvailable();
    const initial = proofs.at(-1)!;
    for (let i = 0; i < 3; i++) {
      clock.value = new Date(clock.now().getTime() + 60_000);
      await worker.processAvailable();
    }
    const replies = await db
      .selectFrom("start_response_deliveries")
      .select("id")
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", "70005")
      .where("source_key", "like", "activation:%:unavailable")
      .execute();
    expect(replies).toHaveLength(1);
    source = "member";
    clock.value = new Date(clock.now().getTime() + 60_000);
    await worker.processAvailable();
    expect(proofs.at(-1)!.attemptId).not.toBe(initial.attemptId);
    expect(granted.has(`course:${await identity(70005)}`)).toBe(true);
  });
  it("expires known unavailable work and permits a fresh explicit start", async () => {
    source = "unavailable";
    await ingress(70011, "/start a_course");
    await link(70011);
    await worker.processAvailable();
    const first = proofs.at(-1)!;
    const calls = { begins: begins.length, proofs: proofs.length };
    clock.value = new Date(clock.now().getTime() + 31 * 24 * 60 * 60_000);
    await worker.processAvailable();
    expect({ begins: begins.length, proofs: proofs.length }).toEqual(calls);
    expect(
      await db
        .selectFrom("activation_attempts")
        .selectAll()
        .where("bot_identity", "=", bot)
        .where("telegram_user_id", "=", "70011")
        .execute(),
    ).toEqual([]);
    source = "member";
    await ingress(70011, "/start a_course");
    await worker.processAvailable();
    expect(proofs.at(-1)!.attemptId).not.toBe(first.attemptId);
    expect(granted.has(`course:${await identity(70011)}`)).toBe(true);
  });
  it("resolves expired uncertain evidence before cleanup without starting a new proof", async () => {
    await ingress(70010, "/start a_course");
    await link(70010);
    dropBeforeAccept = true;
    await worker.processAvailable();
    const first = proofs.at(-1)!;
    const beginCount = begins.length;
    clock.value = new Date(clock.now().getTime() + 31 * 24 * 60 * 60_000);
    await worker.processAvailable();
    expect(proofs.at(-1)).toEqual(first);
    expect(begins).toHaveLength(beginCount);
    expect(granted.has(`course:${await identity(70010)}`)).toBe(false);
    expect(
      await db
        .selectFrom("activation_attempts")
        .selectAll()
        .where("bot_identity", "=", bot)
        .where("telegram_user_id", "=", "70010")
        .execute(),
    ).toEqual([]);
  });
  it("allows a rejected course to be checked again after retention", async () => {
    source = "not_member";
    await ingress(70006, "/start a_course");
    await link(70006);
    await worker.processAvailable();
    const rejected = proofs.at(-1)!;
    clock.value = new Date(clock.now().getTime() + 31 * 24 * 60 * 60_000);
    source = "member";
    await ingress(70006, "/start a_course");
    await worker.processAvailable();
    expect(proofs.at(-1)!.attemptId).not.toBe(rejected.attemptId);
    expect(granted.has(`course:${await identity(70006)}`)).toBe(true);
  });
  it("purges old unlinked attempts while retaining the stable source identity", async () => {
    await ingress(70004, "/start a_course");
    await worker.processAvailable();
    const before = await identity(70004);
    await db
      .updateTable("activation_attempts")
      .set({ expires_at: new Date(clock.now().getTime() - 1) })
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", "70004")
      .execute();
    await worker.processAvailable();
    await ingress(70004, "/start a_course");
    expect(await identity(70004)).toBe(before);
    expect(
      await db
        .selectFrom("activation_attempts")
        .selectAll()
        .where("bot_identity", "=", bot)
        .where("telegram_user_id", "=", "70004")
        .execute(),
    ).toHaveLength(1);
  });
});

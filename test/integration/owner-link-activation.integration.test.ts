import { randomUUID } from "node:crypto";
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
import { ActivationReviews } from "../../src/modules/subscription-activation/activation-reviews.js";
import { announceActivation } from "../../src/modules/subscription-activation/activation-announcement.js";
import { OWNER_REVIEW } from "../../src/modules/subscription-activation/activation-view.js";
import { reserveTelegramIdentity } from "../../src/modules/identity-linking/stable-telegram-identity.js";
import { SubscriptionActivation } from "../../src/modules/subscription-activation/subscription-activation.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";
import { required } from "../support/required.js";

// The Platform double below grants by a simple table so the consumer's checks, messages and
// review queue can be observed. It does not prove Platform's own rule or grant policy.
const bot = `owner-link-${randomUUID()}`;
const canonicalChatId = "-1000000000000";
const courseChatId = "-1000000000001";
const clock = {
  value: new Date(),
  now() {
    return new Date(this.value);
  },
};
const config = loadApplicationConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  TELEGRAM_BOT_IDENTITY: bot,
  TELEGRAM_CANONICAL_CHAT_ID: canonicalChatId,
  TELEGRAM_WEBHOOK_SECRET: "synthetic-owner-link-webhook-secret",
  PLATFORM_INTEGRATION_SECRET: "synthetic-link-secret-for-tests-only",
  TELEGRAM_LINK_RECEIPT_TEXT: "Link receipt",
  TELEGRAM_LINKED_MEMBER_TEXT: "member",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "not member",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "unavailable",
  TELEGRAM_WELCOME_TEXT: "Welcome",
  WORKERS_ENABLED: "false",
  TELEGRAM_ACTIVATION_ENABLED: "true",
  PLATFORM_ACTIVATION_SECRET: "k".repeat(32),
  PLATFORM_ACTIVATION_URL: "http://127.0.0.1:1/activation",
  PLATFORM_ACCOUNT_URL: "https://platform.example/account",
  TELEGRAM_ACTIVATION_SOURCES: JSON.stringify([
    { sourceRef: "course", chatId: courseChatId, policy: "whole_group" },
  ]),
});
const rules = {
  course: {
    id: randomUUID(),
    revision: 1,
    sourceRef: "course",
    verificationMode: "course_membership" as const,
  },
  tribute: {
    id: randomUUID(),
    revision: 1,
    sourceRef: "tribute-roster",
    verificationMode: "tribute_registry" as const,
  },
};
type Code = keyof typeof rules;
const bindings = new Map<string, ActivationBinding>();
/** Chat members by `${chatId}:${userId}`; the canonical chat is listed to prove it is ignored. */
const members = new Set<string>();
const tributeRegistry = new Set<string>();
/** Rules the owner paused on Platform. */
const paused = new Set<string>();
/** Identities whose Tribute ground Platform holds as a latched source end. */
const suspendedTribute = new Set<string>();
const begins: string[] = [];
const proofs: ActivationEvidence[] = [];
const memberLookups: string[] = [];
const grants = new Map<string, number>();
const platform: ActivationPlatform = {
  redeem: () => Promise.resolve(undefined),
  binding(identityRef) {
    const binding = bindings.get(identityRef);
    return Promise.resolve({
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        ...(binding ? { state: "linked", binding } : { state: "unlinked" }),
      },
    });
  },
  begin(input) {
    begins.push(input.code);
    const code = Object.keys(rules).find(
      (key): key is Code => key === input.code,
    );
    if (!code)
      return Promise.resolve({ ok: false, error: { code: "not_found" } });
    if (paused.has(code))
      return Promise.resolve({ ok: false, error: { code: "policy_paused" } });
    return Promise.resolve({
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        attemptId: input.attemptId,
        state: "checking",
        enrollment: null,
        rule: rules[code],
      },
    });
  },
  evidence(input) {
    proofs.push(structuredClone(input));
    const confirmed =
      input.decision === "member" ||
      (input.decision === "registry_lookup" &&
        tributeRegistry.has(input.identityRef));
    const key = `${input.sourceRef}:${input.identityRef}`;
    const prior = grants.get(key) ?? 0;
    if (confirmed && prior === 0) grants.set(key, 1);
    const suspended =
      input.decision === "registry_lookup" &&
      suspendedTribute.has(input.identityRef);
    const result: ActivationResult<ActivationResponse> = {
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        attemptId: input.attemptId,
        state: confirmed
          ? prior
            ? "already_active"
            : "active"
          : input.decision === "registry_lookup"
            ? "pending_review"
            : "rejected",
        enrollment: suspended
          ? {
              id: randomUUID(),
              tier: { name: "Inside", benefits: ["materials", "community"] },
              origin: "tribute",
              startsAt: "2026-01-01T00:00:00.000Z",
              endsAt: "2026-06-01T00:00:00.000Z",
              state: "suspended_source",
              renewal: "not_applicable",
            }
          : null,
      },
    };
    return Promise.resolve(result);
  },
  own() {
    return Promise.resolve({
      ok: true,
      value: {
        contractVersion: ACTIVATION_VERSION,
        enrollments: [],
        grounds: [],
        admission: { state: "no_access", admissionRestriction: "none" },
      },
    });
  },
};
let app: NestFastifyApplication;
let db: Database;
let worker: SubscriptionActivation;
let reviews: ActivationReviews;
let updateId = 820000;
let nextUser = 820000;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(ACTIVATION_PLATFORM)
    .useValue(platform)
    .overrideProvider(SourceGroupProof)
    .useValue(
      new SourceGroupProof(required(config.activation).sources, {
        getBotChatMember() {
          return Promise.resolve({
            kind: "observed",
            value: { status: "administrator" },
          });
        },
        getChatMember(chatId, userId) {
          memberLookups.push(chatId);
          return Promise.resolve({
            kind: "observed",
            value: {
              status: members.has(`${chatId}:${userId}`) ? "member" : "left",
            },
          });
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
  reviews = new ActivationReviews(db, clock);
});
beforeEach(() => {
  begins.length = 0;
  proofs.length = 0;
  memberLookups.length = 0;
  clock.value = new Date(clock.now().getTime() + 61_000);
});
afterAll(async () => {
  await db
    .deleteFrom("activation_review_requests")
    .where("bot_identity", "=", bot)
    .execute();
  await app.close();
});

async function send(
  user: number,
  text = "/start",
  chat?: { id: number; type: string },
) {
  const update = privateStartUpdate(++updateId, user, { text });
  const payload = chat
    ? { ...update, message: { ...update.message, chat } }
    : update;
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/telegram",
    headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
    payload,
  });
  expect(response.statusCode).toBe(202);
  await app.get(TelegramUpdateProcessor).processAvailable();
}
/** A person who started the bot once and then linked the Account on Platform. */
async function linkedPerson() {
  const user = ++nextUser;
  await send(user);
  // Linking on Platform reserves the stable identity; an ordinary /start does not.
  const ref = await db
    .transaction()
    .execute((tx) => reserveTelegramIdentity(tx, bot, String(user)));
  bindings.set(ref, {
    accountRef: `account-${user}`,
    identityRef: ref,
    linkRef: randomUUID(),
    linkRevision: 1,
  });
  return { user, identityRef: ref };
}
async function drain() {
  for (let round = 0; round < 3; round++) await worker.processAvailable();
}
function activationMessages(user: number) {
  return db
    .selectFrom("start_response_deliveries")
    .select(["message_text", "buttons"])
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", String(user))
    .where("source_key", "like", "activation%")
    .orderBy("id")
    .execute();
}
async function openReviews(user: number) {
  return (await reviews.open()).filter(
    (review) =>
      review.botIdentity === bot && review.telegramUserId === String(user),
  );
}

function attempts(user: number) {
  return db
    .selectFrom("activation_attempts")
    .select(["code", "state"])
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", String(user))
    .orderBy("code")
    .execute();
}
/** The `/start` a member sends after pressing the owner's button in the course group. */
async function pressButton(code: string) {
  const result = await announceActivation(
    { activation: config.activation, sourceRef: "course", code, send: false },
    {
      botUsername: () => Promise.resolve("inside_test_bot"),
      sendText: () => Promise.reject(new Error("A preview sends nothing")),
    },
  );
  if (result.status !== "ready") throw new Error(result.status);
  const url = new URL(required(result.button.url));
  expect(`${url.origin}${url.pathname}`).toBe("https://t.me/inside_test_bot");
  return `/start ${required(url.searchParams.get("start"))}`;
}

describe("ordinary /start", () => {
  it("checks nothing, grants nothing and queues nobody, even for a linked course member", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    tributeRegistry.add(person.identityRef);
    await send(person.user);
    await send(person.user);
    await drain();
    expect(begins).toEqual([]);
    expect(proofs).toEqual([]);
    expect(memberLookups).toEqual([]);
    expect(await attempts(person.user)).toEqual([]);
    expect(await activationMessages(person.user)).toEqual([]);
    expect(await openReviews(person.user)).toEqual([]);
    expect(grants.has(`course:${person.identityRef}`)).toBe(false);
    // The person gets the ordinary greeting instead.
    const texts = await db
      .selectFrom("start_response_deliveries")
      .select("message_text")
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", String(person.user))
      .execute();
    expect(texts.map((row) => row.message_text)).toContain("Welcome");
  });
});

describe("the owner's button in the course group", () => {
  it("leads a group member to rights and the community invitation", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    const start = await pressButton("course");
    expect(start).toBe("/start a_course");
    await send(person.user, start);
    await drain();
    expect(begins).toEqual(["course"]);
    expect(memberLookups).toEqual([courseChatId]);
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
    const [message] = await activationMessages(person.user);
    expect(required(message).message_text).toContain("Вступить в сообщество");
    expect(
      required(message).buttons?.some(
        (button) => button.text === "Вступить в сообщество",
      ),
    ).toBe(true);
    expect(await openReviews(person.user)).toEqual([]);
    // Pressing again confirms the same right: no second grant, attempt or review.
    await send(person.user, start);
    await drain();
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
    expect(await attempts(person.user)).toEqual([
      { code: "course", state: "completed" },
    ]);
    expect(await openReviews(person.user)).toEqual([]);
  });

  it("answers a non-member and queues one owner review however often they press", async () => {
    const person = await linkedPerson();
    const start = await pressButton("course");
    await send(person.user, start);
    await drain();
    const messages = await activationMessages(person.user);
    expect(messages).toHaveLength(1);
    expect(required(messages[0]).message_text).toContain(
      "Автоматическая проверка не подтвердила покупку",
    );
    // One instruction: the person writes to the author; the owner still gets the review.
    expect(required(messages[0]).message_text).toContain("напишите автору");
    expect(required(messages[0]).message_text).not.toContain(OWNER_REVIEW);
    const [review] = await openReviews(person.user);
    expect(review).toMatchObject({
      identityRef: person.identityRef,
      accountRef: `account-${person.user}`,
      outcomes: [{ code: "course", outcome: "rejected" }],
    });
    await send(person.user, start);
    await drain();
    expect(await openReviews(person.user)).toHaveLength(1);
    expect(grants.has(`course:${person.identityRef}`)).toBe(false);
    expect(await reviews.resolve(required(review).reviewId)).toBe("resolved");
    expect(await openReviews(person.user)).toEqual([]);
    expect(await reviews.resolve(required(review).reviewId)).toBe("not_found");
  });

  it("resolves the owner review when the person joins the group and presses again", async () => {
    const person = await linkedPerson();
    const start = await pressButton("course");
    await send(person.user, start);
    await drain();
    expect(await openReviews(person.user)).toHaveLength(1);
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user, start);
    await drain();
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
    expect(await openReviews(person.user)).toEqual([]);
    expect(
      (await activationMessages(person.user)).at(-1)?.message_text,
    ).toContain("Назначение тарифа подтверждено");
  });

  it("never accepts the canonical community chat as a ground", async () => {
    const person = await linkedPerson();
    members.add(`${canonicalChatId}:${person.user}`);
    await send(person.user, await pressButton("course"));
    await drain();
    expect(memberLookups).toEqual([courseChatId]);
    expect(grants.has(`course:${person.identityRef}`)).toBe(false);
    expect(await openReviews(person.user)).toHaveLength(1);
  });
});

describe("the owner link", () => {
  it("does not start from the community chat", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user, "/start a_course", {
      id: Number(canonicalChatId),
      type: "supergroup",
    });
    await drain();
    expect(begins).toEqual([]);
    expect(await attempts(person.user)).toEqual([]);
  });

  it("passes a Tribute registry ground to Platform", async () => {
    const person = await linkedPerson();
    tributeRegistry.add(person.identityRef);
    await send(person.user, "/start a_tribute");
    await drain();
    expect(proofs.map((proof) => proof.decision)).toEqual(["registry_lookup"]);
    expect(grants.get(`tribute-roster:${person.identityRef}`)).toBe(1);
    expect(await openReviews(person.user)).toEqual([]);
  });

  it("shows a Tribute ground Platform holds as suspended and queues it for the owner", async () => {
    const person = await linkedPerson();
    suspendedTribute.add(person.identityRef);
    await send(person.user, "/start a_tribute");
    await drain();
    const [message] = await activationMessages(person.user);
    expect(required(message).message_text).toContain(
      "Источник Tribute завершён",
    );
    expect(required(message).message_text).toContain(OWNER_REVIEW);
    expect(await openReviews(person.user)).toHaveLength(1);
  });

  it("starts only its own rule and queues nobody who already has a confirmed ground", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user, "/start a_course");
    await drain();
    begins.length = 0;
    await send(person.user, "/start a_tribute");
    await drain();
    expect(begins).toEqual(["tribute"]);
    const last = (await activationMessages(person.user)).at(-1);
    expect(required(last).message_text).not.toContain(OWNER_REVIEW);
    expect(await openReviews(person.user)).toEqual([]);
  });

  it("ends an expired retry of a confirmed ground as confirmed", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user, "/start a_course");
    await drain();
    // A retry of the confirmed ground kept failing until its retention ran out.
    await db
      .updateTable("activation_attempts")
      .set({
        state: "retry",
        result: { ok: false, error: { code: "unavailable" } },
        expires_at: clock.now(),
        due_at: clock.now(),
      })
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", String(person.user))
      .where("code", "=", "course")
      .execute();
    begins.length = 0;
    clock.value = new Date(clock.now().getTime() + 61_000);
    await drain();
    expect(begins).toEqual([]);
    const kept = await db
      .selectFrom("activation_attempts")
      .select(["state", "confirmed_at"])
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", String(person.user))
      .where("code", "=", "course")
      .executeTakeFirstOrThrow();
    expect(kept.state).toBe("completed");
    expect(kept.confirmed_at).toBeInstanceOf(Date);
  });

  it("answers a link to an unknown or paused rule without queueing an owner review", async () => {
    const person = await linkedPerson();
    await send(person.user, "/start a_typo");
    await drain();
    paused.add("course");
    try {
      await send(person.user, "/start a_course");
      await drain();
    } finally {
      paused.clear();
    }
    const messages = await activationMessages(person.user);
    expect(required(messages[0]).message_text).toBe(
      "Правило активации не найдено. Проверьте ссылку у владельца.",
    );
    expect(messages).toHaveLength(2);
    expect(await openReviews(person.user)).toEqual([]);
  });
});

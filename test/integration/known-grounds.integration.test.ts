import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { sql } from "kysely";
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
import { NO_KNOWN_GROUND } from "../../src/modules/subscription-activation/activation-view.js";
import { SubscriptionActivation } from "../../src/modules/subscription-activation/subscription-activation.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";
import { required } from "../support/required.js";

// The Platform double below grants by a simple table so the consumer's grouping, messages and
// review queue can be observed. It does not prove Platform's own rule or grant policy.
const bot = `known-grounds-${randomUUID()}`;
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
  TELEGRAM_WEBHOOK_SECRET: "synthetic-known-grounds-webhook-secret",
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
  TELEGRAM_ACTIVATION_START_CODES: JSON.stringify(["course", "tribute"]),
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
const begins: string[] = [];
const proofs: ActivationEvidence[] = [];
const memberLookups: string[] = [];
const grants = new Map<string, number>();
/** When set, evidence answers wait here until the test opens the gate. */
let barrier: { waiting: number; open: Promise<unknown> } | undefined;
const platform: ActivationPlatform = {
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
    if (!code) throw new Error(`Unexpected activation code ${input.code}`);
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
  async evidence(input) {
    proofs.push(structuredClone(input));
    if (barrier) {
      barrier.waiting++;
      await barrier.open;
    }
    const confirmed =
      input.decision === "member" ||
      (input.decision === "registry_lookup" &&
        tributeRegistry.has(input.identityRef));
    const key = `${input.sourceRef}:${input.identityRef}`;
    const prior = grants.get(key) ?? 0;
    if (confirmed && prior === 0) grants.set(key, 1);
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
        enrollment: null,
      },
    };
    return result;
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
let updateId = 810000;
let nextUser = 810000;

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
/** A person who started the bot once and then linked the Account on Platform. */
async function linkedPerson() {
  const user = ++nextUser;
  await send(user);
  const ref = await identity(user);
  bindings.set(ref, {
    accountRef: `account-${user}`,
    identityRef: ref,
    linkRef: randomUUID(),
    linkRevision: 1,
  });
  return { user, identityRef: ref };
}
/** A promise the test settles by hand. */
function signal(): { promise: Promise<unknown>; resolve: () => void } {
  let settle: ((value: unknown) => void) | undefined;
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.(undefined) };
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

describe("ordinary /start checks known grounds of a linked identity", () => {
  it("passes a prior course group membership to Platform and invites to the community", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user);
    await drain();
    expect(begins.sort()).toEqual(["course", "tribute"]);
    expect(proofs.map((p) => [p.sourceRef, p.decision]).sort()).toEqual([
      ["course", "member"],
      ["tribute-roster", "registry_lookup"],
    ]);
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
    const messages = await activationMessages(person.user);
    expect(messages.map((m) => m.message_text)).toHaveLength(1);
    expect(required(messages[0]).message_text).toContain(
      "Вступить в сообщество",
    );
    expect(
      required(messages[0]).buttons?.some(
        (b) => b.text === "Вступить в сообщество",
      ),
    ).toBe(true);
    expect(await openReviews(person.user)).toEqual([]);
  });

  it("passes a Tribute registry ground without reporting the unconfirmed course", async () => {
    const person = await linkedPerson();
    tributeRegistry.add(person.identityRef);
    await send(person.user);
    await drain();
    expect(grants.get(`tribute-roster:${person.identityRef}`)).toBe(1);
    const messages = await activationMessages(person.user);
    expect(messages).toHaveLength(1);
    expect(required(messages[0]).message_text).toContain(
      "Назначение тарифа подтверждено",
    );
    expect(await openReviews(person.user)).toEqual([]);
  });

  it("answers once and queues an owner review when no ground is confirmed", async () => {
    const person = await linkedPerson();
    await send(person.user);
    await drain();
    expect(await activationMessages(person.user)).toEqual([
      expect.objectContaining({ message_text: NO_KNOWN_GROUND }),
    ]);
    const [review] = await openReviews(person.user);
    expect(review).toMatchObject({
      identityRef: person.identityRef,
      accountRef: `account-${person.user}`,
      outcomes: [
        { code: "course", outcome: "rejected" },
        { code: "tribute", outcome: "pending_review" },
      ],
    });
    // Pressing /start again checks again, answers again and keeps one request per person.
    await send(person.user);
    await drain();
    expect(await activationMessages(person.user)).toHaveLength(2);
    expect(await openReviews(person.user)).toHaveLength(1);
    expect(await reviews.resolve(required(review).reviewId)).toBe("resolved");
    expect(await openReviews(person.user)).toEqual([]);
    expect(await reviews.resolve(required(review).reviewId)).toBe("not_found");
  });

  it("finishes a group once when its last two grounds finish concurrently", async () => {
    const person = await linkedPerson();
    await send(person.user);
    const opened = signal();
    const gate = { waiting: 0, open: opened.promise };
    barrier = gate;
    const unlocked = signal();
    const rowsLocked = signal();
    try {
      // The first worker holds its lease at the gate, so the second one claims the other ground.
      const first = worker.processAvailable(1);
      await expect.poll(() => gate.waiting).toBe(1);
      const second = worker.processAvailable(1);
      await expect.poll(() => gate.waiting).toBe(2);
      // Holding both rows makes the two finishing transactions start together once released.
      const holder = db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("activation_attempts")
          .select("attempt_id")
          .where("bot_identity", "=", bot)
          .where("telegram_user_id", "=", String(person.user))
          .forUpdate()
          .execute();
        rowsLocked.resolve();
        await unlocked.promise;
      });
      await rowsLocked.promise;
      opened.resolve();
      await expect
        .poll(async () =>
          Number(
            (
              await sql<{ count: string }>`select count(*)::text as count
                from pg_stat_activity where wait_event_type = 'Lock'
                and query like 'update "activation_attempts"%'`.execute(db)
            ).rows[0]?.count,
          ),
        )
        .toBe(2);
      unlocked.resolve();
      await Promise.all([holder, first, second]);
    } finally {
      barrier = undefined;
      unlocked.resolve();
    }
    await drain();
    expect(await activationMessages(person.user)).toHaveLength(1);
    expect(await openReviews(person.user)).toHaveLength(1);
  });

  it("resolves the owner review when a later check confirms a ground", async () => {
    const person = await linkedPerson();
    await send(person.user);
    await drain();
    expect(await openReviews(person.user)).toHaveLength(1);
    tributeRegistry.add(person.identityRef);
    await send(person.user);
    await drain();
    expect(await openReviews(person.user)).toEqual([]);
    expect(grants.get(`tribute-roster:${person.identityRef}`)).toBe(1);
  });

  it("grants once: a repeated /start after leaving the group sends nothing new", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user);
    await drain();
    members.delete(`${courseChatId}:${person.user}`);
    begins.length = 0;
    proofs.length = 0;
    await send(person.user);
    await send(person.user);
    await drain();
    expect(begins).toEqual([]);
    expect(proofs).toEqual([]);
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
    expect(await activationMessages(person.user)).toHaveLength(1);
  });

  it("stays silent for an unlinked identity and asks Platform for no rule", async () => {
    const user = ++nextUser;
    await send(user);
    await drain();
    expect(begins).toEqual([]);
    expect(await activationMessages(user)).toEqual([]);
    expect(
      await db
        .selectFrom("activation_attempts")
        .select("code")
        .where("bot_identity", "=", bot)
        .where("telegram_user_id", "=", String(user))
        .execute(),
    ).toEqual([]);
  });

  it("never accepts the canonical community chat as a ground", async () => {
    const person = await linkedPerson();
    members.add(`${canonicalChatId}:${person.user}`);
    await send(person.user);
    await drain();
    expect(memberLookups).toEqual([courseChatId]);
    expect(grants.has(`course:${person.identityRef}`)).toBe(false);
    expect(await openReviews(person.user)).toHaveLength(1);
  });
});

describe("the owner link", () => {
  it("checks its own rule, answers for it alone and does not start from the community chat", async () => {
    const person = await linkedPerson();
    members.add(`${courseChatId}:${person.user}`);
    await send(person.user, "/start a_course", {
      id: Number(canonicalChatId),
      type: "supergroup",
    });
    await drain();
    expect(begins).toEqual([]);
    await send(person.user, "/start a_course");
    await drain();
    expect(begins).toEqual(["course"]);
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
    const messages = await activationMessages(person.user);
    expect(
      messages.some((m) =>
        m.message_text.includes("Назначение тарифа подтверждено"),
      ),
    ).toBe(true);
    // A repeated link confirms the same right without a second grant.
    await send(person.user, "/start a_course");
    await drain();
    expect(grants.get(`course:${person.identityRef}`)).toBe(1);
  });

  it("answers a failed owner link for its own rule without an owner review", async () => {
    const person = await linkedPerson();
    await send(person.user, "/start a_course");
    await drain();
    const messages = await activationMessages(person.user);
    expect(messages.map((m) => m.message_text)).not.toContain(NO_KNOWN_GROUND);
    expect(messages.length).toBeGreaterThan(0);
    expect(await openReviews(person.user)).toEqual([]);
  });
});

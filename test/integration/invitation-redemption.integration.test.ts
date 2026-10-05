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
import {
  ACTIVATION_PLATFORM,
  type ActivationPlatform,
} from "../../src/modules/subscription-activation/activation-ports.js";
import {
  ACTIVATION_VERSION,
  type InvitationRedeem,
  type InvitationRedeemResponse,
} from "../../src/modules/subscription-activation/activation-contract.js";
import { InvitationRedemption } from "../../src/modules/subscription-activation/invitation-redemption.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";
import { reserveTelegramIdentity } from "../../src/modules/identity-linking/stable-telegram-identity.js";

const bot = `invitation-${randomUUID()}`;
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
  TELEGRAM_ACTIVATION_SOURCES: "[]",
});

/** A Platform double that keeps the provider's rules: first identity claims, repeats are idempotent. */
interface Invitation {
  readonly mode: "purchase" | "gift";
  claimedBy?: string;
  redeemed?: boolean;
  readonly refusal?: "expired" | "revoked" | "unavailable";
}
const invitations = new Map<string, Invitation>();
const linked = new Set<string>();
const requests: InvitationRedeem[] = [];
let redemptions = 0;
let outage:
  | "none"
  | "lost"
  | "error"
  | "unavailable"
  | "identity_conflict"
  | "invalid_input" = "none";
const checkoutUrl = "https://inside.example/subscription?offer=offer-1";
const enrollment = {
  id: "90800000-0000-4000-8000-000000000001",
  tier: { name: "Подписка Inside" },
  endsAt: "2030-04-01T00:00:00.000Z",
};

function redeem(input: InvitationRedeem): InvitationRedeemResponse | undefined {
  requests.push(structuredClone(input));
  if (outage === "error") return undefined;
  if (
    outage === "unavailable" ||
    outage === "identity_conflict" ||
    outage === "invalid_input"
  )
    return { ok: false, error: { code: outage } };
  const invitation = invitations.get(input.code);
  const refusal = (
    state: "claimed_by_other" | "expired" | "revoked" | "unavailable",
  ): InvitationRedeemResponse => ({
    ok: true,
    value: { contractVersion: ACTIVATION_VERSION, state },
  });
  if (!invitation) return refusal("unavailable");
  if (invitation.refusal) return refusal(invitation.refusal);
  invitation.claimedBy ??= input.identityRef;
  if (invitation.claimedBy !== input.identityRef)
    return refusal("claimed_by_other");
  if (!linked.has(input.identityRef))
    return {
      ok: true,
      value: { contractVersion: ACTIVATION_VERSION, state: "needs_account" },
    };
  const repeat = invitation.redeemed === true;
  if (!repeat) redemptions += 1;
  invitation.redeemed = true;
  const response: InvitationRedeemResponse =
    invitation.mode === "purchase"
      ? {
          ok: true,
          value: {
            contractVersion: ACTIVATION_VERSION,
            state: repeat ? "already_redeemed" : "purchase_ready",
            mode: "purchase",
            offerName: "Подписка Inside",
            checkoutUrl,
          },
        }
      : {
          ok: true,
          value: {
            contractVersion: ACTIVATION_VERSION,
            state: repeat ? "already_redeemed" : "gift_granted",
            mode: "gift",
            offerName: "Подписка Inside",
            enrollment,
          },
        };
  // The answer is lost after Platform committed the redemption.
  if (outage === "lost") {
    outage = "none";
    return undefined;
  }
  return response;
}

const platform: ActivationPlatform = {
  binding: () =>
    Promise.resolve({
      ok: true,
      value: { contractVersion: ACTIVATION_VERSION, state: "unlinked" },
    }),
  begin: () => Promise.resolve(undefined),
  evidence: () => Promise.resolve(undefined),
  own: () => Promise.resolve(undefined),
  redeem: (input) => Promise.resolve(redeem(input)),
};

let app: NestFastifyApplication;
let db: Database;
let worker: InvitationRedemption;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(ACTIVATION_PLATFORM)
    .useValue(platform)
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DATABASE);
  worker = app.get(InvitationRedemption);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  outage = "none";
  requests.length = 0;
  redemptions = 0;
});

let updateId = 500000;
async function receive(user: number, text: string) {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/telegram",
    headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
    payload: privateStartUpdate(++updateId, user, { text }),
  });
  expect(response.statusCode).toBe(202);
}
async function send(user: number, text: string) {
  await receive(user, text);
  await app.get(TelegramUpdateProcessor).processAvailable();
}
/** Links an Account before the person opens the link. */
async function linkedBefore(user: number) {
  linked.add(
    await db
      .transaction()
      .execute((tx) => reserveTelegramIdentity(tx, bot, String(user))),
  );
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
async function replies(user: number) {
  return db
    .selectFrom("start_response_deliveries")
    .select(["message_text", "buttons"])
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", String(user))
    .orderBy("id")
    .execute();
}
async function rows(user: number) {
  return db
    .selectFrom("invitation_redemptions")
    .select("state")
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", String(user))
    .execute();
}
function later(ms = 60_000) {
  clock.value = new Date(clock.now().getTime() + ms);
}

describe("invitation link in the bot", () => {
  it("asks an unlinked person to sign in and redeems the same request after linking", async () => {
    invitations.set("buy1", { mode: "purchase" });
    await send(81001, "/start i_buy1");
    await worker.processAvailable();
    const id = await identity(81001);
    expect(requests).toEqual([
      { contractVersion: ACTIVATION_VERSION, code: "buy1", identityRef: id },
    ]);
    const prompt = (await replies(81001)).at(-1);
    expect(prompt?.message_text).toContain("свяжите Telegram");
    expect(prompt?.buttons).toContainEqual({
      text: "Я связал Telegram — проверить",
      callbackData: "access:retry",
    });

    // Still unlinked: the bot keeps waiting without repeating the prompt.
    later();
    await worker.processAvailable();
    expect(requests).toHaveLength(2);
    expect(await replies(81001)).toHaveLength(1);

    linked.add(id);
    later();
    await worker.processAvailable();
    expect(requests.at(-1)).toEqual(requests[0]);
    expect(redemptions).toBe(1);
    const answer = (await replies(81001)).at(-1);
    expect(answer?.message_text).toContain("Подписка Inside");
    expect(answer?.buttons).toEqual([{ text: "Оплатить", url: checkoutUrl }]);

    // Done: the row goes with the answer; no more calls until the person opens the link again.
    expect(await rows(81001)).toEqual([]);
    later();
    await worker.processAvailable();
    expect(requests).toHaveLength(3);
  });

  it("continues at once when the person presses the retry button after linking", async () => {
    invitations.set("buy2", { mode: "purchase" });
    await send(81002, "/start i_buy2");
    await worker.processAvailable();
    linked.add(await identity(81002));
    await send(81002, "/retry");
    await worker.processAvailable();
    expect(redemptions).toBe(1);
    expect((await replies(81002)).at(-1)?.buttons).toEqual([
      { text: "Оплатить", url: checkoutUrl },
    ]);
  });

  it("grants a gift and leads to the community through /community", async () => {
    await linkedBefore(81003);
    invitations.set("gift1", { mode: "gift" });
    await send(81003, "/start i_gift1");
    await worker.processAvailable();
    const answer = (await replies(81003)).at(-1);
    expect(answer?.message_text).toContain("Подписка Inside");
    expect(answer?.message_text).toContain("/community");
    expect(answer?.buttons).toEqual([
      { text: "Вступить в сообщество", callbackData: "access:community" },
    ]);
  });

  it("repeats a lost answer with the same request and redeems once", async () => {
    await linkedBefore(81004);
    const id = await identity(81004);
    invitations.set("gift2", { mode: "gift" });
    outage = "lost";
    await send(81004, "/start i_gift2");
    await worker.processAvailable();
    expect(redemptions).toBe(1);
    later();
    await worker.processAvailable();
    expect(requests).toEqual([
      { contractVersion: ACTIVATION_VERSION, code: "gift2", identityRef: id },
      { contractVersion: ACTIVATION_VERSION, code: "gift2", identityRef: id },
    ]);
    expect(redemptions).toBe(1);
    const gifts = (await replies(81004)).filter((reply) =>
      reply.message_text.includes("/community"),
    );
    expect(gifts).toHaveLength(1);

    // Opening the link again answers with the same payload, still one redemption.
    await send(81004, "/start i_gift2");
    await worker.processAvailable();
    expect(redemptions).toBe(1);
    expect((await replies(81004)).at(-1)?.message_text).toContain("/community");
  });

  it("retries a Platform outage with growing pauses and tells the person once", async () => {
    await linkedBefore(81005);
    invitations.set("buy3", { mode: "purchase" });
    outage = "unavailable";
    await send(81005, "/start i_buy3");
    await worker.processAvailable();
    later();
    outage = "error";
    await worker.processAvailable();
    expect(requests).toHaveLength(2);
    // The second failure waits two minutes, not one.
    later();
    await worker.processAvailable();
    expect(requests).toHaveLength(2);
    const before = await replies(81005);
    expect(before.at(-1)?.message_text).toContain("повторит");
    expect(
      before.filter((reply) => reply.message_text.includes("повторит")),
    ).toHaveLength(1);
    outage = "none";
    later();
    await worker.processAvailable();
    expect(requests).toHaveLength(3);
    expect(redemptions).toBe(1);
    expect((await replies(81005)).at(-1)?.buttons).toEqual([
      { text: "Оплатить", url: checkoutUrl },
    ]);
  });

  it.each([
    ["expired", "Срок приглашения истёк"],
    ["revoked", "отозвано"],
    ["unavailable", "недоступно"],
  ] as const)(
    "answers %s with a request to write to the author",
    async (refusal, text) => {
      const user =
        81100 + ["expired", "revoked", "unavailable"].indexOf(refusal);
      invitations.set(`refused-${refusal}`, { mode: "gift", refusal });
      await send(user, `/start i_refused-${refusal}`);
      await worker.processAvailable();
      const answer = (await replies(user)).at(-1)?.message_text;
      expect(answer).toContain(text);
      expect(answer).toContain("Напишите автору");
      later();
      await worker.processAvailable();
      expect(requests).toHaveLength(1);
    },
  );

  it("answers claimed_by_other to the second identity", async () => {
    invitations.set("mine", { mode: "purchase" });
    await send(81201, "/start i_mine");
    await send(81202, "/start i_mine");
    await worker.processAvailable();
    const answer = (await replies(81202)).at(-1)?.message_text;
    expect(answer).toContain("другой Telegram-аккаунт");
    expect(answer).toContain("Напишите автору");
  });

  it("answers a malformed link without calling Platform and keeps the code out of the inbox", async () => {
    await send(81301, "/start i_bad!");
    await worker.processAvailable();
    expect(requests).toHaveLength(0);
    expect((await replies(81301)).at(-1)?.message_text).toContain(
      "Напишите автору",
    );
    // The code waits in a side field only until the update is processed, then the payload goes.
    invitations.set("hidden", { mode: "purchase" });
    await receive(81302, "/start i_hidden");
    const stored = () =>
      db
        .selectFrom("telegram_updates")
        .select("payload")
        .where("bot_identity", "=", bot)
        .where("update_id", "=", String(updateId))
        .executeTakeFirstOrThrow();
    const waiting = JSON.stringify((await stored()).payload);
    expect(waiting).not.toContain("i_hidden");
    expect(waiting).toContain('"text":"/start"');
    await app.get(TelegramUpdateProcessor).processAvailable();
    expect((await stored()).payload).toBeNull();
  });

  it("answers invalid_input once and stops", async () => {
    await linkedBefore(81402);
    outage = "invalid_input";
    await send(81402, "/start i_rejected");
    await worker.processAvailable();
    later();
    await worker.processAvailable();
    expect(requests.filter((r) => r.code === "rejected")).toHaveLength(1);
    expect((await replies(81402)).at(-1)?.message_text).toContain(
      "Напишите автору",
    );
    expect(await rows(81402)).toEqual([]);
  });

  it("asks to write to the author on an identity conflict", async () => {
    await linkedBefore(81401);
    invitations.set("conflict", { mode: "gift" });
    outage = "identity_conflict";
    await send(81401, "/start i_conflict");
    await worker.processAvailable();
    expect((await replies(81401)).at(-1)?.message_text).toContain(
      "Напишите автору",
    );
  });
});

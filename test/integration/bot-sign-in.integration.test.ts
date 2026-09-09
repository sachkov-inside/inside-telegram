import { MarketingEntry } from "../../src/modules/communications/marketing-entry.js";
import { Communications } from "../../src/modules/communications/communications.js";
import { lockTelegramIdentity } from "../../src/modules/identity-linking/identity-link-account-lock.js";
import { randomBytes, randomUUID } from "node:crypto";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
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
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import {
  BotSignIn,
  digestSignInSecret,
  type SignInResult,
} from "../../src/modules/bot-sign-in/bot-sign-in.js";
import { IdentityLinking } from "../../src/modules/identity-linking/identity-linking.js";
import { StartResponseDeliveryQueue } from "../../src/modules/outbound/start-response-delivery-queue.js";
import { StartResponseDeliveryProcessor } from "../../src/modules/outbound/start-response-delivery-processor.js";
import type { TelegramTextMessage } from "../../src/modules/outbound/telegram-messages.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { TelegramUpdateInbox } from "../../src/modules/update-inbox/telegram-update-inbox.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import { MembershipEvidenceProvider } from "../../src/modules/membership-evidence/membership-evidence-provider.js";
import { CommunityProvider } from "../../src/modules/community/community-provider.js";
import { RuntimeMetrics } from "../../src/operations/runtime-metrics.js";
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for integration tests");
const config = loadApplicationConfig({
  DATABASE_URL: databaseUrl,
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
  TELEGRAM_SIGN_IN_ENABLED: "true",
  TELEGRAM_SIGN_IN_INTEGRATION_SECRET:
    "synthetic_sign_in_credential_for_tests_only",
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_LINK_RECEIPT_TEXT: "Synthetic link receipt",
  TELEGRAM_LINKED_MEMBER_TEXT: "Synthetic member",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "Synthetic non-member",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "Synthetic unavailable",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
  TELEGRAM_WELCOME_TEXT: "Synthetic welcome",
  WORKERS_ENABLED: "false",
});
const contractVersion = "inside.bot-sign-in.v1";
let application: NestFastifyApplication;
let fastify: FastifyInstance;
let database: Database;
let secondDatabase: Database;
let signIn: BotSignIn;
let updateId = 100;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  secondDatabase = createDatabase(databaseUrl);
  await migrateToLatest(database);
  application = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
    { logger: false },
  );
  await application.init();
  fastify = application.getHttpAdapter().getInstance() as FastifyInstance;
  await fastify.ready();
  signIn = application.get(BotSignIn);
});

beforeEach(async () => {
  await sql`truncate sign_in_requests, sign_in_subjects, telegram_updates, bot_contacts, bot_contact_events, start_response_deliveries, platform_links, link_transactions restart identity cascade`.execute(
    database,
  );
});

afterAll(async () => {
  await application.close();
  await database.destroy();
  await secondDatabase.destroy();
});

describe("bot sign-in provider", () => {
  it("does not enter marketing when a sign-in start arrives while marketing is enabled", async () => {
    const marketing = application.get(MarketingEntry);
    const enabled = vi.spyOn(marketing, "enabled").mockReturnValue(true);
    const enter = vi.spyOn(marketing, "enter");
    try {
      const challenge = await register();
      await start(challenge, 42);
      expect(enter).not.toHaveBeenCalled();
      expect(
        await database
          .selectFrom("start_response_deliveries")
          .select("sign_in_request_ref")
          .execute(),
      ).toEqual([{ sign_in_request_ref: challenge.requestRef }]);
      await callback(challenge, 42);
      expect(await status(challenge)).toMatchObject({ status: "approved" });
    } finally {
      enabled.mockRestore();
      enter.mockRestore();
    }
  });

  it.each(["sign-in", "email-link"] as const)(
    "serializes %s winning against the other ownership path",
    async (winner) => {
      const linking = application.get(IdentityLinking);
      const emailPrincipal = randomUUID();
      const normalToken = randomBytes(32).toString("base64url");
      const normal = await linking.register({
        accountRef: emailPrincipal,
        returnCorrelation: "race-return",
        tokenDigest: digestSignInSecret(normalToken),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await linking.acceptStart({
        botIdentity: "inside",
        telegramUserId: "42",
        observedAt: new Date(),
        linkToken: { kind: "digest", digest: digestSignInSecret(normalToken) },
      });
      const challenge = await register();
      await start(challenge, 42);
      await callback(challenge, 42);
      const locked = deferred();
      const release = deferred();
      const blocker = secondDatabase
        .transaction()
        .execute(async (transaction) => {
          await lockTelegramIdentity(transaction, "inside", "42");
          locked.resolve();
          await release.promise;
        });
      await locked.promise;
      const confirmEmail = () =>
        linking.confirm({
          accountRef: emailPrincipal,
          returnCorrelation: "race-return",
          linkTransactionRef: normal.linkTransactionRef,
        });
      const consume = () => status(challenge, true);
      const waiting = async () => {
        const result = await sql<{
          count: number;
        }>`select count(*)::int as count from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`.execute(
          database,
        );
        return result.rows[0]?.count ?? 0;
      };
      let proofPromise: Promise<SignInResult>;
      let linkPromise: ReturnType<typeof confirmEmail>;
      try {
        if (winner === "sign-in") {
          proofPromise = consume();
          await expect.poll(waiting).toBe(1);
          linkPromise = confirmEmail();
        } else {
          linkPromise = confirmEmail();
          await expect.poll(waiting).toBe(1);
          proofPromise = consume();
        }
        await expect.poll(waiting).toBe(2);
      } finally {
        release.resolve();
        await blocker;
      }
      const [proof, linked] = await Promise.all([proofPromise, linkPromise]);
      if (proof.status !== "verified") throw new Error("Expected proof");
      if (winner === "email-link") {
        expect(linked.status).toBe("linked");
        expect(proof.existingLink?.accountRef).toBe(emailPrincipal);
      } else {
        expect(linked.status).toBe("recovery-required");
        expect(proof.existingLink).toBeNull();
        // Simulate loss of the first consume response: a fresh interaction repairs the reservation.
        const retry = await register();
        await start(retry, 42);
        await callback(retry, 42);
        const fresh = await status(retry, true);
        expect(fresh).toMatchObject({
          status: "verified",
          subjectRef: proof.subjectRef,
          existingLink: null,
        });
        expect(
          (
            await request(`/${retry.requestRef}/account-link`, {
              contractVersion,
              subjectRef: proof.subjectRef,
              accountRef: randomUUID(),
            })
          ).json(),
        ).toMatchObject({ status: "linked" });
      }
      expect(
        await database.selectFrom("platform_links").selectAll().execute(),
      ).toHaveLength(1);
    },
  );

  it("finalizes consumed proof idempotently and rejects a different Account or identity", async () => {
    const challenge = await register();
    const accountRef = randomUUID();
    const bind = (subjectRef: string, target = accountRef) =>
      request(`/${challenge.requestRef}/account-link`, {
        contractVersion,
        subjectRef,
        accountRef: target,
      });
    expect((await bind(randomUUID())).json()).toMatchObject({
      status: "unavailable",
    });
    await start(challenge, 42);
    await callback(challenge, 42);
    const verified = await status(challenge, true);
    if (verified.status !== "verified")
      throw new Error("Expected verified proof");
    expect((await bind(randomUUID())).json()).toMatchObject({
      status: "unavailable",
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => bind(verified.subjectRef)),
    );
    const bodies = results.map((result) =>
      result.json<{ status: string; telegramIdentityRef: string }>(),
    );
    expect(bodies.every((result) => result.status === "linked")).toBe(true);
    expect(
      new Set(bodies.map((result) => result.telegramIdentityRef)).size,
    ).toBe(1);
    expect(
      (await bind(verified.subjectRef, randomUUID())).json(),
    ).toMatchObject({ status: "unavailable" });
    expect(
      await database.selectFrom("platform_links").selectAll().execute(),
    ).toHaveLength(1);
    expect((await status(challenge, true)).status).toBe("consumed");
  });

  it("edits the approved prompt only after account finalization and retries the same message after transport ambiguity", async () => {
    const challenge = await register();
    await start(challenge, 42);
    await callback(challenge, 42);
    const edits = () =>
      database
        .selectFrom("start_response_deliveries")
        .selectAll()
        .where("edit_message_id", "is not", null)
        .execute();
    expect(await edits()).toHaveLength(0);
    const verified = await status(challenge, true);
    if (verified.status !== "verified")
      throw new Error("Expected verified proof");
    expect(await edits()).toHaveLength(0);
    const accountRef = randomUUID();
    const bind = () =>
      request(`/${challenge.requestRef}/account-link`, {
        contractVersion,
        subjectRef: verified.subjectRef,
        accountRef,
      });
    await Promise.all([bind(), bind()]);
    expect(await edits()).toMatchObject([
      {
        edit_message_id: "100",
        message_text: "Вход подтверждён. Вернитесь на сайт.",
      },
    ]);
    const calls: { chatId: string; messageId: string; text: string }[] = [];
    const messages = {
      async sendText() {
        throw new Error("Completion must edit, never send another message");
      },
      async editText(message: {
        chatId: string;
        messageId: string;
        text: string;
      }) {
        calls.push(message);
        return calls.length === 1
          ? { kind: "transport_unknown" as const }
          : {
              kind: "delivered" as const,
              providerMessageId: message.messageId,
            };
      },
    };
    const now = new Date();
    const firstWorker = new StartResponseDeliveryProcessor(
      new StartResponseDeliveryQueue(database),
      messages,
      new RuntimeMetrics(),
      config,
    );
    expect(await firstWorker.processAvailable(1, now)).toBe(1);
    const restartedWorker = new StartResponseDeliveryProcessor(
      new StartResponseDeliveryQueue(secondDatabase),
      messages,
      new RuntimeMetrics(),
      config,
    );
    const retryAt = new Date(now.getTime() + 1001);
    expect(await restartedWorker.processAvailable(1, retryAt)).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({ chatId: "42", messageId: "100" });
    expect(await edits()).toMatchObject([
      { state: "delivered", attempt_count: 2 },
    ]);
    expect(await restartedWorker.processAvailable(1, retryAt)).toBe(0);
  });

  it.each(["before", "after"] as const)(
    "retains completion intent across a failure %s the link commit without premature success",
    async (failurePoint) => {
      const challenge = await register();
      await start(challenge, 42);
      await callback(challenge, 42);
      const verified = await status(challenge, true);
      if (verified.status !== "verified")
        throw new Error("Expected verified proof");
      const accountRef = randomUUID();
      const linking = application.get(IdentityLinking);
      const confirm = linking.confirm.bind(linking);
      const fault = vi
        .spyOn(linking, "confirm")
        .mockImplementationOnce(async (input) => {
          if (failurePoint === "after") await confirm(input);
          throw new Error("Synthetic process failure at link boundary");
        });
      const bind = () =>
        request(`/${challenge.requestRef}/account-link`, {
          contractVersion,
          subjectRef: verified.subjectRef,
          accountRef,
        });
      try {
        expect((await bind()).statusCode).toBe(500);
      } finally {
        fault.mockRestore();
      }
      const queue = new StartResponseDeliveryQueue(secondDatabase);
      if (failurePoint === "before") {
        expect(await queue.claimNext(new Date(), true)).toBeUndefined();
        expect((await bind()).json()).toMatchObject({ status: "linked" });
      }
      // After commit no request replay is needed: a fresh worker sees the durable result.
      expect(await queue.claimNext(new Date(), true)).toMatchObject({
        editMessageId: "100",
        messageText: "Вход подтверждён. Вернитесь на сайт.",
      });
      expect(await queue.claimNext(new Date(), true)).toBeUndefined();
    },
  );

  it("updates a cancelled prompt once and never lets another identity choose the edit target", async () => {
    const challenge = await register();
    await start(challenge, 42);
    await callback(challenge, 43, "deny");
    const edits = () =>
      database
        .selectFrom("start_response_deliveries")
        .selectAll()
        .where("edit_message_id", "is not", null)
        .execute();
    expect(await edits()).toHaveLength(0);
    await callback(challenge, 42, "deny");
    await callback(challenge, 42, "deny");
    expect(await edits()).toMatchObject([
      {
        edit_message_id: "100",
        private_chat_id: "42",
        message_text: "Вход отменён.",
      },
    ]);
    const queue = new StartResponseDeliveryQueue(database);
    expect(await queue.claimNext(new Date(), false)).toBeUndefined();
    const claims = await Promise.all([
      queue.claimNext(new Date(), true),
      new StartResponseDeliveryQueue(secondDatabase).claimNext(
        new Date(),
        true,
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      editMessageId: "100",
      messageText: "Вход отменён.",
    });
  });

  it("refreshes inbox leases after a delayed callback instead of claiming with batch-start time", async () => {
    const current = new Date();
    const later = new Date(current.getTime() + 60_001);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(current);
    const inbox = application.get(TelegramUpdateInbox);
    const claim = vi.spyOn(inbox, "claimNext");
    try {
      const challenge = await register();
      await start(challenge, 42);
      for (const payload of [
        decisionUpdate(challenge, 42),
        privateStartUpdate(++updateId, 43),
      ]) {
        expect(
          (
            await fastify.inject({
              method: "POST",
              url: "/webhooks/telegram",
              headers: {
                "x-telegram-bot-api-secret-token": config.webhookSecret,
              },
              payload,
            })
          ).statusCode,
        ).toBe(202);
      }
      claim.mockClear();
      const processor = new TelegramUpdateProcessor(
        inbox,
        application.get(BotContacts),
        application.get(IdentityLinking),
        new RuntimeMetrics(),
        application.get(MembershipEvidenceProvider),
        signIn,
        {
          async answer() {
            vi.setSystemTime(later);
          },
        },
        application.get(Communications),
        { handle: async () => false },
        application.get(MarketingEntry),
        application.get(CommunityProvider),
      );
      expect(await processor.processAvailable()).toBe(2);
      expect(claim.mock.calls[0]?.[0]).toEqual(current);
      expect(claim.mock.calls[1]?.[0]).toEqual(later);
      const last = await database
        .selectFrom("telegram_updates")
        .select(["state", "processed_at"])
        .orderBy("update_id", "desc")
        .executeTakeFirstOrThrow();
      expect(last).toEqual({ state: "processed", processed_at: later });
    } finally {
      claim.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reports disabled over authenticated HTTP after loading a disabled runtime configuration", async () => {
    const disabledConfig = loadApplicationConfig({
      DATABASE_URL: databaseUrl,
      PLATFORM_INTEGRATION_SECRET: config.platformIntegrationSecret,
      TELEGRAM_BOT_IDENTITY: config.botIdentity,
      TELEGRAM_CANONICAL_CHAT_ID: config.canonicalChatId,
      TELEGRAM_LINK_RECEIPT_TEXT: config.linkReceiptText,
      TELEGRAM_LINKED_MEMBER_TEXT: config.linkedMemberText,
      TELEGRAM_LINKED_NON_MEMBER_TEXT: config.linkedNonMemberText,
      TELEGRAM_LINKED_UNAVAILABLE_TEXT: config.linkedUnavailableText,
      TELEGRAM_WEBHOOK_SECRET: config.webhookSecret,
      TELEGRAM_WELCOME_TEXT: config.welcomeText,
      TELEGRAM_SIGN_IN_ENABLED: "false",
      TELEGRAM_SIGN_IN_INTEGRATION_SECRET: config.signInIntegrationSecret,
      WORKERS_ENABLED: "false",
    });
    const challenge = await register();
    await start(challenge, 42);
    await callback(challenge, 42);
    const disabledApplication =
      await NestFactory.create<NestFastifyApplication>(
        AppModule.register(disabledConfig),
        new FastifyAdapter(),
        { logger: false },
      );
    try {
      await disabledApplication.init();
      const disabledHttp = disabledApplication
        .getHttpAdapter()
        .getInstance() as FastifyInstance;
      for (const path of ["status", "consume"]) {
        const response = await disabledHttp.inject({
          method: "POST",
          url: `/integrations/identity/v1/sign-in/${challenge.requestRef}/${path}`,
          headers: {
            authorization: `Bearer ${config.signInIntegrationSecret}`,
          },
          payload: { contractVersion, browserSecret: challenge.browserSecret },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({ status: "disabled" });
      }
      const registration = await disabledHttp.inject({
        method: "POST",
        url: "/integrations/identity/v1/sign-in",
        headers: { authorization: `Bearer ${config.signInIntegrationSecret}` },
        payload: newChallenge().envelope,
      });
      expect(registration.json()).toMatchObject({ status: "disabled" });
      expect(await status(challenge)).toMatchObject({ status: "approved" });
    } finally {
      await disabledApplication.close();
    }
  });

  it("does not send a sign-in prompt that expires behind an earlier delivery", async () => {
    const current = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(current);
    try {
      await webhook(privateStartUpdate(++updateId, 43));
      const challenge = await register();
      await start(challenge, 42);
      const messages: TelegramTextMessage[] = [];
      const delivery = new StartResponseDeliveryProcessor(
        new StartResponseDeliveryQueue(database),
        {
          async editText() {
            throw new Error("Unexpected message edit");
          },
          async sendText(message) {
            messages.push(message);
            vi.setSystemTime(new Date(challenge.envelope.expiresAt));
            return { kind: "delivered", providerMessageId: "1" };
          },
        },
        new RuntimeMetrics(),
        config,
      );
      expect(await delivery.processAvailable()).toBe(1);
      expect(messages[0]?.buttons).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires dedicated server credentials and a closed versioned envelope", async () => {
    const challenge = newChallenge();
    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Bearer ${config.platformIntegrationSecret}`,
    ]) {
      const result = await fastify.inject({
        method: "POST",
        url: "/integrations/identity/v1/sign-in",
        payload: challenge.envelope,
        ...(authorization ? { headers: { authorization } } : {}),
      });
      expect(result.statusCode).toBe(401);
    }
    for (const payload of [
      { ...challenge.envelope, email: "must-not-cross@example.test" },
      { ...challenge.envelope, contractVersion: "v2" },
      {
        ...challenge.envelope,
        browserSecretDigest: challenge.envelope.startTokenDigest,
      },
      {
        ...challenge.envelope,
        expiresAt: new Date(Date.now() + 301_000).toISOString(),
      },
    ]) {
      expect((await request("", payload)).statusCode).toBe(400);
    }
    expect(
      await database.selectFrom("sign_in_requests").selectAll().execute(),
    ).toEqual([]);
  });

  it("requires explicit bot approval and the independent original-browser secret", async () => {
    const challenge = await register();
    await start(challenge, 42);
    expect(await status(challenge)).toMatchObject({ status: "pending" });
    const inbox = await database
      .selectFrom("telegram_updates")
      .select("payload")
      .execute();
    expect(JSON.stringify(inbox)).not.toContain(challenge.startToken);
    expect(
      JSON.stringify(
        await database.selectFrom("sign_in_requests").selectAll().execute(),
      ),
    ).not.toContain(challenge.browserSecret);
    const messages: TelegramTextMessage[] = [];
    const delivery = new StartResponseDeliveryProcessor(
      new StartResponseDeliveryQueue(database),
      {
        async editText() {
          throw new Error("Unexpected message edit");
        },
        async sendText(message) {
          messages.push(message);
          return { kind: "delivered", providerMessageId: "1" };
        },
      },
      new RuntimeMetrics(),
      config,
    );
    expect(await delivery.processAvailable()).toBe(1);
    expect(messages[0]?.text).toBe("Вы входите в Sachkov Inside?");
    expect(messages[0]?.buttons?.map((button) => button.text)).toEqual([
      "Подтвердить вход",
      "Отменить",
    ]);
    expect(messages[0]?.buttons?.map((button) => button.callbackData)).toEqual([
      `signin:approve:${challenge.requestRef}`,
      `signin:deny:${challenge.requestRef}`,
    ]);
    expect(
      messages[0]?.buttons?.every(
        (button) => Buffer.byteLength(button.callbackData) <= 64,
      ),
    ).toBe(true);
    await callback(challenge, 42);
    expect(await status(challenge)).toMatchObject({ status: "approved" });
    expect(await status(challenge, true, challenge.startToken)).toMatchObject({
      status: "unavailable",
    });
    expect(
      await status(challenge, true, randomBytes(32).toString("base64url")),
    ).toMatchObject({ status: "unavailable" });
    const proof = await status(challenge, true);
    expect(proof).toMatchObject({
      status: "verified",
      subjectRef: expect.any(String),
      existingLink: null,
    });
    expect(proof).not.toHaveProperty("telegramUserId");
    expect(proof).not.toHaveProperty("email");
    expect(await status(challenge, true)).toMatchObject({ status: "consumed" });
    expect(
      await database.selectFrom("platform_links").selectAll().execute(),
    ).toEqual([]);
  });

  it("never approves from start alone, another user, a group or a bot", async () => {
    const challenge = await register();
    await callback(challenge, 42);
    await start(challenge, 42);
    await start(challenge, 43);
    for (const payload of [
      decisionUpdate(challenge, 43),
      decisionUpdate(challenge, 42, "approve", { type: "group" }),
      decisionUpdate(challenge, 42, "approve", { isBot: true }),
    ])
      await webhook(payload);
    expect(await status(challenge)).toMatchObject({ status: "pending" });
    const prompts = await database
      .selectFrom("start_response_deliveries")
      .selectAll()
      .execute();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.telegram_user_id).toBe("42");
    await callback(challenge, 42);
    expect(await status(challenge)).toMatchObject({ status: "approved" });
  });

  it("makes denial terminal even if old approval buttons are pressed", async () => {
    const challenge = await register();
    await start(challenge, 42);
    await callback(challenge, 42, "deny");
    await callback(challenge, 42);
    expect(await status(challenge, true)).toMatchObject({ status: "denied" });
    const queue = new StartResponseDeliveryQueue(database);
    expect(await queue.claimNext(new Date(), true)).toMatchObject({
      editMessageId: "100",
      messageText: "Вход отменён.",
    });
    expect(await queue.claimNext(new Date(), true)).toBeUndefined();
  });

  it("allows exactly one consumer across independent database connections", async () => {
    const challenge = await register();
    await start(challenge, 42);
    await callback(challenge, 42);
    const other = new BotSignIn(secondDatabase, config, {
      now: () => new Date(),
    });
    const results = await Promise.all([
      signIn.inspect(challenge.requestRef, challenge.browserSecret, true),
      other.inspect(challenge.requestRef, challenge.browserSecret, true),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "consumed",
      "verified",
    ]);
  });

  it("keeps the opaque subject stable and reports an existing link without changing it", async () => {
    const linking = new IdentityLinking(database, { now: () => new Date() });
    const link = await linking.register({
      accountRef: "existing-account",
      expiresAt: new Date(Date.now() + 60_000),
      returnCorrelation: "synthetic-return",
      tokenDigest: digestSignInSecret("synthetic-link-token"),
    });
    await linking.acceptStart({
      botIdentity: "inside",
      telegramUserId: "42",
      observedAt: new Date(),
      linkToken: {
        kind: "digest",
        digest: digestSignInSecret("synthetic-link-token"),
      },
    });
    await linking.confirm({
      accountRef: "existing-account",
      linkTransactionRef: link.linkTransactionRef,
      returnCorrelation: "synthetic-return",
    });
    const proofs: SignInResult[] = [];
    for (let index = 0; index < 2; index++) {
      const challenge = await register();
      await start(challenge, 42);
      await callback(challenge, 42);
      proofs.push(await status(challenge, true));
    }
    expect(proofs[0]).toMatchObject({
      status: "verified",
      existingLink: { accountRef: "existing-account" },
    });
    if (proofs[0]?.status !== "verified" || proofs[1]?.status !== "verified")
      throw new Error("Expected verified proofs");
    expect(proofs[0].subjectRef).toBe(proofs[1].subjectRef);
    expect(
      await database.selectFrom("platform_links").selectAll().execute(),
    ).toHaveLength(1);
  });

  it("fails closed when disabled, including already-approved requests and queued prompts", async () => {
    const challenge = await register();
    await start(challenge, 42);
    const disabled = new BotSignIn(
      database,
      { ...config, signInEnabled: false },
      { now: () => new Date() },
    );
    await disabled.decide({
      messageId: "1",
      botIdentity: "inside",
      telegramUserId: "42",
      privateChatId: "42",
      requestRef: challenge.requestRef,
      decision: "approve",
    });
    expect(await status(challenge)).toMatchObject({ status: "pending" });
    expect(
      await disabled.register({
        ...challenge.envelope,
        expiresAt: new Date(challenge.envelope.expiresAt),
      }),
    ).toEqual({ status: "disabled" });
    expect(
      await new StartResponseDeliveryQueue(database).claimNext(
        new Date(),
        false,
      ),
    ).toBeUndefined();
    await callback(challenge, 42);
    expect(
      await disabled.inspect(
        challenge.requestRef,
        challenge.browserSecret,
        true,
      ),
    ).toEqual({ status: "disabled" });
    expect(await status(challenge)).toMatchObject({ status: "approved" });
  });

  it("expires approval and consumption at the deadline using processing time, not inbox time", async () => {
    const challenge = await register();
    await start(challenge, 42);
    const deadline = new Date(challenge.envelope.expiresAt);
    const expired = new BotSignIn(database, config, { now: () => deadline });
    await expired.decide({
      messageId: "1",
      botIdentity: "inside",
      telegramUserId: "42",
      privateChatId: "42",
      requestRef: challenge.requestRef,
      decision: "approve",
    });
    expect(
      (
        await database
          .selectFrom("sign_in_requests")
          .select("state")
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("awaiting_approval");
    expect(
      await expired.inspect(
        challenge.requestRef,
        challenge.browserSecret,
        true,
      ),
    ).toEqual({ status: "expired" });
    expect(
      await new StartResponseDeliveryQueue(database).claimNext(deadline, true),
    ).toBeUndefined();
    await callback(challenge, 42);
    expect(
      await expired.inspect(
        challenge.requestRef,
        challenge.browserSecret,
        true,
      ),
    ).toEqual({ status: "expired" });
  });

  it("registers idempotently but never replaces the browser binding", async () => {
    const challenge = await register();
    expect((await request("", challenge.envelope)).json()).toMatchObject({
      status: "registered",
      confirmationCode: challenge.confirmationCode,
    });
    expect(
      (
        await request("", {
          ...challenge.envelope,
          browserSecretDigest: digestSignInSecret("another-browser"),
        })
      ).json(),
    ).toMatchObject({ status: "unavailable" });
  });
});

function newChallenge() {
  const startToken = randomBytes(26).toString("base64url");
  const browserSecret = randomBytes(32).toString("base64url");
  const requestRef = randomUUID();
  return {
    startToken,
    browserSecret,
    requestRef,
    envelope: {
      contractVersion,
      requestRef,
      startTokenDigest: digestSignInSecret(startToken),
      browserSecretDigest: digestSignInSecret(browserSecret),
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
    },
  };
}

async function register() {
  const challenge = newChallenge();
  const response = await request("", challenge.envelope);
  expect(response.statusCode).toBe(200);
  const body = response.json<{ status: string; confirmationCode: string }>();
  expect(body.status).toBe("registered");
  return { ...challenge, confirmationCode: body.confirmationCode };
}

function request(path: string, payload: Record<string, unknown>) {
  return fastify.inject({
    method: "POST",
    headers: { authorization: `Bearer ${config.signInIntegrationSecret}` },
    url: `/integrations/identity/v1/sign-in${path}`,
    payload,
  });
}

async function status(
  challenge: ReturnType<typeof newChallenge>,
  consume = false,
  browserSecret = challenge.browserSecret,
): Promise<SignInResult> {
  return (
    await request(
      `/${challenge.requestRef}/${consume ? "consume" : "status"}`,
      { contractVersion, browserSecret },
    )
  ).json<SignInResult>();
}

async function webhook(payload: Record<string, unknown>) {
  expect(
    (
      await fastify.inject({
        method: "POST",
        url: "/webhooks/telegram",
        headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
        payload,
      })
    ).statusCode,
  ).toBe(202);
  await application.get(TelegramUpdateProcessor).processAvailable();
}

function start(challenge: ReturnType<typeof newChallenge>, userId: number) {
  return webhook(
    privateStartUpdate(++updateId, userId, {
      text: `/start signin_${challenge.startToken}`,
    }),
  );
}

function decisionUpdate(
  challenge: ReturnType<typeof newChallenge>,
  userId: number,
  decision = "approve",
  options: { type?: string; isBot?: boolean } = {},
) {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: { id: userId, is_bot: options.isBot ?? false },
      message: {
        chat: { id: userId, type: options.type ?? "private" },
        message_id: 100,
      },
      data: `signin:${decision}:${challenge.requestRef}`,
    },
  };
}

function callback(
  challenge: ReturnType<typeof newChallenge>,
  userId: number,
  decision = "approve",
) {
  return webhook(decisionUpdate(challenge, userId, decision));
}

function deferred() {
  let signal = () => {};
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { promise, resolve: () => signal() };
}

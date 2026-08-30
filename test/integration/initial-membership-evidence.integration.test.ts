import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationConfig } from "../../src/config/application-config.js";
import evidenceSchema from "../../src/contracts/inside-membership-evidence-v1/schema.json" with { type: "json" };
import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import type { Clock } from "../../src/modules/identity-linking/clock.js";
import { IdentityLinking } from "../../src/modules/identity-linking/identity-linking.js";
import { InitialMembershipCheckProcessor } from "../../src/modules/membership-evidence/initial-membership-check-processor.js";
import { InitialMembershipCheckQueue } from "../../src/modules/membership-evidence/initial-membership-check-queue.js";
import { MembershipEvidenceDeliveryProcessor } from "../../src/modules/membership-evidence/membership-evidence-delivery-processor.js";
import { MembershipEvidenceOutbox } from "../../src/modules/membership-evidence/membership-evidence-outbox.js";
import { MembershipEvidenceProvider } from "../../src/modules/membership-evidence/membership-evidence-provider.js";
import { StartResponseDeliveryProcessor } from "../../src/modules/outbound/start-response-delivery-processor.js";
import { StartResponseDeliveryQueue } from "../../src/modules/outbound/start-response-delivery-queue.js";
import type {
  TelegramDeliveryResult,
  TelegramMessages,
  TelegramTextMessage,
} from "../../src/modules/outbound/telegram-messages.js";
import { RuntimeMetrics } from "../../src/operations/runtime-metrics.js";
import type {
  PlatformEvidenceDelivery,
  PlatformEvidenceDeliveryRequest,
} from "../../src/modules/membership-evidence/platform-evidence-delivery.js";
import type {
  TelegramChatMemberResult,
  TelegramMembership,
} from "../../src/modules/membership-evidence/telegram-membership.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const now = new Date("2030-01-01T00:00:00.000Z");
const ajv = new Ajv2020.default({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
addFormats.default(ajv);
const validateEvidence = ajv.compile(evidenceSchema);
const clock: Clock = { now: () => now };
const config: ApplicationConfig = {
  botIdentity: "inside",
  canonicalChatId: "-1000000000000",
  databaseUrl,
  deliveryMode: "disabled",
  evidenceDeliveryMode: "disabled",
  host: "127.0.0.1",
  linkReceiptText: "Synthetic link receipt",
  linkedMemberText: "Membership check sent to Platform.",
  linkedNonMemberText: "Telegram linked; Membership is not active.",
  linkedUnavailableText: "Telegram linked; Membership check is unavailable.",
  membershipMode: "disabled",
  platformIntegrationSecret: "synthetic_platform_secret",
  port: 3002,
  webhookSecret: "synthetic_webhook_secret",
  welcomeText: "Synthetic welcome",
  workersEnabled: false,
};

let database: Database;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
});

beforeEach(async () => {
  await sql`
    truncate table
      membership_evidence_outbox,
      membership_observations,
      membership_checks,
      membership_provider_state,
      identity_link_events,
      platform_links,
      link_transactions,
      start_response_delivery_attempts,
      start_response_deliveries,
      bot_contact_events,
      bot_contacts,
      telegram_updates
    restart identity cascade
  `.execute(database);
});

afterAll(async () => {
  await database.destroy();
});

describe("initial Membership Evidence", () => {
  it("rebuilds its migration down and forward", async () => {
    const { migrateDown } = await import("../../src/database/migrator.js");
    await migrateDown(database);
    const removed = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public'
          and table_name = 'membership_evidence_outbox'
      ) as exists
    `.execute(database);
    expect(removed.rows[0]?.exists).toBe(false);

    await migrateToLatest(database);
    const restored = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public'
          and table_name = 'membership_evidence_outbox'
      ) as exists
    `.execute(database);
    expect(restored.rows[0]?.exists).toBe(true);
  });

  it("checks a confirmed link and asynchronously delivers fresh member evidence", async () => {
    const confirmation = await confirmLink("42");
    const telegram = new ControlledTelegramMembership(
      { kind: "observed", value: { status: "administrator" } },
      { kind: "observed", value: { status: "member" } },
    );
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const checks = new InitialMembershipCheckProcessor(
      new InitialMembershipCheckQueue(database),
      provider,
    );

    const outcome = await checks.processNext(now);

    expect(outcome).toEqual({
      evidence: {
        checkedAt: "2030-01-01T00:00:00.000Z",
        contractVersion: "inside.membership-evidence.v1",
        decision: "member",
        evidenceRef: expect.any(String),
        evidenceVersion: 1,
        principalRef: "account-ref-a",
        reasonCode: "chat_member",
        telegramIdentityRef: confirmation.telegramIdentityRef,
        validUntil: "2030-01-01T00:05:00.000Z",
      },
      providerState: "ready",
      responsePlanned: true,
    });
    expect(validateEvidence(outcome?.evidence)).toBe(true);
    expect(telegram.subjectRequests).toEqual([
      { chatId: config.canonicalChatId, telegramUserId: "42" },
    ]);

    const platform = new ControlledPlatformEvidenceDelivery();
    const deliveries = new MembershipEvidenceDeliveryProcessor(
      new MembershipEvidenceOutbox(database),
      platform,
    );
    await expect(deliveries.processNext(now)).resolves.toBe("delivered");
    await expect(deliveries.processNext(now)).resolves.toBeUndefined();
    expect(platform.requests).toHaveLength(1);
    expect(platform.requests[0]?.evidence).toEqual(outcome?.evidence);
    expect(platform.requests[0]?.evidence).not.toHaveProperty("telegramUserId");
    expect(platform.requests[0]?.evidence).not.toHaveProperty("rawStatus");

    const messages = new ControlledTelegramMessages();
    const responses = new StartResponseDeliveryProcessor(
      new StartResponseDeliveryQueue(database),
      messages,
      new RuntimeMetrics(),
    );
    await expect(responses.processAvailable(10, now)).resolves.toBe(2);
    expect(messages.sent.map((message) => message.text)).toEqual([
      config.linkReceiptText,
      config.linkedMemberText,
    ]);
  });

  it.each([
    [
      { kind: "observed", value: { status: "left" } },
      "not_member",
      "chat_not_member",
      "ready",
      config.linkedNonMemberText,
    ],
    [
      { kind: "observed", value: { status: "future_status" } },
      "unavailable",
      "provider_unavailable",
      "unavailable",
      config.linkedUnavailableText,
    ],
    [
      { diagnosticCode: "telegram_api_unavailable", kind: "unavailable" },
      "unavailable",
      "provider_unavailable",
      "unavailable",
      config.linkedUnavailableText,
    ],
  ] as const)(
    "maps link-time result %o to %s evidence",
    async (
      subjectResult,
      decision,
      reasonCode,
      providerState,
      responseText,
    ) => {
      const confirmation = await confirmLink("42");
      const telegram = new ControlledTelegramMembership(
        { kind: "observed", value: { status: "administrator" } },
        subjectResult,
      );
      const provider = new MembershipEvidenceProvider(
        database,
        config,
        clock,
        telegram,
      );

      const outcome = await provider.observe({
        checkRef: "controlled-check-a",
        telegramIdentityRef: confirmation.telegramIdentityRef,
      });

      expect(outcome.evidence).toMatchObject({ decision, reasonCode });
      expect(validateEvidence(outcome.evidence)).toBe(true);
      expect(outcome.providerState).toBe(providerState);
      expect(outcome.responsePlanned).toBe(true);
      expect(outcome.evidence).not.toHaveProperty(
        decision === "unavailable" ? "evidenceVersion" : "missing",
      );
      expect(telegram.subjectRequests).toHaveLength(1);

      const messages = new ControlledTelegramMessages();
      await new StartResponseDeliveryProcessor(
        new StartResponseDeliveryQueue(database),
        messages,
        new RuntimeMetrics(),
      ).processAvailable(10, now);
      expect(messages.sent.at(-1)?.text).toBe(responseText);
    },
  );

  it("fails closed before checking the subject when the bot is not administrator", async () => {
    const confirmation = await confirmLink("42");
    const telegram = new ControlledTelegramMembership(
      { kind: "observed", value: { status: "member" } },
      { kind: "observed", value: { status: "member" } },
    );
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );

    const outcome = await provider.observe({
      checkRef: "admin-loss-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });

    expect(outcome).toMatchObject({
      evidence: {
        decision: "unavailable",
        reasonCode: "provider_unavailable",
      },
      providerState: "degraded",
    });
    expect(telegram.subjectRequests).toHaveLength(0);
  });

  it("allocates monotonic revisions for concurrent observations", async () => {
    const confirmation = await confirmLink("42");
    const telegram = new ControlledTelegramMembership(
      { kind: "observed", value: { status: "administrator" } },
      { kind: "observed", value: { status: "member" } },
    );
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );

    const outcomes = await Promise.all([
      provider.observe({
        checkRef: "concurrent-check-a",
        telegramIdentityRef: confirmation.telegramIdentityRef,
      }),
      provider.observe({
        checkRef: "concurrent-check-b",
        telegramIdentityRef: confirmation.telegramIdentityRef,
      }),
    ]);

    expect(
      outcomes
        .map((outcome) =>
          "evidenceVersion" in outcome.evidence
            ? outcome.evidence.evidenceVersion
            : undefined,
        )
        .sort(),
    ).toEqual([1, 2]);
  });

  it("retries the exact evidence delivery with one idempotency key", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(
        { kind: "observed", value: { status: "administrator" } },
        { kind: "observed", value: { status: "member" } },
      ),
    );
    await provider.observe({
      checkRef: "retry-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    const platform = new ControlledPlatformEvidenceDelivery([
      { diagnosticCode: "platform_unavailable", kind: "retryable" },
      { kind: "delivered" },
    ]);
    const deliveries = new MembershipEvidenceDeliveryProcessor(
      new MembershipEvidenceOutbox(database),
      platform,
    );

    await expect(deliveries.processNext(now)).resolves.toBe("retryable");
    await expect(
      deliveries.processNext(new Date(now.getTime() + 999)),
    ).resolves.toBeUndefined();
    await expect(
      deliveries.processNext(new Date(now.getTime() + 1000)),
    ).resolves.toBe("delivered");

    expect(platform.requests).toHaveLength(2);
    expect(platform.requests[0]?.idempotencyKey).toBe(
      platform.requests[1]?.idempotencyKey,
    );
    expect(platform.requests[0]?.evidence).toEqual(
      platform.requests[1]?.evidence,
    );
  });
});

async function confirmLink(telegramUserId: string) {
  const contacts = new BotContacts(database, config);
  await contacts.observeStart(
    {
      botIdentity: config.botIdentity,
      observedAt: now,
      privateChatId: telegramUserId,
      telegramUserId,
      updateId: "1",
    },
    "link-receipt",
  );
  const linking = new IdentityLinking(database, clock);
  const challenge = await linking.register({
    accountRef: "account-ref-a",
    expiresAt: new Date(now.getTime() + 60_000),
    returnCorrelation: "return-ref-a",
    tokenDigest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
  });
  await linking.acceptStart({
    botIdentity: config.botIdentity,
    linkToken: {
      digest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
      kind: "digest",
    },
    observedAt: now,
    telegramUserId,
  });
  const confirmation = await linking.confirm({
    accountRef: "account-ref-a",
    linkTransactionRef: challenge.linkTransactionRef,
    returnCorrelation: "return-ref-a",
  });
  if (
    confirmation.status !== "linked" &&
    confirmation.status !== "idempotent"
  ) {
    throw new Error(`Expected linked outcome, got ${confirmation.status}`);
  }
  return confirmation;
}

class ControlledTelegramMembership implements TelegramMembership {
  readonly subjectRequests: Array<{
    chatId: string;
    telegramUserId: string;
  }> = [];

  constructor(
    private readonly botResult: TelegramChatMemberResult,
    private readonly subjectResult: TelegramChatMemberResult,
  ) {}

  async getBotChatMember(): Promise<TelegramChatMemberResult> {
    return this.botResult;
  }

  async getChatMember(
    chatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatMemberResult> {
    this.subjectRequests.push({ chatId, telegramUserId });
    return this.subjectResult;
  }
}

class ControlledPlatformEvidenceDelivery implements PlatformEvidenceDelivery {
  readonly requests: PlatformEvidenceDeliveryRequest[] = [];

  constructor(
    private readonly results: Array<
      | { diagnosticCode: string; kind: "rejected" | "retryable" }
      | { kind: "delivered" }
    > = [{ kind: "delivered" }],
  ) {}

  async deliver(
    request: PlatformEvidenceDeliveryRequest,
  ): Promise<
    | { diagnosticCode: string; kind: "rejected" | "retryable" }
    | { kind: "delivered" }
  > {
    this.requests.push(request);
    return this.results.shift() ?? { kind: "delivered" };
  }
}

class ControlledTelegramMessages implements TelegramMessages {
  readonly sent: TelegramTextMessage[] = [];

  async sendText(
    message: TelegramTextMessage,
  ): Promise<TelegramDeliveryResult> {
    this.sent.push(message);
    return {
      kind: "delivered",
      providerMessageId: String(this.sent.length),
    };
  }
}

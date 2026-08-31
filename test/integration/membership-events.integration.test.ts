import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { BotContacts } from "../../src/modules/bot-contacts/bot-contacts.js";
import type { Clock } from "../../src/modules/identity-linking/clock.js";
import { IdentityLinking } from "../../src/modules/identity-linking/identity-linking.js";
import { MembershipEvidenceProvider } from "../../src/modules/membership-evidence/membership-evidence-provider.js";
import { MembershipEvidenceDeliveryProcessor } from "../../src/modules/membership-evidence/membership-evidence-delivery-processor.js";
import { MembershipEvidenceOutbox } from "../../src/modules/membership-evidence/membership-evidence-outbox.js";
import type {
  PlatformEvidenceDelivery,
  PlatformEvidenceDeliveryRequest,
} from "../../src/modules/membership-evidence/platform-evidence-delivery.js";
import type {
  TelegramChatMemberResult,
  TelegramMembership,
} from "../../src/modules/membership-evidence/telegram-membership.js";
import { TelegramUpdateInbox } from "../../src/modules/update-inbox/telegram-update-inbox.js";
import { TelegramUpdateProcessor } from "../../src/modules/update-inbox/telegram-update-processor.js";
import { TelegramWebhook } from "../../src/modules/webhook/telegram-webhook.js";
import { RuntimeMetrics } from "../../src/operations/runtime-metrics.js";
import { canonicalMembershipUpdate } from "../support/synthetic-telegram-updates.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const linkedAt = new Date("2030-01-01T00:00:00.000Z");
const clock: Clock = { now: () => linkedAt };
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
      membership_event_audit,
      membership_check_results,
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

describe("durable Membership events", () => {
  it("rebuilds the durable event migration down and forward", async () => {
    const { migrateDown } = await import("../../src/database/migrator.js");
    await migrateDown(database);
    const removed = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public'
          and table_name = 'membership_event_audit'
      ) as exists
    `.execute(database);
    expect(removed.rows[0]?.exists).toBe(false);

    await migrateToLatest(database);
    const restored = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public'
          and table_name = 'membership_event_audit'
      ) as exists
    `.execute(database);
    expect(restored.rows[0]?.exists).toBe(true);
  });

  it("issues a newer non-member evidence after canonical removal", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    const initial = await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    expect(initial.evidence).toMatchObject({
      decision: "member",
      evidenceVersion: 1,
    });

    const removal = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "left" },
      eventAt: new Date("2030-01-01T00:01:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "9001",
    });

    expect(removal?.evidence).toMatchObject({
      checkedAt: "2030-01-01T00:01:00.000Z",
      decision: "not_member",
      evidenceVersion: 2,
      reasonCode: "chat_not_member",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    expect(removal?.responsePlanned).toBe(false);
  });

  it("ignores delayed events without treating update_id as the business version", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });

    const removal = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "left" },
      eventAt: new Date("2030-01-01T00:02:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "9001",
    });
    expect(removal?.evidence).toMatchObject({ evidenceVersion: 2 });

    await expect(
      provider.accept({
        actorIsSubject: true,
        botIdentity: config.botIdentity,
        canonicalChatId: config.canonicalChatId,
        chatMember: { status: "member" },
        eventAt: new Date("2030-01-01T00:01:00.000Z"),
        kind: "subject",
        subjectTelegramUserId: "42",
        updateId: "9002",
      }),
    ).resolves.toBeUndefined();

    const rejoin = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-08T00:00:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "10",
    });
    expect(rejoin?.evidence).toMatchObject({
      decision: "member",
      evidenceVersion: 3,
    });

    const duplicate = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-08T00:00:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "10",
    });
    expect(duplicate?.evidence).toEqual(rejoin?.evidence);

    const audit = await sql<{
      actor_is_subject: boolean | null;
      disposition: string;
      subject_linked: boolean | null;
      update_id: string;
    }>`
      select
        actor_is_subject,
        disposition,
        subject_linked,
        update_id::text as update_id
      from membership_event_audit
      order by event_at, update_id
    `.execute(database);
    expect(audit.rows).toEqual([
      {
        actor_is_subject: true,
        disposition: "ignored_older",
        subject_linked: true,
        update_id: "9002",
      },
      {
        actor_is_subject: false,
        disposition: "evidence",
        subject_linked: true,
        update_id: "9001",
      },
      {
        actor_is_subject: true,
        disposition: "evidence",
        subject_linked: true,
        update_id: "10",
      },
    ]);
  });

  it("blocks positive evidence after admin loss until a newer recovery", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });

    await provider.accept({
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-01T00:02:00.000Z"),
      kind: "provider",
      updateId: "200",
    });
    const blockedPositive = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-01T00:03:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "201",
    });
    expect(blockedPositive).toMatchObject({
      evidence: { decision: "unavailable" },
      providerState: "degraded",
    });
    expect(blockedPositive?.evidence).not.toHaveProperty("evidenceVersion");

    const removal = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "left" },
      eventAt: new Date("2030-01-01T00:04:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "202",
    });
    expect(removal).toMatchObject({
      evidence: { decision: "not_member", evidenceVersion: 2 },
      providerState: "degraded",
    });

    await provider.accept({
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "administrator" },
      eventAt: new Date("2030-01-01T00:01:00.000Z"),
      kind: "provider",
      updateId: "203",
    });
    await provider.accept({
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "administrator" },
      eventAt: new Date("2030-01-01T00:05:00.000Z"),
      kind: "provider",
      updateId: "10",
    });
    const recovered = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-01T00:06:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "11",
    });
    expect(recovered).toMatchObject({
      evidence: { decision: "member", evidenceVersion: 3 },
      providerState: "ready",
    });
  });

  it("routes an authenticated durable update to evidence exactly once", async () => {
    const confirmation = await confirmLink("42");
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    const platform = new ControlledPlatformEvidenceDelivery();
    const deliveries = new MembershipEvidenceDeliveryProcessor(
      new MembershipEvidenceOutbox(database),
      platform,
    );
    await deliveries.processNext(linkedAt);

    const inbox = new TelegramUpdateInbox(database);
    const metrics = new RuntimeMetrics();
    const linking = new IdentityLinking(database, clock);
    const processor = new TelegramUpdateProcessor(
      inbox,
      new BotContacts(database, config),
      linking,
      metrics,
      provider,
    );
    const webhook = new TelegramWebhook(config, inbox, metrics);
    const update = canonicalMembershipUpdate(
      9001,
      -1_000_000_000_000,
      42,
      "left",
      { date: 1_893_456_060 },
    );

    await webhook.accept(config.webhookSecret, update);
    await expect(processor.processAvailable(10, linkedAt)).resolves.toBe(1);
    await expect(
      deliveries.processNext(new Date("2030-01-01T00:01:00.000Z")),
    ).resolves.toBe("delivered");
    expect(platform.requests.at(-1)?.evidence).toMatchObject({
      decision: "not_member",
      evidenceVersion: 2,
    });

    await webhook.accept(config.webhookSecret, update);
    await expect(processor.processAvailable(10, linkedAt)).resolves.toBe(0);
    await expect(
      deliveries.processNext(new Date("2030-01-01T00:01:00.000Z")),
    ).resolves.toBeUndefined();
  });

  it("audits an unlinked subject without persisting actor or subject identity", async () => {
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );

    await expect(
      provider.accept({
        actorIsSubject: false,
        botIdentity: config.botIdentity,
        canonicalChatId: config.canonicalChatId,
        chatMember: { status: "member" },
        eventAt: new Date("2030-01-01T00:07:00.000Z"),
        kind: "subject",
        subjectTelegramUserId: "99",
        updateId: "700",
      }),
    ).resolves.toBeUndefined();

    const audit = await sql<{
      actor_is_subject: boolean | null;
      disposition: string;
      subject_linked: boolean | null;
    }>`
      select actor_is_subject, disposition, subject_linked
      from membership_event_audit
      where bot_identity = ${config.botIdentity} and update_id = 700
    `.execute(database);
    expect(audit.rows).toEqual([
      {
        actor_is_subject: false,
        disposition: "unlinked_subject",
        subject_linked: false,
      },
    ]);
    const identityColumns = await sql<{ column_name: string }>`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'membership_event_audit'
        and column_name like '%telegram%id%'
    `.execute(database);
    expect(identityColumns.rows).toEqual([]);
    const links = await sql<{ count: string }>`
      select count(*)::text as count
      from platform_links
      where telegram_user_id = 99
    `.execute(database);
    expect(links.rows[0]?.count).toBe("0");
  });

  it("uses the shared restriction and unknown normalization for event sequences", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });

    const restrictedOutside = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { isMember: false, status: "restricted" },
      eventAt: new Date("2030-01-01T00:08:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "800",
    });
    expect(restrictedOutside?.evidence).toMatchObject({
      decision: "not_member",
      evidenceVersion: 2,
    });

    const restrictedInside = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { isMember: true, status: "restricted" },
      eventAt: new Date("2030-01-01T00:09:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "801",
    });
    expect(restrictedInside?.evidence).toMatchObject({
      decision: "member",
      evidenceVersion: 3,
    });

    const unknown = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "future_status" },
      eventAt: new Date("2030-01-01T00:10:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "802",
    });
    expect(unknown?.evidence).toEqual({
      contractVersion: "inside.membership-evidence.v1",
      decision: "unavailable",
      principalRef: "account-ref-a",
      reasonCode: "provider_unavailable",
    });
  });

  it("serializes concurrent same-second events by their ingress tie-breaker", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    const eventAt = new Date("2030-01-01T00:11:00.000Z");
    await Promise.all([
      provider.accept({
        actorIsSubject: false,
        botIdentity: config.botIdentity,
        canonicalChatId: config.canonicalChatId,
        chatMember: { status: "left" },
        eventAt,
        kind: "subject",
        subjectTelegramUserId: "42",
        updateId: "900",
      }),
      provider.accept({
        actorIsSubject: true,
        botIdentity: config.botIdentity,
        canonicalChatId: config.canonicalChatId,
        chatMember: { status: "member" },
        eventAt,
        kind: "subject",
        subjectTelegramUserId: "42",
        updateId: "901",
      }),
    ]);

    const latest = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt,
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "901",
    });
    expect(latest?.evidence).toMatchObject({ decision: "member" });
    if (!latest || !("evidenceVersion" in latest.evidence)) {
      throw new Error("Expected current member evidence");
    }

    const next = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "left" },
      eventAt: new Date("2030-01-01T00:12:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "1",
    });
    expect(next?.evidence).toMatchObject({
      decision: "not_member",
      evidenceVersion: latest.evidence.evidenceVersion + 1,
    });
  });

  it("does not let a delayed event overwrite a newer direct observation", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "left" },
      eventAt: new Date("2030-01-01T00:13:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "1300",
    });

    const reconciled = await new MembershipEvidenceProvider(
      database,
      config,
      { now: () => new Date("2030-01-01T00:15:00.000Z") },
      new ControlledTelegramMembership(),
    ).observe({
      checkRef: "reconciliation-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    expect(reconciled.evidence).toMatchObject({
      decision: "member",
      evidenceVersion: 3,
    });

    await expect(
      provider.accept({
        actorIsSubject: false,
        botIdentity: config.botIdentity,
        canonicalChatId: config.canonicalChatId,
        chatMember: { status: "left" },
        eventAt: new Date("2030-01-01T00:14:00.000Z"),
        kind: "subject",
        subjectTelegramUserId: "42",
        updateId: "1301",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not let a stale direct response overwrite a newer event", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    const removal = await provider.accept({
      actorIsSubject: false,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "left" },
      eventAt: new Date("2030-01-01T00:20:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "2000",
    });
    expect(removal?.evidence).toMatchObject({
      decision: "not_member",
      evidenceVersion: 2,
    });

    const staleDirect = await new MembershipEvidenceProvider(
      database,
      config,
      { now: () => new Date("2030-01-01T00:19:00.000Z") },
      new ControlledTelegramMembership(),
    ).observe({
      checkRef: "stale-reconciliation-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    expect(staleDirect.evidence).toEqual(removal?.evidence);
  });

  it("cancels a pending positive that was observed after delayed admin loss", async () => {
    const confirmation = await confirmLink("42");
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      new ControlledTelegramMembership(),
    );
    await provider.observe({
      checkRef: "initial-check",
      telegramIdentityRef: confirmation.telegramIdentityRef,
    });
    const platform = new ControlledPlatformEvidenceDelivery();
    const deliveries = new MembershipEvidenceDeliveryProcessor(
      new MembershipEvidenceOutbox(database),
      platform,
    );
    await deliveries.processNext(linkedAt);

    const positive = await provider.accept({
      actorIsSubject: true,
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-01T00:17:00.000Z"),
      kind: "subject",
      subjectTelegramUserId: "42",
      updateId: "1701",
    });
    expect(positive?.evidence).toMatchObject({
      decision: "member",
      evidenceVersion: 2,
    });

    await provider.accept({
      botIdentity: config.botIdentity,
      canonicalChatId: config.canonicalChatId,
      chatMember: { status: "member" },
      eventAt: new Date("2030-01-01T00:16:00.000Z"),
      kind: "provider",
      updateId: "1700",
    });

    await expect(
      deliveries.processNext(new Date("2030-01-01T00:18:00.000Z")),
    ).resolves.toBeUndefined();
    expect(platform.requests).toHaveLength(1);
  });
});

async function confirmLink(telegramUserId: string) {
  await new BotContacts(database, config).observeStart(
    {
      botIdentity: config.botIdentity,
      observedAt: linkedAt,
      privateChatId: telegramUserId,
      telegramUserId,
      updateId: "1",
    },
    "link-receipt",
  );
  const linking = new IdentityLinking(database, clock);
  const challenge = await linking.register({
    accountRef: "account-ref-a",
    expiresAt: new Date(linkedAt.getTime() + 60_000),
    returnCorrelation: "return-ref-a",
    tokenDigest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
  });
  await linking.acceptStart({
    botIdentity: config.botIdentity,
    linkToken: {
      digest: "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8",
      kind: "digest",
    },
    observedAt: linkedAt,
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
  async getBotChatMember(): Promise<TelegramChatMemberResult> {
    return { kind: "observed", value: { status: "administrator" } };
  }

  async getChatMember(): Promise<TelegramChatMemberResult> {
    return { kind: "observed", value: { status: "member" } };
  }
}

class ControlledPlatformEvidenceDelivery implements PlatformEvidenceDelivery {
  readonly requests: PlatformEvidenceDeliveryRequest[] = [];

  async deliver(
    request: PlatformEvidenceDeliveryRequest,
  ): Promise<{ kind: "delivered" }> {
    this.requests.push(request);
    return { kind: "delivered" };
  }
}

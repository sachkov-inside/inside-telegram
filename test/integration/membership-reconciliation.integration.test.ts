import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateDown, migrateToLatest } from "../../src/database/migrator.js";
import type { Clock } from "../../src/modules/identity-linking/clock.js";
import { MembershipEvidenceProvider } from "../../src/modules/membership-evidence/membership-evidence-provider.js";
import type {
  TelegramChatMemberResult,
  TelegramMembership,
} from "../../src/modules/membership-evidence/telegram-membership.js";
import { RuntimeMetrics } from "../../src/operations/runtime-metrics.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const linkedAt = new Date("2030-01-01T00:00:00.000Z");
const cadenceMilliseconds = 4 * 60_000;
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
  membershipReconciliationCadenceMilliseconds: cadenceMilliseconds,
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
      membership_reconciliations,
      membership_evidence_outbox,
      membership_event_audit,
      membership_check_results,
      membership_checks,
      membership_provider_observations,
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

describe("durable Membership reconciliation", () => {
  it("rebuilds its migration down and forward", async () => {
    await migrateDown(database);
    const removed = await tableExists("membership_reconciliations");
    expect(removed).toBe(false);

    await migrateToLatest(database);
    await expect(tableExists("membership_reconciliations")).resolves.toBe(true);
  });

  it("refreshes every link on a configurable cadence before evidence expiry", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const identityRef = await seedLinkedMember(provider, telegram, clock, 1);

    clock.set(new Date("2030-01-01T00:03:59.999Z"));
    await expect(
      provider.reconcileDue({ maxDurationMs: 1000, maxItems: 10 }, clock),
    ).resolves.toMatchObject({ processed: 0, stoppedReason: "empty" });

    clock.set(new Date("2030-01-01T00:04:00.000Z"));
    const refreshed = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 10 },
      clock,
    );
    expect(refreshed).toMatchObject({
      dueRemaining: 0,
      failed: 0,
      processed: 1,
      stoppedReason: "empty",
      succeeded: 1,
    });
    const result = await database
      .selectFrom("membership_check_results")
      .select(["evidence_version", "normalized_state", "observed_at"])
      .where("telegram_identity_ref", "=", identityRef)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(result).toEqual({
      evidence_version: "2",
      normalized_state: "member",
      observed_at: new Date("2030-01-01T00:04:00.000Z"),
    });
    const schedule = await database
      .selectFrom("membership_reconciliations")
      .select(["attempt_count", "due_at", "state"])
      .where("telegram_identity_ref", "=", identityRef)
      .executeTakeFirstOrThrow();
    expect(schedule).toEqual({
      attempt_count: 0,
      due_at: new Date("2030-01-01T00:08:00.000Z"),
      state: "pending",
    });
    const responses = await database
      .selectFrom("start_response_deliveries")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(responses.count).toBe("1");
  });

  it("repairs a missed removal and later rejoin with monotonic revisions", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const identityRef = await seedLinkedMember(provider, telegram, clock, 2);

    telegram.members.set("102", {
      kind: "observed",
      value: { status: "left" },
    });
    clock.set(new Date("2030-01-01T00:04:00.000Z"));
    await provider.reconcileDue({ maxDurationMs: 1000, maxItems: 1 }, clock);

    telegram.members.set("102", {
      kind: "observed",
      value: { status: "member" },
    });
    clock.set(new Date("2030-01-01T00:08:00.000Z"));
    await provider.reconcileDue({ maxDurationMs: 1000, maxItems: 1 }, clock);

    const results = await database
      .selectFrom("membership_check_results")
      .select(["evidence_version", "normalized_state"])
      .where("telegram_identity_ref", "=", identityRef)
      .orderBy("id")
      .execute();
    expect(results).toEqual([
      { evidence_version: "1", normalized_state: "member" },
      { evidence_version: "2", normalized_state: "non_member" },
      { evidence_version: "3", normalized_state: "member" },
    ]);
  });

  it("fails an outage closed without extending positive freshness and recovers", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const identityRef = await seedLinkedMember(provider, telegram, clock, 3);

    telegram.members.set("103", {
      diagnosticCode: "telegram_api_unavailable",
      kind: "unavailable",
    });
    clock.set(new Date("2030-01-01T00:04:00.000Z"));
    const failed = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    expect(failed).toMatchObject({ degraded: 1, failed: 1, succeeded: 0 });
    const afterFailure = await database
      .selectFrom("platform_links")
      .select(["evidence_version", "last_membership_observation_at"])
      .where("telegram_identity_ref", "=", identityRef)
      .executeTakeFirstOrThrow();
    expect(afterFailure).toEqual({
      evidence_version: "1",
      last_membership_observation_at: linkedAt,
    });
    const retry = await database
      .selectFrom("membership_reconciliations")
      .select("due_at")
      .where("telegram_identity_ref", "=", identityRef)
      .executeTakeFirstOrThrow();
    expect(retry.due_at).toEqual(new Date("2030-01-01T00:04:15.000Z"));

    telegram.members.set("103", {
      kind: "observed",
      value: { status: "member" },
    });
    clock.set(retry.due_at);
    const recovered = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    expect(recovered).toMatchObject({ failed: 0, succeeded: 1 });
    const link = await database
      .selectFrom("platform_links")
      .select("evidence_version")
      .where("telegram_identity_ref", "=", identityRef)
      .executeTakeFirstOrThrow();
    expect(link.evidence_version).toBe("2");
  });

  it("reports a lost administrator prerequisite as degraded without reading the subject", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    await seedLinkedMember(provider, telegram, clock, 30);
    telegram.subjectCalls = 0;
    telegram.provider = {
      kind: "observed",
      value: { status: "member" },
    };
    clock.set(new Date("2030-01-01T00:04:00.000Z"));

    const degraded = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    expect(degraded).toMatchObject({ degraded: 1, failed: 1, succeeded: 0 });
    expect(telegram.subjectCalls).toBe(0);
  });

  it("continues to later due links after an unavailable result", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    await seedLinkedMember(provider, telegram, clock, 20);
    await seedLinkedMember(provider, telegram, clock, 21);
    telegram.members.set("120", {
      diagnosticCode: "telegram_api_unavailable",
      kind: "unavailable",
    });
    clock.set(new Date("2030-01-01T00:04:00.000Z"));

    const batch = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 2 },
      clock,
    );
    expect(batch).toMatchObject({
      dueRemaining: 0,
      failed: 1,
      processed: 2,
      succeeded: 1,
    });
  });

  it("backs off unavailable retries at 15, 30 and capped 60 second intervals", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const identityRef = await seedLinkedMember(provider, telegram, clock, 31);
    telegram.members.set("131", {
      diagnosticCode: "telegram_api_unavailable",
      kind: "unavailable",
    });

    const dueSequence = [
      ["2030-01-01T00:04:00.000Z", "2030-01-01T00:04:15.000Z"],
      ["2030-01-01T00:04:15.000Z", "2030-01-01T00:04:45.000Z"],
      ["2030-01-01T00:04:45.000Z", "2030-01-01T00:05:45.000Z"],
      ["2030-01-01T00:05:45.000Z", "2030-01-01T00:06:45.000Z"],
    ] as const;
    for (const [attemptedAt, expectedDueAt] of dueSequence) {
      clock.set(new Date(attemptedAt));
      const outcome = await provider.reconcileDue(
        { maxDurationMs: 1000, maxItems: 1 },
        clock,
      );
      expect(outcome.failed).toBe(1);
      const schedule = await database
        .selectFrom("membership_reconciliations")
        .select("due_at")
        .where("telegram_identity_ref", "=", identityRef)
        .executeTakeFirstOrThrow();
      expect(schedule.due_at).toEqual(new Date(expectedDueAt));
    }
    const responses = await database
      .selectFrom("start_response_deliveries")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(responses.count).toBe("1");
  });

  it("gives one parallel worker the due lease", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    await seedLinkedMember(provider, telegram, clock, 4);
    telegram.subjectCalls = 0;
    clock.set(new Date("2030-01-01T00:04:00.000Z"));

    const batches = await Promise.all([
      provider.reconcileDue({ maxDurationMs: 1000, maxItems: 1 }, clock),
      provider.reconcileDue({ maxDurationMs: 1000, maxItems: 1 }, clock),
    ]);
    expect(batches.reduce((sum, batch) => sum + batch.processed, 0)).toBe(1);
    expect(telegram.subjectCalls).toBe(1);
  });

  it("recovers an expired lease after restart but not an active lease", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const identityRef = await seedLinkedMember(provider, telegram, clock, 5);
    clock.set(new Date("2030-01-01T00:03:00.000Z"));
    await provider.reconcileDue({ maxDurationMs: 1000, maxItems: 1 }, clock);
    await database
      .updateTable("membership_reconciliations")
      .set({
        lease_token: "synthetic-abandoned-lease",
        locked_at: new Date("2030-01-01T00:04:00.000Z"),
        state: "processing",
      })
      .where("telegram_identity_ref", "=", identityRef)
      .execute();

    clock.set(new Date("2030-01-01T00:04:59.999Z"));
    const active = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    expect(active.processed).toBe(0);

    clock.set(new Date("2030-01-01T00:05:00.001Z"));
    const recovered = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    expect(recovered).toMatchObject({ processed: 1, recoveredLeases: 1 });
  });

  it("fences a resumed stale worker from the replacement lease", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new PausingTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    const identityRef = await seedLinkedMember(provider, telegram, clock, 32);

    const firstRead = telegram.pauseNext({
      kind: "observed",
      value: { status: "member" },
    });
    clock.set(new Date("2030-01-01T00:04:00.000Z"));
    const staleWorker = provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    await firstRead.started;

    const replacementRead = telegram.pauseNext({
      kind: "observed",
      value: { status: "left" },
    });
    clock.set(new Date("2030-01-01T00:05:00.001Z"));
    const replacementWorker = provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 1 },
      clock,
    );
    await replacementRead.started;

    firstRead.resume();
    await expect(staleWorker).resolves.toMatchObject({
      failed: 1,
      processed: 1,
      succeeded: 0,
    });
    const replacementLease = await database
      .selectFrom("membership_reconciliations")
      .select(["attempt_count", "lease_token", "state"])
      .where("telegram_identity_ref", "=", identityRef)
      .executeTakeFirstOrThrow();
    expect(replacementLease).toMatchObject({
      attempt_count: 2,
      state: "processing",
    });
    expect(replacementLease.lease_token).not.toBeNull();

    replacementRead.resume();
    await replacementWorker;
    const completed = await database
      .selectFrom("membership_reconciliations")
      .select(["attempt_count", "lease_token", "state"])
      .where("telegram_identity_ref", "=", identityRef)
      .executeTakeFirstOrThrow();
    expect(completed).toEqual({
      attempt_count: 0,
      lease_token: null,
      state: "pending",
    });
    const latestEvidence = await database
      .selectFrom("membership_check_results")
      .select(["evidence_version", "normalized_state"])
      .where("telegram_identity_ref", "=", identityRef)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(latestEvidence).toEqual({
      evidence_version: "2",
      normalized_state: "non_member",
    });
  });

  it("bounds a hanging Telegram read by the remaining elapsed-time budget", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new PausingTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    await seedLinkedMember(provider, telegram, clock, 33);
    const hangingRead = telegram.pauseNext({
      kind: "observed",
      value: { status: "member" },
    });
    clock.set(new Date("2030-01-01T00:04:00.000Z"));

    const startedAt = Date.now();
    const outcome = await provider.reconcileDue(
      { maxDurationMs: 50, maxItems: 1 },
      clock,
    );
    const elapsedMilliseconds = Date.now() - startedAt;
    hangingRead.resume();
    expect(outcome).toMatchObject({ failed: 1, processed: 1 });
    expect(elapsedMilliseconds).toBeLessThan(500);
  });

  it("honours item and time budgets without starving the remaining links", async () => {
    const clock = new MutableClock(linkedAt);
    const telegram = new ControlledTelegramMembership();
    const provider = new MembershipEvidenceProvider(
      database,
      config,
      clock,
      telegram,
    );
    for (const index of [6, 7, 8]) {
      await seedLinkedMember(provider, telegram, clock, index);
    }
    clock.set(new Date("2030-01-01T00:04:00.000Z"));

    const limited = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 2 },
      clock,
    );
    expect(limited).toMatchObject({
      dueRemaining: 1,
      processed: 2,
      stoppedReason: "item_limit",
    });
    const remainder = await provider.reconcileDue(
      { maxDurationMs: 1000, maxItems: 2 },
      clock,
    );
    expect(remainder).toMatchObject({ dueRemaining: 0, processed: 1 });

    clock.set(new Date("2030-01-01T00:08:00.000Z"));
    const advancingClock = new AdvancingClock(clock.now(), 1000);
    const timed = await provider.reconcileDue(
      { maxDurationMs: 500, maxItems: 3 },
      advancingClock,
    );
    expect(timed).toMatchObject({
      dueRemaining: 3,
      processed: 0,
      stoppedReason: "time_limit",
    });
  });

  it("reports redacted due, success, failure, degraded and backlog metrics", async () => {
    const metrics = new RuntimeMetrics();
    metrics.recordReconciliation({
      degraded: 1,
      dueRemaining: 2,
      evidenceBacklog: 3,
      failed: 1,
      oldestDueAgeMs: 12_000,
      processed: 2,
      recoveredLeases: 0,
      stoppedReason: "item_limit",
      succeeded: 1,
    });

    const rendered = metrics.render();
    expect(rendered).toContain(
      "inside_telegram_reconciliation_success_total 1",
    );
    expect(rendered).toContain(
      "inside_telegram_reconciliation_failure_total 1",
    );
    expect(rendered).toContain(
      "inside_telegram_reconciliation_degraded_total 1",
    );
    expect(rendered).toContain("inside_telegram_reconciliation_due 2");
    expect(rendered).toContain(
      "inside_telegram_reconciliation_oldest_due_seconds 12",
    );
    expect(rendered).toContain("inside_telegram_evidence_delivery_backlog 3");
    expect(rendered).not.toContain("telegram_user");
    expect(rendered).not.toContain("account-ref");
  });
});

async function seedLinkedMember(
  provider: MembershipEvidenceProvider,
  telegram: ControlledTelegramMembership,
  clock: MutableClock,
  index: number,
): Promise<string> {
  const telegramUserId = String(100 + index);
  const identityRef = `telegram-identity-${index}`;
  const linkRef = `link-transaction-${index}`;
  await database
    .insertInto("bot_contacts")
    .values({
      bot_identity: config.botIdentity,
      contactability: "reachable",
      first_started_at: linkedAt,
      last_started_at: linkedAt,
      private_chat_id: telegramUserId,
      telegram_user_id: telegramUserId,
      updated_at: linkedAt,
    })
    .execute();
  await database
    .insertInto("link_transactions")
    .values({
      account_ref: `account-ref-${index}`,
      bot_identity: config.botIdentity,
      candidate_telegram_user_id: telegramUserId,
      confirmed_at: linkedAt,
      expires_at: new Date(linkedAt.getTime() + 60_000),
      link_transaction_ref: linkRef,
      received_at: linkedAt,
      registered_at: linkedAt,
      return_correlation: `return-ref-${index}`,
      state: "linked",
      token_digest: String(index).padStart(43, "A"),
    })
    .execute();
  await database
    .insertInto("platform_links")
    .values({
      account_ref: `account-ref-${index}`,
      bot_identity: config.botIdentity,
      evidence_version: 0,
      last_membership_observation_at: null,
      last_membership_observation_update_id: null,
      link_transaction_ref: linkRef,
      linked_at: linkedAt,
      telegram_identity_ref: identityRef,
      telegram_user_id: telegramUserId,
    })
    .execute();
  telegram.members.set(telegramUserId, {
    kind: "observed",
    value: { status: "member" },
  });
  clock.set(linkedAt);
  await provider.observe({
    checkRef: `initial-check-${index}`,
    telegramIdentityRef: identityRef,
  });
  return identityRef;
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = ${tableName}
    ) as exists
  `.execute(database);
  return result.rows[0]?.exists ?? false;
}

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(current: Date): void {
    this.current = current;
  }
}

class AdvancingClock implements Clock {
  private calls = 0;

  constructor(
    private readonly startedAt: Date,
    private readonly advanceMilliseconds: number,
  ) {}

  now(): Date {
    const current = new Date(
      this.startedAt.getTime() + this.calls * this.advanceMilliseconds,
    );
    this.calls += 1;
    return current;
  }
}

class ControlledTelegramMembership implements TelegramMembership {
  readonly members = new Map<string, TelegramChatMemberResult>();
  provider: TelegramChatMemberResult = {
    kind: "observed",
    value: { status: "administrator" },
  };
  subjectCalls = 0;

  async getBotChatMember(): Promise<TelegramChatMemberResult> {
    return this.provider;
  }

  async getChatMember(
    _canonicalChatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatMemberResult> {
    this.subjectCalls += 1;
    return (
      this.members.get(telegramUserId) ?? {
        diagnosticCode: "synthetic_missing_member",
        kind: "unavailable",
      }
    );
  }
}

class PausingTelegramMembership extends ControlledTelegramMembership {
  private readonly pauses: Array<{
    readonly result: TelegramChatMemberResult;
    readonly resumed: Promise<void>;
    resume: () => void;
    signalStarted: () => void;
  }> = [];

  pauseNext(result: TelegramChatMemberResult): {
    readonly started: Promise<void>;
    resume: () => void;
  } {
    let resume!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.pauses.push({ result, resumed, resume, signalStarted });
    return { resume, started };
  }

  override async getChatMember(
    canonicalChatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatMemberResult> {
    const pause = this.pauses.shift();
    if (!pause) {
      return super.getChatMember(canonicalChatId, telegramUserId);
    }
    this.subjectCalls += 1;
    pause.signalStarted();
    await pause.resumed;
    return pause.result;
  }
}

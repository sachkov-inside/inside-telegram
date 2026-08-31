import { createHash } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateTo, migrateToLatest } from "../../src/database/migrator.js";
import { IdentityLinkRecovery } from "../../src/modules/identity-linking/identity-link-recovery.js";
import { IdentityLinking } from "../../src/modules/identity-linking/identity-linking.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const now = new Date("2030-01-01T00:02:00.000Z");
let database: Database;
let linking: IdentityLinking;
let recovery: IdentityLinkRecovery;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
  linking = new IdentityLinking(database, { now: () => now });
  recovery = new IdentityLinkRecovery(database, { now: () => now });
});

beforeEach(async () => {
  await sql`
    truncate table
      identity_link_recoveries,
      identity_link_events,
      membership_reconciliations,
      membership_evidence_outbox,
      membership_check_results,
      membership_checks,
      platform_links,
      link_transactions
    restart identity cascade
  `.execute(database);
});

afterAll(async () => {
  await database.destroy();
});

describe("IdentityLinkRecovery", () => {
  it("rebuilds the owner recovery migration down and forward", async () => {
    try {
      await migrateTo(database, "006-platform-evidence-conformance");
      await expect(tableExists("identity_link_recoveries")).resolves.toBe(
        false,
      );
    } finally {
      await migrateToLatest(database);
    }
    await expect(tableExists("identity_link_recoveries")).resolves.toBe(true);
  });

  it("previews without mutation and transfers only the explicitly confirmed conflict", async () => {
    const fixture = await conflictingLinkFixture();
    const command = {
      confirmedSourceAccountRef: "principal-ref-source",
      confirmedTargetAccountRef: "principal-ref-target",
      operatorRef: "owner-kirill",
      reasonRef: "inside-telegram-9-proof",
      recoveryRef: "recovery-proof-0001",
      sourceAccountRef: "principal-ref-source",
      targetAccountRef: "principal-ref-target",
      targetLinkTransactionRef: fixture.targetLinkTransactionRef,
      telegramIdentityRef: fixture.telegramIdentityRef,
    };

    await expect(recovery.preview(command)).resolves.toEqual({
      ok: true,
      outcome: "ready",
      transfer: {
        botIdentity: "inside",
        sourceAccountRef: "principal-ref-source",
        sourceLinkTransactionRef: fixture.sourceLinkTransactionRef,
        targetAccountRef: "principal-ref-target",
        targetLinkTransactionRef: fixture.targetLinkTransactionRef,
        telegramIdentityRef: fixture.telegramIdentityRef,
        telegramUserId: "42",
      },
    });
    expect(await currentAccount()).toBe("principal-ref-source");
    expect(await recoveryAuditCount()).toBe(0);

    await expect(recovery.execute(command)).resolves.toMatchObject({
      ok: true,
      outcome: "transferred",
      transfer: {
        sourceAccountRef: "principal-ref-source",
        targetAccountRef: "principal-ref-target",
        targetLinkTransactionRef: fixture.targetLinkTransactionRef,
        telegramIdentityRef: fixture.telegramIdentityRef,
      },
    });
    expect(await currentAccount()).toBe("principal-ref-target");
    expect(await recoveryAuditCount()).toBe(1);
    await expect(recovery.execute(command)).resolves.toMatchObject({
      ok: true,
      outcome: "idempotent",
    });
    expect(await recoveryAuditCount()).toBe(1);
  });

  it("rejects mismatched confirmations and unrelated target transactions", async () => {
    const fixture = await conflictingLinkFixture();
    const base = {
      confirmedSourceAccountRef: "principal-ref-source",
      confirmedTargetAccountRef: "principal-ref-target",
      operatorRef: "owner-kirill",
      reasonRef: "inside-telegram-9-proof",
      recoveryRef: "recovery-proof-0002",
      sourceAccountRef: "principal-ref-source",
      targetAccountRef: "principal-ref-target",
      targetLinkTransactionRef: fixture.targetLinkTransactionRef,
      telegramIdentityRef: fixture.telegramIdentityRef,
    };

    await expect(
      recovery.preview({
        ...base,
        confirmedTargetAccountRef: "principal-ref-other",
      }),
    ).resolves.toEqual({ ok: false, reason: "confirmation_mismatch" });
    await expect(
      recovery.preview({
        ...base,
        targetLinkTransactionRef: fixture.sourceLinkTransactionRef,
      }),
    ).resolves.toEqual({ ok: false, reason: "target_not_recoverable" });
    expect(await currentAccount()).toBe("principal-ref-source");
    expect(await recoveryAuditCount()).toBe(0);
  });

  it("keeps completed recovery audit facts immutable", async () => {
    const fixture = await conflictingLinkFixture();
    await recovery.execute({
      confirmedSourceAccountRef: "principal-ref-source",
      confirmedTargetAccountRef: "principal-ref-target",
      operatorRef: "owner-kirill",
      reasonRef: "inside-telegram-9-proof",
      recoveryRef: "recovery-proof-0003",
      sourceAccountRef: "principal-ref-source",
      targetAccountRef: "principal-ref-target",
      targetLinkTransactionRef: fixture.targetLinkTransactionRef,
      telegramIdentityRef: fixture.telegramIdentityRef,
    });

    await expect(
      sql`update identity_link_recoveries set reason_ref = 'rewritten'`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`delete from identity_link_recoveries`.execute(database),
    ).rejects.toThrow();
  });

  it("serializes duplicate recovery references into one transfer and one idempotent result", async () => {
    const fixture = await conflictingLinkFixture();
    const command = {
      confirmedSourceAccountRef: "principal-ref-source",
      confirmedTargetAccountRef: "principal-ref-target",
      operatorRef: "owner-kirill",
      reasonRef: "inside-telegram-9-proof",
      recoveryRef: "recovery-proof-concurrent",
      sourceAccountRef: "principal-ref-source",
      targetAccountRef: "principal-ref-target",
      targetLinkTransactionRef: fixture.targetLinkTransactionRef,
      telegramIdentityRef: fixture.telegramIdentityRef,
    };

    const results = await Promise.all([
      recovery.execute(command),
      recovery.execute(command),
    ]);

    expect(
      results
        .map((result) => (result.ok ? result.outcome : result.reason))
        .sort(),
    ).toEqual(["idempotent", "transferred"]);
    expect(await recoveryAuditCount()).toBe(1);
  });

  it("allows only one concurrent recovery into the same target Account", async () => {
    const first = await conflictingLinkFixture();
    const second = await conflictingLinkFixtureFor({
      sourceAccountRef: "principal-ref-source-second",
      sourceReturnCorrelation: "source-return-second",
      sourceToken: "source-token-second",
      targetReturnCorrelation: "target-return-second",
      targetToken: "target-token-second",
      telegramUserId: "99",
    });

    const results = await Promise.all([
      recovery.execute(recoveryCommand(first, "first")),
      recovery.execute(recoveryCommand(second, "second")),
    ]);

    expect(
      results
        .map((result) => (result.ok ? result.outcome : result.reason))
        .sort(),
    ).toEqual(["target_account_already_linked", "transferred"]);
    expect(await linksForAccount("principal-ref-target")).toBe(1);
    expect(await recoveryAuditCount()).toBe(1);
  });
});

async function conflictingLinkFixture(): Promise<{
  sourceAccountRef: string;
  sourceLinkTransactionRef: string;
  targetLinkTransactionRef: string;
  telegramIdentityRef: string;
}> {
  return conflictingLinkFixtureFor({
    sourceAccountRef: "principal-ref-source",
    sourceReturnCorrelation: "source-return",
    sourceToken: "source-token",
    targetReturnCorrelation: "target-return",
    targetToken: "target-token",
    telegramUserId: "42",
  });
}

async function conflictingLinkFixtureFor(options: {
  sourceAccountRef: string;
  sourceReturnCorrelation: string;
  sourceToken: string;
  targetReturnCorrelation: string;
  targetToken: string;
  telegramUserId: string;
}): Promise<{
  sourceAccountRef: string;
  sourceLinkTransactionRef: string;
  targetLinkTransactionRef: string;
  telegramIdentityRef: string;
}> {
  const source = await registerAndReceive(
    options.sourceAccountRef,
    digest(options.sourceToken),
    options.sourceReturnCorrelation,
    options.telegramUserId,
  );
  const linked = await linking.confirm({
    accountRef: options.sourceAccountRef,
    linkTransactionRef: source,
    returnCorrelation: options.sourceReturnCorrelation,
  });
  if (linked.status !== "linked") {
    throw new Error("fixture source did not link");
  }

  const target = await linking.register({
    accountRef: "principal-ref-target",
    expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    returnCorrelation: options.targetReturnCorrelation,
    tokenDigest: digest(options.targetToken),
  });
  await linking.acceptStart({
    botIdentity: "inside",
    linkToken: { digest: digest(options.targetToken), kind: "digest" },
    observedAt: new Date("2030-01-01T00:01:00.000Z"),
    telegramUserId: options.telegramUserId,
  });

  return {
    sourceAccountRef: options.sourceAccountRef,
    sourceLinkTransactionRef: source,
    targetLinkTransactionRef: target.linkTransactionRef,
    telegramIdentityRef: linked.telegramIdentityRef,
  };
}

function recoveryCommand(
  fixture: {
    sourceAccountRef: string;
    targetLinkTransactionRef: string;
    telegramIdentityRef: string;
  },
  suffix: string,
) {
  return {
    confirmedSourceAccountRef: fixture.sourceAccountRef,
    confirmedTargetAccountRef: "principal-ref-target",
    operatorRef: "owner-kirill",
    reasonRef: "inside-telegram-9-proof",
    recoveryRef: `recovery-proof-account-race-${suffix}`,
    sourceAccountRef: fixture.sourceAccountRef,
    targetAccountRef: "principal-ref-target",
    targetLinkTransactionRef: fixture.targetLinkTransactionRef,
    telegramIdentityRef: fixture.telegramIdentityRef,
  };
}

async function registerAndReceive(
  accountRef: string,
  tokenDigest: string,
  returnCorrelation: string,
  telegramUserId = "42",
): Promise<string> {
  const link = await linking.register({
    accountRef,
    expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    returnCorrelation,
    tokenDigest,
  });
  await linking.acceptStart({
    botIdentity: "inside",
    linkToken: { digest: tokenDigest, kind: "digest" },
    observedAt: new Date("2030-01-01T00:01:00.000Z"),
    telegramUserId,
  });
  return link.linkTransactionRef;
}

async function linksForAccount(accountRef: string): Promise<number> {
  const result = await database
    .selectFrom("platform_links")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("account_ref", "=", accountRef)
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

async function currentAccount(): Promise<string> {
  return (
    await database
      .selectFrom("platform_links")
      .select("account_ref")
      .executeTakeFirstOrThrow()
  ).account_ref;
}

async function recoveryAuditCount(): Promise<number> {
  const result = await database
    .selectFrom("identity_link_recoveries")
    .select(({ fn }) => fn.countAll().as("count"))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public' and table_name = ${tableName}
    ) as exists
  `.execute(database);
  return result.rows[0]?.exists ?? false;
}

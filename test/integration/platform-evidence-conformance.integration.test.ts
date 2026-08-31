import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateTo, migrateToLatest } from "../../src/database/migrator.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

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

describe("Platform evidence conformance migration", () => {
  it("backfills every historical producer source and enforces the vocabulary", async () => {
    try {
      await migrateTo(database, "005-membership-reconciliation");
      const sourceColumnBefore = await sourceColumnExists();
      expect(sourceColumnBefore).toBe(false);

      await seedHistoricalDeliveries();
      await migrateToLatest(database);

      const deliveries = await database
        .selectFrom("membership_evidence_outbox")
        .select(["result_ref", "source"])
        .orderBy("result_ref")
        .execute();
      expect(deliveries).toEqual([
        { result_ref: "initial-link:1", source: "link_time" },
        {
          result_ref: "membership-event:inside:1",
          source: "member_status_event",
        },
        {
          result_ref: "reconciliation:identity-ref:1",
          source: "reconciliation",
        },
      ]);
      await expect(
        sql`
          update membership_evidence_outbox
          set source = 'untrusted'
          where result_ref = 'initial-link:1'
        `.execute(database),
      ).rejects.toThrow();
    } finally {
      await migrateToLatest(database);
    }
  });
});

async function sourceColumnExists(): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'membership_evidence_outbox'
        and column_name = 'source'
    ) as exists
  `.execute(database);
  return result.rows[0]?.exists ?? false;
}

async function seedHistoricalDeliveries(): Promise<void> {
  await sql`
    insert into link_transactions (
      link_transaction_ref,
      account_ref,
      token_digest,
      return_correlation,
      expires_at,
      state,
      bot_identity,
      candidate_telegram_user_id,
      registered_at,
      received_at,
      confirmed_at
    ) values (
      'link-ref',
      'account-ref',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'return-ref',
      '2030-01-01T01:00:00.000Z',
      'linked',
      'inside',
      42,
      '2030-01-01T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z'
    );
    insert into platform_links (
      telegram_identity_ref,
      bot_identity,
      telegram_user_id,
      account_ref,
      link_transaction_ref,
      linked_at
    ) values (
      'identity-ref',
      'inside',
      42,
      'account-ref',
      'link-ref',
      '2030-01-01T00:00:00.000Z'
    );
    insert into membership_check_results (
      result_ref,
      telegram_identity_ref,
      normalized_state,
      evidence_ref,
      evidence_version,
      observed_at
    ) values
      ('initial-link:1', 'identity-ref', 'member', 'evidence-1', 1, '2030-01-01T00:00:00.000Z'),
      ('membership-event:inside:1', 'identity-ref', 'non_member', 'evidence-2', 2, '2030-01-01T00:01:00.000Z'),
      ('reconciliation:identity-ref:1', 'identity-ref', 'member', 'evidence-3', 3, '2030-01-01T00:02:00.000Z');
    insert into membership_evidence_outbox (
      id,
      result_ref,
      envelope,
      state,
      attempt_count,
      available_at,
      updated_at
    ) values
      ('delivery-1', 'initial-link:1', '{}', 'pending', 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
      ('delivery-2', 'membership-event:inside:1', '{}', 'pending', 0, '2030-01-01T00:01:00.000Z', '2030-01-01T00:01:00.000Z'),
      ('delivery-3', 'reconciliation:identity-ref:1', '{}', 'pending', 0, '2030-01-01T00:02:00.000Z', '2030-01-01T00:02:00.000Z')
  `.execute(database);
}

import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import {
  redactedDatabaseSnapshot,
  validateReconciliationRepair,
} from "../../src/operations/credentialed-proof.js";

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
      identity_link_recoveries,
      identity_link_events,
      membership_reconciliations,
      membership_provider_observations,
      membership_provider_state,
      membership_event_audit,
      membership_evidence_outbox,
      membership_check_results,
      membership_checks,
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

describe("credentialed proof evidence", () => {
  it("correlates raw normalization and proves a current bounded reconciliation denial", async () => {
    await seedMembershipTransitions();

    const snapshot = await redactedDatabaseSnapshot(database);
    const transitions = snapshot.membershipTransitions;
    if (!Array.isArray(transitions)) {
      throw new Error("Membership transitions were not captured");
    }
    expect(transitions).toEqual([
      expect.objectContaining({
        decision: "member",
        freshnessBounded: true,
        mappingObserved: true,
        normalizedState: "member",
        rawIsMember: true,
        rawStatus: "restricted",
        revision: "1",
        source: "member_status_event",
        validitySeconds: 300,
      }),
      expect.objectContaining({
        decision: "not_member",
        freshnessBounded: true,
        isCurrentRevision: true,
        mappingObserved: true,
        normalizedState: "non_member",
        rawIsMember: false,
        rawStatus: "left",
        revision: "2",
        source: "reconciliation",
        validitySeconds: 300,
      }),
    ]);
    expect(() =>
      validateReconciliationRepair(
        transitions,
        [
          {
            ...transitions[0],
            decision: "not_member",
            isCurrentRevision: true,
            normalizedState: "non_member",
            revision: "0",
            sequence: 0,
          },
        ],
        [{ ...transitions[0], isCurrentRevision: true }],
        [{ ...transitions[0], isCurrentRevision: true }],
      ),
    ).not.toThrow();
    expect(JSON.stringify(transitions)).not.toMatch(
      /identity-ref-sensitive|account-ref-sensitive|telegram_user/u,
    );
  });
});

async function seedMembershipTransitions(): Promise<void> {
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
      'link-ref-sensitive',
      'account-ref-sensitive',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'return-ref-sensitive',
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
      linked_at,
      evidence_version
    ) values (
      'identity-ref-sensitive',
      'inside',
      42,
      'account-ref-sensitive',
      'link-ref-sensitive',
      '2030-01-01T00:00:00.000Z',
      2
    );
    insert into membership_check_results (
      result_ref,
      telegram_identity_ref,
      normalized_state,
      raw_status,
      raw_is_member,
      evidence_ref,
      evidence_version,
      observed_at
    ) values
      (
        'member-result',
        'identity-ref-sensitive',
        'member',
        'restricted',
        true,
        'member-evidence',
        1,
        '2030-01-01T00:01:00.000Z'
      ),
      (
        'reconciliation-result',
        'identity-ref-sensitive',
        'non_member',
        'left',
        false,
        'reconciliation-evidence',
        2,
        '2030-01-01T00:02:00.000Z'
      );
    insert into membership_evidence_outbox (
      id,
      result_ref,
      envelope,
      source,
      state,
      attempt_count,
      available_at,
      updated_at
    ) values
      (
        'member-delivery',
        'member-result',
        '{"decision":"member","checkedAt":"2030-01-01T00:01:00.000Z","validUntil":"2030-01-01T00:06:00.000Z"}',
        'member_status_event',
        'pending',
        0,
        '2030-01-01T00:01:00.000Z',
        '2030-01-01T00:01:00.000Z'
      ),
      (
        'reconciliation-delivery',
        'reconciliation-result',
        '{"decision":"not_member","checkedAt":"2030-01-01T00:02:00.000Z","validUntil":"2030-01-01T00:07:00.000Z"}',
        'reconciliation',
        'pending',
        0,
        '2030-01-01T00:02:00.000Z',
        '2030-01-01T00:02:00.000Z'
      )
  `.execute(database);
}

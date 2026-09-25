import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { purgeExpiredRecords } from "../../src/database/retention.js";
import { seedCommunityBinding } from "../support/community-binding.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const now = new Date("2026-09-24T12:00:00.000Z");
const old = new Date(now.getTime() - 31 * 86_400_000);
const recent = new Date(now.getTime() - 29 * 86_400_000);
const periods = { membershipCheckDays: 90 };

let database: Database;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
});

beforeEach(async () => {
  await sql`
    truncate table
      bot_contact_events,
      bot_contacts,
      communication_author_receipts,
      communication_contacts,
      communication_entries,
      communication_intake_receipts,
      identity_link_events,
      link_transactions,
      membership_check_results,
      membership_event_audit,
      membership_evidence_outbox,
      membership_provider_observations,
      notification_result_outbox,
      start_response_delivery_attempts,
      start_response_deliveries,
      platform_links,
      telegram_updates
    restart identity cascade
  `.execute(database);
});

afterAll(async () => {
  await database.destroy();
});

describe("retention", () => {
  it("deletes only settled technical records past their period", async () => {
    await update("1", "processed", old);
    await update("2", "failed", old);
    await update("3", "processed", recent);
    await update("4", "pending", old);
    for (const updateId of ["1", "3"]) {
      await database
        .insertInto("communication_author_receipts")
        .values({ bot_identity: "inside", update_id: updateId })
        .execute();
      await database
        .insertInto("communication_intake_receipts")
        .values({
          bot_identity: "inside",
          outcome: "saved",
          template_id: null,
          update_id: updateId,
        })
        .execute();
    }
    const delivered = await reply("delivered", old);
    await reply("unknown_exhausted", old);
    await reply("delivered", recent);
    await database
      .insertInto("start_response_delivery_attempts")
      .values({
        attempt_number: 1,
        attempted_at: old,
        diagnostic_code: null,
        outcome: "delivered",
        provider_error_code: null,
        provider_message_id: "5",
        start_response_delivery_id: delivered,
      })
      .execute();
    await observation("old", old);
    await observation("recent", recent);
    await result("published-old", new Date(now.getTime() - 8 * 86_400_000));
    await result("published-recent", new Date(now.getTime() - 6 * 86_400_000));
    await result("unpublished", null);

    await expect(
      purgeExpiredRecords(database, now, periods),
    ).resolves.toBeGreaterThan(0);
    await expect(purgeExpiredRecords(database, now, periods)).resolves.toBe(0);

    expect(await ids("telegram_updates", "update_id")).toEqual(["3", "4"]);
    expect(await ids("communication_author_receipts", "update_id")).toEqual([
      "3",
    ]);
    expect(await ids("communication_intake_receipts", "update_id")).toEqual([
      "3",
    ]);
    expect(await ids("start_response_deliveries", "state")).toEqual([
      "delivered",
      "unknown_exhausted",
    ]);
    expect(await ids("start_response_delivery_attempts", "outcome")).toEqual(
      [],
    );
    expect(await ids("membership_provider_observations", "source_ref")).toEqual(
      ["recent"],
    );
    expect(await ids("notification_result_outbox", "result")).toEqual([
      "published-recent",
      "unpublished",
    ]);
  });

  it("keeps membership checks for the configured period and each identity's latest state", async () => {
    await linkedIdentity("identity-a", "101");
    await linkedIdentity("identity-b", "102");
    await linkedIdentity("identity-c", "103");
    await check("a-oldest", "identity-a", daysAgo(130), "delivered");
    await check("a-rejected", "identity-a", daysAgo(100), "rejected");
    await check("a-undelivered", "identity-a", daysAgo(95), "retry_scheduled");
    await check("a-recent", "identity-a", daysAgo(10), "delivered");
    await check("b-earlier", "identity-b", daysAgo(120), "delivered");
    await check("b-latest", "identity-b", daysAgo(100), "delivered");
    await check("c-first", "identity-c", daysAgo(95), "delivered");
    await check("c-same-time-later", "identity-c", daysAgo(95), "delivered");

    await purgeUntilDone({ membershipCheckDays: 120 });
    expect(await ids("membership_check_results", "result_ref")).toEqual([
      "a-recent",
      "a-rejected",
      "a-undelivered",
      "b-earlier",
      "b-latest",
      "c-first",
      "c-same-time-later",
    ]);

    await purgeUntilDone(periods);
    const kept = ["a-recent", "a-undelivered", "b-latest", "c-same-time-later"];
    expect(await ids("membership_check_results", "result_ref")).toEqual(kept);
    expect(await ids("membership_evidence_outbox", "result_ref")).toEqual(kept);
  });

  it("keeps contact, link, Membership audit and communication history without a deadline", async () => {
    const ancient = daysAgo(3650);
    const linkRef = await linkedIdentity("identity-a", "101");
    await database
      .insertInto("bot_contact_events")
      .values({
        bot_identity: "inside",
        contactability: "reachable",
        event_type: "start_observed",
        observed_at: ancient,
        telegram_user_id: "101",
        update_id: "7",
      })
      .execute();
    await database
      .insertInto("identity_link_events")
      .values({
        event_type: "confirmed",
        link_transaction_ref: linkRef,
        occurred_at: ancient,
      })
      .execute();
    await database
      .insertInto("membership_event_audit")
      .values({
        actor_is_subject: true,
        bot_identity: "inside",
        canonical_chat_id: "-1000000000000",
        diagnostic_code: null,
        disposition: "ignored_older",
        event_at: ancient,
        event_kind: "subject",
        normalized_state: "member",
        result_ref: null,
        subject_linked: true,
        update_id: "8",
      })
      .execute();
    await sql`
      insert into communication_contacts (contact_id, bot_identity, telegram_user_id)
      values ('00000000-0000-4000-8000-000000000001', 'inside', 101)
    `.execute(database);
    await sql`
      insert into communication_entries
        (bot_identity, update_id, contact_id, entered_at, outcome)
      values ('inside', 9, '00000000-0000-4000-8000-000000000001', ${ancient}, 'default')
    `.execute(database);

    await purgeUntilDone(periods);

    expect(await ids("bot_contact_events", "update_id")).toEqual(["7"]);
    expect(await ids("identity_link_events", "event_type")).toEqual([
      "confirmed",
    ]);
    expect(await ids("membership_event_audit", "update_id")).toEqual(["8"]);
    expect(await ids("communication_entries", "update_id")).toEqual(["9"]);
  });
});

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

async function purgeUntilDone(retention: typeof periods): Promise<void> {
  while ((await purgeExpiredRecords(database, now, retention)) > 0);
}

async function linkedIdentity(
  telegramIdentityRef: string,
  telegramUserId: string,
): Promise<string> {
  await seedCommunityBinding(
    database,
    {
      accountRef: `account-${telegramIdentityRef}`,
      linkRef: `link-${telegramIdentityRef}`,
      linkRevision: 1,
      telegramIdentityRef,
    },
    daysAgo(3650),
    telegramUserId,
  );
  const link = await database
    .selectFrom("platform_links")
    .select("link_transaction_ref")
    .where("telegram_identity_ref", "=", telegramIdentityRef)
    .executeTakeFirstOrThrow();
  return link.link_transaction_ref;
}

async function check(
  resultRef: string,
  telegramIdentityRef: string,
  observedAt: Date,
  delivery: "delivered" | "rejected" | "retry_scheduled",
): Promise<void> {
  await database
    .insertInto("membership_check_results")
    .values({
      diagnostic_code: null,
      evidence_ref: `evidence-${resultRef}`,
      evidence_version: "1",
      normalized_state: "member",
      observation_update_id: null,
      observed_at: observedAt,
      raw_is_member: null,
      raw_status: "member",
      result_ref: resultRef,
      telegram_identity_ref: telegramIdentityRef,
    })
    .execute();
  await database
    .insertInto("membership_evidence_outbox")
    .values({
      attempt_count: 1,
      available_at: observedAt,
      delivered_at: delivery === "delivered" ? observedAt : null,
      diagnostic_code: null,
      envelope: JSON.stringify({ synthetic: resultRef }),
      id: `delivery-${resultRef}`,
      locked_at: null,
      result_ref: resultRef,
      source: "reconciliation",
      state: delivery,
      updated_at: observedAt,
    })
    .execute();
}

async function update(
  updateId: string,
  state: "pending" | "processed" | "failed",
  at: Date,
): Promise<void> {
  await database
    .insertInto("telegram_updates")
    .values({
      available_at: at,
      bot_identity: "inside",
      failure_code: null,
      locked_at: null,
      payload: state === "pending" ? JSON.stringify({}) : null,
      process_attempt_count: 1,
      processed_at: state === "pending" ? null : at,
      received_at: at,
      state,
      update_id: updateId,
    })
    .execute();
}

async function reply(
  state: "delivered" | "unknown_exhausted",
  at: Date,
): Promise<string> {
  const row = await database
    .insertInto("start_response_deliveries")
    .values({
      attempt_count: 1,
      available_at: at,
      bot_identity: "inside",
      created_at: at,
      delivered_at: state === "delivered" ? at : null,
      diagnostic_code: null,
      locked_at: null,
      message_text: "Synthetic reply",
      private_chat_id: "42",
      source_key: `retention:${state}:${at.toISOString()}`,
      state,
      telegram_user_id: "42",
      trigger_update_id: null,
      updated_at: at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function observation(sourceRef: string, at: Date): Promise<void> {
  await database
    .insertInto("membership_provider_observations")
    .values({
      bot_identity: "inside",
      diagnostic_code: null,
      observed_at: at,
      source_kind: "direct",
      source_ref: sourceRef,
      source_update_id: null,
      state: "ready",
    })
    .execute();
}

async function result(marker: string, publishedAt: Date | null): Promise<void> {
  await sql`
    insert into notification_result_outbox (message_id, result, published_at, created_at)
    values (gen_random_uuid(), ${JSON.stringify(marker)}::jsonb, ${publishedAt}, ${old})
  `.execute(database);
}

async function ids(table: string, column: string): Promise<string[]> {
  const rows = await sql<{ value: string }>`
    select ${sql.ref(column)}::text as value from ${sql.table(table)}
    order by 1
  `.execute(database);
  return rows.rows.map((row) => row.value.replace(/^"|"$/g, ""));
}

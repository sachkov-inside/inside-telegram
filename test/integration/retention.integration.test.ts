import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { purgeExpiredRecords } from "../../src/database/retention.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const now = new Date("2026-09-24T12:00:00.000Z");
const old = new Date(now.getTime() - 31 * 86_400_000);
const recent = new Date(now.getTime() - 29 * 86_400_000);

let database: Database;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
});

beforeEach(async () => {
  await sql`
    truncate table
      communication_author_receipts,
      communication_intake_receipts,
      membership_provider_observations,
      notification_result_outbox,
      start_response_delivery_attempts,
      start_response_deliveries,
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

    await expect(purgeExpiredRecords(database, now)).resolves.toBeGreaterThan(
      0,
    );
    await expect(purgeExpiredRecords(database, now)).resolves.toBe(0);

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
});

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

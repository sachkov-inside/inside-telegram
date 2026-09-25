import { communicationFunnelsMigration } from "../../src/database/migrations/011-communication-funnels.js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import {
  migrateDown,
  migrateTo,
  migrateToLatest,
} from "../../src/database/migrator.js";
import { botSignInMigration } from "../../src/database/migrations/008-bot-sign-in.js";
import { signInReservationMigration } from "../../src/database/migrations/009-sign-in-reservation.js";
import { communicationsTemplatesMigration } from "../../src/database/migrations/010-communications-templates.js";
import { signInMessageResultMigration } from "../../src/database/migrations/010-sign-in-message-result.js";
import { CommunityRestrictions } from "../../src/modules/community/community-restrictions.js";
import { digest } from "../../src/security/payload-digest.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for integration tests");
const database = createDatabase(databaseUrl);
beforeAll(() => migrateToLatest(database));
beforeEach(() => migrateTo(database, "007-owner-identity-recovery"));
afterAll(async () => {
  await migrateToLatest(database);
  await database.destroy();
});

// Reconstruct the real pre-merge histories using their unchanged migrations and ledger keys.
async function applyHistorical(
  name: string,
  migration: Migration,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await migration.up(transaction);
    await sql`insert into kysely_migration (name, timestamp) values (${name}, ${new Date().toISOString()})`.execute(
      transaction,
    );
  });
}

it.each(["communications-first", "sign-in-first"] as const)(
  "preserves existing data and supports down/latest after %s deployment",
  async (history) => {
    const identity = randomUUID();
    if (history === "communications-first") {
      await applyHistorical(
        "010-communications-templates",
        communicationsTemplatesMigration,
      );
      await applyHistorical(
        "011-communication-funnels",
        communicationFunnelsMigration,
      );
      await database
        .insertInto("communication_templates")
        .values({
          template_id: identity,
          bot_identity: "synthetic",
          owner_account_ref: "synthetic-account",
          revision: 1,
          content: { text: "preserved" },
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    } else {
      await applyHistorical("008-bot-sign-in", botSignInMigration);
      await applyHistorical(
        "009-sign-in-reservation",
        signInReservationMigration,
      );
      await applyHistorical(
        "010-sign-in-message-result",
        signInMessageResultMigration,
      );
      await database
        .insertInto("sign_in_subjects")
        .values({
          subject_ref: identity,
          bot_identity: "synthetic",
          telegram_user_id: "42",
          reserved_for_sign_in: true,
        })
        .execute();
    }
    const assertPreserved = async () => {
      if (history === "communications-first") {
        expect(
          await database
            .selectFrom("communication_templates")
            .select(["content", "revision"])
            .where("template_id", "=", identity)
            .executeTakeFirst(),
        ).toEqual({ content: { text: "preserved" }, revision: 1 });
      } else {
        expect(
          await database
            .selectFrom("sign_in_subjects")
            .select("reserved_for_sign_in")
            .where("subject_ref", "=", identity)
            .executeTakeFirst(),
        ).toEqual({ reserved_for_sign_in: true });
      }
    };
    await migrateToLatest(database);
    await assertPreserved();
    await migrateDown(database);
    await migrateToLatest(database);
    await assertPreserved();
    await migrateToLatest(database);
    const ledger = await sql<{
      count: string;
    }>`select count(*) from kysely_migration`.execute(database);
    expect(ledger.rows[0]?.count).toBe("25");
  },
);

it("preserves legacy restriction receipts without inventing an audit during upgrade", async () => {
  await migrateTo(database, "020-community-effect-provenance");
  const input = {
    operationId: randomUUID(),
    botIdentity: "synthetic-legacy",
    accountRef: "opaque-legacy-account",
    identityRef: "opaque-legacy-identity",
    expectedRevision: 1,
    action: "restore" as const,
    actorRef: "synthetic-owner",
    reason: "Legacy decision",
  };
  const now = new Date();
  await sql`insert into community_restriction_decisions
    (operation_id, fingerprint, actor_ref, reason, created_at)
    values (${input.operationId}, ${digest(input)}, ${input.actorRef}, ${input.reason}, ${now})`.execute(
    database,
  );
  await migrateToLatest(database);
  const read = () =>
    database
      .selectFrom("community_restriction_decisions")
      .selectAll()
      .where("operation_id", "=", input.operationId)
      .executeTakeFirstOrThrow();
  const historical = await read();
  expect(historical.audit).toBeNull();
  const decisions = new CommunityRestrictions(database, { now: () => now });
  expect(await decisions.decide(input, true)).toBe("duplicate");
  expect(await decisions.decide({ ...input, reason: "Changed" }, true)).toBe(
    "conflict",
  );
  expect(await read()).toEqual(historical);
  await migrateDown(database);
  await migrateToLatest(database);
  expect(await read()).toEqual(historical);
});

it.each([
  "009-sign-in-reservation",
  "011-communication-funnels",
  "012-marketing-preferences",
  "013-broadcast-analytics",
  "014-author-admin",
  "015-author-drafts",
])(
  "still rejects missing dependencies for %s at every entrypoint",
  async (migrationName) => {
    await sql`insert into kysely_migration (name, timestamp) values (${migrationName}, ${new Date().toISOString()})`.execute(
      database,
    );
    try {
      await expect(migrateToLatest(database)).rejects.toThrow(
        "Database migration failed",
      );
      await expect(migrateDown(database)).rejects.toThrow(
        "Database rollback failed",
      );
      await expect(
        migrateTo(database, "007-owner-identity-recovery"),
      ).rejects.toThrow("Database migration to");
    } finally {
      await sql`delete from kysely_migration where name = ${migrationName}`.execute(
        database,
      );
    }
  },
);

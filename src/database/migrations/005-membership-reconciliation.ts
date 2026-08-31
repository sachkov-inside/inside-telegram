import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const membershipReconciliationMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("membership_reconciliations")
      .addColumn("telegram_identity_ref", "text", (column) =>
        column
          .primaryKey()
          .references("platform_links.telegram_identity_ref")
          .onDelete("cascade"),
      )
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("due_at", "timestamptz", (column) => column.notNull())
      .addColumn("attempt_count", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("locked_at", "timestamptz")
      .addColumn("last_completed_at", "timestamptz")
      .addColumn("diagnostic_code", "text")
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .addCheckConstraint(
        "membership_reconciliations_state_check",
        sql`state in ('pending', 'processing')`,
      )
      .execute();
    await db.schema
      .createIndex("membership_reconciliations_due_idx")
      .on("membership_reconciliations")
      .columns(["state", "due_at", "telegram_identity_ref"])
      .execute();
    await sql`
      insert into membership_reconciliations (
        telegram_identity_ref,
        state,
        due_at,
        attempt_count,
        locked_at,
        last_completed_at,
        diagnostic_code,
        updated_at
      )
      select
        telegram_identity_ref,
        'pending',
        linked_at,
        0,
        null,
        null,
        null,
        linked_at
      from platform_links
      on conflict (telegram_identity_ref) do nothing
    `.execute(db);
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("membership_reconciliations").execute();
  },
};

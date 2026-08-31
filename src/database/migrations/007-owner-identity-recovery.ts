import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const ownerIdentityRecoveryMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("identity_link_recoveries")
      .addColumn("recovery_ref", "text", (column) => column.primaryKey())
      .addColumn("operator_ref", "text", (column) => column.notNull())
      .addColumn("reason_ref", "text", (column) => column.notNull())
      .addColumn("telegram_identity_ref", "text", (column) =>
        column.notNull().references("platform_links.telegram_identity_ref"),
      )
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint", (column) => column.notNull())
      .addColumn("source_account_ref", "text", (column) => column.notNull())
      .addColumn("target_account_ref", "text", (column) => column.notNull())
      .addColumn("source_link_transaction_ref", "text", (column) =>
        column.notNull().references("link_transactions.link_transaction_ref"),
      )
      .addColumn("target_link_transaction_ref", "text", (column) =>
        column.notNull().references("link_transactions.link_transaction_ref"),
      )
      .addColumn("source_linked_at", "timestamptz", (column) =>
        column.notNull(),
      )
      .addColumn("target_linked_at", "timestamptz", (column) =>
        column.notNull(),
      )
      .addUniqueConstraint(
        "identity_link_recoveries_target_transaction_unique",
        ["target_link_transaction_ref"],
      )
      .addCheckConstraint(
        "identity_link_recoveries_distinct_accounts_check",
        sql`source_account_ref <> target_account_ref`,
      )
      .addCheckConstraint(
        "identity_link_recoveries_refs_check",
        sql`
          char_length(recovery_ref) between 1 and 128
          and char_length(operator_ref) between 1 and 128
          and char_length(reason_ref) between 1 and 256
        `,
      )
      .execute();

    await sql`
      create function reject_identity_link_recovery_audit_mutation()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'identity_link_recoveries is immutable';
      end;
      $function$
    `.execute(db);
    await sql`
      create trigger identity_link_recoveries_immutable
      before update or delete on identity_link_recoveries
      for each row execute function reject_identity_link_recovery_audit_mutation()
    `.execute(db);
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await sql`
      drop trigger identity_link_recoveries_immutable on identity_link_recoveries
    `.execute(db);
    await sql`drop function reject_identity_link_recovery_audit_mutation()`.execute(
      db,
    );
    await db.schema.dropTable("identity_link_recoveries").execute();
  },
};

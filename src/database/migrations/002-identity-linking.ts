import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const identityLinkingMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table welcome_deliveries rename to start_response_deliveries`.execute(
      db,
    );
    await sql`alter table start_response_deliveries rename constraint welcome_deliveries_trigger_unique to start_response_deliveries_trigger_unique`.execute(
      db,
    );
    await sql`alter table start_response_deliveries rename constraint welcome_deliveries_state_check to start_response_deliveries_state_check`.execute(
      db,
    );
    await sql`alter index welcome_deliveries_send_idx rename to start_response_deliveries_send_idx`.execute(
      db,
    );
    await sql`alter table welcome_delivery_attempts rename column welcome_delivery_id to start_response_delivery_id`.execute(
      db,
    );
    await sql`alter table welcome_delivery_attempts rename to start_response_delivery_attempts`.execute(
      db,
    );
    await sql`alter table start_response_delivery_attempts rename constraint welcome_delivery_attempts_number_unique to start_response_delivery_attempts_number_unique`.execute(
      db,
    );
    await sql`alter table start_response_delivery_attempts rename constraint welcome_delivery_attempts_outcome_check to start_response_delivery_attempts_outcome_check`.execute(
      db,
    );

    await db.schema
      .createTable("link_transactions")
      .addColumn("link_transaction_ref", "text", (column) =>
        column.primaryKey(),
      )
      .addColumn("account_ref", "text", (column) => column.notNull())
      .addColumn("token_digest", "text", (column) => column.notNull().unique())
      .addColumn("return_correlation", "text", (column) => column.notNull())
      .addColumn("expires_at", "timestamptz", (column) => column.notNull())
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("registered"),
      )
      .addColumn("bot_identity", "text")
      .addColumn("candidate_telegram_user_id", "bigint")
      .addColumn("registered_at", "timestamptz", (column) => column.notNull())
      .addColumn("received_at", "timestamptz")
      .addColumn("confirmed_at", "timestamptz")
      .addCheckConstraint(
        "link_transactions_account_ref_check",
        sql`char_length(account_ref) between 1 and 256`,
      )
      .addCheckConstraint(
        "link_transactions_return_correlation_check",
        sql`char_length(return_correlation) between 1 and 256`,
      )
      .addCheckConstraint(
        "link_transactions_token_digest_check",
        sql`token_digest ~ '^[A-Za-z0-9_-]{43}$'`,
      )
      .addCheckConstraint(
        "link_transactions_state_check",
        sql`state in ('registered', 'received', 'linked', 'conflict')`,
      )
      .execute();

    await db.schema
      .createTable("platform_links")
      .addColumn("telegram_identity_ref", "text", (column) =>
        column.primaryKey(),
      )
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint", (column) => column.notNull())
      .addColumn("account_ref", "text", (column) => column.notNull())
      .addColumn("link_transaction_ref", "text", (column) =>
        column.notNull().references("link_transactions.link_transaction_ref"),
      )
      .addColumn("linked_at", "timestamptz", (column) => column.notNull())
      .addUniqueConstraint("platform_links_telegram_identity_unique", [
        "bot_identity",
        "telegram_user_id",
      ])
      .execute();

    await db.schema
      .createTable("identity_link_events")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("link_transaction_ref", "text", (column) =>
        column.notNull().references("link_transactions.link_transaction_ref"),
      )
      .addColumn("event_type", "text", (column) => column.notNull())
      .addColumn("occurred_at", "timestamptz", (column) => column.notNull())
      .addCheckConstraint(
        "identity_link_events_type_check",
        sql`event_type in ('registered', 'receipt_accepted', 'receipt_conflict', 'receipt_expired', 'receipt_replayed', 'confirmed', 'confirmation_idempotent', 'confirmation_expired', 'recovery_required')`,
      )
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("identity_link_events").execute();
    await db.schema.dropTable("platform_links").execute();
    await db.schema.dropTable("link_transactions").execute();

    await sql`alter table start_response_delivery_attempts rename constraint start_response_delivery_attempts_number_unique to welcome_delivery_attempts_number_unique`.execute(
      db,
    );
    await sql`alter table start_response_delivery_attempts rename constraint start_response_delivery_attempts_outcome_check to welcome_delivery_attempts_outcome_check`.execute(
      db,
    );
    await sql`alter table start_response_delivery_attempts rename to welcome_delivery_attempts`.execute(
      db,
    );
    await sql`alter table welcome_delivery_attempts rename column start_response_delivery_id to welcome_delivery_id`.execute(
      db,
    );
    await sql`alter index start_response_deliveries_send_idx rename to welcome_deliveries_send_idx`.execute(
      db,
    );
    await sql`alter table start_response_deliveries rename constraint start_response_deliveries_trigger_unique to welcome_deliveries_trigger_unique`.execute(
      db,
    );
    await sql`alter table start_response_deliveries rename constraint start_response_deliveries_state_check to welcome_deliveries_state_check`.execute(
      db,
    );
    await sql`alter table start_response_deliveries rename to welcome_deliveries`.execute(
      db,
    );
  },
};

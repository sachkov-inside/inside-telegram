import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const ordinaryStartMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("telegram_updates")
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("update_id", "bigint", (column) => column.notNull())
      .addColumn("payload", "jsonb")
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("process_attempt_count", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("available_at", "timestamptz", (column) =>
        column.notNull().defaultTo(sql`now()`),
      )
      .addColumn("received_at", "timestamptz", (column) =>
        column.notNull().defaultTo(sql`now()`),
      )
      .addColumn("locked_at", "timestamptz")
      .addColumn("processed_at", "timestamptz")
      .addColumn("failure_code", "text")
      .addPrimaryKeyConstraint("telegram_updates_pk", [
        "bot_identity",
        "update_id",
      ])
      .addCheckConstraint(
        "telegram_updates_state_check",
        sql`state in ('pending', 'processing', 'processed', 'failed')`,
      )
      .execute();

    await db.schema
      .createIndex("telegram_updates_process_idx")
      .on("telegram_updates")
      .columns(["state", "available_at", "update_id"])
      .execute();

    await db.schema
      .createTable("bot_contacts")
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint", (column) => column.notNull())
      .addColumn("private_chat_id", "bigint", (column) => column.notNull())
      .addColumn("contactability", "text", (column) => column.notNull())
      .addColumn("first_started_at", "timestamptz", (column) =>
        column.notNull(),
      )
      .addColumn("last_started_at", "timestamptz", (column) => column.notNull())
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .addPrimaryKeyConstraint("bot_contacts_pk", [
        "bot_identity",
        "telegram_user_id",
      ])
      .addUniqueConstraint("bot_contacts_private_chat_unique", [
        "bot_identity",
        "private_chat_id",
      ])
      .addCheckConstraint(
        "bot_contacts_contactability_check",
        sql`contactability in ('blocked', 'reachable')`,
      )
      .execute();

    await db.schema
      .createTable("bot_contact_events")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint", (column) => column.notNull())
      .addColumn("update_id", "bigint", (column) => column.notNull())
      .addColumn("event_type", "text", (column) => column.notNull())
      .addColumn("contactability", "text", (column) => column.notNull())
      .addColumn("observed_at", "timestamptz", (column) => column.notNull())
      .addUniqueConstraint("bot_contact_events_update_unique", [
        "bot_identity",
        "update_id",
        "event_type",
      ])
      .addCheckConstraint(
        "bot_contact_events_type_check",
        sql`event_type in ('start_observed', 'contactability_observed')`,
      )
      .addCheckConstraint(
        "bot_contact_events_contactability_check",
        sql`contactability in ('blocked', 'reachable')`,
      )
      .execute();

    await db.schema
      .createTable("welcome_deliveries")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint", (column) => column.notNull())
      .addColumn("private_chat_id", "bigint", (column) => column.notNull())
      .addColumn("trigger_update_id", "bigint", (column) => column.notNull())
      .addColumn("message_text", "text", (column) => column.notNull())
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("attempt_count", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("available_at", "timestamptz", (column) =>
        column.notNull().defaultTo(sql`now()`),
      )
      .addColumn("locked_at", "timestamptz")
      .addColumn("diagnostic_code", "text")
      .addColumn("delivered_at", "timestamptz")
      .addColumn("created_at", "timestamptz", (column) => column.notNull())
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .addUniqueConstraint("welcome_deliveries_trigger_unique", [
        "bot_identity",
        "trigger_update_id",
      ])
      .addCheckConstraint(
        "welcome_deliveries_state_check",
        sql`state in ('pending', 'sending', 'retry_scheduled', 'delivered', 'rejected', 'unknown_exhausted')`,
      )
      .execute();

    await db.schema
      .createIndex("welcome_deliveries_send_idx")
      .on("welcome_deliveries")
      .columns(["state", "available_at", "id"])
      .execute();

    await db.schema
      .createTable("welcome_delivery_attempts")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("welcome_delivery_id", "bigint", (column) =>
        column
          .notNull()
          .references("welcome_deliveries.id")
          .onDelete("cascade"),
      )
      .addColumn("attempt_number", "integer", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("provider_message_id", "bigint")
      .addColumn("provider_error_code", "integer")
      .addColumn("diagnostic_code", "text")
      .addColumn("attempted_at", "timestamptz", (column) => column.notNull())
      .addUniqueConstraint("welcome_delivery_attempts_number_unique", [
        "welcome_delivery_id",
        "attempt_number",
      ])
      .addCheckConstraint(
        "welcome_delivery_attempts_outcome_check",
        sql`outcome in ('delivered', 'api_rejected', 'api_retryable', 'transport_unknown')`,
      )
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("welcome_delivery_attempts").execute();
    await db.schema.dropTable("welcome_deliveries").execute();
    await db.schema.dropTable("bot_contact_events").execute();
    await db.schema.dropTable("bot_contacts").execute();
    await db.schema.dropTable("telegram_updates").execute();
  },
};

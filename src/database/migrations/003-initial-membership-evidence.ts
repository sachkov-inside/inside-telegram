import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const initialMembershipEvidenceMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("platform_links")
      .addColumn("evidence_version", "bigint", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();

    await db.schema
      .createTable("membership_checks")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("telegram_identity_ref", "text", (column) =>
        column
          .notNull()
          .references("platform_links.telegram_identity_ref")
          .onDelete("cascade"),
      )
      .addColumn("source_ref", "text", (column) => column.notNull().unique())
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("attempt_count", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("available_at", "timestamptz", (column) => column.notNull())
      .addColumn("locked_at", "timestamptz")
      .addColumn("completed_at", "timestamptz")
      .addColumn("diagnostic_code", "text")
      .addColumn("created_at", "timestamptz", (column) => column.notNull())
      .addCheckConstraint(
        "membership_checks_state_check",
        sql`state in ('pending', 'processing', 'completed')`,
      )
      .execute();

    await db.schema
      .createIndex("membership_checks_process_idx")
      .on("membership_checks")
      .columns(["state", "available_at", "id"])
      .execute();

    await sql`
      insert into membership_checks (
        telegram_identity_ref,
        source_ref,
        state,
        attempt_count,
        available_at,
        created_at
      )
      select
        telegram_identity_ref,
        link_transaction_ref,
        'pending',
        0,
        linked_at,
        linked_at
      from platform_links
      on conflict (source_ref) do nothing
    `.execute(db);

    await db.schema
      .createTable("membership_observations")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("observation_ref", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("telegram_identity_ref", "text", (column) =>
        column
          .notNull()
          .references("platform_links.telegram_identity_ref")
          .onDelete("cascade"),
      )
      .addColumn("normalized_state", "text", (column) => column.notNull())
      .addColumn("diagnostic_code", "text")
      .addColumn("raw_status", "text")
      .addColumn("raw_is_member", "boolean")
      .addColumn("evidence_ref", "text")
      .addColumn("evidence_version", "bigint")
      .addColumn("observed_at", "timestamptz", (column) => column.notNull())
      .addCheckConstraint(
        "membership_observations_state_check",
        sql`normalized_state in ('member', 'non_member', 'unavailable')`,
      )
      .addCheckConstraint(
        "membership_observations_evidence_check",
        sql`(
          normalized_state = 'unavailable'
          and evidence_ref is null
          and evidence_version is null
        ) or (
          normalized_state in ('member', 'non_member')
          and evidence_ref is not null
          and evidence_version is not null
        )`,
      )
      .execute();

    await db.schema
      .createTable("membership_evidence_outbox")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("observation_ref", "text", (column) =>
        column
          .notNull()
          .unique()
          .references("membership_observations.observation_ref")
          .onDelete("cascade"),
      )
      .addColumn("envelope", "jsonb", (column) => column.notNull())
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("attempt_count", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("available_at", "timestamptz", (column) => column.notNull())
      .addColumn("locked_at", "timestamptz")
      .addColumn("delivered_at", "timestamptz")
      .addColumn("diagnostic_code", "text")
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .addCheckConstraint(
        "membership_evidence_outbox_state_check",
        sql`state in ('pending', 'delivering', 'retry_scheduled', 'delivered', 'rejected')`,
      )
      .execute();

    await db.schema
      .createIndex("membership_evidence_outbox_delivery_idx")
      .on("membership_evidence_outbox")
      .columns(["state", "available_at", "id"])
      .execute();

    await db.schema
      .createTable("membership_provider_state")
      .addColumn("bot_identity", "text", (column) => column.primaryKey())
      .addColumn("canonical_chat_id", "bigint", (column) => column.notNull())
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("diagnostic_code", "text")
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .addCheckConstraint(
        "membership_provider_state_check",
        sql`state in ('ready', 'degraded', 'unavailable')`,
      )
      .execute();

    await db.schema
      .alterTable("start_response_deliveries")
      .addColumn("source_key", "text")
      .execute();
    await sql`
      update start_response_deliveries
      set source_key = 'telegram-update:' || bot_identity || ':' || trigger_update_id
    `.execute(db);
    await sql`
      alter table start_response_deliveries
      drop constraint start_response_deliveries_trigger_unique
    `.execute(db);
    await sql`
      alter table start_response_deliveries
      alter column trigger_update_id drop not null,
      alter column source_key set not null
    `.execute(db);
    await db.schema
      .alterTable("start_response_deliveries")
      .addUniqueConstraint("start_response_deliveries_source_unique", [
        "source_key",
      ])
      .execute();
    await db.schema
      .alterTable("start_response_deliveries")
      .addCheckConstraint(
        "start_response_deliveries_source_check",
        sql`char_length(source_key) between 1 and 256`,
      )
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await sql`
      delete from start_response_deliveries where trigger_update_id is null
    `.execute(db);
    await db.schema
      .alterTable("start_response_deliveries")
      .dropConstraint("start_response_deliveries_source_check")
      .execute();
    await db.schema
      .alterTable("start_response_deliveries")
      .dropConstraint("start_response_deliveries_source_unique")
      .execute();
    await sql`
      alter table start_response_deliveries
      alter column trigger_update_id set not null
    `.execute(db);
    await db.schema
      .alterTable("start_response_deliveries")
      .dropColumn("source_key")
      .execute();
    await db.schema
      .alterTable("start_response_deliveries")
      .addUniqueConstraint("start_response_deliveries_trigger_unique", [
        "bot_identity",
        "trigger_update_id",
      ])
      .execute();

    await db.schema.dropTable("membership_provider_state").execute();
    await db.schema.dropTable("membership_evidence_outbox").execute();
    await db.schema.dropTable("membership_observations").execute();
    await db.schema.dropTable("membership_checks").execute();
    await db.schema
      .alterTable("platform_links")
      .dropColumn("evidence_version")
      .execute();
  },
};

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const durableMembershipEventsMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("platform_links")
      .addColumn("last_membership_observation_at", "timestamptz")
      .addColumn("last_membership_observation_update_id", "bigint")
      .execute();
    await db.schema
      .alterTable("membership_provider_state")
      .addColumn("last_provider_observation_at", "timestamptz")
      .addColumn("last_provider_observation_update_id", "bigint")
      .execute();
    await db.schema
      .createTable("membership_provider_observations")
      .addColumn("id", "bigserial", (column) => column.primaryKey())
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("observed_at", "timestamptz", (column) => column.notNull())
      .addColumn("source_kind", "text", (column) => column.notNull())
      .addColumn("source_ref", "text", (column) => column.notNull())
      .addColumn("source_update_id", "bigint")
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("diagnostic_code", "text")
      .addUniqueConstraint("membership_provider_observations_source_unique", [
        "bot_identity",
        "source_kind",
        "source_ref",
      ])
      .addCheckConstraint(
        "membership_provider_observations_source_check",
        sql`source_kind in ('direct', 'event')`,
      )
      .addCheckConstraint(
        "membership_provider_observations_state_check",
        sql`state in ('ready', 'degraded', 'unavailable')`,
      )
      .execute();
    await db.schema
      .createIndex("membership_provider_observations_order_idx")
      .on("membership_provider_observations")
      .columns(["bot_identity", "observed_at", "id"])
      .execute();
    await db.schema
      .createTable("membership_event_audit")
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("update_id", "bigint", (column) => column.notNull())
      .addColumn("canonical_chat_id", "bigint", (column) => column.notNull())
      .addColumn("event_kind", "text", (column) => column.notNull())
      .addColumn("event_at", "timestamptz", (column) => column.notNull())
      .addColumn("actor_is_subject", "boolean")
      .addColumn("subject_linked", "boolean")
      .addColumn("normalized_state", "text")
      .addColumn("disposition", "text", (column) => column.notNull())
      .addColumn("diagnostic_code", "text")
      .addColumn("result_ref", "text")
      .addPrimaryKeyConstraint("membership_event_audit_pk", [
        "bot_identity",
        "update_id",
      ])
      .addCheckConstraint(
        "membership_event_audit_kind_check",
        sql`event_kind in ('subject', 'provider')`,
      )
      .addCheckConstraint(
        "membership_event_audit_state_check",
        sql`normalized_state in ('member', 'non_member', 'unavailable')`,
      )
      .addCheckConstraint(
        "membership_event_audit_disposition_check",
        sql`disposition in ('evidence', 'ignored_older', 'provider_state', 'unlinked_subject')`,
      )
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("membership_event_audit").execute();
    await db.schema.dropTable("membership_provider_observations").execute();
    await db.schema
      .alterTable("membership_provider_state")
      .dropColumn("last_provider_observation_update_id")
      .dropColumn("last_provider_observation_at")
      .execute();
    await db.schema
      .alterTable("platform_links")
      .dropColumn("last_membership_observation_update_id")
      .dropColumn("last_membership_observation_at")
      .execute();
  },
};

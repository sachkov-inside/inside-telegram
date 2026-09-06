import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

// 008/009 are reserved by the independently reviewed bot sign-in work.
export const communicationsTemplatesMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      create table communication_author_modes (
        bot_identity text not null,
        telegram_user_id bigint not null,
        account_ref text not null,
        enabled boolean not null,
        last_update_id bigint not null,
        primary key (bot_identity, telegram_user_id)
      );
      create table communication_templates (
        template_id uuid primary key,
        bot_identity text not null,
        owner_account_ref text not null,
        revision integer not null check (revision > 0),
        content jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table communication_operations (
        bot_identity text not null,
        operation_id uuid not null,
        actor_account_ref text not null,
        request jsonb not null,
        result jsonb not null,
        created_at timestamptz not null,
        primary key (bot_identity, operation_id)
      );
      create table communication_intake_receipts (
        bot_identity text not null,
        update_id bigint not null,
        outcome text not null,
        template_id uuid references communication_templates(template_id),
        primary key (bot_identity, update_id)
      );
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    for (const table of [
      "communication_intake_receipts",
      "communication_operations",
      "communication_templates",
      "communication_author_modes",
    ])
      await db.schema.dropTable(table).execute();
  },
};

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
export const notificationsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`create table notification_deliveries (
      delivery_ref uuid primary key, latest_operation uuid not null, result_revision integer not null default 0
    );
    create table notification_commands (
      operation_id uuid primary key, delivery_ref uuid not null references notification_deliveries,
      bot_identity text not null, command_revision bigint not null, payload_digest text not null,
      command jsonb not null, result jsonb not null, state text not null,
      category text not null check(category in ('subscription','material')),
      available_at timestamptz not null, retry_count integer not null default 0, created_at timestamptz not null,
      unique(delivery_ref, command_revision)
    );
    create index notification_due on notification_commands(bot_identity, category, available_at) where state in ('accepted','retrying');
    create table notification_attempts (
      attempt_ref uuid primary key, operation_id uuid not null references notification_commands,
      permit_ref uuid not null, started_at timestamptz not null,
      outcome text not null check(outcome in ('started','unknown','sent','not_sent','rejected')),
      receipt_ref uuid, provider_message_id text
    );
    create table notification_result_outbox (
      message_id uuid primary key, result jsonb not null, published_at timestamptz, created_at timestamptz not null
    );
    create index notification_outbox_pending on notification_result_outbox(created_at) where published_at is null;
    create table notification_quarantine (
      id uuid primary key default gen_random_uuid(), digest text not null, reason text not null,
      encrypted_payload text, created_at timestamptz not null
    );`.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop table notification_quarantine, notification_result_outbox, notification_attempts, notification_commands, notification_deliveries`.execute(
      db,
    );
  },
};

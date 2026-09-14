import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const subscriptionActivationMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`create table telegram_identity_reservations (
      bot_identity text not null, telegram_user_id bigint not null,
      identity_ref text not null unique, primary key(bot_identity, telegram_user_id)
    );
    insert into telegram_identity_reservations select bot_identity, telegram_user_id, telegram_identity_ref from platform_links;
    create table activation_attempts (
      attempt_id uuid primary key, bot_identity text not null, telegram_user_id bigint not null,
      private_chat_id bigint not null, identity_ref text not null, code text not null,
      trigger_update_id bigint not null, state text not null, evidence jsonb, result jsonb,
      created_at timestamptz not null, expires_at timestamptz not null,
      due_at timestamptz not null, lease_token uuid, lease_until timestamptz,
      attempts integer not null default 0, diagnostic_code text,
      unique(bot_identity, telegram_user_id, code)
    );
    create index activation_due on activation_attempts(due_at);
    alter table start_response_deliveries add column buttons jsonb;`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`alter table start_response_deliveries drop column buttons;
      drop table activation_attempts, telegram_identity_reservations`.execute(
      db,
    );
  },
};

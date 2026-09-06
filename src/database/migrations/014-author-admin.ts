import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
export const authorAdminMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      create table communication_author_sessions (
        bot_identity text not null, telegram_user_id bigint not null,
        account_ref text not null, state jsonb not null,
        primary key(bot_identity, telegram_user_id)
      );
      create table communication_author_receipts (
        bot_identity text not null, update_id bigint not null,
        primary key(bot_identity, update_id)
      );
      create table communication_author_outbox (
        sequence_id bigserial unique not null, delivery_id uuid primary key, bot_identity text not null,
        account_ref text not null, telegram_user_id bigint not null,
        telegram_identity_ref text not null, message jsonb not null,
        state text not null check(state in ('pending','sending','delivered','rejected','unknown')),
        created_at timestamptz not null, attempted_at timestamptz,
        available_at timestamptz not null default now(), attempt_count integer not null default 0,
        diagnostic_code text,
        provider_message_id text
      );
      create index communication_author_outbox_pending on communication_author_outbox(bot_identity, created_at) where state = 'pending';
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop table communication_author_outbox, communication_author_receipts, communication_author_sessions`.execute(
      db,
    );
  },
};

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * An ordinary `/start` checks every known ground as one group, so the person hears one outcome.
 * A ground check or owner link that confirms nothing leaves one review request per person.
 * A confirmed ground keeps its confirmation time, so a later retry result cannot hide it; a
 * confirmation from before this migration, including one already rescheduled for a retry, gets its
 * attempt's creation time.
 */
export const knownGroundChecksMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      alter table activation_attempts add column ground_check_id uuid;
      alter table activation_attempts add column confirmed_at timestamptz;
      update activation_attempts set confirmed_at = created_at
        where result->'value'->>'state' in ('active', 'already_active');
      create index activation_attempts_ground_check on activation_attempts
        (bot_identity, ground_check_id) where ground_check_id is not null;
      create table activation_review_requests (
        review_id uuid primary key,
        bot_identity text not null,
        telegram_user_id bigint not null,
        identity_ref text not null,
        account_ref text,
        outcomes jsonb not null,
        requested_at timestamptz not null,
        updated_at timestamptz not null,
        resolved_at timestamptz,
        resolution text check (resolution in ('confirmed', 'owner')),
        check ((resolved_at is null) = (resolution is null)),
        unique (bot_identity, telegram_user_id)
      );
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`
      drop table activation_review_requests;
      drop index activation_attempts_ground_check;
      alter table activation_attempts drop column confirmed_at;
      alter table activation_attempts drop column ground_check_id;
    `.execute(db);
  },
};

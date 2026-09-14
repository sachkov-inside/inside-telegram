import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const communityRestrictionsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table community_desired_states
      add column admission_restriction text not null default 'none'
        check (admission_restriction in ('none','moderation','external_unknown')),
      add column removal_origin text not null default 'none'
        check (removal_origin in ('none','bot_expiry','operator_restore','external_unknown')),
      add column restriction_revision bigint not null default 0,
      add column last_membership_event_at timestamptz;
      alter table community_effects add column join_invite_digest text, add column join_invite_expires_at timestamptz;
      create table community_restriction_decisions (operation_id uuid primary key, fingerprint text not null, actor_ref text not null, reason text not null, created_at timestamptz not null);`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`alter table community_desired_states
      drop column admission_restriction, drop column removal_origin, drop column restriction_revision, drop column last_membership_event_at;
      alter table community_effects drop column join_invite_digest, drop column join_invite_expires_at;
      drop table community_restriction_decisions`.execute(db);
  },
};

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const communityEffectProvenanceMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table community_desired_states
      add column last_membership_update_id bigint,
      add column confirmed_ban_attempt_id uuid;
      alter table community_effect_attempts add column restriction_revision bigint not null default 0;`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`alter table community_desired_states drop column last_membership_update_id, drop column confirmed_ban_attempt_id;
      alter table community_effect_attempts drop column restriction_revision;`.execute(
      db,
    );
  },
};

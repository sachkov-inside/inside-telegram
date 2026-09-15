import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * A Tribute removal is a known expiry origin that asks for a proactive return invite.
 * An observed ban without any recorded actor is kept apart from a recorded unknown actor.
 */
export const communityTributeReadmissionMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table community_desired_states
      drop constraint community_desired_states_removal_origin_check,
      add constraint community_desired_states_removal_origin_check
        check (removal_origin in ('none','bot_expiry','operator_restore','external_unknown','tribute_expiry','unexplained_ban')),
      add column readmission_requested_at timestamptz`.execute(db);
  },
  async down(db: Kysely<unknown>) {
    // The older provider does not know these origins, so each falls back to its fail-closed one.
    await sql`update community_desired_states set removal_origin = 'external_unknown'
        where removal_origin = 'tribute_expiry';
      update community_desired_states set removal_origin = 'none'
        where removal_origin = 'unexplained_ban';
      alter table community_desired_states
        drop column readmission_requested_at,
        drop constraint community_desired_states_removal_origin_check,
        add constraint community_desired_states_removal_origin_check
          check (removal_origin in ('none','bot_expiry','operator_restore','external_unknown'))`.execute(
      db,
    );
  },
};

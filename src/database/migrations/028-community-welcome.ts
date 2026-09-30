import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The first community right of an Account asks for one private welcome with its first link.
 * Accounts stored before this migration get none, so a release never greets existing people.
 */
export const communityWelcomeMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table community_desired_states
      add column welcome_state text not null default 'offered'
        check (welcome_state in ('not_due','requested','offered'));
      alter table community_desired_states alter column welcome_state drop default`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`alter table community_desired_states drop column welcome_state`.execute(
      db,
    );
  },
};

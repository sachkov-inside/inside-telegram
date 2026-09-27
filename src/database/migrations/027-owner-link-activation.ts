import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * An ordinary `/start` no longer checks known grounds (#115): only the owner's activation link
 * starts a check, so the grouping of one start's checks goes away. Confirmation times and the
 * owner's review queue stay.
 */
export const ownerLinkActivationMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      drop index activation_attempts_ground_check;
      alter table activation_attempts drop column ground_check_id;
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`
      alter table activation_attempts add column ground_check_id uuid;
      create index activation_attempts_ground_check on activation_attempts
        (bot_identity, ground_check_id) where ground_check_id is not null;
    `.execute(db);
  },
};

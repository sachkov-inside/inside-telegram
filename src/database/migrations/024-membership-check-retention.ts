import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Retention finds expired checks by time and keeps each identity's latest one; the identity
 * index also serves the current-outcome read.
 */
export const membershipCheckRetentionMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      create index membership_check_results_observed on membership_check_results
        (observed_at);
      create index membership_check_results_identity_latest on membership_check_results
        (telegram_identity_ref, observed_at, id);
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop index membership_check_results_identity_latest,
      membership_check_results_observed`.execute(db);
  },
};

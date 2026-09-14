import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const communityRestrictionAuditMigration: Migration = {
  async up(db: Kysely<unknown>) {
    // A historical fingerprint cannot recover the decision. Keep its replay receipt,
    // but leave the missing snapshot explicitly unknown rather than inventing history.
    await sql`alter table community_restriction_decisions add column audit jsonb
      check (audit is null or (jsonb_typeof(audit) = 'object' and audit->>'version' is not distinct from '1'))`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`alter table community_restriction_decisions drop column audit`.execute(
      db,
    );
  },
};

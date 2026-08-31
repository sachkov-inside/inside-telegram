import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const platformEvidenceConformanceMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("membership_evidence_outbox")
      .addColumn("source", "text")
      .execute();
    await sql`
      update membership_evidence_outbox
      set source = case
        when result_ref like 'membership-event:%' then 'member_status_event'
        when result_ref like 'reconciliation:%' then 'reconciliation'
        else 'link_time'
      end
    `.execute(db);
    await db.schema
      .alterTable("membership_evidence_outbox")
      .alterColumn("source", (column) => column.setNotNull())
      .execute();
    await db.schema
      .alterTable("membership_evidence_outbox")
      .addCheckConstraint(
        "membership_evidence_outbox_source_check",
        sql`source in ('link_time', 'member_status_event', 'reconciliation')`,
      )
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("membership_evidence_outbox")
      .dropConstraint("membership_evidence_outbox_source_check")
      .execute();
    await db.schema
      .alterTable("membership_evidence_outbox")
      .dropColumn("source")
      .execute();
  },
};

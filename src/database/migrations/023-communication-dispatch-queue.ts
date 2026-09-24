import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Dispatch reads due work from bounded index ranges: replies to a subscriber's own /start first,
 * then the funnel and broadcast backlog. Planning reads one enrollment's history by index.
 */
export const communicationDispatchQueueMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      create index communication_dispatch_replies on communication_deliveries
        (bot_identity, due_at, created_at, delivery_id)
        where completed_at is null and kind in ('intro','entry','fallback');
      create index communication_dispatch_backlog on communication_deliveries
        (bot_identity, due_at, created_at, delivery_id)
        where completed_at is null and kind in ('step','broadcast');
      create index communication_dispatch_claims on communication_deliveries
        (bot_identity, locked_at)
        where completed_at is null and locked_at is not null;
      create index communication_enrollment_history on communication_deliveries
        (contact_id, funnel_id);
      create index communication_funnel_enrollments on communication_enrollments
        (funnel_id, contact_id);
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop index communication_funnel_enrollments, communication_enrollment_history,
      communication_dispatch_claims, communication_dispatch_backlog, communication_dispatch_replies`.execute(
      db,
    );
  },
};

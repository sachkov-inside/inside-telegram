import { sql, type RawBuilder } from "kysely";

import type { Database } from "./database.js";

const DAY_MILLISECONDS = 86_400_000;
const BATCH = 1000;

/**
 * Technical records that no decision reads once they are old. Telegram redelivers an update
 * for about a day, so a month covers every replay a stored key or receipt can still stop.
 */
const OPERATIONAL_DAYS = 30;
const PUBLISHED_RESULT_DAYS = 7;

/**
 * Owner-decided periods (inside-telegram#91). Contact, link, Membership audit, communication
 * and notification history has no period and is kept.
 */
export interface RetentionPeriods {
  /** Membership check results with their evidence deliveries. */
  readonly membershipCheckDays: number;
}

/**
 * Deletes one bounded batch of each expired record kind. Returns how many rows were deleted;
 * a full batch means more remain.
 */
export async function purgeExpiredRecords(
  database: Database,
  now: Date,
  periods: RetentionPeriods,
): Promise<number> {
  const operational = daysBefore(now, OPERATIONAL_DAYS);
  const published = daysBefore(now, PUBLISHED_RESULT_DAYS);
  const checks = daysBefore(now, periods.membershipCheckDays);
  const batches: RawBuilder<unknown>[] = [
    // Settled updates keep only their deduplication key and redacted failure code.
    sql`delete from telegram_updates where (bot_identity, update_id) in (
      select bot_identity, update_id from telegram_updates
      where state in ('processed', 'failed')
        and available_at < ${operational} and processed_at < ${operational}
      limit ${BATCH})`,
    // A receipt only stops a replay of an update that is still stored.
    ...(
      [
        "communication_author_receipts",
        "communication_intake_receipts",
      ] as const
    ).map(
      (
        receipts,
      ) => sql`delete from ${sql.table(receipts)} where (bot_identity, update_id) in (
      select r.bot_identity, r.update_id from ${sql.table(receipts)} r
      where not exists (select 1 from telegram_updates u
        where u.bot_identity = r.bot_identity and u.update_id = r.update_id)
      limit ${BATCH})`,
    ),
    // Delivered or rejected replies; their attempts follow by cascade. Unknown outcomes stay.
    sql`delete from start_response_deliveries where id in (
      select id from start_response_deliveries
      where state in ('delivered', 'rejected') and available_at < ${operational}
      limit ${BATCH})`,
    sql`delete from membership_provider_observations where id in (
      select id from membership_provider_observations
      where observed_at < ${operational}
      limit ${BATCH})`,
    sql`delete from notification_result_outbox where message_id in (
      select message_id from notification_result_outbox
      where published_at < ${published}
      limit ${BATCH})`,
    // Each identity keeps its latest check, and a delivery still in flight keeps its check;
    // the evidence delivery follows by cascade.
    sql`delete from membership_check_results where id in (
      select c.id from membership_check_results c
      where c.observed_at < ${checks}
        and exists (select 1 from membership_check_results n
          where n.telegram_identity_ref = c.telegram_identity_ref
            and (n.observed_at, n.id) > (c.observed_at, c.id))
        and not exists (select 1 from membership_evidence_outbox o
          where o.result_ref = c.result_ref
            and o.state not in ('delivered', 'rejected'))
      limit ${BATCH})`,
  ];
  let deleted = 0;
  for (const batch of batches) {
    const result = await batch.execute(database);
    deleted += Number(result.numAffectedRows ?? 0n);
  }
  return deleted;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MILLISECONDS);
}

import { sql } from "kysely";

// Shared aliases: delivery d, funnel f, broadcast b, common intro i.
// Use the same owner boundary for history, explicit resolution and analytics.
export function deliveryOwnerPredicate(actor: string) {
  return sql<boolean>`(f.owner_account_ref=${actor} or b.owner_account_ref=${actor}
    or (d.funnel_id is null and d.broadcast_id is null and i.owner_account_ref=${actor}))`;
}

/** The cursor after a page read with one extra row, or null when the page is the last one. */
export function nextCursor<Row>(
  rows: readonly Row[],
  pageSize: number,
  cursor: (row: Row) => string,
): string | null {
  const last = rows.length > pageSize ? rows[pageSize - 1] : undefined;
  return last === undefined ? null : cursor(last);
}

/** The single row of an aggregate query, which Postgres returns even for no input rows. */
export function aggregateRow<Row>(result: {
  readonly rows: readonly Row[];
}): Row {
  const row = result.rows[0];
  if (row === undefined) throw new Error("Aggregate query returned no row");
  return row;
}

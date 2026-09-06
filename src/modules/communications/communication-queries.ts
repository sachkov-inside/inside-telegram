import { sql } from "kysely";

// Shared aliases: delivery d, funnel f, broadcast b, common intro i.
// Use the same owner boundary for history, explicit resolution and analytics.
export function deliveryOwnerPredicate(actor: string) {
  return sql<boolean>`(f.owner_account_ref=${actor} or b.owner_account_ref=${actor}
    or (d.funnel_id is null and d.broadcast_id is null and i.owner_account_ref=${actor}))`;
}

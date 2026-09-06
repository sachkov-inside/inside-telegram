import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
} from "./communications-contract.js";
import { uuidCursor } from "./broadcasts.js";
type Tx = Transaction<DatabaseSchema>;
type Entry = {
  sourceId: string | null;
  sourceCode: string | null;
  funnelId: string | null;
  enteredAt: string;
  outcome: string;
};
type Counts = {
  sent: number;
  suppressed: number;
  failed: number;
  unknown: number;
  partialCancelled: number;
  pending: number;
};
export type StatisticsResult = {
  statistics: {
    totalBotContacts: number;
    reachable: number;
    blocked: number;
    marketingOff: number;
    uniqueParticipants: number;
    deliveries: Counts;
    trackingHits: number;
    uniqueTokensWithHits: number;
    knownAutomationHits: number;
    analyticsLagSeconds: number;
    contacts: {
      contactId: string;
      reachable: boolean;
      marketingEnabled: boolean;
      firstSourceId: string | null;
      latestSourceId: string | null;
      entries: Entry[];
      nextEntryCursor: string | null;
    }[];
    nextCursor: string | null;
  };
};
export type EntriesResult = { entries: Entry[]; nextCursor: string | null };
async function assertScope(
  tx: Tx,
  request: CommunicationsRequest,
  bot: string,
  actor: string,
) {
  if (request.payload.funnelId) {
    const row = await tx
      .selectFrom("communication_funnels")
      .select("funnel_id")
      .where("funnel_id", "=", request.payload.funnelId)
      .where("bot_identity", "=", bot)
      .where("owner_account_ref", "=", actor)
      .executeTakeFirst();
    if (!row) throw new CommunicationsError("not_found");
  }
  if (request.payload.broadcastId) {
    const row = await tx
      .selectFrom("communication_broadcasts")
      .select("broadcast_id")
      .where("broadcast_id", "=", request.payload.broadcastId)
      .where("bot_identity", "=", bot)
      .where("owner_account_ref", "=", actor)
      .executeTakeFirst();
    if (!row) throw new CommunicationsError("not_found");
  }
}
function entryQuery(tx: Tx, bot: string, actor: string, contactId: string) {
  return tx
    .selectFrom("communication_entries as e")
    .leftJoin("communication_funnels as f", "f.funnel_id", "e.funnel_id")
    .selectAll("e")
    .where("e.bot_identity", "=", bot)
    .where("e.contact_id", "=", contactId)
    .where((eb) =>
      eb.or([
        eb("f.owner_account_ref", "=", actor),
        eb("e.funnel_id", "is", null),
      ]),
    );
}
function entryView(row: {
  source_id: string | null;
  source_code: string | null;
  funnel_id: string | null;
  entered_at: Date;
  outcome: string;
}): Entry {
  return {
    sourceId: row.source_id,
    sourceCode: row.source_code,
    funnelId: row.funnel_id,
    enteredAt: row.entered_at.toISOString(),
    outcome: row.outcome,
  };
}
export async function readEntries(
  tx: Tx,
  request: CommunicationsRequest,
  bot: string,
  actor: string,
): Promise<EntriesResult> {
  let query = entryQuery(tx, bot, actor, request.payload.contactId!);
  if (request.payload.cursor) {
    const decoded = Buffer.from(request.payload.cursor, "base64url").toString();
    if (
      !/^[0-9]{1,19}$/.test(decoded) ||
      BigInt(decoded) > 9223372036854775807n
    )
      throw new CommunicationsError("malformed");
    query = query.where("e.update_id", ">", decoded);
  }
  const rows = await query.orderBy("e.update_id").limit(101).execute();
  return {
    entries: rows.slice(0, 100).map(entryView),
    nextCursor:
      rows.length > 100
        ? Buffer.from(rows[99]!.update_id).toString("base64url")
        : null,
  };
}
export async function readStatistics(
  tx: Tx,
  request: CommunicationsRequest,
  bot: string,
  actor: string,
): Promise<StatisticsResult> {
  await assertScope(tx, request, bot, actor);
  const funnel = request.payload.funnelId ?? null;
  const broadcast = request.payload.broadcastId ?? null;
  const totals = await sql<{
    total: number;
    reachable: number;
    blocked: number;
    off: number;
  }>`
    select count(*)::int total, count(*) filter(where b.contactability='reachable')::int reachable,
      count(*) filter(where b.contactability='blocked')::int blocked,
      count(*) filter(where not coalesce(c.marketing_enabled,true))::int off
    from bot_contacts b left join communication_contacts c using(bot_identity,telegram_user_id) where b.bot_identity=${bot}`.execute(
    tx,
  );
  const participants = await sql<{
    count: number;
  }>`select count(distinct e.contact_id)::int count from communication_enrollments e
    join communication_funnels f using(funnel_id) where f.bot_identity=${bot} and f.owner_account_ref=${actor}
    and (${funnel}::uuid is null or e.funnel_id=${funnel}::uuid)`.execute(tx);
  const deliveryScope = sql`d.bot_identity=${bot}
    and (f.owner_account_ref=${actor} or b.owner_account_ref=${actor} or (d.funnel_id is null and d.broadcast_id is null and i.owner_account_ref=${actor}))
    and (${funnel}::uuid is null or d.funnel_id=${funnel}::uuid)
    and (${broadcast}::uuid is null or d.broadcast_id=${broadcast}::uuid)`;
  const counts = await sql<Counts>`with deliveries as (
    select d.* from communication_deliveries d left join communication_funnels f using(funnel_id)
    left join communication_broadcasts b using(broadcast_id) left join communication_intro i on i.bot_identity=d.bot_identity where ${deliveryScope}
  ), parts as (select jsonb_array_elements(parts)->>'state' state from deliveries)
  select count(*) filter(where state='sent')::int sent, count(*) filter(where state='suppressed')::int suppressed,
    count(*) filter(where state='failed')::int failed, count(*) filter(where state='unknown')::int unknown,
    count(*) filter(where state in ('pending','in_flight'))::int pending,
    (select count(*)::int from deliveries where completed_at is not null and parts @> '[{"state":"sent"}]'::jsonb
      and (parts @> '[{"state":"cancelled"}]'::jsonb or parts @> '[{"state":"suppressed"}]'::jsonb)) as "partialCancelled"
    from parts`.execute(tx);
  const hits = await sql<{
    hits: number;
    tokens: number;
    automation: number;
    lag: number;
  }>`
    select count(*) filter(where h.traffic='unknown')::int hits,
      count(distinct h.token) filter(where h.traffic='unknown')::int tokens,
      count(*) filter(where h.traffic='known_automation')::int automation,
      coalesce(ceil(max(greatest(0,extract(epoch from h.received_at-h.occurred_at)))),0)::int lag
    from communication_tracking_hits h join communication_tracking_tokens t using(token)
    join communication_deliveries d on d.delivery_id=t.delivery_id
    left join communication_funnels f using(funnel_id) left join communication_broadcasts b using(broadcast_id)
    left join communication_intro i on i.bot_identity=d.bot_identity where ${deliveryScope}`.execute(
    tx,
  );
  let contacts = tx
    .selectFrom("communication_contacts as c")
    .innerJoin("bot_contacts as b", (j) =>
      j
        .onRef("b.bot_identity", "=", "c.bot_identity")
        .onRef("b.telegram_user_id", "=", "c.telegram_user_id"),
    )
    .select(["c.contact_id", "c.marketing_enabled", "b.contactability"])
    .where("c.bot_identity", "=", bot);
  if (funnel)
    contacts = contacts.where((eb) =>
      eb.exists(
        eb
          .selectFrom("communication_enrollments as e")
          .select("e.contact_id")
          .whereRef("e.contact_id", "=", "c.contact_id")
          .where("e.funnel_id", "=", funnel),
      ),
    );
  if (broadcast)
    contacts = contacts.where((eb) =>
      eb.exists(
        eb
          .selectFrom("communication_deliveries as d")
          .select("d.contact_id")
          .whereRef("d.contact_id", "=", "c.contact_id")
          .where("d.broadcast_id", "=", broadcast),
      ),
    );
  if (request.payload.cursor)
    contacts = contacts.where(
      "c.contact_id",
      ">",
      uuidCursor(request.payload.cursor),
    );
  const rows = await contacts.orderBy("c.contact_id").limit(101).execute();
  const page: StatisticsResult["statistics"]["contacts"] = [];
  for (const row of rows.slice(0, 100)) {
    const history = await readEntries(
      tx,
      { ...request, payload: { contactId: row.contact_id } },
      bot,
      actor,
    );
    const first = await entryQuery(tx, bot, actor, row.contact_id)
      .orderBy("e.update_id")
      .limit(1)
      .executeTakeFirst();
    const latest = await entryQuery(tx, bot, actor, row.contact_id)
      .orderBy("e.update_id", "desc")
      .limit(1)
      .executeTakeFirst();
    page.push({
      contactId: row.contact_id,
      reachable: row.contactability === "reachable",
      marketingEnabled: row.marketing_enabled,
      firstSourceId: first?.source_id ?? null,
      latestSourceId: latest?.source_id ?? null,
      entries: history.entries,
      nextEntryCursor: history.nextCursor,
    });
  }
  const total = totals.rows[0]!;
  const hit = hits.rows[0]!;
  return {
    statistics: {
      totalBotContacts: total.total,
      reachable: total.reachable,
      blocked: total.blocked,
      marketingOff: total.off,
      uniqueParticipants: participants.rows[0]!.count,
      deliveries: counts.rows[0]!,
      trackingHits: hit.hits,
      uniqueTokensWithHits: hit.tokens,
      knownAutomationHits: hit.automation,
      analyticsLagSeconds: hit.lag,
      contacts: page,
      nextCursor: rows.length > 100 ? rows[99]!.contact_id : null,
    },
  };
}

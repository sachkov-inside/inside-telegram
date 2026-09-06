import { randomUUID } from "node:crypto";
import { sql, type Transaction, type Selectable } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
  validateContent,
} from "./communications-contract.js";
import { planDelivery } from "./communication-state.js";
import { cancelDelivery } from "./funnel-timeline.js";
import type { MessagePart } from "./funnel-types.js";

type Broadcast = Selectable<DatabaseSchema["communication_broadcasts"]>;
type Audience = NonNullable<CommunicationsRequest["payload"]["audience"]>;
type Tx = Transaction<DatabaseSchema>;
export function broadcastView(row: Broadcast) {
  return {
    broadcastId: row.broadcast_id,
    revision: row.revision,
    state: row.state,
    parts: row.parts as MessagePart[],
    audience: row.audience as Audience,
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    audienceSnapshotId: row.audience_snapshot_id,
    snapshotSize: row.snapshot_size,
  };
}
export type BroadcastResult =
  | { broadcast: ReturnType<typeof broadcastView> }
  | {
      broadcasts: ReturnType<typeof broadcastView>[];
      nextCursor: string | null;
    };

// Author operations and scheduler hold the same bot scheduler lock as stop/dispatch.
export async function applyBroadcast(
  tx: Tx,
  request: CommunicationsRequest,
  bot: string,
  actor: string,
  now: Date,
): Promise<BroadcastResult> {
  const { operation, payload, expectedRevision } = request;
  if (operation === "broadcasts.list") {
    let query = tx
      .selectFrom("communication_broadcasts")
      .selectAll()
      .where("bot_identity", "=", bot)
      .where("owner_account_ref", "=", actor);
    if (payload.cursor)
      query = query.where("broadcast_id", ">", uuidCursor(payload.cursor));
    const rows = await query.orderBy("broadcast_id").limit(101).execute();
    return {
      broadcasts: rows.slice(0, 100).map(broadcastView),
      nextCursor: rows.length > 100 ? rows[99]!.broadcast_id : null,
    };
  }
  let row = await tx
    .selectFrom("communication_broadcasts")
    .selectAll()
    .where("broadcast_id", "=", payload.broadcastId!)
    .executeTakeFirst();
  if (row && (row.bot_identity !== bot || row.owner_account_ref !== actor))
    throw new CommunicationsError("not_found");
  if (operation === "broadcasts.read") {
    if (!row) throw new CommunicationsError("not_found");
    return { broadcast: broadcastView(row) };
  }
  if ((row?.revision ?? 0) !== expectedRevision)
    throw new CommunicationsError("revision_conflict");
  if (operation === "broadcasts.save") {
    if (
      row &&
      (row.audience_snapshot_id ||
        !["draft", "scheduled", "paused"].includes(row.state))
    )
      throw new CommunicationsError("revision_conflict");
    const parts = payload.parts!;
    if (new Set(parts.map((p) => p.partId)).size !== parts.length)
      throw new CommunicationsError("unsupported_content");
    parts.forEach((p) => validateContent(p.content));
    const audience = payload.audience!;
    if (audience.kind === "funnels") {
      const ids = [...new Set(audience.funnelIds)];
      const owned = await tx
        .selectFrom("communication_funnels")
        .select("funnel_id")
        .where("bot_identity", "=", bot)
        .where("owner_account_ref", "=", actor)
        .where("funnel_id", "in", ids)
        .execute();
      if (owned.length !== ids.length)
        throw new CommunicationsError("not_found");
    }
    row = await tx
      .insertInto("communication_broadcasts")
      .values({
        broadcast_id: payload.broadcastId!,
        bot_identity: bot,
        owner_account_ref: actor,
        revision: expectedRevision + 1,
        state: "draft",
        parts: JSON.stringify(parts),
        audience: JSON.stringify(audience),
        scheduled_at: payload.scheduledAt
          ? new Date(payload.scheduledAt)
          : null,
        audience_snapshot_id: null,
        snapshot_size: 0,
        launched_at: null,
        launch_operation_id: null,
        created_at: now,
      })
      .onConflict((c) =>
        c.column("broadcast_id").doUpdateSet({
          revision: expectedRevision + 1,
          parts: JSON.stringify(parts),
          audience: JSON.stringify(audience),
          scheduled_at: payload.scheduledAt
            ? new Date(payload.scheduledAt)
            : null,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  } else {
    if (!row) throw new CommunicationsError("not_found");
    if (["cancelled", "completed"].includes(row.state))
      throw new CommunicationsError("revision_conflict");
    if (operation === "broadcasts.launch") {
      if (row.state !== "draft" || row.audience_snapshot_id)
        throw new CommunicationsError("revision_conflict");
      row = await tx
        .updateTable("communication_broadcasts")
        .set({
          state: "scheduled",
          revision: row.revision + 1,
          launch_operation_id: request.operationId,
        })
        .where("broadcast_id", "=", row.broadcast_id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (!row.scheduled_at || row.scheduled_at <= now)
        row = await launchBroadcast(tx, row, now);
    } else if (operation === "broadcasts.lifecycle") {
      let state: Broadcast["state"];
      if (payload.action === "cancel") state = "cancelled";
      else if (
        payload.action === "pause" &&
        ["scheduled", "running"].includes(row.state)
      )
        state = "paused";
      else if (payload.action === "resume" && row.state === "paused")
        state = row.audience_snapshot_id ? "running" : "scheduled";
      else throw new CommunicationsError("revision_conflict");
      if (state === "cancelled") {
        const deliveries = await tx
          .selectFrom("communication_deliveries")
          .selectAll()
          .where("broadcast_id", "=", row.broadcast_id)
          .where("completed_at", "is", null)
          .execute();
        for (const delivery of deliveries)
          await cancelDelivery(tx, delivery, now, "broadcast_cancelled");
      }
      row = await tx
        .updateTable("communication_broadcasts")
        .set({ state, revision: row.revision + 1 })
        .where("broadcast_id", "=", row.broadcast_id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else throw new CommunicationsError("not_implemented");
  }
  return { broadcast: broadcastView(row) };
}
export function uuidCursor(cursor: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      cursor,
    )
  )
    throw new CommunicationsError("malformed");
  return cursor;
}
async function launchBroadcast(
  tx: Tx,
  row: Broadcast,
  now: Date,
): Promise<Broadcast> {
  if (row.audience_snapshot_id) return row;
  // All includes legacy contacts who never entered a marketing funnel. No enrollment is created.
  await sql`insert into communication_contacts(contact_id,bot_identity,telegram_user_id)
    select gen_random_uuid(),bot_identity,telegram_user_id from bot_contacts where bot_identity=${row.bot_identity}
    on conflict(bot_identity,telegram_user_id) do nothing`.execute(tx);
  const audience = row.audience as Audience;
  let query = tx
    .selectFrom("communication_contacts as c")
    .innerJoin("bot_contacts as b", (j) =>
      j
        .onRef("b.bot_identity", "=", "c.bot_identity")
        .onRef("b.telegram_user_id", "=", "c.telegram_user_id"),
    )
    .select("c.contact_id")
    .where("c.bot_identity", "=", row.bot_identity)
    .where("c.marketing_enabled", "=", true)
    .where("b.contactability", "=", "reachable");
  if (audience.kind === "funnels")
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("communication_enrollments as e")
          .select("e.contact_id")
          .whereRef("e.contact_id", "=", "c.contact_id")
          .where("e.funnel_id", "in", audience.funnelIds),
      ),
    );
  const contacts = await query.execute();
  for (const contact of contacts)
    await planDelivery(tx, {
      bot: row.bot_identity,
      contactId: contact.contact_id,
      broadcastId: row.broadcast_id,
      kind: "broadcast",
      key: `broadcast:${row.broadcast_id}:${contact.contact_id}`,
      parts: row.parts as MessagePart[],
      revision: row.revision,
      dueAt: now,
      now,
    });
  return tx
    .updateTable("communication_broadcasts")
    .set({
      state: contacts.length ? "running" : "completed",
      audience_snapshot_id: randomUUID(),
      snapshot_size: contacts.length,
      launched_at: now,
      revision: row.revision + 1,
    })
    .where("broadcast_id", "=", row.broadcast_id)
    .returningAll()
    .executeTakeFirstOrThrow();
}
export async function reconcileBroadcasts(
  tx: Tx,
  bot: string,
  now: Date,
): Promise<void> {
  const scheduled = await tx
    .selectFrom("communication_broadcasts")
    .selectAll()
    .where("bot_identity", "=", bot)
    .where("state", "=", "scheduled")
    .where((eb) =>
      eb.or([eb("scheduled_at", "is", null), eb("scheduled_at", "<=", now)]),
    )
    .execute();
  for (const row of scheduled) await launchBroadcast(tx, row, now);
  await tx
    .updateTable("communication_broadcasts")
    .set((eb) => ({ state: "completed", revision: eb("revision", "+", 1) }))
    .where("bot_identity", "=", bot)
    .where("state", "in", ["running", "paused"])
    .where("audience_snapshot_id", "is not", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("communication_deliveries as d")
            .select("d.delivery_id")
            .whereRef(
              "d.broadcast_id",
              "=",
              "communication_broadcasts.broadcast_id",
            )
            .where("d.completed_at", "is", null),
        ),
      ),
    )
    .execute();
}

import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import type { MessagePart } from "./funnel-types.js";
import { aggregateRow } from "./communication-queries.js";
export async function communicationLock(
  tx: Transaction<DatabaseSchema>,
  key: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
    tx,
  );
}
// Planning, dispatch, results and author operations of one bot.
export async function schedulerLock(
  tx: Transaction<DatabaseSchema>,
  bot: string,
): Promise<void> {
  await communicationLock(tx, `communications-scheduler:${bot}`);
}
// One BotContact's communication state: /start, stop/resume, contactability, entry, an operator
// decision on its delivery, and the dispatch claim, result and stale-claim recovery. It never
// serializes other contacts.
function contactKey(bot: string, telegramUserId: string): string {
  return `communications-contact:${bot}:${telegramUserId}`;
}
export async function contactLock(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  telegramUserId: string,
): Promise<void> {
  await communicationLock(tx, contactKey(bot, telegramUserId));
}
export async function tryContactLock(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  telegramUserId: string,
): Promise<boolean> {
  const result = await sql<{
    locked: boolean;
  }>`select pg_try_advisory_xact_lock(hashtextextended(${contactKey(bot, telegramUserId)}, 0)) as locked`.execute(
    tx,
  );
  return aggregateRow(result).locked;
}
// Locks the BotContact that owns this delivery, if the delivery exists.
export async function lockDeliveryContact(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  deliveryId: string,
): Promise<void> {
  const owner = await tx
    .selectFrom("communication_deliveries as d")
    .innerJoin("communication_contacts as c", "c.contact_id", "d.contact_id")
    .select("c.telegram_user_id")
    .where("d.bot_identity", "=", bot)
    .where("d.delivery_id", "=", deliveryId)
    .executeTakeFirst();
  if (owner) await contactLock(tx, bot, owner.telegram_user_id);
}
// Audience-wide writes hold the bot scheduler lock and cannot take thousands of advisory locks.
// Row locks, which need no shared lock memory, order them with a contact whose availability
// changes at the same time; that change locks the same row. An array parameter avoids the
// statement parameter limit.
export async function lockContactRows(
  tx: Transaction<DatabaseSchema>,
  contactIds: readonly string[],
): Promise<void> {
  if (!contactIds.length) return;
  await tx
    .selectFrom("communication_contacts")
    .select("contact_id")
    .where(sql<boolean>`contact_id = any(${[...new Set(contactIds)]}::uuid[])`)
    .orderBy("contact_id")
    .forNoKeyUpdate()
    .execute();
}
type PlannedDelivery = {
  bot: string;
  contactId: string;
  funnelId?: string;
  stepId?: string;
  kind: "intro" | "entry" | "step" | "fallback" | "broadcast";
  broadcastId?: string;
  key: string;
  parts: readonly MessagePart[];
  revision: number;
  dueAt: Date;
  now: Date;
};
export async function planDelivery(
  tx: Transaction<DatabaseSchema>,
  input: PlannedDelivery,
): Promise<void> {
  await planDeliveries(tx, [input]);
}
// Idempotent by dedup key. A broadcast snapshot is planned in chunks of this size.
export async function planDeliveries(
  tx: Transaction<DatabaseSchema>,
  inputs: readonly PlannedDelivery[],
): Promise<void> {
  for (let i = 0; i < inputs.length; i += 1000)
    await tx
      .insertInto("communication_deliveries")
      .values(
        inputs.slice(i, i + 1000).map((input) => ({
          delivery_id: randomUUID(),
          dedup_key: input.key,
          bot_identity: input.bot,
          contact_id: input.contactId,
          funnel_id: input.funnelId ?? null,
          step_id: input.stepId ?? null,
          kind: input.kind,
          broadcast_id: input.broadcastId ?? null,
          published_revision: input.revision,
          snapshot: JSON.stringify(input.parts),
          parts: JSON.stringify(
            input.parts.map((p) => ({
              partId: p.partId,
              state: "pending",
              diagnosticCode: null,
              attempts: [],
            })),
          ),
          revision: 1,
          due_at: input.dueAt,
          created_at: input.now,
          completed_at: null,
          cancel_requested: false,
          attempt_id: null,
          locked_at: null,
        })),
      )
      .onConflict((c) => c.column("dedup_key").doNothing())
      .execute();
}
/**
 * The result an operation stored in communication_operations. A replay returns it only after
 * matching the same actor and the deep-equal request, so the row was written by this operation.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the type its own operation stored
export function replayedResult<Result>(receipt: {
  readonly result: unknown;
}): Result {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the matched request fixes the stored result type
  return receipt.result as Result;
}

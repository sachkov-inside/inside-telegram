import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import type { MessagePart } from "./funnel-types.js";
export async function communicationLock(
  tx: Transaction<DatabaseSchema>,
  key: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
    tx,
  );
}
export async function planDelivery(
  tx: Transaction<DatabaseSchema>,
  input: {
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
  },
): Promise<void> {
  await tx
    .insertInto("communication_deliveries")
    .values({
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
    })
    .onConflict((c) => c.column("dedup_key").doNothing())
    .execute();
}

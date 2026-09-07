import { isDeepStrictEqual } from "node:util";
import type { Selectable, Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import { planDelivery } from "./communication-state.js";
import type { DeliveryPart, FunnelDraft, MessagePart } from "./funnel-types.js";

type Delivery = Selectable<DatabaseSchema["communication_deliveries"]>;
export function relativeDue(
  enrolled: Date,
  firstPublished: Date,
  previous: Date,
  delay: number,
): Date {
  return new Date(
    Math.max(+enrolled, +firstPublished, +previous) + delay * 1000,
  );
}
export function terminal(parts: readonly DeliveryPart[]): boolean {
  return parts.every((p) =>
    ["sent", "cancelled", "skipped", "suppressed"].includes(p.state),
  );
}
export function started(delivery: Delivery): boolean {
  return (delivery.parts as DeliveryPart[]).some(
    (p) => p.attempts.length > 0 || p.state === "in_flight",
  );
}
export async function cancelDelivery(
  tx: Transaction<DatabaseSchema>,
  delivery: Delivery,
  now: Date,
  reason: string,
): Promise<void> {
  if (delivery.completed_at) return;
  const parts = delivery.parts as DeliveryPart[];
  for (const part of parts) {
    if (part.state === "pending" || part.state === "failed") {
      part.state =
        delivery.kind === "broadcast" && reason === "marketing_unavailable"
          ? "suppressed"
          : "cancelled";
      part.diagnosticCode = reason;
    }
  }
  await tx
    .updateTable("communication_deliveries")
    .set({
      cancel_requested: true,
      cancellation_reason: reason,
      parts: JSON.stringify(parts),
      revision: delivery.revision + 1,
      completed_at: terminal(parts) ? now : null,
    })
    .where("delivery_id", "=", delivery.delivery_id)
    .execute();
}

// All callers hold the bot scheduler transaction lock. A resume computes the virtual
// timeline once, using the current order; ordinary reconciliation never consumes missed steps.
export async function reconcileFunnels(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  now: Date,
  suppressContactId?: string,
): Promise<void> {
  let query = tx
    .selectFrom("communication_enrollments as e")
    .innerJoin("communication_funnels as f", "f.funnel_id", "e.funnel_id")
    .selectAll("e")
    .select(["f.published", "f.published_revision"])
    .where("f.bot_identity", "=", bot)
    .where("f.published", "is not", null);
  if (suppressContactId)
    query = query.where("e.contact_id", "=", suppressContactId);
  for (const enrollment of await query.execute()) {
    const draft = enrollment.published as FunnelDraft;
    let history = await tx
      .selectFrom("communication_deliveries")
      .selectAll()
      .where("contact_id", "=", enrollment.contact_id)
      .where("funnel_id", "=", enrollment.funnel_id)
      .execute();
    for (const delivery of history) {
      if (
        delivery.kind === "step" &&
        !draft.steps.some((s) => s.stepId === delivery.step_id)
      )
        await cancelDelivery(tx, delivery, now, "step_deleted");
    }
    history = await tx
      .selectFrom("communication_deliveries")
      .selectAll()
      .where("contact_id", "=", enrollment.contact_id)
      .where("funnel_id", "=", enrollment.funnel_id)
      .execute();
    const initial = history.find(
      (d) => d.dedup_key === enrollment.initial_entry_key,
    );
    if (!initial?.completed_at) continue;
    // Started work owns the lane even after reorder/delete. Pending work can change order.
    if (history.some((d) => d.kind === "step" && !d.completed_at && started(d)))
      continue;
    let previous = new Date(
      Math.max(
        +initial.completed_at,
        ...history
          .filter((d) => d.kind === "step" && d.completed_at)
          .map((d) => +d.completed_at!),
      ),
    );
    for (const step of draft.steps) {
      const old = history.find(
        (d) => d.kind === "step" && d.step_id === step.stepId,
      );
      if (old?.completed_at) continue;
      const definition = await tx
        .selectFrom("communication_step_ids")
        .select("first_published_at")
        .where("funnel_id", "=", draft.funnelId)
        .where("step_id", "=", step.stepId)
        .executeTakeFirstOrThrow();
      const due =
        step.delayAnchor === "entry"
          ? new Date(+enrollment.enrolled_at + step.delaySeconds * 1000)
          : relativeDue(
              enrollment.enrolled_at,
              definition.first_published_at,
              previous,
              step.delaySeconds,
            );
      const suppressed = suppressContactId !== undefined && +due <= +now;
      const parts: DeliveryPart[] = step.parts.map((p) => ({
        partId: p.partId,
        state: suppressed ? "suppressed" : "pending",
        diagnosticCode: suppressed ? "marketing_unavailable" : null,
        attempts: [],
      }));
      if (!old) {
        await planDelivery(tx, {
          bot,
          contactId: enrollment.contact_id,
          funnelId: draft.funnelId,
          stepId: step.stepId,
          kind: "step",
          key: `step:${enrollment.enrollment_id}:${step.stepId}`,
          parts: step.parts,
          revision: enrollment.published_revision!,
          now,
          dueAt: due,
        });
      }
      if (
        !old ||
        +old.due_at !== +due ||
        old.published_revision !== enrollment.published_revision ||
        !isDeepStrictEqual(old.snapshot, step.parts) ||
        suppressed
      ) {
        await tx
          .updateTable("communication_deliveries")
          .set({
            snapshot: JSON.stringify(step.parts),
            parts: JSON.stringify(parts),
            published_revision: enrollment.published_revision!,
            due_at: due,
            revision: (old?.revision ?? 1) + 1,
            completed_at: suppressed ? due : null,
          })
          .where(
            "dedup_key",
            "=",
            `step:${enrollment.enrollment_id}:${step.stepId}`,
          )
          .execute();
      }
      if (!suppressed) break;
      previous = due;
    }
  }
}

export function deliveryView(r: Delivery) {
  return {
    deliveryId: r.delivery_id,
    revision: r.revision,
    contactId: r.contact_id,
    funnelId: r.funnel_id,
    broadcastId: r.broadcast_id,
    stepId: r.step_id,
    publishedRevision: r.published_revision,
    snapshot: r.snapshot as MessagePart[],
    parts: r.parts as DeliveryPart[],
    cancelRequested: r.cancel_requested,
    completedAt: r.completed_at?.toISOString() ?? null,
  };
}

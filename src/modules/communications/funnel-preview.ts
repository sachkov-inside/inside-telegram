import { isDeepStrictEqual } from "node:util";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import type { FunnelDraft } from "./funnel-types.js";

export interface FunnelPreview {
  funnelId: string;
  revision: number;
  addedStepIds: string[];
  editedStepIds: string[];
  deletedStepIds: string[];
  reorderedStepIds: string[];
  eligibleContacts: number;
  completedParticipantsReceivingNewSteps: number;
  validationErrors: [];
}

// The caller holds the same definition/scheduler locks as publish and dispatch.
// Content eligibility is supplied by Platform, the owner of Material/Series access.
export async function previewFunnel(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  draft: FunnelDraft,
  published: FunnelDraft | null,
  revision: number,
): Promise<FunnelPreview> {
  const before = published?.steps ?? [];
  const oldById = new Map(before.map((step) => [step.stepId, step]));
  const currentIds = new Set(draft.steps.map((step) => step.stepId));
  const commonBefore = before.filter((step) => currentIds.has(step.stepId));
  const commonAfter = draft.steps.filter((step) => oldById.has(step.stepId));
  const addedStepIds = draft.steps
    .filter((step) => !oldById.has(step.stepId))
    .map((step) => step.stepId);
  const participants = await tx
    .selectFrom("communication_enrollments as e")
    .innerJoin("communication_contacts as c", "c.contact_id", "e.contact_id")
    .innerJoin("bot_contacts as b", (join) =>
      join
        .onRef("b.bot_identity", "=", "c.bot_identity")
        .onRef("b.telegram_user_id", "=", "c.telegram_user_id"),
    )
    .select(["e.contact_id", "e.initial_entry_key"])
    .where("e.funnel_id", "=", draft.funnelId)
    .where("c.bot_identity", "=", bot)
    .where("c.marketing_enabled", "=", true)
    .where("c.unavailable_since", "is", null)
    .where("b.contactability", "=", "reachable")
    .execute();
  const history = await tx
    .selectFrom("communication_deliveries")
    .select(["contact_id", "step_id", "completed_at", "dedup_key"])
    .where("bot_identity", "=", bot)
    .where("funnel_id", "=", draft.funnelId)
    .execute();
  let eligibleContacts = 0;
  let completedParticipantsReceivingNewSteps = 0;
  for (const participant of participants) {
    const deliveries = history.filter(
      (delivery) => delivery.contact_id === participant.contact_id,
    );
    const completed = new Set(
      deliveries
        .filter((delivery) => delivery.completed_at !== null)
        .map((delivery) => delivery.step_id),
    );
    const receives = draft.steps.some((step) => !completed.has(step.stepId));
    if (receives) eligibleContacts += 1;
    if (
      published &&
      receives &&
      addedStepIds.some((id) => !completed.has(id)) &&
      deliveries.some(
        (delivery) =>
          delivery.dedup_key === participant.initial_entry_key &&
          delivery.completed_at !== null,
      ) &&
      before.every((step) => completed.has(step.stepId))
    ) {
      completedParticipantsReceivingNewSteps += 1;
    }
  }
  return {
    funnelId: draft.funnelId,
    revision,
    addedStepIds,
    editedStepIds: draft.steps
      .filter((step) => {
        const old = oldById.get(step.stepId);
        return old !== undefined && !isDeepStrictEqual(old, step);
      })
      .map((step) => step.stepId),
    deletedStepIds: before
      .filter((step) => !currentIds.has(step.stepId))
      .map((step) => step.stepId),
    reorderedStepIds: commonAfter
      .filter((step, index) => commonBefore[index]?.stepId !== step.stepId)
      .map((step) => step.stepId),
    eligibleContacts,
    completedParticipantsReceivingNewSteps,
    validationErrors: [],
  };
}

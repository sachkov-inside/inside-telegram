import type { Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import { cancelDelivery, reconcileFunnels } from "./funnel-timeline.js";

// The caller holds the scheduler lock before contact rows. The shared unavailable
// interval ends only when both transport and the explicit subscriber preference allow it.
export async function updateMarketingAvailability(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  user: string,
  now: Date,
  reachable: boolean,
  enabled?: boolean,
): Promise<void> {
  const contact = await tx
    .selectFrom("communication_contacts")
    .selectAll()
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", user)
    .executeTakeFirst();
  if (!contact) return;
  const marketing = enabled ?? contact.marketing_enabled;
  const available = reachable && marketing;
  if (available && contact.unavailable_since) {
    await reconcileFunnels(tx, bot, now, contact.contact_id);
  }
  if (!available && !contact.unavailable_since) {
    const intros = await tx
      .selectFrom("communication_deliveries")
      .selectAll()
      .where("contact_id", "=", contact.contact_id)
      .where("kind", "=", "intro")
      .where("completed_at", "is", null)
      .execute();
    for (const intro of intros)
      await cancelDelivery(tx, intro, now, "marketing_unavailable");
  }
  await tx
    .updateTable("communication_contacts")
    .set({
      marketing_enabled: marketing,
      unavailable_since: available ? null : (contact.unavailable_since ?? now),
    })
    .where("contact_id", "=", contact.contact_id)
    .execute();
}

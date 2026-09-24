import type { Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import { lockContactRows } from "./communication-state.js";
import {
  cancelDelivery,
  reconcileFunnels,
  started,
} from "./funnel-timeline.js";

// The caller holds this contact's lock. The shared unavailable interval ends only when both
// transport and the explicit marketing preference allow it. An unchanged contact is only read,
// so an ordinary /start never waits for audience-wide planning.
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
  const unavailableSince = available
    ? null
    : (contact.unavailable_since ?? now);
  if (
    marketing === contact.marketing_enabled &&
    +(unavailableSince ?? 0) === +(contact.unavailable_since ?? 0)
  )
    return;
  await lockContactRows(tx, [contact.contact_id]);
  if (available && contact.unavailable_since) {
    await reconcileFunnels(
      tx,
      bot,
      now,
      { contactId: contact.contact_id },
      { suppressMissed: true },
    );
  }
  if (!available && !contact.unavailable_since) {
    const unfinished = await tx
      .selectFrom("communication_deliveries")
      .selectAll()
      .where("contact_id", "=", contact.contact_id)
      .where("completed_at", "is", null)
      .execute();
    for (const delivery of unfinished)
      if (delivery.kind !== "step" || started(delivery))
        await cancelDelivery(tx, delivery, now, "marketing_unavailable");
    // A cancelled initial response completes its enrollment's entry, as dispatch would.
    await reconcileFunnels(tx, bot, now, { contactId: contact.contact_id });
  }
  await tx
    .updateTable("communication_contacts")
    .set({ marketing_enabled: marketing, unavailable_since: unavailableSince })
    .where("contact_id", "=", contact.contact_id)
    .execute();
}

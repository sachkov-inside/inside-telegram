import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../../src/database/database.js";
import type { NotificationCommand } from "../../src/modules/notifications/notification-contract.js";
export async function seedNotificationRecipient(
  db: Database,
  c: NotificationCommand,
  now: Date,
  user = "10001",
) {
  const ref = randomUUID();
  await db
    .insertInto("link_transactions")
    .values({
      link_transaction_ref: ref,
      account_ref: c.binding.accountRef,
      token_digest: randomBytes(32).toString("base64url"),
      return_correlation: "synthetic",
      expires_at: new Date(now.getTime() + 600000),
      state: "linked",
      registered_at: now,
      bot_identity: "inside",
      candidate_telegram_user_id: user,
      received_at: now,
      confirmed_at: now,
    })
    .execute();
  await db
    .insertInto("platform_links")
    .values({
      telegram_identity_ref: c.binding.telegramIdentityRef,
      account_ref: c.binding.accountRef,
      bot_identity: "inside",
      telegram_user_id: user,
      link_transaction_ref: ref,
      linked_at: now,
      evidence_version: 0,
      last_membership_observation_at: null,
      last_membership_observation_update_id: null,
    })
    .execute();
  await db
    .insertInto("bot_contacts")
    .values({
      bot_identity: "inside",
      telegram_user_id: user,
      private_chat_id: user,
      contactability: "reachable",
      first_started_at: now,
      last_started_at: now,
      updated_at: now,
    })
    .execute();
}

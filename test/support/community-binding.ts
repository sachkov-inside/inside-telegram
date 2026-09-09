import { randomBytes, randomUUID } from "node:crypto";

import type { Database } from "../../src/database/database.js";
import type { CommunityBinding } from "../../src/modules/community/community-contract.js";

/** Seeds the verified link the provider must resolve before touching Telegram. */
export async function seedCommunityBinding(
  db: Database,
  binding: CommunityBinding,
  now: Date,
  telegramUserId: string,
  botIdentity = "inside",
): Promise<void> {
  const ref = randomUUID();
  await db
    .insertInto("link_transactions")
    .values({
      link_transaction_ref: ref,
      account_ref: binding.accountRef,
      token_digest: randomBytes(32).toString("base64url"),
      return_correlation: "synthetic",
      expires_at: new Date(now.getTime() + 600_000),
      state: "linked",
      registered_at: now,
      bot_identity: botIdentity,
      candidate_telegram_user_id: telegramUserId,
      received_at: now,
      confirmed_at: now,
    })
    .execute();
  await db
    .insertInto("platform_links")
    .values({
      telegram_identity_ref: binding.telegramIdentityRef,
      account_ref: binding.accountRef,
      bot_identity: botIdentity,
      telegram_user_id: telegramUserId,
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
      bot_identity: botIdentity,
      telegram_user_id: telegramUserId,
      private_chat_id: telegramUserId,
      contactability: "reachable",
      first_started_at: now,
      last_started_at: now,
      updated_at: now,
    })
    .onConflict((c) => c.doNothing())
    .execute();
}

export async function unlinkCommunityBinding(
  db: Database,
  binding: CommunityBinding,
  botIdentity = "inside",
): Promise<void> {
  await db
    .deleteFrom("platform_links")
    .where("bot_identity", "=", botIdentity)
    .where("account_ref", "=", binding.accountRef)
    .where("telegram_identity_ref", "=", binding.telegramIdentityRef)
    .execute();
}

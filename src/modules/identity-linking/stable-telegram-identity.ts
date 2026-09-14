import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import { lockTelegramIdentity } from "./identity-link-account-lock.js";

/** A private identity exists before an Account; linking must retain its source key. */
export async function reserveTelegramIdentity(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  user: string,
): Promise<string> {
  await lockTelegramIdentity(tx, bot, user);
  const linked = await tx
    .selectFrom("platform_links")
    .select("telegram_identity_ref")
    .where("bot_identity", "=", bot)
    .where("telegram_user_id", "=", user)
    .executeTakeFirst();
  await tx
    .insertInto("telegram_identity_reservations")
    .values({
      bot_identity: bot,
      telegram_user_id: user,
      identity_ref: linked?.telegram_identity_ref ?? randomUUID(),
    })
    .onConflict((c) =>
      c.columns(["bot_identity", "telegram_user_id"]).doNothing(),
    )
    .execute();
  return (
    await tx
      .selectFrom("telegram_identity_reservations")
      .select("identity_ref")
      .where("bot_identity", "=", bot)
      .where("telegram_user_id", "=", user)
      .executeTakeFirstOrThrow()
  ).identity_ref;
}

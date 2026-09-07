import type { Database } from "../../database/database.js";

/** The callback's verified message is the edit target, even when the original send acknowledgement was lost. */
export async function queueSignInResult(
  database: Database,
  requestRef: string,
  now: Date,
  text: string,
): Promise<void> {
  const request = await database
    .selectFrom("sign_in_requests")
    .select([
      "bot_identity",
      "telegram_user_id",
      "private_chat_id",
      "confirmation_message_id",
    ])
    .where("request_ref", "=", requestRef)
    .executeTakeFirstOrThrow();
  if (
    !request.confirmation_message_id ||
    !request.telegram_user_id ||
    !request.private_chat_id
  )
    return;
  await database
    .insertInto("start_response_deliveries")
    .values({
      attempt_count: 0,
      available_at: now,
      bot_identity: request.bot_identity,
      created_at: now,
      delivered_at: null,
      diagnostic_code: null,
      locked_at: null,
      message_text: text,
      private_chat_id: request.private_chat_id,
      source_key: `sign-in-result:${requestRef}`,
      state: "pending",
      telegram_user_id: request.telegram_user_id,
      trigger_update_id: null,
      updated_at: now,
      sign_in_request_ref: requestRef,
      edit_message_id: request.confirmation_message_id,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

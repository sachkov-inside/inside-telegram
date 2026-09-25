import { enqueueReply } from "../outbound/start-response-delivery-queue.js";
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
  await enqueueReply(database, {
    botIdentity: request.bot_identity,
    telegramUserId: request.telegram_user_id,
    privateChatId: request.private_chat_id,
    messageText: text,
    sourceKey: `sign-in-result:${requestRef}`,
    signInRequestRef: requestRef,
    editMessageId: request.confirmation_message_id,
    now,
  });
}

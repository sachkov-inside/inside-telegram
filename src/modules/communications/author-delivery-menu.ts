import { findPlatformLink } from "../identity-linking/platform-links.js";
import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";
import { enqueueAuthorMessage } from "./author-delivery.js";

/** Subscriber deliveries never carry admin controls; only the linked owning author's chat does. */
export async function enqueueBroadcastAuthorMenu(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  broadcastId: string,
  contactId: string,
) {
  const recipient = await tx
    .selectFrom("communication_broadcasts as b")
    .innerJoin(
      "communication_contacts as c",
      "c.bot_identity",
      "b.bot_identity",
    )
    .select(["b.owner_account_ref", "c.telegram_user_id"])
    .where("b.bot_identity", "=", bot)
    .where("b.broadcast_id", "=", broadcastId)
    .where("c.contact_id", "=", contactId)
    .executeTakeFirst();
  // The recipient gets the menu only when it is the owning author's own linked chat.
  const owner =
    recipient &&
    (await findPlatformLink(tx, {
      botIdentity: bot,
      telegramUserId: recipient.telegram_user_id,
      accountRef: recipient.owner_account_ref,
    }));
  if (!owner) return;
  await enqueueAuthorMessage(tx, {
    deliveryId: randomUUID(),
    botIdentity: bot,
    accountRef: owner.accountRef,
    telegramUserId: owner.telegramUserId,
    telegramIdentityRef: owner.telegramIdentityRef,
    message: {
      chatId: owner.telegramUserId,
      authorMenu: true,
      editMenu: false,
      content: {
        type: "text",
        text: "Управление рассылкой",
        entities: [],
        buttons: [],
      },
      authorButtons: [
        {
          text: "К рассылке",
          callbackData: `author:open-broadcast:${broadcastId}`,
        },
        { text: "Все рассылки", callbackData: "author:broadcasts:0" },
        { text: "Главное меню", callbackData: "author:home:0" },
      ],
    },
  });
}

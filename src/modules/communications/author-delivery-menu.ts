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
  const owner = await tx
    .selectFrom("communication_broadcasts as b")
    .innerJoin("platform_links as l", (j) =>
      j
        .onRef("l.bot_identity", "=", "b.bot_identity")
        .onRef("l.account_ref", "=", "b.owner_account_ref"),
    )
    .innerJoin("communication_contacts as c", (j) =>
      j
        .onRef("c.bot_identity", "=", "l.bot_identity")
        .onRef("c.telegram_user_id", "=", "l.telegram_user_id"),
    )
    .select(["l.account_ref", "l.telegram_user_id", "l.telegram_identity_ref"])
    .where("b.bot_identity", "=", bot)
    .where("b.broadcast_id", "=", broadcastId)
    .where("c.contact_id", "=", contactId)
    .executeTakeFirst();
  if (!owner) return;
  await enqueueAuthorMessage(tx, {
    deliveryId: randomUUID(),
    botIdentity: bot,
    accountRef: owner.account_ref,
    telegramUserId: owner.telegram_user_id,
    telegramIdentityRef: owner.telegram_identity_ref,
    message: {
      chatId: owner.telegram_user_id,
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

import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";

// Shared by service and marketing dispatch. Reservations commit before external I/O.
export async function reserveTelegramSlot(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  chat: string,
  now: Date,
): Promise<boolean> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-transport:${bot}`}, 0))`.execute(
    tx,
  );
  const lanes = [
    { lane: "global", delay: 40 },
    { lane: `chat:${chat}`, delay: 1000 },
  ];
  const existing = await tx
    .selectFrom("telegram_transport_slots")
    .selectAll()
    .where("bot_identity", "=", bot)
    .where(
      "lane",
      "in",
      lanes.map((l) => l.lane),
    )
    .execute();
  if (existing.some((r) => r.available_at > now)) return false;
  for (const lane of lanes)
    await tx
      .insertInto("telegram_transport_slots")
      .values({
        bot_identity: bot,
        lane: lane.lane,
        available_at: new Date(now.getTime() + lane.delay),
      })
      .onConflict((c) =>
        c
          .columns(["bot_identity", "lane"])
          .doUpdateSet({ available_at: new Date(now.getTime() + lane.delay) }),
      )
      .execute();
  return true;
}
export async function deferTelegramSlot(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  until: Date,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-transport:${bot}`}, 0))`.execute(
    tx,
  );
  await tx
    .insertInto("telegram_transport_slots")
    .values({ bot_identity: bot, lane: "global", available_at: until })
    .onConflict((c) =>
      c.columns(["bot_identity", "lane"]).doUpdateSet({
        available_at: sql`greatest(telegram_transport_slots.available_at, ${until})`,
      }),
    )
    .execute();
}

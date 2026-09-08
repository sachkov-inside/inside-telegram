import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "../../database/database.js";

// Shared by service and marketing dispatch. Reservations commit before external I/O.
export async function reserveTelegramSlot(
  tx: Transaction<DatabaseSchema>,
  bot: string,
  chat: string,
  now: Date,
  purpose: "general" | "subscription" | "material" = "general",
): Promise<boolean> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-transport:${bot}`}, 0))`.execute(
    tx,
  );
  // Two service slots, one material slot, one existing-traffic slot per 160ms.
  // Idle reservations are borrowed; an active category cannot be starved by another worker.
  const reserved = (
    ["subscription", "subscription", "material", "general"] as const
  )[Math.floor(now.getTime() / 40) % 4]!;
  if (reserved !== purpose && reserved !== "general") {
    const demand = await tx
      .selectFrom("notification_commands")
      .select("operation_id")
      .where("bot_identity", "=", bot)
      .where("category", "=", reserved)
      .where("state", "in", ["accepted", "retrying"])
      .where("available_at", "<=", now)
      .limit(1)
      .executeTakeFirst();
    if (demand) return false;
  }
  if (reserved === "general" && purpose !== "general") return false;
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

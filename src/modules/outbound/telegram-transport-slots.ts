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
  // Persist the next turn rather than assigning wall-clock windows: preflight latency
  // cannot make a pending category miss its share forever.
  await tx
    .insertInto("telegram_transport_fairness")
    .values({
      bot_identity: bot,
      cursor: 0,
      general_waiting_until: new Date(0),
      subscription_waiting_until: new Date(0),
      material_waiting_until: new Date(0),
    })
    .onConflict((c) => c.column("bot_identity").doNothing())
    .execute();
  const waitingColumn = `${purpose}_waiting_until` as const;
  await tx
    .updateTable("telegram_transport_fairness")
    .set({
      [waitingColumn]: new Date(
        now.getTime() + (purpose === "general" ? 1000 : 10000),
      ),
    })
    .where("bot_identity", "=", bot)
    .execute();
  const fairness = await tx
    .selectFrom("telegram_transport_fairness")
    .selectAll()
    .where("bot_identity", "=", bot)
    .executeTakeFirstOrThrow();
  // Only a sender that reached capacity admission can reserve a turn. Durable backlog alone
  // must not block other senders when Notifications are disabled or the worker has died.
  const active = new Set<string>();
  for (const category of ["general", "subscription", "material"] as const)
    if (fairness[`${category}_waiting_until`] > now) active.add(category);
  const turns = [
    "subscription",
    "subscription",
    "material",
    "general",
  ] as const;
  let selected = fairness.cursor;
  for (let n = 0; n < turns.length; n++) {
    selected = (fairness.cursor + n) % turns.length;
    if (active.has(turns[selected]!)) break;
  }
  if (turns[selected] !== purpose) return false;
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
  await tx
    .updateTable("telegram_transport_fairness")
    .set({
      cursor: (selected + 1) % turns.length,
      [waitingColumn]: new Date(0),
    })
    .where("bot_identity", "=", bot)
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

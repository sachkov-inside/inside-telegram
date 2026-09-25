import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import {
  admitTelegramSlot,
  telegramTurnPending,
} from "../../src/modules/outbound/telegram-transport-slots.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const now = new Date("2026-09-24T12:00:00.000Z");
let database: Database;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
});

beforeEach(async () => {
  await sql`truncate table telegram_transport_fairness, telegram_transport_slots`.execute(
    database,
  );
});

afterAll(async () => {
  await database.destroy();
});

describe("Telegram turns", () => {
  it("reports a refused sender as waiting until it gets its turn", async () => {
    await expect(
      telegramTurnPending(database, "inside", "general", now),
    ).resolves.toBe(false);

    // A reply takes the global lane; a notification refused meanwhile keeps its turn.
    await expect(admit("42", "general", now)).resolves.toBe("reserved");
    await expect(admit("43", "subscription", at(10))).resolves.toBe("bot_busy");
    await expect(admit("44", "general", at(100))).resolves.toBe("bot_busy");
    await expect(
      telegramTurnPending(database, "inside", "general", at(100)),
    ).resolves.toBe(true);
    await expect(
      telegramTurnPending(database, "inside", "subscription", at(100)),
    ).resolves.toBe(true);

    await expect(admit("43", "subscription", at(200))).resolves.toBe(
      "reserved",
    );
    await expect(
      telegramTurnPending(database, "inside", "subscription", at(200)),
    ).resolves.toBe(false);
  });
});

function at(milliseconds: number): Date {
  return new Date(now.getTime() + milliseconds);
}

function admit(
  chat: string,
  purpose: "general" | "subscription",
  at: Date,
): Promise<"reserved" | "chat_busy" | "bot_busy"> {
  return database
    .transaction()
    .execute((tx) => admitTelegramSlot(tx, "inside", chat, at, purpose));
}

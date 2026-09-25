import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import {
  claimNext,
  retryDelay,
  settle,
  type DurableQueue,
} from "../../src/database/durable-queue.js";
import { migrateToLatest } from "../../src/database/migrator.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const queue: DurableQueue<"telegram_updates"> = {
  table: "telegram_updates",
  key: ["bot_identity", "update_id"],
  order: ["update_id"],
  ready: ["pending"],
  leased: "processing",
  due: "available_at",
  attempts: "process_attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 1000, maxMs: 16_000 },
};
/** The same queue with one lane per sender: a sender's rows run one at a time, in order. */
const lanes: DurableQueue<"telegram_updates"> = {
  ...queue,
  lane: ["bot_identity", "ordering_key"],
};
const expired = {
  failure_code: "worker_lease_expired",
  locked_at: null,
  state: "pending",
} as const;
const start = new Date("2026-09-24T10:00:00.000Z");

let database: Database;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
});

beforeEach(async () => {
  await sql`truncate table telegram_updates`.execute(database);
});

afterAll(async () => {
  await database.destroy();
});

describe("durable queue", () => {
  it("leases due rows in queue order and skips rows that are not due", async () => {
    await insert("2", start);
    await insert("1", start);
    await insert("3", new Date(start.getTime() + 5000));

    const first = await claim(start);
    const second = await claim(start);
    const none = await claim(start);

    expect(first?.row.update_id).toBe("1");
    expect(second?.row.update_id).toBe("2");
    expect(first?.attempt).toBe(1);
    expect(none).toBeUndefined();
    expect(await row("1")).toMatchObject({
      state: "processing",
      process_attempt_count: 1,
    });
  });

  it("settles a row only for the worker that still holds its lease", async () => {
    await insert("1", start);
    const abandoned = await claim(start);
    const afterExpiry = new Date(start.getTime() + 60_000);
    const current = await claim(afterExpiry);

    expect(current?.attempt).toBe(2);
    expect(
      await settle(database, queue, abandoned!, {
        state: "processed",
        locked_at: null,
      }),
    ).toBe(false);
    expect(await row("1")).toMatchObject({ state: "processing" });

    expect(
      await settle(database, queue, current!, {
        state: "processed",
        locked_at: null,
      }),
    ).toBe(true);
    expect(
      await settle(database, queue, current!, {
        state: "failed",
        locked_at: null,
      }),
    ).toBe(false);
    expect(await row("1")).toMatchObject({ state: "processed" });
  });

  it("returns an abandoned lease to the queue with the caller's values", async () => {
    await insert("1", start);
    await claim(start);

    expect(await claim(new Date(start.getTime() + 59_999))).toBeUndefined();
    const recovered = await claim(new Date(start.getTime() + 60_000));

    expect(recovered?.row.update_id).toBe("1");
    expect(await row("1")).toMatchObject({
      failure_code: "worker_lease_expired",
      state: "processing",
    });
  });

  it("leaves a candidate untouched when preparation declines it", async () => {
    await insert("1", start);

    const declined = await claimNext(database, queue, start, expired, {
      select: ["update_id"],
      prepare: async () => undefined,
    });

    expect(declined).toBeUndefined();
    expect(await row("1")).toMatchObject({
      state: "pending",
      process_attempt_count: 0,
    });
  });

  it("keeps one sender's rows in order while other senders proceed", async () => {
    await insert("1", start, "42");
    await insert("2", start, "42");
    await insert("3", start, "43");

    const first = await claimLane(start);
    const other = await claimLane(start);

    expect(first?.row.update_id).toBe("1");
    expect(other?.row.update_id).toBe("3");
    expect(await claimLane(start)).toBeUndefined();

    await settle(database, lanes, first!, {
      state: "processed",
      locked_at: null,
    });
    expect((await claimLane(start))?.row.update_id).toBe("2");
  });

  it("does not let a later row overtake an earlier one waiting to retry", async () => {
    await insert("1", new Date(start.getTime() + 5000), "42");
    await insert("2", start, "42");
    await insert("3", start);

    expect((await claimLane(start))?.row.update_id).toBe("3");
    expect(await claimLane(start)).toBeUndefined();
    const later = new Date(start.getTime() + 5000);
    expect((await claimLane(later))?.row.update_id).toBe("1");
  });

  it("gives concurrent workers at most one row of a sender", async () => {
    for (const id of ["1", "2", "3", "4"]) await insert(id, start, "42");

    const claims = await Promise.all(
      Array.from({ length: 4 }, () => claimLane(start)),
    );

    expect(claims.filter(Boolean).map((c) => c!.row.update_id)).toEqual(["1"]);
  });

  it("backs off exponentially up to the queue maximum", () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((attempt) => retryDelay(queue, attempt)),
    ).toEqual([1000, 2000, 4000, 8000, 16_000, 16_000]);
  });
});

function claim(now: Date) {
  return claimNext(database, queue, now, expired, {
    select: ["update_id"],
  });
}

function claimLane(now: Date) {
  return claimNext(database, lanes, now, expired, {
    select: ["update_id"],
  });
}

async function insert(
  updateId: string,
  availableAt: Date,
  orderingKey: string | null = null,
): Promise<void> {
  await database
    .insertInto("telegram_updates")
    .values({
      available_at: availableAt,
      bot_identity: "inside",
      failure_code: null,
      locked_at: null,
      ordering_key: orderingKey,
      payload: JSON.stringify({ update_id: Number(updateId) }),
      process_attempt_count: 0,
      processed_at: null,
      received_at: availableAt,
      state: "pending",
      update_id: updateId,
    })
    .execute();
}

function row(updateId: string) {
  return database
    .selectFrom("telegram_updates")
    .select(["failure_code", "process_attempt_count", "state"])
    .where("update_id", "=", updateId)
    .executeTakeFirstOrThrow();
}

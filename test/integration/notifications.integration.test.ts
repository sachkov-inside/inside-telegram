import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { NotificationProvider } from "../../src/modules/notifications/notification-provider.js";
import {
  digest,
  notificationValidator,
  type NotificationCommand,
  type DispatchResponse,
  type DispatchRequest,
  type NotificationResult,
} from "../../src/modules/notifications/notification-contract.js";
import type {
  TelegramDeliveryResult,
  TelegramTextMessage,
} from "../../src/modules/outbound/telegram-messages.js";
import { reserveTelegramSlot } from "../../src/modules/outbound/telegram-transport-slots.js";
import fixtures from "../../docs/contracts/notifications-v1/fixtures.json" with { type: "json" };
const db = createDatabase(process.env.DATABASE_URL!);
const db2 = createDatabase(process.env.DATABASE_URL!);
const clock = {
  value: new Date("2026-09-08T12:00:00Z"),
  now() {
    return new Date(this.value);
  },
};
let sends: TelegramTextMessage[] = [],
  calls: DispatchRequest[] = [];
let response: TelegramDeliveryResult = {
  kind: "delivered",
  providerMessageId: "11",
};
let preflight: (r: DispatchRequest) => Promise<DispatchResponse | undefined>;
let send: (m: TelegramTextMessage) => Promise<TelegramDeliveryResult>;
const auth = {
  authorize: (r: DispatchRequest) => {
    calls.push(r);
    return preflight(r);
  },
};
const transport = {
  sendText: (m: TelegramTextMessage) => {
    sends.push(m);
    return send(m);
  },
  editText: async () => response,
};
const provider = () =>
  new NotificationProvider(
    db,
    "inside",
    clock,
    auth,
    transport,
    Buffer.alloc(32, 1),
  );
const concurrent = () =>
  new NotificationProvider(
    db2,
    "inside",
    clock,
    auth,
    transport,
    Buffer.alloc(32, 1),
  );
function command(
  category: "subscription" | "material" = "subscription",
): NotificationCommand {
  const c = structuredClone(
    fixtures.find((f) => f.name === "subscription-telegram")!.value,
  ) as NotificationCommand;
  c.operationId = randomUUID();
  c.deliveryRef = randomUUID();
  c.notificationRef = randomUUID();
  if (category === "material")
    c.content = { category, kind: "material_published" };
  c.issuedAt = clock.now().toISOString();
  c.notAfter = new Date(clock.now().getTime() + 600000).toISOString();
  return c;
}
async function receive(c: NotificationCommand, p = provider()) {
  return p.receive(
    Buffer.from(JSON.stringify(c)),
    {
      exchange: "inside.notifications.telegram.v1",
      routingKey: c.content.category,
      contentType: "application/json",
      type: c.contractVersion,
      messageId: c.operationId,
      persistent: true,
    },
    c.content.category,
  );
}
async function result(c: NotificationCommand) {
  return (
    await db
      .selectFrom("notification_commands")
      .select("result")
      .where("operation_id", "=", c.operationId)
      .executeTakeFirstOrThrow()
  ).result;
}
async function linked(c: NotificationCommand) {
  const now = clock.now(),
    ref = randomUUID(),
    user = "10001";
  await db
    .insertInto("link_transactions")
    .values({
      link_transaction_ref: ref,
      account_ref: c.binding.accountRef,
      token_digest: "x".repeat(43),
      return_correlation: "synthetic",
      expires_at: new Date(now.getTime() + 600000),
      state: "linked",
      registered_at: now,
      bot_identity: "inside",
      candidate_telegram_user_id: user,
      received_at: now,
      confirmed_at: now,
    })
    .execute();
  await db
    .insertInto("platform_links")
    .values({
      telegram_identity_ref: c.binding.telegramIdentityRef,
      account_ref: c.binding.accountRef,
      bot_identity: "inside",
      telegram_user_id: user,
      link_transaction_ref: ref,
      linked_at: now,
      evidence_version: 0,
      last_membership_observation_at: null,
      last_membership_observation_update_id: null,
    })
    .execute();
  await db
    .insertInto("bot_contacts")
    .values({
      bot_identity: "inside",
      telegram_user_id: user,
      private_chat_id: user,
      contactability: "reachable",
      first_started_at: now,
      last_started_at: now,
      updated_at: now,
    })
    .execute();
}
function advance(ms: number) {
  clock.value = new Date(clock.value.getTime() + ms);
}
beforeAll(async () => {
  await migrateToLatest(db);
});
afterAll(async () => {
  await db.destroy();
  await db2.destroy();
});
beforeEach(async () => {
  await sql`truncate notification_attempts, notification_commands, notification_deliveries, notification_result_outbox, notification_quarantine,
    platform_links, link_transactions, bot_contacts, telegram_transport_slots cascade`.execute(
    db,
  );
  clock.value = new Date("2026-09-08T12:00:00Z");
  sends = [];
  calls = [];
  response = { kind: "delivered", providerMessageId: "11" };
  send = async () => response;
  preflight = async (r) => ({
    ...r,
    status: "allowed",
    permitRef: randomUUID(),
    validUntil: new Date(clock.now().getTime() + 5000).toISOString(),
  });
});
describe("Notification provider with real PostgreSQL and synthetic external facets", () => {
  it("real process death at I/O leaves a durable started barrier after restart", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "test/support/notification-crash-worker.ts"],
        { env: process.env },
      ),
    ).rejects.toMatchObject({ code: 74 });
    expect(await result(c)).toMatchObject({
      state: "unknown",
      reason: "interrupted_attempt",
    });
    advance(60000);
    await concurrent().processCategory("subscription");
    expect(sends).toHaveLength(0);
    expect(
      await receive({ ...c, operationId: randomUUID(), commandRevision: 2 }),
    ).toBeUndefined();
  });
  it("lost commit after successful external effect retains unknown and does not resend", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    await sql`create function notification_test_fail_sent() returns trigger language plpgsql as $$ begin
      if new.result->>'state' = 'sent' then raise exception 'synthetic commit failure'; end if; return new; end $$;
      create trigger notification_test_fail_sent before insert on notification_result_outbox for each row execute function notification_test_fail_sent()`.execute(
      db,
    );
    try {
      await expect(provider().processCategory("subscription")).rejects.toThrow(
        "synthetic commit failure",
      );
      expect((await result(c)).state).toBe("unknown");
      await concurrent().processCategory("subscription");
      expect(sends).toHaveLength(1);
    } finally {
      await sql`drop trigger notification_test_fail_sent on notification_result_outbox; drop function notification_test_fail_sent()`.execute(
        db,
      );
    }
  });

  it.each(["subscription", "material"] as const)(
    "durably accepts %s and replays the same sent result after restart",
    async (category) => {
      const c = command(category);
      await linked(c);
      if (category === "material") advance(80);
      expect((await receive(c))?.state).toBe("accepted");
      expect(sends).toHaveLength(0);
      await provider().processCategory(category);
      const sent = await result(c);
      expect(sent.state).toBe("sent");
      expect(sends).toEqual([{ chatId: "10001", text: c.text }]);
      expect(await receive(c, concurrent())).toEqual(sent);
      await concurrent().processCategory(category);
      expect(sends).toHaveLength(1);
      const rows = await db
        .selectFrom("notification_result_outbox")
        .selectAll()
        .execute();
      for (const row of rows)
        expect(
          notificationValidator(
            `${row.result.state === "retrying" ? "retry" : row.result.state}Result`,
          )(row.result),
        ).toBe(true);
      expect(rows.map((r) => r.result.state)).toEqual(
        expect.arrayContaining(["accepted", "unknown", "sent"]),
      );
    },
  );
  it("rejects operation/revision/category/account conflicts without changing the saved command", async () => {
    const c = command();
    await receive(c);
    for (const changed of [
      { ...c, text: "conflicting" },
      { ...c, operationId: randomUUID() },
      {
        ...c,
        operationId: randomUUID(),
        commandRevision: 2,
        binding: { ...c.binding, accountRef: "other" },
      },
      {
        ...c,
        operationId: randomUUID(),
        commandRevision: 2,
        content: { category: "material" as const, kind: "material_published" },
      },
    ])
      expect(await receive(changed)).toBeUndefined();
    expect((await result(c)).payloadDigest).toBe(digest(c));
    expect(
      await db.selectFrom("notification_quarantine").selectAll().execute(),
    ).toHaveLength(4);
  });
  it("supersedes a proven unstarted command under the same lock and keeps result revisions monotone", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    const next = {
      ...c,
      operationId: randomUUID(),
      commandRevision: 2,
      text: "fresh",
    };
    await receive(next);
    expect(await result(c)).toMatchObject({
      state: "suppressed",
      reason: "superseded",
    });
    await provider().processCategory("subscription");
    expect(sends.map((m) => m.text)).toEqual(["fresh"]);
    expect((await result(next)).resultRevision).toBeGreaterThan(
      (await result(c)).resultRevision,
    );
    expect(
      await receive({ ...next, operationId: randomUUID(), commandRevision: 3 }),
    ).toBeUndefined();
  });
  it("persists started before I/O; concurrent replay, new revisions and restart cannot resend; late evidence correlates", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    let finish!: (r: TelegramDeliveryResult) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    send = async () => {
      expect((await result(c)).state).toBe("unknown");
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const running = provider().processCategory("subscription");
    await entered;
    const unknown = await result(c);
    expect(unknown.state).toBe("unknown");
    await receive(c, concurrent());
    await concurrent().processCategory("subscription");
    expect(
      await receive({ ...c, operationId: randomUUID(), commandRevision: 2 }),
    ).toBeUndefined();
    expect(sends).toHaveLength(1);
    finish({ kind: "transport_unknown" });
    await running;
    const attempt = (
      (await result(c)) as Extract<NotificationResult, { state: "unknown" }>
    ).attemptRef;
    await expect(
      concurrent().settle(c.operationId, randomUUID(), digest(c), response),
    ).rejects.toThrow("correlation");
    await concurrent().settle(c.operationId, attempt, digest(c), response);
    expect((await result(c)).state).toBe("sent");
    expect(sends).toHaveLength(1);
  });
  it("two independent connections authorize but only one commits started", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    await Promise.all([
      provider().processCategory("subscription"),
      concurrent().processCategory("subscription"),
    ]);
    expect(sends).toHaveLength(1);
    expect((await result(c)).state).toBe("sent");
  });
  it.each([
    "preference_disabled",
    "superseded",
    "access_denied",
    "binding_conflict",
  ] as const)("fresh Platform %s suppresses before send", async (reason) => {
    const c = command();
    await linked(c);
    await receive(c);
    preflight = async (r) => ({ ...r, status: "denied", reason });
    await provider().processCategory("subscription");
    expect(await result(c)).toMatchObject({ state: "suppressed", reason });
    expect(sends).toHaveLength(0);
  });
  it("unlinked identity, blocked bot and elapsed deadline cannot start", async () => {
    const c = command();
    await receive(c);
    await provider().processCategory("subscription");
    expect(await result(c)).toMatchObject({ reason: "binding_conflict" });
    const blocked = command();
    await linked(blocked);
    await db
      .updateTable("bot_contacts")
      .set({ contactability: "blocked" })
      .execute();
    await receive(blocked);
    await provider().processCategory("subscription");
    expect(await result(blocked)).toMatchObject({
      reason: "recipient_unreachable",
      attemptRef: null,
    });
    const expired = command();
    await receive(expired);
    advance(600001);
    await provider().processCategory("subscription");
    expect(await result(expired)).toMatchObject({ reason: "expired" });
    expect(sends).toHaveLength(0);
  });
  it.each([
    "unavailable",
    "wrong-correlation",
    "long-permit",
    "expired-permit",
  ])(
    "fails closed on %s and exhausts bounded pre-start retries",
    async (failure) => {
      const c = command();
      await linked(c);
      await receive(c);
      preflight = async (r) =>
        failure === "unavailable"
          ? undefined
          : {
              ...r,
              deliveryOperationId:
                failure === "wrong-correlation"
                  ? randomUUID()
                  : r.deliveryOperationId,
              status: "allowed",
              permitRef: randomUUID(),
              validUntil: new Date(
                clock.now().getTime() +
                  (failure === "expired-permit" ? 0 : 6000),
              ).toISOString(),
            };
      for (const delay of [0, 1000, 5000, 30000]) {
        advance(delay);
        await provider().processCategory("subscription");
      }
      expect(await result(c)).toMatchObject({
        state: "failed",
        reason: "retry_exhausted",
        attemptRef: null,
      });
      expect(sends).toHaveLength(0);
    },
  );
  it("429 records not_sent, defers the shared bot, then uses a new correlated attempt and permit", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    response = {
      kind: "api_retryable",
      providerErrorCode: 429,
      retryAfterSeconds: 2,
    };
    await provider().processCategory("subscription");
    const retry = await result(c);
    expect(retry).toMatchObject({
      state: "retrying",
      attemptRef: calls[0]!.attemptRef,
    });
    const reserved = await db
      .transaction()
      .execute((tx) =>
        reserveTelegramSlot(tx, "inside", "another", clock.now()),
      );
    expect(reserved).toBe(false);
    advance(2080);
    response = { kind: "delivered", providerMessageId: "12" };
    await provider().processCategory("subscription");
    expect(sends).toHaveLength(2);
    expect((await result(c)).state).toBe("sent");
    expect(calls[1]!.attemptRef).not.toBe(calls[0]!.attemptRef);
  });
  it.each([500, 502, 504])(
    "ambiguous %s never turns retryable after restart/deadline",
    async (code) => {
      const c = command();
      await linked(c);
      await receive(c);
      response = { kind: "api_retryable", providerErrorCode: code };
      await provider().processCategory("subscription");
      advance(700000);
      await concurrent().processCategory("subscription");
      expect((await result(c)).state).toBe("unknown");
      expect(sends).toHaveLength(1);
    },
  );
  it("result publication outage retains outbox and never re-sends; duplicate publication uses original messageId", async () => {
    const c = command();
    await linked(c);
    await receive(c);
    await provider().processCategory("subscription");
    const published: string[] = [];
    await expect(
      provider().publishResults(async (r) => {
        published.push(r.messageId);
        throw new Error("lost confirm");
      }),
    ).rejects.toThrow();
    await concurrent().publishResults(async (r) => {
      published.push(r.messageId);
    });
    expect(published[0]).toBe(published[1]);
    expect(sends).toHaveLength(1);
    expect(
      await db
        .selectFrom("notification_result_outbox")
        .selectAll()
        .where("published_at", "is", null)
        .execute(),
    ).toHaveLength(0);
  });
  it("quarantines poison without plaintext and erases only payload after seven days", async () => {
    await provider().receive(
      Buffer.from("private malformed input"),
      { exchange: "wrong", routingKey: "material" },
      "material",
    );
    let q = await db
      .selectFrom("notification_quarantine")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(q.encrypted_payload).not.toContain("private");
    advance(8 * 86400000);
    await provider().expireQuarantinePayloads();
    q = await db
      .selectFrom("notification_quarantine")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(q.encrypted_payload).toBeNull();
    expect(q.digest).toHaveLength(64);
  });
  it("reserves nonzero material, subscription and existing-traffic capacity under continuous demand", async () => {
    await receive(command());
    await receive(command("material"));
    const grants = { general: 0, subscription: 0, material: 0 };
    for (let i = 0; i < 40; i++) {
      for (const lane of ["subscription", "general", "material"] as const) {
        if (
          await db
            .transaction()
            .execute((tx) =>
              reserveTelegramSlot(
                tx,
                "inside",
                `${lane}:${i}`,
                clock.now(),
                lane,
              ),
            )
        )
          grants[lane]++;
      }
      advance(40);
    }
    expect(grants).toEqual({ subscription: 20, general: 10, material: 10 });
  });
});

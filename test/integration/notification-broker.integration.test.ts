import { reserveTelegramSlot } from "../../src/modules/outbound/telegram-transport-slots.js";
import { createServer } from "node:http";
import { NotificationWorker } from "../../src/operations/notification-worker.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { systemClock } from "../../src/modules/identity-linking/clock.js";
import { seedNotificationRecipient } from "../support/notification-recipient.js";
import { randomUUID } from "node:crypto";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { sql } from "kysely";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { NotificationProvider } from "../../src/modules/notifications/notification-provider.js";
import { NotificationBroker } from "../../src/adapters/amqp/notification-broker.js";
import type { NotificationInbox } from "../../src/modules/notifications/notification-ports.js";
import type { NotificationCommand } from "../../src/modules/notifications/notification-contract.js";
import topology from "../../docs/operations/notification-topology.json" with { type: "json" };
import fixtures from "../../docs/contracts/notifications-v1/fixtures.json" with { type: "json" };
const db = createDatabase(process.env.DATABASE_URL!);
const vhost = `notification-test-${randomUUID()}`;
const users = {
  provider: `${vhost}-provider`,
  producer: `${vhost}-producer`,
  rogue: `${vhost}-rogue`,
};
const password = randomUUID();
const connections: ChannelModel[] = [];
let brokers: NotificationBroker[] = [];
const root =
  process.env.NOTIFICATION_TEST_AMQP_URL ?? "amqp://guest:guest@127.0.0.1:5673";
const management =
  process.env.NOTIFICATION_TEST_MANAGEMENT_URL ?? "http://127.0.0.1:15673";
for (const url of [root, management])
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname))
    throw new Error("Broker tests require isolated loopback infrastructure");
const rootUrl = new URL(root);
async function api(path: string, method = "PUT", value?: unknown) {
  const response = await fetch(`${management}/api/${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${decodeURIComponent(rootUrl.username)}:${decodeURIComponent(rootUrl.password)}`).toString("base64")}`,
      "content-type": "application/json",
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (!response.ok)
    throw new Error(`Synthetic broker setup failed: ${response.status}`);
  return response;
}
function url(user?: string) {
  const u = new URL(root);
  u.pathname = `/${encodeURIComponent(vhost)}`;
  if (user) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
}
async function connection(user?: string) {
  const c = await connect(url(user));
  c.on("error", () => undefined);
  connections.push(c);
  return c;
}
const clock = { now: () => new Date("2026-09-08T12:00:00Z") };
const provider = new NotificationProvider(
  db,
  "inside",
  clock,
  { authorize: async () => undefined },
  {
    sendText: async () => {
      throw new Error("No external sends in broker tests");
    },
    editText: async () => {
      throw new Error("No external sends");
    },
  },
  Buffer.alloc(32, 2),
);
function command(category: "subscription" | "material" = "subscription") {
  const c = structuredClone(
    fixtures.find((f) => f.name === "subscription-telegram")!.value,
  ) as NotificationCommand;
  c.operationId = randomUUID();
  c.deliveryRef = randomUUID();
  c.notificationRef = randomUUID();
  if (category === "material")
    c.content = { category, kind: "material_published" };
  return c;
}
function publish(
  ch: ConfirmChannel,
  c: NotificationCommand,
  exchange = "inside.notifications.telegram.v1",
) {
  return new Promise<void>((resolve, reject) => {
    ch.publish(
      exchange,
      c.content.category,
      Buffer.from(JSON.stringify(c)),
      {
        persistent: true,
        mandatory: true,
        contentType: "application/json",
        type: c.contractVersion,
        messageId: c.operationId,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
async function start(inbox: NotificationInbox = provider) {
  const b = new NotificationBroker(
    url(users.provider),
    inbox,
    2,
    () => undefined,
  );
  brokers.push(b);
  await b.open();
  return b;
}
beforeAll(async () => {
  await migrateToLatest(db);
  await api(`vhosts/${vhost}`, "PUT", {});
  for (const user of Object.values(users))
    await api(`users/${user}`, "PUT", { password, tags: "" });
  await api(`permissions/${vhost}/${users.provider}`, "PUT", {
    configure: "^$",
    write: "^inside\\.results\\.telegram\\.v1$",
    read: "^telegram\\.notifications\\.(subscription|material)\\.v1$",
  });
  await api(`permissions/${vhost}/${users.producer}`, "PUT", {
    configure: "^$",
    write: "^inside\\.notifications\\.telegram\\.v1$",
    read: "^platform\\.notification-results\\.telegram\\.v1$",
  });
  await api(`permissions/${vhost}/${users.rogue}`, "PUT", {
    configure: "^$",
    write: "^inside\\.results\\.email\\.v1$",
    read: "^$",
  });
  const admin = await connection();
  const ch = await admin.createChannel();
  for (const e of topology.exchanges)
    await ch.assertExchange(e.name, e.type, { durable: e.durable });
  await ch.assertExchange("inside.results.email.v1", "topic", {
    durable: true,
  });
  for (const q of topology.queues)
    await ch.assertQueue(q.name, { durable: true, arguments: q.arguments });
  for (const b of topology.bindings)
    await ch.bindQueue(b.destination, b.source, b.routing_key);
  await ch.close();
}, 30000);
beforeEach(async () => {
  await sql`truncate telegram_transport_fairness, notification_attempts, notification_commands, notification_deliveries, notification_result_outbox, notification_quarantine cascade`.execute(
    db,
  );
  const admin = await connection();
  const ch = await admin.createChannel();
  for (const q of topology.queues) await ch.purgeQueue(q.name);
  await ch.close();
});
afterEach(async () => {
  for (const b of brokers) await b.close();
  brokers = [];
});
afterAll(async () => {
  for (const c of connections) await c.close().catch(() => undefined);
  await api(`vhosts/${vhost}`, "DELETE");
  for (const u of Object.values(users)) await api(`users/${u}`, "DELETE");
  await sql`truncate telegram_transport_fairness, notification_attempts, notification_commands, notification_deliveries, notification_result_outbox, notification_quarantine cascade`.execute(
    db,
  );
  await db.destroy();
}, 30000);
describe("real RabbitMQ consumer, confirms, permissions and limits", () => {
  it("runtime worker delivers both lanes under sustained backlog and delayed HTTP preflight", async () => {
    await sql`truncate platform_links, link_transactions, bot_contacts, telegram_transport_slots cascade`.execute(
      db,
    );
    const now = new Date();
    const commands = Array.from({ length: 32 }, (_, i) => {
      const c = command(i < 24 ? "subscription" : "material");
      c.binding.accountRef = `synthetic-account-${i}`;
      c.binding.telegramIdentityRef = `synthetic-identity-${i}`;
      c.text = `${c.content.category}:${i}`;
      return c;
    });
    for (const c of commands) {
      c.issuedAt = now.toISOString();
      c.notAfter = new Date(now.getTime() + 600000).toISOString();
    }
    for (const [i, c] of commands.entries())
      await seedNotificationRecipient(db, c, now, String(10001 + i));
    const authorizations: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString());
      authorizations.push(request);
      await new Promise((resolve) => setTimeout(resolve, 80));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ...request,
          status: "allowed",
          permitRef: randomUUID(),
          validUntil: new Date(Date.now() + 4900).toISOString(),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP test endpoint");
    const config = loadApplicationConfig({
      DATABASE_URL: process.env.DATABASE_URL!,
      TELEGRAM_BOT_IDENTITY: "inside",
      TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
      TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook",
      PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
      TELEGRAM_WELCOME_TEXT: "synthetic",
      TELEGRAM_LINK_RECEIPT_TEXT: "synthetic",
      TELEGRAM_LINKED_MEMBER_TEXT: "synthetic",
      TELEGRAM_LINKED_NON_MEMBER_TEXT: "synthetic",
      TELEGRAM_LINKED_UNAVAILABLE_TEXT: "synthetic",
      TELEGRAM_NOTIFICATIONS_ENABLED: "true",
      NOTIFICATION_AMQP_URL: url(users.provider),
      NOTIFICATION_AUTHORIZE_URL: `http://127.0.0.1:${address.port}/internal/notifications/dispatch/authorize`,
      NOTIFICATION_AUTHORIZE_SECRET: "a".repeat(32),
      NOTIFICATION_QUARANTINE_KEY: "b".repeat(64),
      TELEGRAM_DELIVERY_MODE: "live",
      TELEGRAM_BOT_TOKEN: "synthetic-never-passed-to-real-adapter",
    });
    const sent: string[] = [];
    const worker = new NotificationWorker(
      config,
      db,
      {
        sendText: async (message) => {
          sent.push(message.text);
          return { kind: "delivered", providerMessageId: String(sent.length) };
        },
        editText: async () => {
          throw new Error("unused");
        },
      },
      systemClock,
    );
    try {
      worker.onApplicationBootstrap();
      const producer = await connection(users.producer);
      const ch = await producer.createConfirmChannel();
      for (const c of commands) await publish(ch, c);
      let general = 0;
      let running: Promise<void> | undefined;
      const traffic = setInterval(() => {
        if (running) return;
        running = db
          .transaction()
          .execute((tx) =>
            reserveTelegramSlot(tx, "inside", `general:${general}`, new Date()),
          )
          .then((granted) => {
            if (granted) general++;
          })
          .finally(() => {
            running = undefined;
          });
      }, 30);
      try {
        await expect
          .poll(
            () => sent.filter((text) => text.startsWith("material:")).length,
            { timeout: 10000 },
          )
          .toBeGreaterThanOrEqual(3);
        expect(
          sent.filter((text) => text.startsWith("subscription:")).length,
        ).toBeGreaterThanOrEqual(3);
        expect(general).toBeGreaterThan(0);
        expect(
          await db
            .selectFrom("notification_commands")
            .select("operation_id")
            .where("category", "=", "subscription")
            .where("state", "=", "accepted")
            .execute(),
        ).not.toHaveLength(0);
      } finally {
        clearInterval(traffic);
        await running;
      }
      await expect
        .poll(() => sent.length, { timeout: 15000 })
        .toBe(commands.length);
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom("notification_result_outbox")
                .selectAll()
                .where("published_at", "is", null)
                .execute()
            ).length,
        )
        .toBe(0);
      expect(authorizations.length).toBeGreaterThanOrEqual(2);
      expect(
        (
          await db.selectFrom("notification_commands").selectAll().execute()
        ).map((c) => c.state),
      ).toEqual(Array.from({ length: commands.length }, () => "sent"));
    } finally {
      await worker.onModuleDestroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);

  it("blocked subscription ingestion respects prefetch while material lane still commits", async () => {
    const c = await connection(users.producer);
    const ch = await c.createConfirmChannel();
    let subscriptionInFlight = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({
      receive: async (bytes, envelope, category) => {
        if (category === "subscription") {
          subscriptionInFlight++;
          await held;
        }
        return provider.receive(bytes, envelope, category);
      },
    });
    try {
      for (let i = 0; i < 8; i++) await publish(ch, command());
      const material = command("material");
      await publish(ch, material);
      await expect
        .poll(async () =>
          Boolean(
            await db
              .selectFrom("notification_commands")
              .select("operation_id")
              .where("operation_id", "=", material.operationId)
              .executeTakeFirst(),
          ),
        )
        .toBe(true);
      expect(subscriptionInFlight).toBe(2);
    } finally {
      release();
    }
    await expect
      .poll(
        async () =>
          (await db.selectFrom("notification_commands").selectAll().execute())
            .length,
      )
      .toBe(9);
  });

  it("consumes both durable lanes, acknowledges after inbox and replays accepted result while Platform is offline", async () => {
    const p = await connection(users.producer);
    const ch = await p.createConfirmChannel();
    await start();
    const commands = [command(), command("material")];
    for (const c of commands) await publish(ch, c);
    await expect
      .poll(
        async () =>
          (await db.selectFrom("notification_commands").selectAll().execute())
            .length,
      )
      .toBe(2);
    const original = await db
      .selectFrom("notification_commands")
      .selectAll()
      .execute();
    for (const c of commands) await publish(ch, c);
    await expect
      .poll(
        async () =>
          (await db.selectFrom("notification_commands").selectAll().execute())
            .length,
      )
      .toBe(2);
    expect(
      (await db.selectFrom("notification_commands").selectAll().execute()).map(
        (r) => r.result,
      ),
    ).toEqual(original.map((r) => r.result));
    for (const c of commands)
      expect(
        (
          await db
            .selectFrom("notification_commands")
            .selectAll()
            .where("operation_id", "=", c.operationId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("accepted");
  });
  it("re-delivers after consumer dies before commit/ack; poison is durable before ack", async () => {
    const c = command();
    const p = await connection(users.producer);
    const ch = await p.createConfirmChannel();
    let reached = false;
    const broken = await start({
      receive: async () => {
        reached = true;
        throw new Error("crashed before commit");
      },
    });
    await publish(ch, c);
    await expect.poll(() => reached).toBe(true);
    await broken.close();
    await start();
    await expect
      .poll(
        async () =>
          (await db.selectFrom("notification_commands").selectAll().execute())
            .length,
      )
      .toBe(1);
    await publish(ch, {
      ...c,
      contractVersion: "unknown",
    } as unknown as NotificationCommand);
    await expect
      .poll(
        async () =>
          (await db.selectFrom("notification_quarantine").selectAll().execute())
            .length,
      )
      .toBe(1);
  });
  it("redelivery after inbox commit before ack preserves immutable receipt", async () => {
    const c = command();
    const p = await connection(users.producer);
    const ch = await p.createConfirmChannel();
    const broken = await start({
      receive: async (...args) => {
        await provider.receive(...args);
        throw new Error("crashed after commit before ack");
      },
    });
    await publish(ch, c);
    await expect
      .poll(
        async () =>
          (await db.selectFrom("notification_commands").selectAll().execute())
            .length,
      )
      .toBe(1);
    await broken.close();
    const original = (
      await db
        .selectFrom("notification_commands")
        .selectAll()
        .executeTakeFirstOrThrow()
    ).result;
    await start();
    await publish(ch, c);
    await expect
      .poll(
        async () =>
          (
            await db
              .selectFrom("notification_commands")
              .selectAll()
              .executeTakeFirstOrThrow()
          ).result,
      )
      .toEqual(original);
  });
  it("positive result confirm drains outbox; mandatory return retains it until routing is restored", async () => {
    const c = command();
    const p = await connection(users.producer);
    const ch = await p.createConfirmChannel();
    const b = await start();
    await publish(ch, c);
    await expect
      .poll(
        async () =>
          (
            await db
              .selectFrom("notification_result_outbox")
              .selectAll()
              .execute()
          ).length,
      )
      .toBe(1);
    const admin = await connection();
    const control = await admin.createChannel();
    const queue = "platform.notification-results.telegram.v1";
    await control.unbindQueue(
      queue,
      "inside.results.telegram.v1",
      "delivery.result",
    );
    await expect(provider.publishResults((r) => b.publish(r))).rejects.toThrow(
      "not confirmed/routed",
    );
    expect(
      (
        await db
          .selectFrom("notification_result_outbox")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).published_at,
    ).toBeNull();
    await control.bindQueue(
      queue,
      "inside.results.telegram.v1",
      "delivery.result",
    );
    await provider.publishResults((r) => b.publish(r));
    const result = await ch.get(queue);
    expect(result).toBeTruthy();
    if (result) {
      expect(JSON.parse(result.content.toString()).state).toBe("accepted");
      ch.ack(result);
    }
    expect(
      (
        await db
          .selectFrom("notification_result_outbox")
          .selectAll()
          .executeTakeFirstOrThrow()
      ).published_at,
    ).not.toBeNull();
  });
  it("real ACL rejects foreign producer, provider writes to command exchange, configure, and foreign queue reads", async () => {
    for (const [user, action] of [
      [users.rogue, async (ch: ConfirmChannel) => publish(ch, command())],
      [users.provider, async (ch: ConfirmChannel) => publish(ch, command())],
      [
        users.provider,
        async (ch: ConfirmChannel) => ch.assertQueue("forbidden"),
      ],
      [
        users.provider,
        async (ch: ConfirmChannel) =>
          ch.get("platform.notification-results.telegram.v1"),
      ],
    ] as const) {
      const c = await connection(user);
      const ch = await c.createConfirmChannel();
      ch.on("error", () => undefined);
      await expect(action(ch)).rejects.toThrow();
    }
  });
  it("quorum limits reject publishing rather than discard oldest; topology has no TTL and unlimited redelivery", async () => {
    const c = await connection();
    const ch = await c.createConfirmChannel();
    ch.on("error", () => undefined);
    const q = `bounded-${randomUUID()}`;
    await ch.assertQueue(q, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-max-length": 1,
        "x-overflow": "reject-publish",
        "x-delivery-limit": -1,
      },
    });
    let rejected = false;
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise<void>((resolve, reject) =>
          ch.sendToQueue(
            q,
            Buffer.from(String(i)),
            { persistent: true },
            (e) => (e ? reject(e) : resolve()),
          ),
        );
      } catch {
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    const first = await ch.get(q);
    expect(first && first.content.toString()).toBe("0");
    if (first) ch.ack(first);
    for (const queue of topology.queues) {
      const info = (await (
        await api(`queues/${vhost}/${queue.name}`, "GET")
      ).json()) as { arguments: Record<string, unknown> };
      expect(info.arguments["x-delivery-limit"]).toBe(-1);
      expect(info.arguments["x-overflow"]).toBe("reject-publish");
      expect(info.arguments).not.toHaveProperty("x-message-ttl");
      expect(info.arguments).not.toHaveProperty("x-expires");
    }
  });
});

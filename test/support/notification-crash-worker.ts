import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/database/create-database.js";
import { NotificationProvider } from "../../src/modules/notifications/notification-provider.js";
const db = createDatabase(process.env.DATABASE_URL!);
const now = new Date("2026-09-08T12:00:00Z");
const provider = new NotificationProvider(
  db,
  "inside",
  { now: () => now },
  {
    authorize: async (r) => ({
      ...r,
      status: "allowed",
      permitRef: randomUUID(),
      validUntil: new Date(now.getTime() + 5000).toISOString(),
    }),
  },
  {
    sendText: async () => {
      process.exit(74);
    },
    editText: async () => {
      throw new Error("unused");
    },
  },
  Buffer.alloc(32, 1),
);
await provider.processCategory("subscription");
await db.destroy();

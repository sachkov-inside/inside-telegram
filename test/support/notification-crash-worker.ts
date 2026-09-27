import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/database/create-database.js";
import { NotificationProvider } from "../../src/modules/notifications/notification-provider.js";
import { required } from "./required.js";
const db = createDatabase(required(process.env.DATABASE_URL));
const now = new Date("2026-09-08T12:00:00Z");
const provider = new NotificationProvider(
  db,
  "inside",
  { now: () => now },
  {
    authorize: (r) =>
      Promise.resolve({
        ...r,
        status: "allowed",
        permitRef: randomUUID(),
        validUntil: new Date(now.getTime() + 5000).toISOString(),
      }),
  },
  {
    sendText: () => {
      process.exit(74);
    },
    editText: () => {
      return Promise.reject(new Error("unused"));
    },
  },
  Buffer.alloc(32, 1),
);
await provider.processCategory("subscription");
await db.destroy();

import "dotenv/config";

import { createDatabase } from "./create-database.js";
import { migrateToLatest } from "./migrator.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabase(databaseUrl);
try {
  await migrateToLatest(database);
} finally {
  await database.destroy();
}

import { Client } from "pg";

const database = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
  statement_timeout: 2000,
});

try {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing database configuration");
  }
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? "3002"}/integrations/platform/v1/identity-links`,
    { method: "POST", signal: AbortSignal.timeout(2000) },
  );
  if (response.status !== 401) {
    throw new Error("Application authentication is not ready");
  }
  await database.connect();
  await database.query(`
    select
      (select count(*) from bot_contacts where false),
      (select count(*) from membership_reconciliations where false),
      (select count(*) from identity_link_recoveries where false)
  `);
} catch {
  console.error("Telegram application or database is not ready");
  process.exitCode = 1;
} finally {
  await database.end();
}

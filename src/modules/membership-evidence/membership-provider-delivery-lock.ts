import { sql, type Kysely } from "kysely";

import type { Database, DatabaseSchema } from "../../database/database.js";

function providerDeliveryLockKey(botIdentity: string): string {
  return `membership-provider-delivery:${botIdentity}`;
}

export async function lockProviderStateChanges(
  database: Kysely<DatabaseSchema>,
  botIdentity: string,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(${providerDeliveryLockKey(botIdentity)}, 0)
    )
  `.execute(database);
}

export async function withProviderDeliveryLock<Result>(
  database: Database,
  botIdentity: string,
  operation: (connection: Kysely<DatabaseSchema>) => Promise<Result>,
): Promise<Result> {
  return database.connection().execute(async (connection) => {
    const lockKey = providerDeliveryLockKey(botIdentity);
    await sql`
      select pg_advisory_lock(hashtextextended(${lockKey}, 0))
    `.execute(connection);
    try {
      return await operation(connection);
    } finally {
      await sql`
        select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
      `.execute(connection);
    }
  });
}

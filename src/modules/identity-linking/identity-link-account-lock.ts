import { sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../../database/database.js";

const ACCOUNT_LOCK_PREFIX = "inside-telegram:platform-link-account:";

export async function lockIdentityLinkAccount(
  transaction: Transaction<DatabaseSchema>,
  accountRef: string,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`${ACCOUNT_LOCK_PREFIX}${accountRef}`}, 0)
    )
  `.execute(transaction);
}

import type { Database } from "../../database/database.js";

export async function linkedAccount(database: Database, user: string) {
  return database
    .selectFrom("platform_links")
    .select("account_ref")
    .where("telegram_user_id", "=", user)
    .executeTakeFirst();
}

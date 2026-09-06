import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const signInMessageResultMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("sign_in_requests")
      .addColumn("confirmation_message_id", "bigint")
      .execute();
    await db.schema
      .alterTable("sign_in_requests")
      .addCheckConstraint(
        "sign_in_confirmation_message_id_positive",
        sql`confirmation_message_id > 0`,
      )
      .execute();
    await db.schema
      .alterTable("start_response_deliveries")
      .addColumn("edit_message_id", "bigint")
      .execute();
    await db.schema
      .alterTable("start_response_deliveries")
      .addCheckConstraint(
        "start_response_edit_message_id_positive",
        sql`edit_message_id > 0`,
      )
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("start_response_deliveries")
      .dropColumn("edit_message_id")
      .execute();
    await db.schema
      .alterTable("sign_in_requests")
      .dropColumn("confirmation_message_id")
      .execute();
  },
};

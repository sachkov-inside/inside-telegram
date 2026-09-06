import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const botSignInMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("sign_in_requests")
      .addColumn("request_ref", "uuid", (column) => column.primaryKey())
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("start_token_digest", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("browser_secret_digest", "text", (column) => column.notNull())
      .addColumn("confirmation_code", "text", (column) => column.notNull())
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint")
      .addColumn("private_chat_id", "bigint")
      .addColumn("created_at", "timestamptz", (column) => column.notNull())
      .addColumn("expires_at", "timestamptz", (column) => column.notNull())
      .addColumn("approved_at", "timestamptz")
      .addColumn("consumed_at", "timestamptz")
      .addCheckConstraint(
        "sign_in_requests_state_check",
        sql`state in ('pending', 'awaiting_approval', 'approved', 'denied', 'consumed')`,
      )
      .addCheckConstraint(
        "sign_in_requests_lifetime_check",
        sql`expires_at > created_at and expires_at <= created_at + interval '5 minutes'`,
      )
      .addCheckConstraint(
        "sign_in_requests_digest_check",
        sql`start_token_digest ~ '^[A-Za-z0-9_-]{43}$' and browser_secret_digest ~ '^[A-Za-z0-9_-]{43}$' and start_token_digest <> browser_secret_digest`,
      )
      .addCheckConstraint(
        "sign_in_requests_code_check",
        sql`confirmation_code ~ '^[0-9]{6}$'`,
      )
      .execute();
    await db.schema
      .createTable("sign_in_subjects")
      .addColumn("subject_ref", "uuid", (column) => column.primaryKey())
      .addColumn("bot_identity", "text", (column) => column.notNull())
      .addColumn("telegram_user_id", "bigint", (column) => column.notNull())
      .addUniqueConstraint("sign_in_subjects_identity_unique", [
        "bot_identity",
        "telegram_user_id",
      ])
      .execute();
    await db.schema
      .alterTable("start_response_deliveries")
      .addColumn("sign_in_request_ref", "uuid", (column) =>
        column.references("sign_in_requests.request_ref"),
      )
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("start_response_deliveries")
      .dropColumn("sign_in_request_ref")
      .execute();
    await db.schema.dropTable("sign_in_subjects").execute();
    await db.schema.dropTable("sign_in_requests").execute();
  },
};

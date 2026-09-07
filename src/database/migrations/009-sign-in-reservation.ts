import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const signInReservationMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("sign_in_subjects")
      .addColumn("reserved_for_sign_in", "boolean", (column) =>
        column.notNull().defaultTo(false),
      )
      .execute();
    await sql`update sign_in_subjects s set reserved_for_sign_in = true
      where not exists (select 1 from platform_links p where p.bot_identity = s.bot_identity and p.telegram_user_id = s.telegram_user_id)`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("sign_in_subjects")
      .dropColumn("reserved_for_sign_in")
      .execute();
  },
};

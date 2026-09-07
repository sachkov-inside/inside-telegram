import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const authorDraftsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`create table communication_author_drafts (
      bot_identity text not null, owner_account_ref text not null,
      draft_id uuid not null, kind text not null check (kind in ('broadcast','funnel','intro')),
      name text not null, snapshot jsonb,
      primary key (bot_identity, owner_account_ref, draft_id)
    )`.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop table communication_author_drafts`.execute(db);
  },
};

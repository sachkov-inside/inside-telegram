import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Updates of one sender run one at a time and in `update_id` order; other senders run in
 * parallel. Rows already waiting get their sender from the stored payload.
 */
export const updateSenderLanesMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      alter table telegram_updates add column ordering_key text;
      update telegram_updates set ordering_key = coalesce(
        payload->'chat_member'->'new_chat_member'->'user'->>'id',
        payload->'callback_query'->'from'->>'id',
        payload->'chat_join_request'->'from'->>'id',
        payload->'my_chat_member'->'from'->>'id',
        payload->'message'->'from'->>'id',
        payload->'edited_message'->'from'->>'id',
        payload->'message'->'chat'->>'id',
        payload->'edited_message'->'chat'->>'id'
      )
      where state in ('pending', 'processing');
      create index telegram_updates_lane on telegram_updates
        (bot_identity, ordering_key, update_id)
        where state in ('pending', 'processing');
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`
      drop index telegram_updates_lane;
      alter table telegram_updates drop column ordering_key;
    `.execute(db);
  },
};

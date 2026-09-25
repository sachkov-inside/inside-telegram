import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Updates run in lanes: one per user conversation and one per chat whose membership changes.
 * A lane's updates run one at a time in `update_id` order; lanes run in parallel. Rows already
 * waiting get their lane from the stored payload by the rule in `telegram-update-inbox.ts`.
 */
export const updateLanesMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      alter table telegram_updates add column lane_key text;
      update telegram_updates set lane_key = case
        when coalesce(payload->'chat_member', payload->'my_chat_member')
          ->'chat'->>'type' <> 'private'
        then coalesce(payload->'chat_member', payload->'my_chat_member')->'chat'->>'id'
        else coalesce(
          payload->'message'->'from'->>'id',
          payload->'edited_message'->'from'->>'id',
          payload->'callback_query'->'from'->>'id',
          payload->'chat_join_request'->'from'->>'id',
          payload->'my_chat_member'->'from'->>'id'
        )
      end
      where state in ('pending', 'processing');
      create index telegram_updates_lane on telegram_updates
        (bot_identity, lane_key, update_id)
        where state in ('pending', 'processing');
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`
      drop index telegram_updates_lane;
      alter table telegram_updates drop column lane_key;
    `.execute(db);
  },
};

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Updates run in lanes; rows already waiting get their lane by `laneOf` in the inbox. */
export const updateLanesMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      alter table telegram_updates add column lane_key text;
      update telegram_updates set lane_key = case
        when group_chat->>'id' is not null
          and coalesce(group_chat->>'type', '') <> 'private'
        then group_chat->>'id'
        else coalesce(
          payload->'message'->'from'->>'id',
          payload->'edited_message'->'from'->>'id',
          payload->'callback_query'->'from'->>'id',
          payload->'chat_join_request'->'from'->>'id',
          payload->'my_chat_member'->'from'->>'id'
        )
      end
      from (
        select bot_identity as bot, update_id as id, coalesce(
          payload->'chat_member',
          payload->'my_chat_member',
          payload->'chat_join_request'
        )->'chat' as group_chat
        from telegram_updates
      ) as source
      where source.bot = telegram_updates.bot_identity
        and source.id = telegram_updates.update_id
        and state in ('pending', 'processing');
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

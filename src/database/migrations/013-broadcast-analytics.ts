import { sql, type Kysely } from "kysely";
export const broadcastAnalyticsMigration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      insert into communication_contacts(contact_id,bot_identity,telegram_user_id)
        select gen_random_uuid(),bot_identity,telegram_user_id from bot_contacts on conflict do nothing;
      create table communication_broadcasts (
        broadcast_id uuid primary key, bot_identity text not null, owner_account_ref text not null,
        revision integer not null, state text not null check(state in ('draft','scheduled','running','paused','cancelled','completed')),
        parts jsonb not null, audience jsonb not null, scheduled_at timestamptz,
        audience_snapshot_id uuid unique, snapshot_size integer not null default 0,
        launched_at timestamptz, launch_operation_id uuid, created_at timestamptz not null
      );
      alter table communication_deliveries add column cancellation_reason text;
      alter table communication_deliveries add column broadcast_id uuid references communication_broadcasts;
      alter table communication_deliveries drop constraint communication_deliveries_kind_check;
      alter table communication_deliveries add constraint communication_deliveries_kind_check
        check(kind in ('intro','entry','step','fallback','broadcast'));
      alter table communication_deliveries add constraint communication_broadcast_owner_check
        check ((kind = 'broadcast') = (broadcast_id is not null) and (broadcast_id is null or funnel_id is null));
      create unique index communication_broadcast_recipient on communication_deliveries(broadcast_id,contact_id) where broadcast_id is not null;
      create table communication_tracking_tokens (
        token text primary key, bot_identity text not null,
        delivery_id uuid not null references communication_deliveries, part_id uuid not null,
        destination text not null, created_at timestamptz not null,
        unique(delivery_id,part_id,destination)
      );
      create table communication_tracking_hits (
        bot_identity text not null, event_id uuid not null, token text not null references communication_tracking_tokens,
        occurred_at timestamptz not null, received_at timestamptz not null,
        traffic text not null check(traffic in ('unknown','known_automation')),
        primary key(bot_identity,event_id)
      );
      create index communication_tracking_hit_token on communication_tracking_hits(token);
      create index communication_entry_history on communication_entries(contact_id,entered_at,update_id);
    `.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // Refuse rollback if it would destroy broadcast history.
    await sql`alter table communication_deliveries drop constraint communication_broadcast_owner_check;
      alter table communication_deliveries drop constraint communication_deliveries_kind_check;
      alter table communication_deliveries add constraint communication_deliveries_kind_check check(kind in ('intro','entry','step','fallback'));
      drop table communication_tracking_hits, communication_tracking_tokens;
      drop index communication_entry_history;
      alter table communication_deliveries drop column broadcast_id, drop column cancellation_reason;
      drop table communication_broadcasts;`.execute(db);
  },
};

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Sales funnel events for Platform (#118): one outbox row per `inside.sales-funnel-events.v1`
 * event, written with the fact it reports. Past entries, explicit `/stop` and `/resume` and
 * confirmed links are queued once under the event ids the application derives for the same
 * facts, so Platform recognises a repeat as a duplicate instead of counting it twice.
 */
export const salesFunnelEventsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      create table sales_funnel_event_outbox (
        sequence_id bigint generated always as identity,
        event_id uuid primary key,
        bot_identity text not null,
        kind text not null
          check (kind in ('bot_entered', 'marketing_consent', 'account_linked')),
        event jsonb not null,
        created_at timestamptz not null,
        state text not null default 'pending'
          check (state in ('pending', 'delivering', 'retry_scheduled', 'delivered', 'rejected')),
        attempt_count integer not null default 0,
        available_at timestamptz not null,
        locked_at timestamptz,
        delivered_at timestamptz,
        diagnostic_code text,
        unique (sequence_id)
      );
      create index sales_funnel_event_outbox_due on sales_funnel_event_outbox
        (available_at, sequence_id) where state in ('pending', 'retry_scheduled');

      -- Mirrors salesFunnelEventId(): SHA-256 of the name as an RFC 9562 version 8 UUID.
      create function pg_temp.sales_funnel_event_id(name text) returns uuid
        language sql immutable as $$
          select (
            substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-8' || substr(h, 14, 3) || '-' ||
            substr('89ab', ('x' || substr(h, 17, 1))::bit(4)::int % 4 + 1, 1) ||
            substr(h, 18, 3) || '-' || substr(h, 21, 12)
          )::uuid
          from (select encode(sha256(convert_to(name, 'UTF8')), 'hex') as h) digest
        $$;
      create function pg_temp.sales_funnel_instant(value timestamptz) returns text
        language sql immutable as $$
          select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        $$;

      insert into sales_funnel_event_outbox
        (event_id, bot_identity, kind, event, created_at, available_at)
      select id, bot_identity, 'bot_entered',
        jsonb_build_object(
          'eventId', id, 'contactRef', contact_id,
          'occurredAt', pg_temp.sales_funnel_instant(entered_at),
          'kind', 'bot_entered',
          'sourceCode', case when source_code ~ '^[A-Za-z0-9_-]{1,64}$' then source_code end),
        now(), now()
      from (
        select pg_temp.sales_funnel_event_id(
          'bot_entered:' || bot_identity || ':' || update_id) as id, *
        from communication_entries
      ) entries
      order by entered_at, update_id;

      insert into sales_funnel_event_outbox
        (event_id, bot_identity, kind, event, created_at, available_at)
      select id, bot_identity, 'marketing_consent',
        jsonb_build_object(
          'eventId', id, 'contactRef', contact_id,
          'occurredAt', pg_temp.sales_funnel_instant(observed_at),
          'kind', 'marketing_consent', 'granted', enabled),
        now(), now()
      from (
        select pg_temp.sales_funnel_event_id(
          'marketing_consent:' || bot_identity || ':' || update_id) as id, *
        from communication_preferences
      ) preferences
      order by observed_at, update_id;

      -- A confirmed link always has a communication record, as recordAccountLinked() ensures.
      insert into communication_contacts (contact_id, bot_identity, telegram_user_id)
      select gen_random_uuid(), contacts.bot_identity, contacts.telegram_user_id
      from platform_links links
      join bot_contacts contacts
        on contacts.bot_identity = links.bot_identity
        and contacts.telegram_user_id = links.telegram_user_id
      on conflict (bot_identity, telegram_user_id) do nothing;

      insert into sales_funnel_event_outbox
        (event_id, bot_identity, kind, event, created_at, available_at)
      select id, bot_identity, 'account_linked',
        jsonb_build_object(
          'eventId', id, 'contactRef', contact_id,
          'occurredAt', pg_temp.sales_funnel_instant(linked_at),
          'kind', 'account_linked', 'telegramIdentityRef', telegram_identity_ref),
        now(), now()
      from (
        select pg_temp.sales_funnel_event_id(
          'account_linked:' || links.link_transaction_ref) as id,
          links.bot_identity, contacts.contact_id, links.linked_at,
          links.telegram_identity_ref
        from platform_links links
        join communication_contacts contacts
          on contacts.bot_identity = links.bot_identity
          and contacts.telegram_user_id = links.telegram_user_id
      ) linked
      order by linked_at;

      drop function pg_temp.sales_funnel_event_id(text);
      drop function pg_temp.sales_funnel_instant(timestamptz);
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop table sales_funnel_event_outbox`.execute(db);
  },
};

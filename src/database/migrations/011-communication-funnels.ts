import { sql, type Kysely } from "kysely";
export const communicationFunnelsMigration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      create table communication_funnels (
        funnel_id uuid primary key, bot_identity text not null, owner_account_ref text not null,
        revision integer not null, published_revision integer,
        lifecycle text not null check (lifecycle in ('draft','published','paused','archived')),
        draft jsonb not null, published jsonb, is_default boolean not null default false
      );
      create unique index communication_default on communication_funnels(bot_identity) where is_default;
      create table communication_publications (
        funnel_id uuid not null references communication_funnels, revision integer not null,
        snapshot jsonb not null, published_at timestamptz not null, primary key(funnel_id,revision)
      );
      create table communication_sources (
        bot_identity text not null, source_id uuid not null, code text not null,
        funnel_id uuid not null references communication_funnels,
        primary key(bot_identity,source_id), unique(bot_identity,code)
      );
      create table communication_step_ids (
        funnel_id uuid not null references communication_funnels, step_id uuid not null,
        first_published_at timestamptz not null, part_ids jsonb not null,
        primary key(funnel_id,step_id)
      );
      create table communication_intro (
        bot_identity text primary key, owner_account_ref text not null, snapshot jsonb not null
      );
      create table communication_contacts (
        contact_id uuid primary key, bot_identity text not null, telegram_user_id bigint not null,
        marketing_enabled boolean not null default true,
        unique(bot_identity,telegram_user_id),
        foreign key(bot_identity,telegram_user_id) references bot_contacts(bot_identity,telegram_user_id)
      );
      create table communication_enrollments (
        enrollment_id uuid primary key, contact_id uuid not null references communication_contacts,
        funnel_id uuid not null references communication_funnels, enrolled_at timestamptz not null, initial_entry_key text not null,
        unique(contact_id,funnel_id)
      );
      create table communication_entries (
        bot_identity text not null, update_id bigint not null, contact_id uuid not null references communication_contacts,
        funnel_id uuid references communication_funnels, source_id uuid, source_code text,
        entered_at timestamptz not null, outcome text not null, primary key(bot_identity,update_id)
      );
      create table communication_deliveries (
        delivery_id uuid primary key, dedup_key text not null unique,
        bot_identity text not null, contact_id uuid not null references communication_contacts,
        funnel_id uuid references communication_funnels, step_id uuid,
        kind text not null check(kind in ('intro','entry','step','fallback')),
        published_revision integer not null, snapshot jsonb not null, parts jsonb not null,
        revision integer not null default 1, due_at timestamptz not null,
        created_at timestamptz not null, completed_at timestamptz,
        cancel_requested boolean not null default false,
        attempt_id uuid, locked_at timestamptz
      );
      create index communication_due on communication_deliveries(due_at,delivery_id) where completed_at is null;
      create table telegram_transport_slots (
        bot_identity text not null, lane text not null, available_at timestamptz not null,
        primary key(bot_identity,lane)
      );
    `.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table telegram_transport_slots, communication_deliveries, communication_entries,
      communication_enrollments, communication_contacts, communication_intro, communication_step_ids,
      communication_sources, communication_publications, communication_funnels`.execute(
      db,
    );
  },
};

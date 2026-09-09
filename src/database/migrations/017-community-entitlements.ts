import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const communityEntitlementsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`create table community_desired_states (
      bot_identity text not null,
      account_ref text not null,
      entitlement_revision bigint not null,
      latest_operation uuid not null,
      telegram_identity_ref text not null,
      link_ref uuid not null,
      link_revision bigint not null,
      access jsonb not null,
      valid_until timestamptz,
      invite_link text,
      invite_state text not null default 'none'
        check (invite_state in ('none','unknown','created','revoked')),
      invite_expires_at timestamptz,
      status text not null,
      observed_membership text not null
        check (observed_membership in ('member','not_member','unknown')),
      due_at timestamptz not null,
      updated_at timestamptz not null,
      primary key (bot_identity, account_ref)
    );
    create index community_desired_due on community_desired_states(due_at);
    create table community_operations (
      operation_id uuid primary key,
      bot_identity text not null,
      account_ref text not null,
      entitlement_revision bigint not null,
      payload_digest text not null,
      command jsonb not null,
      result jsonb not null,
      status text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create index community_operations_account
      on community_operations(bot_identity, account_ref, entitlement_revision);
    create table community_bindings (
      bot_identity text not null,
      account_ref text not null,
      telegram_identity_ref text not null,
      link_ref uuid not null,
      link_revision bigint not null,
      telegram_user_id text,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      primary key (bot_identity, account_ref, telegram_identity_ref)
    );
    create table community_effects (
      effect_ref uuid primary key,
      bot_identity text not null,
      account_ref text not null,
      telegram_identity_ref text not null,
      operation_id uuid not null references community_operations,
      entitlement_revision bigint not null,
      effect text not null check (effect in
        ('community.ensure_admission','community.approve_join','community.ensure_absence')),
      step text not null check (step in
        ('observe','unban','create_invite','approve','ban','revoke_link','done')),
      state text not null check (state in
        ('pending','started','unknown','completed','superseded','failed')),
      join_request_key text,
      available_at timestamptz not null,
      attempt_count integer not null default 0,
      retry_count integer not null default 0,
      diagnostic_code text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create unique index community_effect_join_request
      on community_effects(join_request_key) where join_request_key is not null;
    create index community_effects_due on community_effects(bot_identity, available_at)
      where state in ('pending','started','unknown');
    create table community_effect_attempts (
      attempt_id uuid primary key,
      effect_ref uuid not null references community_effects,
      permit_ref uuid not null,
      action text not null,
      started_at timestamptz not null,
      outcome text not null check (outcome in
        ('started','unknown','succeeded','not_started','rejected')),
      diagnostic_code text
    );
    create index community_attempts_effect on community_effect_attempts(effect_ref);`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`drop table community_effect_attempts, community_effects,
      community_bindings, community_operations, community_desired_states`.execute(
      db,
    );
  },
};

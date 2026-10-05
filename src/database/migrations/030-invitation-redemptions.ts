import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Invitation links `i_<code>` (#135): one row per person and code continues redemption at
 * Platform until it answers. The row keeps no Account or Offer data; Platform owns both.
 */
export const invitationRedemptionsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      create table invitation_redemptions (
        redemption_id uuid primary key,
        bot_identity text not null,
        telegram_user_id bigint not null,
        private_chat_id bigint not null,
        identity_ref text not null,
        code text not null,
        trigger_update_id bigint not null,
        state text not null
          check (state in ('pending', 'needs_account', 'retry', 'completed')),
        created_at timestamptz not null,
        expires_at timestamptz not null,
        due_at timestamptz not null,
        lease_token uuid,
        lease_until timestamptz,
        attempts integer not null default 0,
        diagnostic_code text,
        unique (bot_identity, telegram_user_id, code)
      );
      create index invitation_redemptions_due on invitation_redemptions(due_at);
    `.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`drop table invitation_redemptions`.execute(db);
  },
};

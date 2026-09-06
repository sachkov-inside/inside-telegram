import { sql, type Kysely } from "kysely";
export const marketingPreferencesMigration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table communication_contacts add column unavailable_since timestamptz;
      create table communication_preferences (
        bot_identity text not null, update_id bigint not null, contact_id uuid not null references communication_contacts,
        enabled boolean not null, observed_at timestamptz not null, primary key(bot_identity, update_id)
      );`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table communication_preferences; alter table communication_contacts drop column unavailable_since`.execute(
      db,
    );
  },
};

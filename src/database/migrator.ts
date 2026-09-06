import { marketingPreferencesMigration } from "./migrations/012-marketing-preferences.js";
import { communicationFunnelsMigration } from "./migrations/011-communication-funnels.js";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";

import type { Database } from "./database.js";
import { ordinaryStartMigration } from "./migrations/001-ordinary-start.js";
import { identityLinkingMigration } from "./migrations/002-identity-linking.js";
import { initialMembershipEvidenceMigration } from "./migrations/003-initial-membership-evidence.js";
import { durableMembershipEventsMigration } from "./migrations/004-durable-membership-events.js";
import { membershipReconciliationMigration } from "./migrations/005-membership-reconciliation.js";
import { platformEvidenceConformanceMigration } from "./migrations/006-platform-evidence-conformance.js";
import { ownerIdentityRecoveryMigration } from "./migrations/007-owner-identity-recovery.js";
import { botSignInMigration } from "./migrations/008-bot-sign-in.js";

import { signInReservationMigration } from "./migrations/009-sign-in-reservation.js";

import { signInMessageResultMigration } from "./migrations/010-sign-in-message-result.js";

import { communicationsTemplatesMigration } from "./migrations/010-communications-templates.js";

const migrations = {
  "001-ordinary-start": ordinaryStartMigration,
  "002-identity-linking": identityLinkingMigration,
  "003-initial-membership-evidence": initialMembershipEvidenceMigration,
  "004-durable-membership-events": durableMembershipEventsMigration,
  "005-membership-reconciliation": membershipReconciliationMigration,
  "006-platform-evidence-conformance": platformEvidenceConformanceMigration,
  "007-owner-identity-recovery": ownerIdentityRecoveryMigration,
  "008-bot-sign-in": botSignInMigration,
  "009-sign-in-reservation": signInReservationMigration,
  "010-communications-templates": communicationsTemplatesMigration,
  "010-sign-in-message-result": signInMessageResultMigration,
  "011-communication-funnels": communicationFunnelsMigration,
  "012-marketing-preferences": marketingPreferencesMigration,
};

function createMigrator(db: Database): Migrator {
  return new Migrator({
    db,
    allowUnorderedMigrations: true,
    provider: {
      async getMigrations() {
        // Kysely calls the provider under its migration lock, after creating the ledger.
        // Only the independently deployed communications sequence may cross the sign-in sequence.
        const independent = [
          "010-communications-templates",
          "011-communication-funnels",
        ];
        const expected = Object.keys(migrations)
          .filter((name) => !independent.includes(name))
          .sort();
        const history = await sql<{
          name: string;
        }>`select name from kysely_migration order by timestamp, name`.execute(
          db,
        );
        const ordered = history.rows.filter(
          ({ name }) => !independent.includes(name),
        );
        const communications = history.rows.filter(({ name }) =>
          independent.includes(name),
        );
        if (
          ordered.some(({ name }, index) => name !== expected[index]) ||
          communications.some(({ name }, index) => name !== independent[index])
        ) {
          throw new Error(
            "Migration history is out of order outside the communications compatibility exception",
          );
        }
        return migrations;
      },
    },
  });
}

export async function migrateToLatest(db: Database): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();

  if (error) {
    throw new Error("Database migration failed", { cause: error });
  }

  const failed = results?.find((result) => result.status === "Error");
  if (failed) {
    throw new Error(`Database migration ${failed.migrationName} failed`);
  }
}

export async function migrateDown(db: Database): Promise<void> {
  const { error } = await createMigrator(db).migrateDown();
  if (error) {
    throw new Error("Database rollback failed", { cause: error });
  }
}

export async function migrateTo(
  db: Database,
  migrationName: string,
): Promise<void> {
  const { error, results } = await createMigrator(db).migrateTo(migrationName);
  if (error) {
    throw new Error(`Database migration to ${migrationName} failed`, {
      cause: error,
    });
  }

  const failed = results?.find((result) => result.status === "Error");
  if (failed) {
    throw new Error(`Database migration ${failed.migrationName} failed`);
  }
}

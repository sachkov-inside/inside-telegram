import { Migrator, type MigrationProvider } from "kysely/migration";

import type { Database } from "./database.js";
import { ordinaryStartMigration } from "./migrations/001-ordinary-start.js";
import { identityLinkingMigration } from "./migrations/002-identity-linking.js";
import { initialMembershipEvidenceMigration } from "./migrations/003-initial-membership-evidence.js";
import { durableMembershipEventsMigration } from "./migrations/004-durable-membership-events.js";
import { membershipReconciliationMigration } from "./migrations/005-membership-reconciliation.js";
import { platformEvidenceConformanceMigration } from "./migrations/006-platform-evidence-conformance.js";

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "001-ordinary-start": ordinaryStartMigration,
      "002-identity-linking": identityLinkingMigration,
      "003-initial-membership-evidence": initialMembershipEvidenceMigration,
      "004-durable-membership-events": durableMembershipEventsMigration,
      "005-membership-reconciliation": membershipReconciliationMigration,
      "006-platform-evidence-conformance": platformEvidenceConformanceMigration,
    };
  },
};

export async function migrateToLatest(db: Database): Promise<void> {
  const { error, results } = await new Migrator({
    db,
    provider: migrationProvider,
  }).migrateToLatest();

  if (error) {
    throw new Error("Database migration failed", { cause: error });
  }

  const failed = results?.find((result) => result.status === "Error");
  if (failed) {
    throw new Error(`Database migration ${failed.migrationName} failed`);
  }
}

export async function migrateDown(db: Database): Promise<void> {
  const { error } = await new Migrator({
    db,
    provider: migrationProvider,
  }).migrateDown();
  if (error) {
    throw new Error("Database rollback failed", { cause: error });
  }
}

export async function migrateTo(
  db: Database,
  migrationName: string,
): Promise<void> {
  const { error, results } = await new Migrator({
    db,
    provider: migrationProvider,
  }).migrateTo(migrationName);
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

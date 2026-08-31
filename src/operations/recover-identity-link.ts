import "dotenv/config";

import { createDatabase } from "../database/create-database.js";
import { systemClock } from "../modules/identity-linking/clock.js";
import { IdentityLinkRecovery } from "../modules/identity-linking/identity-link-recovery.js";
import {
  parseRecoveryArguments,
  redactRecoveryResult,
} from "./identity-link-recovery-cli.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exitCode = 1;
} else {
  const database = createDatabase(databaseUrl);
  try {
    const parsed = parseRecoveryArguments(process.argv.slice(2));
    const recovery = new IdentityLinkRecovery(database, systemClock);
    const result =
      parsed.mode === "dry-run"
        ? await recovery.preview(parsed.command)
        : await recovery.execute(parsed.command);
    process.stdout.write(`${JSON.stringify(redactRecoveryResult(result))}\n`);
    if (!result.ok) {
      process.exitCode = 2;
    }
  } catch {
    process.stderr.write(
      "Owner recovery rejected. Check arguments and local database diagnostics; no references were printed.\n",
    );
    process.exitCode = 1;
  } finally {
    await database.destroy();
  }
}

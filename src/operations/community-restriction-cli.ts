import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDatabase } from "../database/create-database.js";
import {
  CommunityRestrictions,
  type RestrictionDecision,
} from "../modules/community/community-restrictions.js";
import { systemClock } from "../modules/identity-linking/clock.js";

const mode = process.argv[2];
if (
  !process.env.DATABASE_URL ||
  process.stdin.isTTY ||
  !["--preview", "--apply"].includes(mode ?? "")
) {
  process.stderr.write(
    "Use --preview or --apply with an owner decision JSON on stdin and DATABASE_URL.\n",
  );
  process.exitCode = 1;
} else {
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as RestrictionDecision;
    if (
      Object.keys(input).sort().join(",") !==
      "accountRef,action,actorRef,botIdentity,expectedRevision,identityRef,operationId,reason"
    )
      throw new Error("Invalid decision");
    const status = await new CommunityRestrictions(db, systemClock).decide(
      input,
      mode === "--apply",
    );
    process.stdout.write(JSON.stringify({ status }) + "\n");
    if (status === "conflict") process.exitCode = 2;
  } catch {
    process.stderr.write(
      "Restriction decision rejected; no references printed.\n",
    );
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

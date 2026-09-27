import "../config/load-environment.js";
import { readFileSync } from "node:fs";
import { createDatabase } from "../database/create-database.js";
import {
  CommunityRestrictions,
  type RestrictionDecision,
} from "../modules/community/community-restrictions.js";
import { systemClock } from "../shared/clock.js";

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
    const input = readDecision(JSON.parse(readFileSync(0, "utf8")));
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

/** The owner decision with exactly its own typed fields; the provider validates their values. */
function readDecision(value: unknown): RestrictionDecision {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid decision");
  const fields = new Map<string, unknown>(Object.entries(value));
  const text = (name: string): string => {
    const field = fields.get(name);
    if (typeof field !== "string") throw new Error("Invalid decision");
    return field;
  };
  const action = fields.get("action");
  const expectedRevision = fields.get("expectedRevision");
  if (
    [...fields.keys()].sort().join(",") !==
      "accountRef,action,actorRef,botIdentity,expectedRevision,identityRef,operationId,reason" ||
    (action !== "hold" && action !== "restore") ||
    typeof expectedRevision !== "number"
  )
    throw new Error("Invalid decision");
  return {
    operationId: text("operationId"),
    botIdentity: text("botIdentity"),
    accountRef: text("accountRef"),
    identityRef: text("identityRef"),
    expectedRevision,
    action,
    actorRef: text("actorRef"),
    reason: text("reason"),
  };
}

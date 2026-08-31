import { readFile } from "node:fs/promises";

import { parse } from "dotenv";

import { validateCredentialedProofDatabaseUrl } from "./credentialed-proof.js";

const argumentsList = process.argv.slice(2);
if (argumentsList[0] === "--") {
  argumentsList.shift();
}
const environmentPath = argumentsList[0];
if (!environmentPath) {
  process.stderr.write("Credentialed proof ENV_FILE path is required.\n");
  process.exitCode = 1;
} else {
  try {
    const environment = parse(await readFile(environmentPath));
    validateCredentialedProofDatabaseUrl(environment.DATABASE_URL);
    process.stdout.write('{"ok":true,"stage":"proof-preflight"}\n');
  } catch {
    process.stderr.write(
      "Credentialed proof preflight rejected ENV_FILE; no values were printed.\n",
    );
    process.exitCode = 1;
  }
}

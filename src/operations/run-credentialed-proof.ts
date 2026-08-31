import "dotenv/config";

import { createDatabase } from "../database/create-database.js";
import {
  CREDENTIAL_PROOF_CAPTURE_PATH,
  CREDENTIAL_PROOF_EVIDENCE_PATH,
  runCredentialedProofCommand,
} from "./credentialed-proof.js";

const argumentsList = process.argv.slice(2);
if (argumentsList[0] === "--") {
  argumentsList.shift();
}
const command = argumentsList[0];
const snapshotLabel = argumentsList[1];
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const botId = process.env.TELEGRAM_PROOF_BOT_ID;
const botUsername = process.env.TELEGRAM_PROOF_BOT_USERNAME;

if (!command || !botToken || !botId || !botUsername) {
  process.stderr.write(
    "Proof command, TELEGRAM_BOT_TOKEN, TELEGRAM_PROOF_BOT_ID and TELEGRAM_PROOF_BOT_USERNAME are required.\n",
  );
  process.exitCode = 1;
} else {
  const needsDatabase =
    command === "observe-webhook-outage" ||
    command === "snapshot" ||
    command === "verify-webhook-auth" ||
    command === "verify-webhook-recovered";
  const databaseUrl = process.env.DATABASE_URL;
  const database =
    needsDatabase && databaseUrl ? createDatabase(databaseUrl) : undefined;
  try {
    if (needsDatabase && !database) {
      throw new Error("DATABASE_URL is required");
    }
    const result = await runCredentialedProofCommand(
      command,
      {
        botId,
        botIdentity: process.env.TELEGRAM_BOT_IDENTITY ?? "inside",
        botToken,
        botUsername,
        capturePath: CREDENTIAL_PROOF_CAPTURE_PATH,
        chatId: process.env.TELEGRAM_CANONICAL_CHAT_ID,
        evidencePath: CREDENTIAL_PROOF_EVIDENCE_PATH,
        minimumAdminConfirmed:
          process.env.TELEGRAM_PROOF_MINIMUM_ADMIN_CONFIRMED,
        retryMarker: process.env.TELEGRAM_PROOF_RETRY_MARKER,
        snapshotLabel,
        temporaryResourcesDisposed:
          process.env.TELEGRAM_PROOF_TEMPORARY_RESOURCES_DISPOSED,
        webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
        webhookUrl: process.env.TELEGRAM_PROOF_WEBHOOK_URL,
      },
      database,
    );
    process.stdout.write(
      typeof result === "string"
        ? `${result}\n`
        : `${JSON.stringify(result)}\n`,
    );
  } catch {
    process.stderr.write(
      "Credentialed proof stage failed; provider payloads and credentials were not printed.\n",
    );
    process.exitCode = 1;
  } finally {
    await database?.destroy();
  }
}

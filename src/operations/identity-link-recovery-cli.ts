import { createHash } from "node:crypto";

import type {
  IdentityLinkRecoveryCommand,
  IdentityLinkRecoveryResult,
} from "../modules/identity-linking/identity-link-recovery.js";

export interface ParsedRecoveryArguments {
  readonly command: IdentityLinkRecoveryCommand;
  readonly mode: "dry-run" | "execute";
}

const INPUT_KEYS = new Set([
  "CONFIRMED_SOURCE_ACCOUNT_REF",
  "CONFIRMED_TARGET_ACCOUNT_REF",
  "OPERATOR_REF",
  "REASON_REF",
  "RECOVERY_REF",
  "SOURCE_ACCOUNT_REF",
  "TARGET_ACCOUNT_REF",
  "TARGET_LINK_TRANSACTION_REF",
  "TELEGRAM_IDENTITY_REF",
]);

export function parseRecoveryArguments(
  argumentsList: readonly string[],
  inputDocument: string,
): ParsedRecoveryArguments {
  const normalizedArguments =
    argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  let dryRun = false;
  let execute = false;

  for (const argument of normalizedArguments) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (!argument) {
      throw new Error(`Unknown owner recovery argument: ${argument ?? ""}`);
    }
    throw new Error(`Unknown owner recovery argument: ${argument}`);
  }

  if (dryRun === execute) {
    throw new Error("Pass exactly one of --dry-run or --execute");
  }
  const values = parseInputDocument(inputDocument);
  const sourceAccountRef = required(values, "SOURCE_ACCOUNT_REF");
  const targetAccountRef = required(values, "TARGET_ACCOUNT_REF");
  const confirmedSourceAccountRef = execute
    ? required(values, "CONFIRMED_SOURCE_ACCOUNT_REF")
    : sourceAccountRef;
  const confirmedTargetAccountRef = execute
    ? required(values, "CONFIRMED_TARGET_ACCOUNT_REF")
    : targetAccountRef;
  if (
    confirmedSourceAccountRef !== sourceAccountRef ||
    confirmedTargetAccountRef !== targetAccountRef
  ) {
    throw new Error(
      "Source and target confirmation values must exactly match their Account references",
    );
  }

  return {
    command: {
      confirmedSourceAccountRef,
      confirmedTargetAccountRef,
      operatorRef: required(values, "OPERATOR_REF"),
      reasonRef: required(values, "REASON_REF"),
      recoveryRef: required(values, "RECOVERY_REF"),
      sourceAccountRef,
      targetAccountRef,
      targetLinkTransactionRef: required(values, "TARGET_LINK_TRANSACTION_REF"),
      telegramIdentityRef: required(values, "TELEGRAM_IDENTITY_REF"),
    },
    mode: dryRun ? "dry-run" : "execute",
  };
}

function parseInputDocument(inputDocument: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of inputDocument.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf("=");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    if (!INPUT_KEYS.has(key)) {
      throw new Error(`Unknown owner recovery input: ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Duplicate owner recovery input: ${key}`);
    }
    if (!value) {
      throw new Error(`${key} is required`);
    }
    values.set(key, value);
  }
  return values;
}

export function redactRecoveryResult(result: IdentityLinkRecoveryResult):
  | { readonly ok: false; readonly reason: string }
  | {
      readonly fingerprints: Record<string, string>;
      readonly ok: true;
      readonly outcome: "idempotent" | "ready" | "transferred";
    } {
  if (!result.ok) {
    return result;
  }
  return {
    fingerprints: {
      bot: fingerprint(result.transfer.botIdentity),
      identity: fingerprint(result.transfer.telegramIdentityRef),
      sourceAccount: fingerprint(result.transfer.sourceAccountRef),
      sourceTransaction: fingerprint(result.transfer.sourceLinkTransactionRef),
      targetAccount: fingerprint(result.transfer.targetAccountRef),
      targetTransaction: fingerprint(result.transfer.targetLinkTransactionRef),
      telegramUser: fingerprint(result.transfer.telegramUserId),
    },
    ok: true,
    outcome: result.outcome,
  };
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

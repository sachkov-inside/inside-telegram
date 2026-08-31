import { createHash } from "node:crypto";

import type {
  IdentityLinkRecoveryCommand,
  IdentityLinkRecoveryResult,
} from "../modules/identity-linking/identity-link-recovery.js";

export interface ParsedRecoveryArguments {
  readonly command: IdentityLinkRecoveryCommand;
  readonly mode: "dry-run" | "execute";
}

const VALUE_FLAGS = new Set([
  "--confirm-source-account-ref",
  "--confirm-target-account-ref",
  "--operator-ref",
  "--reason-ref",
  "--recovery-ref",
  "--source-account-ref",
  "--target-account-ref",
  "--target-link-transaction-ref",
  "--telegram-identity-ref",
]);

export function parseRecoveryArguments(
  argumentsList: readonly string[],
): ParsedRecoveryArguments {
  const values = new Map<string, string>();
  let dryRun = false;
  let execute = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (!argument || !VALUE_FLAGS.has(argument)) {
      throw new Error(`Unknown owner recovery argument: ${argument ?? ""}`);
    }
    if (values.has(argument)) {
      throw new Error(`Duplicate owner recovery argument: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }

  if (dryRun === execute) {
    throw new Error("Pass exactly one of --dry-run or --execute");
  }
  const sourceAccountRef = required(values, "--source-account-ref");
  const targetAccountRef = required(values, "--target-account-ref");
  const confirmedSourceAccountRef = execute
    ? required(values, "--confirm-source-account-ref")
    : sourceAccountRef;
  const confirmedTargetAccountRef = execute
    ? required(values, "--confirm-target-account-ref")
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
      operatorRef: required(values, "--operator-ref"),
      reasonRef: required(values, "--reason-ref"),
      recoveryRef: required(values, "--recovery-ref"),
      sourceAccountRef,
      targetAccountRef,
      targetLinkTransactionRef: required(
        values,
        "--target-link-transaction-ref",
      ),
      telegramIdentityRef: required(values, "--telegram-identity-ref"),
    },
    mode: dryRun ? "dry-run" : "execute",
  };
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

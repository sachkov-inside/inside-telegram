import { describe, expect, it } from "vitest";

import {
  parseRecoveryArguments,
  redactRecoveryResult,
} from "../../src/operations/identity-link-recovery-cli.js";

const argumentsList = [
  "--recovery-ref",
  "recovery-proof-0001",
  "--operator-ref",
  "owner-kirill",
  "--reason-ref",
  "inside-telegram-9-proof",
  "--telegram-identity-ref",
  "telegram-ref-sensitive",
  "--source-account-ref",
  "principal-source-sensitive",
  "--target-account-ref",
  "principal-target-sensitive",
  "--target-link-transaction-ref",
  "transaction-target-sensitive",
];

describe("identity-link recovery CLI", () => {
  it("requires an explicit non-destructive or destructive mode", () => {
    expect(() => parseRecoveryArguments(argumentsList)).toThrow(
      /exactly one of --dry-run or --execute/u,
    );
    expect(() =>
      parseRecoveryArguments([...argumentsList, "--dry-run", "--execute"]),
    ).toThrow(/exactly one/u);
  });

  it("allows dry-run without destructive confirmations", () => {
    expect(
      parseRecoveryArguments([...argumentsList, "--dry-run"]),
    ).toMatchObject({
      command: {
        confirmedSourceAccountRef: "principal-source-sensitive",
        confirmedTargetAccountRef: "principal-target-sensitive",
      },
      mode: "dry-run",
    });
  });

  it("requires exact source and target confirmation for execute", () => {
    expect(() =>
      parseRecoveryArguments([...argumentsList, "--execute"]),
    ).toThrow(/--confirm-source-account-ref/u);
    expect(() =>
      parseRecoveryArguments([
        ...argumentsList,
        "--execute",
        "--confirm-source-account-ref",
        "principal-source-sensitive",
        "--confirm-target-account-ref",
        "principal-other",
      ]),
    ).toThrow(/must exactly match/u);

    expect(
      parseRecoveryArguments([
        ...argumentsList,
        "--execute",
        "--confirm-source-account-ref",
        "principal-source-sensitive",
        "--confirm-target-account-ref",
        "principal-target-sensitive",
      ]),
    ).toMatchObject({ mode: "execute" });
  });

  it("redacts provider and Account references from terminal output", () => {
    const output = JSON.stringify(
      redactRecoveryResult({
        ok: true,
        outcome: "transferred",
        transfer: {
          botIdentity: "inside-sensitive",
          sourceAccountRef: "principal-source-sensitive",
          sourceLinkTransactionRef: "transaction-source-sensitive",
          targetAccountRef: "principal-target-sensitive",
          targetLinkTransactionRef: "transaction-target-sensitive",
          telegramIdentityRef: "telegram-ref-sensitive",
          telegramUserId: "424242",
        },
      }),
    );

    expect(output).toContain("transferred");
    expect(output).not.toMatch(/sensitive|424242/u);
  });
});

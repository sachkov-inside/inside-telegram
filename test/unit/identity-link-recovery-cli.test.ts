import { describe, expect, it } from "vitest";

import {
  parseRecoveryArguments,
  redactRecoveryResult,
} from "../../src/operations/identity-link-recovery-cli.js";

const inputDocument = `RECOVERY_REF=recovery-proof-0001
OPERATOR_REF=owner-kirill
REASON_REF=inside-telegram-9-proof
TELEGRAM_IDENTITY_REF=telegram-ref-sensitive
SOURCE_ACCOUNT_REF=principal-source-sensitive
TARGET_ACCOUNT_REF=principal-target-sensitive
TARGET_LINK_TRANSACTION_REF=transaction-target-sensitive
`;

describe("identity-link recovery CLI", () => {
  it("requires an explicit non-destructive or destructive mode", () => {
    expect(() => parseRecoveryArguments([], inputDocument)).toThrow(
      /exactly one of --dry-run or --execute/u,
    );
    expect(() =>
      parseRecoveryArguments(["--dry-run", "--execute"], inputDocument),
    ).toThrow(/exactly one/u);
  });

  it("allows dry-run without destructive confirmations", () => {
    expect(parseRecoveryArguments(["--dry-run"], inputDocument)).toMatchObject({
      command: {
        confirmedSourceAccountRef: "principal-source-sensitive",
        confirmedTargetAccountRef: "principal-target-sensitive",
      },
      mode: "dry-run",
    });
  });

  it("accepts one package-manager argument separator", () => {
    expect(
      parseRecoveryArguments(["--", "--dry-run"], inputDocument),
    ).toMatchObject({ mode: "dry-run" });
  });

  it("requires exact source and target confirmation for execute", () => {
    expect(() => parseRecoveryArguments(["--execute"], inputDocument)).toThrow(
      /CONFIRMED_SOURCE_ACCOUNT_REF/u,
    );
    expect(() =>
      parseRecoveryArguments(
        ["--execute"],
        `${inputDocument}CONFIRMED_SOURCE_ACCOUNT_REF=principal-source-sensitive\nCONFIRMED_TARGET_ACCOUNT_REF=principal-other\n`,
      ),
    ).toThrow(/must exactly match/u);

    expect(
      parseRecoveryArguments(
        ["--execute"],
        `${inputDocument}CONFIRMED_SOURCE_ACCOUNT_REF=principal-source-sensitive\nCONFIRMED_TARGET_ACCOUNT_REF=principal-target-sensitive\n`,
      ),
    ).toMatchObject({ mode: "execute" });
  });

  it("rejects recovery values passed through argv", () => {
    expect(() =>
      parseRecoveryArguments(
        ["--dry-run", "--source-account-ref", "principal-source-sensitive"],
        inputDocument,
      ),
    ).toThrow(/Unknown owner recovery argument/u);
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

import type {
  AuthenticatedConfirmation,
  BeginLink,
  LinkChallenge,
  LinkOutcome,
  PendingLinkOutcome,
  TokenReceipt,
} from "./identity-linking.js";
import { isOpaqueRef } from "./identity-linking-validation.js";

export const IDENTITY_LINKING_CONTRACT_VERSION =
  "inside.identity-linking.v1" as const;

export function readBeginLinkEnvelope(body: unknown): BeginLink | undefined {
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, [
      "accountRef",
      "contractVersion",
      "expiresAt",
      "returnCorrelation",
      "tokenDigest",
    ]) ||
    body.contractVersion !== IDENTITY_LINKING_CONTRACT_VERSION ||
    typeof body.accountRef !== "string" ||
    !isOpaqueRef(body.accountRef) ||
    typeof body.expiresAt !== "string" ||
    !isIsoDateTime(body.expiresAt) ||
    typeof body.returnCorrelation !== "string" ||
    !isOpaqueRef(body.returnCorrelation) ||
    typeof body.tokenDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.tokenDigest)
  ) {
    return undefined;
  }

  const expiresAt = new Date(body.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) {
    return undefined;
  }
  return {
    accountRef: body.accountRef,
    expiresAt,
    returnCorrelation: body.returnCorrelation,
    tokenDigest: body.tokenDigest,
  };
}

export function readConfirmationEnvelope(
  linkTransactionRef: string,
  body: unknown,
): AuthenticatedConfirmation | undefined {
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, [
      "accountRef",
      "contractVersion",
      "returnCorrelation",
    ]) ||
    body.contractVersion !== IDENTITY_LINKING_CONTRACT_VERSION ||
    typeof body.accountRef !== "string" ||
    !isOpaqueRef(body.accountRef) ||
    typeof body.returnCorrelation !== "string" ||
    !isOpaqueRef(body.returnCorrelation) ||
    !isOpaqueRef(linkTransactionRef)
  ) {
    return undefined;
  }
  return {
    accountRef: body.accountRef,
    linkTransactionRef,
    returnCorrelation: body.returnCorrelation,
  };
}

export function readTokenReceiptEnvelope(
  body: unknown,
): TokenReceipt | undefined {
  if (
    !isRecord(body) ||
    body.contractVersion !== IDENTITY_LINKING_CONTRACT_VERSION ||
    body.operation !== "accept-start" ||
    typeof body.botIdentity !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(body.botIdentity) ||
    typeof body.observedAt !== "string" ||
    !isIsoDateTime(body.observedAt) ||
    typeof body.telegramUserId !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(body.telegramUserId)
  ) {
    return undefined;
  }

  const common = {
    botIdentity: body.botIdentity,
    observedAt: new Date(body.observedAt),
    telegramUserId: body.telegramUserId,
  };
  if (
    hasOnlyKeys(body, [
      "botIdentity",
      "contractVersion",
      "observedAt",
      "operation",
      "telegramUserId",
      "tokenDigest",
    ]) &&
    typeof body.tokenDigest === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(body.tokenDigest)
  ) {
    return {
      ...common,
      linkToken: { digest: body.tokenDigest, kind: "digest" },
    };
  }
  if (
    hasOnlyKeys(body, [
      "botIdentity",
      "contractVersion",
      "observedAt",
      "operation",
      "telegramUserId",
      "tokenStatus",
    ]) &&
    body.tokenStatus === "malformed"
  ) {
    return { ...common, linkToken: { kind: "malformed" } };
  }
  return undefined;
}

export function writeLinkChallenge(challenge: LinkChallenge) {
  return {
    contractVersion: IDENTITY_LINKING_CONTRACT_VERSION,
    expiresAt: challenge.expiresAt.toISOString(),
    linkTransactionRef: challenge.linkTransactionRef,
    returnCorrelation: challenge.returnCorrelation,
    status: challenge.status,
  };
}

export function writeLinkOutcome(outcome: LinkOutcome) {
  return {
    contractVersion: IDENTITY_LINKING_CONTRACT_VERSION,
    ...outcome,
  };
}

export function writePendingLinkOutcome(outcome: PendingLinkOutcome) {
  return {
    contractVersion: IDENTITY_LINKING_CONTRACT_VERSION,
    operation: "accept-start" as const,
    status: outcome.status,
  };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(new Date(value).getTime())
  );
}

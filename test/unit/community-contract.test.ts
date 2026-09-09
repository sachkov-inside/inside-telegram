import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCommunityResult,
  communityErrorStatus,
  parseCommunityRequest,
  type CommunitySetCommand,
} from "../../src/modules/community/community-contract.js";
import { digest } from "../../src/security/payload-digest.js";
import fixtures from "../../docs/contracts/billing-v1/fixtures.json" with { type: "json" };

const grant = fixtures.find((f) => f.name === "finite-community-grant")!
  .value as CommunitySetCommand;

it("runtime schema is byte-identical to the approved corpus", () => {
  expect(readFileSync("src/modules/community/contracts/schema.json")).toEqual(
    readFileSync("docs/contracts/billing-v1/schema.json"),
  );
});

describe("community request boundary", () => {
  it("accepts the approved grant and fingerprints its exact payload", () => {
    const parsed = parseCommunityRequest(structuredClone(grant));
    expect(parsed.kind).toBe("set");
    expect(parsed.kind === "set" && parsed.payloadDigest).toBe(digest(grant));
  });

  it("normalizes UUID spelling before the fingerprint", () => {
    const upper = {
      ...structuredClone(grant),
      operationId: grant.operationId.toUpperCase(),
      correlationRef: grant.correlationRef.toUpperCase(),
      binding: {
        ...grant.binding,
        linkRef: grant.binding.linkRef.toUpperCase(),
      },
    };
    const parsed = parseCommunityRequest(upper);
    expect(parsed.kind === "set" && parsed.payloadDigest).toBe(digest(grant));
    expect(parsed.kind === "set" && parsed.command.operationId).toBe(
      grant.operationId,
    );
  });

  it("reads a status query", () => {
    const parsed = parseCommunityRequest({
      contractVersion: "inside.community-entitlement.v1",
      operation: "entitlement.status",
      operationId: grant.operationId,
    });
    expect(parsed).toEqual({ kind: "status", operationId: grant.operationId });
  });

  it.each([
    ["denied", { ...grant, access: { kind: "denied" } }],
    ["lifetime", { ...grant, access: { kind: "lifetime" } }],
  ])("accepts the %s access shape", (_name, body) => {
    expect(parseCommunityRequest(body).kind).toBe("set");
  });

  it.each([
    ["missing finite deadline", { ...grant, access: { kind: "finite" } }],
    [
      "lifetime with deadline",
      {
        ...grant,
        access: { kind: "lifetime", validUntil: "2026-10-08T09:00:00Z" },
      },
    ],
    ["revision zero", { ...grant, entitlementRevision: 0 }],
    ["non-integer revision", { ...grant, entitlementRevision: 1.5 }],
    ["invalid date", { ...grant, issuedAt: "not-a-date" }],
    ["raw recipient", { ...grant, chatId: -100 }],
    [
      "username binding",
      {
        ...grant,
        binding: { ...grant.binding, username: "someone" },
      },
    ],
  ])("rejects %s as malformed", (_name, body) => {
    const parsed = parseCommunityRequest(body);
    expect(parsed).toMatchObject({ kind: "rejected", error: "malformed" });
    expect(parsed.kind === "rejected" && parsed.operationId).toBe(
      grant.operationId,
    );
  });

  it("rejects an unknown contract version without inventing a result", () => {
    const parsed = parseCommunityRequest({
      ...grant,
      contractVersion: "inside.community-entitlement.v2",
    });
    expect(parsed).toMatchObject({
      kind: "rejected",
      error: "unsupported_contract",
    });
    expect(communityErrorStatus.unsupported_contract).toBe(422);
  });

  it("does not correlate a body without a parseable operation id", () => {
    const parsed = parseCommunityRequest({
      ...grant,
      operationId: "not-a-uuid",
    });
    expect(parsed).toEqual({ kind: "rejected", error: "malformed" });
  });

  it("rejects a body beyond the sixteen kibibyte limit", () => {
    const parsed = parseCommunityRequest({
      ...grant,
      binding: { ...grant.binding, accountRef: "a".repeat(20_000) },
    });
    expect(parsed).toMatchObject({ kind: "rejected", error: "malformed" });
  });

  it("refuses to emit a result that contradicts observed membership", () => {
    expect(() =>
      assertCommunityResult({
        contractVersion: "inside.community-entitlement.v1",
        operation: "entitlement.result",
        operationId: randomUUID(),
        binding: grant.binding,
        entitlementRevision: 1,
        access: { kind: "finite", validUntil: "2026-10-08T09:00:00Z" },
        status: "applied",
        observedMembership: "not_member",
        updatedAt: "2026-09-08T09:00:05Z",
      }),
    ).toThrow();
  });
});

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HttpCommunityAuthorization } from "../../src/adapters/platform/http-community-authorization.adapter.js";
import type { DispatchAuthorizationRequest } from "../../src/modules/community/community-contract.js";

const request: DispatchAuthorizationRequest = {
  contractVersion: "inside.billing-dispatch.v1",
  operation: "dispatch.authorize",
  operationId: randomUUID(),
  dispatchId: randomUUID(),
  dispatchContractVersion: "inside.community-entitlement.v1",
  attemptId: randomUUID(),
  effectRef: randomUUID(),
  effect: "community.approve_join",
  payloadDigest: "a".repeat(64),
};

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const allowed = {
  contractVersion: "inside.billing-dispatch.v1",
  operation: "dispatch.result",
  operationId: request.operationId,
  dispatchId: request.dispatchId,
  attemptId: request.attemptId,
  decision: {
    status: "allowed",
    permitRef: randomUUID(),
    validUntil: "2026-09-08T09:00:05Z",
  },
};

describe("community dispatch authorization", () => {
  it("returns a correlated permit", async () => {
    const adapter = new HttpCommunityAuthorization(
      "https://p/x",
      "s",
      respond(allowed),
    );
    await expect(adapter.authorize(request)).resolves.toEqual(allowed);
  });

  it.each([
    ["a different operation", { ...allowed, operationId: randomUUID() }],
    ["a different attempt", { ...allowed, attemptId: randomUUID() }],
    ["a different dispatch", { ...allowed, dispatchId: randomUUID() }],
    ["an unknown decision", { ...allowed, decision: { status: "maybe" } }],
    [
      "a permit without a deadline",
      {
        ...allowed,
        decision: { status: "allowed", permitRef: randomUUID() },
      },
    ],
  ])("discards %s", async (_name, body) => {
    const adapter = new HttpCommunityAuthorization(
      "https://p/x",
      "s",
      respond(body),
    );
    await expect(adapter.authorize(request)).resolves.toBeUndefined();
  });

  it("discards a body whose status does not match its error", async () => {
    const error = {
      contractVersion: "inside.billing-dispatch.v1",
      operation: "dispatch.error",
      operationId: request.operationId,
      error: "operation_conflict",
    };
    await expect(
      new HttpCommunityAuthorization(
        "https://p/x",
        "s",
        respond(error, 200),
      ).authorize(request),
    ).resolves.toBeUndefined();
    await expect(
      new HttpCommunityAuthorization(
        "https://p/x",
        "s",
        respond(error, 409),
      ).authorize(request),
    ).resolves.toEqual(error);
  });

  it("discards a denial served with an unexpected status", async () => {
    const denied = {
      ...allowed,
      decision: { status: "denied", reason: "superseded" },
    };
    await expect(
      new HttpCommunityAuthorization(
        "https://p/x",
        "s",
        respond(denied, 503),
      ).authorize(request),
    ).resolves.toBeUndefined();
  });

  it("treats a transport failure as no answer", async () => {
    const adapter = new HttpCommunityAuthorization(
      "https://p/x",
      "s",
      (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    );
    await expect(adapter.authorize(request)).resolves.toBeUndefined();
  });

  it("ignores a non-JSON answer", async () => {
    const adapter = new HttpCommunityAuthorization(
      "https://p/x",
      "s",
      (async () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof fetch,
    );
    await expect(adapter.authorize(request)).resolves.toBeUndefined();
  });
});

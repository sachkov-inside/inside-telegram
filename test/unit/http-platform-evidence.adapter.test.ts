import { describe, expect, it } from "vitest";

import { HttpPlatformEvidenceAdapter } from "../../src/adapters/platform/http-platform-evidence.adapter.js";
import type { PlatformEvidenceDeliveryRequest } from "../../src/modules/membership-evidence/platform-evidence-delivery.js";

const request: PlatformEvidenceDeliveryRequest = {
  evidence: {
    checkedAt: "2030-01-01T00:00:00.000Z",
    contractVersion: "inside.membership-evidence.v1",
    decision: "member",
    evidenceRef: "evidence-ref-a",
    evidenceVersion: 1,
    principalRef: "principal-ref-a",
    reasonCode: "chat_member",
    telegramIdentityRef: "telegram-ref-a",
    validUntil: "2030-01-01T00:05:00.000Z",
  },
  idempotencyKey: "delivery-ref-a",
};

describe("HttpPlatformEvidenceAdapter", () => {
  it("authenticates and sends the exact versioned envelope with an idempotency key", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const adapter = new HttpPlatformEvidenceAdapter(
      "https://platform.example.test/integrations/telegram/v1/membership-evidence",
      "synthetic_delivery_secret",
      async (input, init) => {
        calls.push({ input: String(input), init: init ?? {} });
        return new Response(undefined, { status: 202 });
      },
    );

    await expect(adapter.deliver(request)).resolves.toEqual({
      kind: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      body: JSON.stringify(request.evidence),
      headers: {
        authorization: "Bearer synthetic_delivery_secret",
        "content-type": "application/json",
        "idempotency-key": request.idempotencyKey,
      },
      method: "POST",
    });
  });

  it.each([
    [401, "rejected"],
    [422, "rejected"],
    [429, "retryable"],
    [503, "retryable"],
  ] as const)("maps HTTP %s to %s", async (status, kind) => {
    const adapter = new HttpPlatformEvidenceAdapter(
      "https://platform.example.test/evidence",
      "synthetic_delivery_secret",
      async () => new Response(undefined, { status }),
    );

    await expect(adapter.deliver(request)).resolves.toMatchObject({ kind });
  });
});

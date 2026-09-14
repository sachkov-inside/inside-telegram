import { describe, expect, it } from "vitest";
import { HttpActivationPlatform } from "../../src/adapters/platform/http-activation-platform.adapter.js";
import {
  ACTIVATION_VERSION,
  type ActivationEvidence,
} from "../../src/modules/subscription-activation/activation-contract.js";
import fixtures from "../../docs/contracts/subscription-activation-v1/fixtures.json" with { type: "json" };

describe("activation HTTP consumer", () => {
  for (const fixture of fixtures.filter(
    (f) => f.definition === "bindingResponse",
  )) {
    it(`decodes provider binding corpus: ${fixture.name}`, async () => {
      const adapter = new HttpActivationPlatform(
        "https://platform.example/activation",
        "synthetic-activation-secret",
        async (url, init) => {
          expect(url).toBe("https://platform.example/activation/binding");
          expect(init).toMatchObject({
            method: "POST",
            redirect: "error",
            headers: {
              authorization: "Bearer synthetic-activation-secret",
              "content-type": "application/json",
            },
          });
          expect(JSON.parse(String(init?.body))).toEqual({
            contractVersion: ACTIVATION_VERSION,
            identityRef: "synthetic-identity",
          });
          return Response.json(fixture.value);
        },
      );
      expect(await adapter.binding("synthetic-identity")).toEqual(
        fixture.valid ? fixture.value : undefined,
      );
    });
  }
  it.each([302, 401, 403, 429, 503])(
    "does not turn HTTP %s into unlinked",
    async (status) => {
      const adapter = new HttpActivationPlatform(
        "https://platform.example/activation",
        "synthetic-secret",
        async () =>
          Response.json(
            {
              ok: true,
              value: { contractVersion: ACTIVATION_VERSION, state: "unlinked" },
            },
            { status },
          ),
      );
      expect(await adapter.binding("synthetic-identity")).toBeUndefined();
    },
  );
  it("keeps a transport failure uncertain and rejects oversized responses", async () => {
    const failed = new HttpActivationPlatform(
      "https://platform.example/activation",
      "synthetic-secret",
      async () => {
        throw new Error("synthetic timeout");
      },
    );
    expect(await failed.binding("synthetic-identity")).toBeUndefined();
    const oversized = new HttpActivationPlatform(
      "https://platform.example/activation",
      "synthetic-secret",
      async () =>
        new Response(" ".repeat(1_048_577), {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await oversized.binding("synthetic-identity")).toBeUndefined();
  });
  it.each(["member", "registry_lookup"] as const)(
    "keeps stable evidence wire bytes for %s across JSON key reordering",
    async (decision) => {
      const fixture = fixtures.find(
        (f) => f.name === "tribute-exact-binding-registry-request",
      );
      const input = { ...fixture?.value, decision } as ActivationEvidence;
      const bodies: string[] = [];
      const consumer = new HttpActivationPlatform(
        "https://platform.example/activation",
        "synthetic-secret",
        async (_url, init) => {
          bodies.push(String(init?.body));
          return Response.json({ ok: false, error: { code: "unavailable" } });
        },
      );
      await consumer.evidence(input);
      await consumer.evidence(
        Object.fromEntries(
          Object.entries(input).reverse(),
        ) as unknown as ActivationEvidence,
      );
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[0]!)).toEqual(input);
    },
  );
});

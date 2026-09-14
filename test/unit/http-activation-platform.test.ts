import { describe, expect, it } from "vitest";
import { HttpActivationPlatform } from "../../src/adapters/platform/http-activation-platform.adapter.js";
import { ACTIVATION_VERSION } from "../../src/modules/subscription-activation/activation-contract.js";
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
});

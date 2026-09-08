import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import communitySchema from "../../docs/contracts/billing-v1/schema.json" with { type: "json" };
import communityFixtures from "../../docs/contracts/billing-v1/fixtures.json" with { type: "json" };
import communityScenarios from "../../docs/contracts/billing-v1/scenarios.json" with { type: "json" };
import communityManifest from "../../docs/contracts/billing-v1/manifest.json" with { type: "json" };
import notificationSchema from "../../docs/contracts/notifications-v1/schema.json" with { type: "json" };
import notificationFixtures from "../../docs/contracts/notifications-v1/fixtures.json" with { type: "json" };
import notificationScenarios from "../../docs/contracts/notifications-v1/scenarios.json" with { type: "json" };
import notificationManifest from "../../docs/contracts/notifications-v1/manifest.json" with { type: "json" };

const bundles = [
  {
    name: "community",
    directory: "billing-v1",
    schema: communitySchema,
    fixtures: communityFixtures,
    scenarios: communityScenarios,
    manifest: communityManifest,
  },
  {
    name: "notifications",
    directory: "notifications-v1",
    schema: notificationSchema,
    fixtures: notificationFixtures,
    scenarios: notificationScenarios,
    manifest: notificationManifest,
  },
];
for (const bundle of bundles) {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats.default(ajv);
  ajv.addSchema(bundle.schema);
  describe(`${bundle.name} artifacts (shape/integrity, not runtime proof)`, () => {
    for (const fixture of bundle.fixtures) {
      test(fixture.name, () => {
        const validate = ajv.compile({
          $ref: `${bundle.schema.$id}#/definitions/${fixture.definition}`,
        });
        expect(validate(fixture.value), JSON.stringify(validate.errors)).toBe(
          fixture.valid,
        );
        expect(ajv.validate(bundle.schema.$id, fixture.value)).toBe(
          fixture.valid,
        );
      });
    }
    test("reviewed bundle digests match local bytes", () => {
      for (const [path, artifact] of Object.entries(
        bundle.manifest.artifacts,
      )) {
        const bytes = readFileSync(
          new URL(
            `../../docs/contracts/${bundle.directory}/${path}`,
            import.meta.url,
          ),
        );
        expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(
          artifact.sha256,
        );
      }
    });
    test("scenario fixture references resolve without simulating a provider", () => {
      const names = new Set(bundle.fixtures.map((fixture) => fixture.name));
      expect(names.size).toBe(bundle.fixtures.length);
      expect(
        new Set(bundle.scenarios.scenarios.map((scenario) => scenario.name))
          .size,
      ).toBe(bundle.scenarios.scenarios.length);
      for (const scenario of bundle.scenarios.scenarios) {
        expect(
          scenario.implementationTickets.length,
          scenario.name,
        ).toBeGreaterThan(0);
        for (const step of scenario.steps) {
          if ("fixture" in step && typeof step.fixture === "string")
            expect(names.has(step.fixture), scenario.name).toBe(true);
        }
      }
    });
  });
}

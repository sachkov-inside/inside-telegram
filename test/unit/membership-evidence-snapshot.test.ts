import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import fixtures from "../../src/contracts/inside-membership-evidence-v1/fixtures.json" with { type: "json" };
import schema from "../../src/contracts/inside-membership-evidence-v1/schema.json" with { type: "json" };
import snapshot from "../../src/contracts/inside-membership-evidence-v1/snapshot.json" with { type: "json" };

const contractRoot = new URL(
  "../../src/contracts/inside-membership-evidence-v1/",
  import.meta.url,
);

describe("Workspace Membership Evidence snapshot", () => {
  it.each(Object.entries(snapshot.artifacts))(
    "keeps %s at the reviewed Workspace digest",
    async (fileName, artifact) => {
      const content = await readFile(new URL(fileName, contractRoot));
      expect(createHash("sha256").update(content).digest("hex")).toBe(
        artifact.sha256,
      );
    },
  );

  const ajv = new Ajv2020.default({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);

  it.each(fixtures.fixtures)(
    "keeps $name byte-safe and schema-compatible",
    (fixture) => {
      const roundTrip = JSON.parse(JSON.stringify(fixture.evidence)) as unknown;
      expect(roundTrip).toEqual(fixture.evidence);
      expect(validate(roundTrip)).toBe(
        fixture.name !== "unsupported-major" &&
          fixture.name !== "malformed-envelope",
      );
    },
  );

  it.each(
    fixtures.fixtures.filter(
      (fixture) =>
        fixture.evidence.decision === "member" ||
        fixture.evidence.decision === "not_member" ||
        fixture.evidence.decision === "unavailable",
    ),
  )("keeps $name within provider production invariants", (fixture) => {
    const schemaValid = validate(fixture.evidence);
    const evidence = fixture.evidence as Record<string, unknown>;
    const validityMilliseconds =
      typeof evidence.checkedAt === "string" &&
      typeof evidence.validUntil === "string"
        ? new Date(evidence.validUntil).getTime() -
          new Date(evidence.checkedAt).getTime()
        : undefined;
    const producerValid =
      schemaValid &&
      (evidence.decision === "unavailable" ||
        (validityMilliseconds !== undefined &&
          validityMilliseconds > 0 &&
          validityMilliseconds <= 5 * 60_000));
    expect(producerValid).toBe(
      fixture.name !== "positive-over-five-minutes" &&
        fixture.name !== "unsupported-major" &&
        fixture.name !== "malformed-envelope",
    );
  });
});

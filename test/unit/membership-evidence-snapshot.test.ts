import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
});

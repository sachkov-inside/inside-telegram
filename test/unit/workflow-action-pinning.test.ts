import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import harness from "../../.inside-harness/product-harness.json" with { type: "json" };

/** A third-party action runs with the job token, so only an immutable commit may be referenced. */
function unpinnedActions(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)]
    .map((match) => match[1]!)
    .filter(
      (reference) =>
        !reference.startsWith("./") && !/@[0-9a-f]{40}$/.test(reference),
    );
}

// Managed harness workflows are pinned in the canonical Workspace package.
const managed = new Set(harness.managedFiles);
const workflows = readdirSync(".github/workflows")
  .map((name) => `.github/workflows/${name}`)
  .filter((path) => /\.ya?ml$/.test(path) && !managed.has(path));

describe("workflow action pinning", () => {
  it.each(workflows)("%s references every action by commit SHA", (path) => {
    expect(unpinnedActions(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("flags tag, branch and short-SHA references", () => {
    expect(
      unpinnedActions(
        [
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
          "        uses: actions/upload-artifact@v4",
          "      - uses: docker/login-action@main",
          "      - uses: actions/setup-node@8207627",
          "    uses: ./.github/workflows/application-ci.yml",
        ].join("\n"),
      ),
    ).toEqual([
      "actions/upload-artifact@v4",
      "docker/login-action@main",
      "actions/setup-node@8207627",
    ]);
  });
});

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const compose = readFileSync("infra/production/compose.yaml", "utf8");

/** Returns one top-level service block of the production Compose file. */
function service(name: string): string {
  const match = compose.match(
    new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m"),
  );
  if (!match?.[1]) throw new Error(`Compose service ${name} is missing`);
  return match[1];
}

describe("production operations in the runtime image", () => {
  it("runs every compiled entrypoint from a source file that the image builds", () => {
    const entrypoints = [...compose.matchAll(/dist\/([\w/-]+)\.js/g)].map(
      (match) => match[1],
    );
    expect(entrypoints.length).toBeGreaterThan(0);
    for (const entrypoint of entrypoints) {
      expect(existsSync(`src/${entrypoint}.ts`), entrypoint).toBe(true);
    }
  });

  it.each([
    ["community-restriction", "dist/operations/community-restriction-cli.js"],
    ["webhook-registration", "dist/operations/webhook-registration-cli.js"],
  ])(
    "offers %s as an operations-only command without pnpm",
    (name, entrypoint) => {
      const block = service(name);
      expect(block).toContain("profiles: [operations]");
      expect(block).toContain(`entrypoint: [node, ${entrypoint}]`);
      expect(block).toContain('restart: "no"');
      expect(block).not.toMatch(/pnpm|ports:/);
    },
  );
});

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("architecture guardrail", () => {
  it("accepts the application source", () => {
    const result = runGuardrail();

    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    [
      "adapter-imports-persistence",
      "adapters/telegram/transport-with-domain-decision.ts: transport adapter imports ../../database/create-database.js",
    ],
    [
      "module-imports-adapter",
      "modules/sign-in/sign-in.ts: module imports adapters/telegram/translate.ts",
    ],
    [
      "module-imports-transport",
      "modules/contacts/contacts.ts: module imports transport package grammy",
    ],
    ["module-calls-fetch", "modules/contacts/contacts.ts: module calls fetch"],
    [
      "shared-imports-module",
      "shared/clock.ts: shared kernel imports modules/contacts/contacts.ts",
    ],
    ["module-cycle", "module cycle: contacts -> marketing -> contacts"],
    [
      "foreign-table-access",
      "modules/marketing/marketing.ts: platform_links is owned by modules/identity-linking",
    ],
  ])("rejects %s", (fixture, violation) => {
    const result = runGuardrail(`test/architecture/fixtures/${fixture}/src`);

    expect(result.stdout.split("\n")).toContain(violation);
    expect(result.status).toBe(1);
  });
});

function runGuardrail(root?: string) {
  return spawnSync(
    process.execPath,
    ["scripts/check-architecture.mjs", ...(root ? [root] : [])],
    { encoding: "utf8" },
  );
}

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("Telegram transport adapter boundary", () => {
  it("accepts adapters that depend only on application interfaces", () => {
    const result = runGuardrail("src/adapters/telegram");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects a transport adapter that takes persistence decisions", () => {
    const result = runGuardrail(
      "test/architecture/fixtures/transport-with-domain-decision.ts.fixture",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("transport adapter imports");
  });
});

function runGuardrail(candidate: string) {
  return spawnSync(
    process.execPath,
    ["scripts/check-architecture.mjs", candidate],
    { encoding: "utf8" },
  );
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironmentFile } from "../../src/config/environment-file.js";

const KEYS = [
  "ENV_FILE",
  "ENV_FILE_OVERRIDE",
  "SYNTHETIC_INHERITED",
  "SYNTHETIC_FILE_ONLY",
] as const;

describe("environment file", () => {
  let directory: string;
  let saved: Map<string, string | undefined>;

  beforeEach(() => {
    saved = new Map(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) Reflect.deleteProperty(process.env, key);
    directory = mkdtempSync(join(tmpdir(), "inside-telegram-env-"));
    process.env.ENV_FILE = join(directory, "proof.env");
    writeFileSync(
      process.env.ENV_FILE,
      "SYNTHETIC_INHERITED=from-file\nSYNTHETIC_FILE_ONLY=from-file\n",
    );
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of saved)
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
  });

  it("adds missing values and keeps inherited ones", () => {
    process.env.SYNTHETIC_INHERITED = "inherited";

    loadEnvironmentFile();

    expect(process.env.SYNTHETIC_INHERITED).toBe("inherited");
    expect(process.env.SYNTHETIC_FILE_ONLY).toBe("from-file");
  });

  it("lets the file win when the override is requested", () => {
    process.env.SYNTHETIC_INHERITED = "inherited";
    process.env.ENV_FILE_OVERRIDE = "true";

    loadEnvironmentFile();

    expect(process.env.SYNTHETIC_INHERITED).toBe("from-file");
  });

  it("leaves the environment unchanged without the file", () => {
    process.env.ENV_FILE = join(directory, "missing.env");

    loadEnvironmentFile();

    expect(process.env.SYNTHETIC_FILE_ONLY).toBeUndefined();
  });
});

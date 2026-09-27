import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { jsonRecord, record } from "../support/json.js";

// The shared base mirrors Platform's tsconfig.base.json; a project config may add its runtime
// options but never weakens this strictness.
const SHARED_STRICTNESS = [
  "strict",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUncheckedSideEffectImports",
  "noUnusedLocals",
  "noUnusedParameters",
  "allowUnreachableCode",
  "allowUnusedLabels",
  "verbatimModuleSyntax",
  "isolatedModules",
] as const;

// Rules that keep promise handling and non-null claims honest in production code.
const PRODUCTION_RULES = [
  "typescript/no-floating-promises",
  "typescript/no-misused-promises",
  "typescript/await-thenable",
  "typescript/no-non-null-assertion",
] as const;

interface Override {
  readonly files: readonly string[];
  readonly rules: Readonly<Record<string, unknown>>;
}

function json(path: string): Record<string, unknown> {
  return jsonRecord(readFileSync(path, "utf8"));
}

function compilerOptions(config: Record<string, unknown>) {
  return config.compilerOptions === undefined
    ? {}
    : record(config.compilerOptions);
}

/** Why a project tsconfig breaks the shared base contract. */
function baseViolations(
  config: Record<string, unknown>,
  extendsPath: string,
): string[] {
  const own = compilerOptions(config);
  return [
    ...(config.extends === extendsPath ? [] : [`must extend ${extendsPath}`]),
    ...SHARED_STRICTNESS.filter((flag) => flag in own).map(
      (flag) => `must not override ${flag}`,
    ),
  ];
}

/** Rule levels the overrides give `file`, later overrides winning. */
function appliedRules(
  overrides: readonly Override[],
  file: string,
): Map<string, unknown> {
  const applied = new Map<string, unknown>();
  for (const override of overrides)
    if (override.files.some((pattern) => matches(pattern, file)))
      for (const [rule, level] of Object.entries(override.rules))
        applied.set(rule, level);
  return applied;
}

/** Rules from PRODUCTION_RULES that do not apply as errors to `file`. */
function missingProductionRules(
  overrides: readonly Override[],
  file: string,
): string[] {
  const applied = appliedRules(overrides, file);
  return PRODUCTION_RULES.filter((rule) => applied.get(rule) !== "error");
}

/** Ignore patterns that exclude `file` from linting altogether. */
function ignoredBy(config: Record<string, unknown>, file: string): string[] {
  const patterns: unknown = config.ignorePatterns;
  if (!Array.isArray(patterns)) return [];
  const list: readonly unknown[] = patterns;
  return list.filter(
    (pattern): pattern is string =>
      typeof pattern === "string" &&
      gitignoreGlobs(pattern).some((glob) => matches(glob, file)),
  );
}

/**
 * Globs an ignore pattern covers under gitignore rules: a pattern without an inner slash matches
 * at any depth, and a matched directory excludes everything below it.
 */
function gitignoreGlobs(pattern: string): string[] {
  const path = pattern.replace(/\/$/, "");
  const glob = path.includes("/") ? path.replace(/^\//, "") : `**/${path}`;
  return [glob, `${glob}/**`];
}

/** Rules whose level for `file` differs from their level for application code. */
function rulesDifferingFromApplication(
  overrides: readonly Override[],
  file: string,
): string[] {
  const application = appliedRules(overrides, "src/main.ts");
  const applied = appliedRules(overrides, file);
  return [...new Set([...application.keys(), ...applied.keys()])].filter(
    (rule) =>
      JSON.stringify(applied.get(rule)) !==
      JSON.stringify(application.get(rule)),
  );
}

function matches(pattern: string, file: string): boolean {
  const expression = pattern
    .split("**/")
    .map((part) =>
      part
        .replace(/[.+^$()|[\]\\]/g, "\\$&")
        .replace(
          /\{([^}]*)\}/g,
          (_, list: string) => `(?:${list.split(",").join("|")})`,
        )
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^/]*")
        .replace(/\0/g, ".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${expression}$`).test(file);
}

function overridesOf(config: Record<string, unknown>): Override[] {
  const overrides = config.overrides;
  if (!Array.isArray(overrides)) return [];
  const list: readonly unknown[] = overrides;
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const fields = new Map<string, unknown>(Object.entries(entry));
    const files = fields.get("files");
    const rules = fields.get("rules");
    return Array.isArray(files) &&
      files.every((f): f is string => typeof f === "string") &&
      typeof rules === "object" &&
      rules !== null
      ? [{ files, rules: Object.fromEntries(Object.entries(rules)) }]
      : [];
  });
}

describe("toolchain contract", () => {
  it("builds every project config on the shared strict base", () => {
    expect(
      baseViolations(json("tsconfig.json"), "./tsconfig.base.json"),
    ).toEqual([]);
    expect(
      baseViolations(json("tsconfig.build.json"), "./tsconfig.json"),
    ).toEqual([]);
    const base = compilerOptions(json("tsconfig.base.json"));
    for (const flag of SHARED_STRICTNESS)
      expect(base[flag], flag).toBe(
        !["allowUnreachableCode", "allowUnusedLabels"].includes(flag),
      );
  });

  it("rejects a project config that weakens the base", () => {
    expect(
      baseViolations(
        { extends: "./tsconfig.base.json", compilerOptions: { strict: false } },
        "./tsconfig.base.json",
      ),
    ).toEqual(["must not override strict"]);
    expect(
      baseViolations({ compilerOptions: {} }, "./tsconfig.base.json"),
    ).toEqual(["must extend ./tsconfig.base.json"]);
  });

  it("applies the type-aware production rules to application code", () => {
    const overrides = overridesOf(json(".oxlintrc.json"));
    for (const file of [
      "src/main.ts",
      "src/modules/communications/funnels.ts",
      "scripts/platform-conformance-provider.ts",
    ])
      expect(missingProductionRules(overrides, file), file).toEqual([]);
  });

  it("lints tests with the same rules as application code", () => {
    const config = json(".oxlintrc.json");
    const overrides = overridesOf(config);
    for (const file of [
      "test/unit/toolchain-contract.test.ts",
      "test/integration/funnels.integration.test.ts",
      "test/support/community-chat.ts",
      "test/local/course-activation-provider.ts",
    ]) {
      expect(rulesDifferingFromApplication(overrides, file), file).toEqual([]);
      expect(ignoredBy(config, file), file).toEqual([]);
    }
  });

  it("detects a rule turned off for tests", () => {
    const overrides = [
      ...overridesOf(json(".oxlintrc.json")),
      {
        files: ["test/**/*.ts"],
        rules: { "typescript/require-await": "off" },
      },
    ];
    expect(
      rulesDifferingFromApplication(overrides, "test/unit/example.test.ts"),
    ).toEqual(["typescript/require-await"]);
  });

  it("detects tests excluded from linting", () => {
    expect(
      ignoredBy(
        {
          ignorePatterns: [
            "dist/**",
            "test/architecture/fixtures/**",
            "test/**",
            "test",
            "test/",
            "unit",
            "*.test.ts",
            "**/unit/**",
          ],
        },
        "test/unit/example.test.ts",
      ),
    ).toEqual(["test/**", "test", "test/", "unit", "*.test.ts", "**/unit/**"]);
  });

  it("detects a production rule turned off for application code", () => {
    const overrides = [
      ...overridesOf(json(".oxlintrc.json")),
      {
        files: ["src/**/*.ts"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ];
    expect(missingProductionRules(overrides, "src/main.ts")).toEqual([
      "typescript/no-floating-promises",
    ]);
  });

  it("lints with oxlint alone", () => {
    const manifest = json("package.json");
    const scripts = new Map(Object.entries(record(manifest.scripts)));
    const dependencies = Object.keys({
      ...record(manifest.dependencies),
      ...record(manifest.devDependencies),
    });
    expect(scripts.get("lint")).toBe(
      "oxlint --deny-warnings --report-unused-disable-directives .",
    );
    expect(dependencies).toEqual(
      expect.arrayContaining(["oxlint", "oxlint-tsgolint"]),
    );
    expect(dependencies.filter((name) => /eslint|dotenv/.test(name))).toEqual(
      [],
    );
  });
});

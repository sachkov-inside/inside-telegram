import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// Architecture rules of this repository, checked by `pnpm check`. They keep domain decisions
// testable without Telegram or the broker, and each table's invariants in one module.
// Every rule has a negative fixture in test/architecture/fixtures.
// Paths below are relative to the checked source root (`src` by default).

// A transport adapter depends on application interfaces, never on persistence or the framework.
const adapterForbiddenImports = [
  /(?:^|\/)database(?:\/|$)/,
  /(?:^|\/)infrastructure(?:\/|$)/,
  /^@nestjs(?:\/|$)/,
  /^kysely(?:\/|$)/,
  /^pg$/,
];

// Application modules reach Telegram, Platform and the broker only through adapters.
const transportPackages = ["grammy", "amqplib"];
const networkCall = /(?:\bglobalThis\.|(?<![.\w$]))fetch\s*\(/;

// A module never depends on the layers that compose or drive it.
const moduleForbiddenLayers = [
  "adapters",
  "operations",
  "app.module.ts",
  "main.ts",
];

// The shared kernel sits below every module and adapter.
const sharedForbiddenLayers = ["modules", "adapters", "operations", "config"];

// Only the owning module reads or writes these tables; everyone else calls its interface.
// `database/` keeps the schema, migrations and retention for every table.
const tableOwners = {
  platform_links: "modules/identity-linking",
  start_response_deliveries: "modules/outbound",
  start_response_delivery_attempts: "modules/outbound",
};

// The author dialog decides every transition from its arguments alone; author-admin.ts runs
// the effects. Its files import no package and no module that reaches I/O; types are free.
const pureDialogFiles = [
  "author-button",
  "author-composer",
  "author-dialog",
  "author-funnels",
  "author-message-view",
  "author-sequence-composer",
  "author-transition",
  "author-turn",
].map((name) => `modules/communications/${name}.ts`);
const pureDialogImports = [
  ...pureDialogFiles,
  "modules/communications/communications-contract.ts",
  "shared/unhandled.ts",
];

const root = process.argv[2] ?? "src";
const files = await sourceFiles(root);
const violations = [];
const moduleEdges = new Map();

for (const file of files) {
  const source = await readFile(path.join(root, file), "utf8");
  const layer = file.split("/")[0];

  for (const specifier of importSpecifiers(source)) {
    const target = resolveImport(file, specifier);
    const targetLayer = target?.split("/")[0];
    if (layer === "adapters") {
      if (adapterForbiddenImports.some((pattern) => pattern.test(specifier)))
        violations.push(`${file}: transport adapter imports ${specifier}`);
    } else if (layer === "modules") {
      if (transportPackages.includes(specifier))
        violations.push(
          `${file}: module imports transport package ${specifier}`,
        );
      if (targetLayer && moduleForbiddenLayers.includes(targetLayer))
        violations.push(`${file}: module imports ${target}`);
      const from = file.split("/")[1];
      const to = target?.split("/")[1];
      if (targetLayer === "modules" && from && to && from !== to)
        edgesFrom(from).add(to);
    } else if (layer === "shared") {
      if (targetLayer && sharedForbiddenLayers.includes(targetLayer))
        violations.push(`${file}: shared kernel imports ${target}`);
    }
  }

  if (pureDialogFiles.includes(file))
    for (const specifier of valueImportSpecifiers(source)) {
      const target = resolveImport(file, specifier);
      if (!target || !pureDialogImports.includes(target))
        violations.push(
          `${file}: pure author dialog imports ${target ?? specifier}`,
        );
    }

  const code = withoutComments(source);
  if (layer === "modules" && networkCall.test(code))
    violations.push(`${file}: module calls fetch`);

  if (layer !== "database") {
    for (const [table, owner] of Object.entries(tableOwners)) {
      if (
        !file.startsWith(`${owner}/`) &&
        new RegExp(`\\b${table}\\b`).test(code)
      )
        violations.push(`${file}: ${table} is owned by ${owner}`);
    }
  }
}

for (const cycle of moduleCycles(moduleEdges))
  violations.push(`module cycle: ${cycle.join(" -> ")}`);

if (violations.length > 0) {
  process.stdout.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
}

function edgesFrom(module) {
  let targets = moduleEdges.get(module);
  if (!targets) {
    targets = new Set();
    moduleEdges.set(module, targets);
  }
  return targets;
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

/** Modules loaded at runtime; `import type` and all-type import lists are erased. */
function valueImportSpecifiers(source) {
  const statements = source.matchAll(
    /^\s*(import|export)\s+(?!type\b)(?:([^"';]*?)\bfrom\s+)?["']([^"']+)["']/gm,
  );
  const dynamic = source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g);
  return [
    ...[...statements]
      .filter(
        ([, keyword, clause]) =>
          !onlyTypes(clause) && (keyword === "import" || clause !== undefined),
      )
      .map((match) => match[3]),
    ...[...dynamic].map((match) => match[1]),
  ];
}

/** `{ type A, type B }`: an import clause that names only types. */
function onlyTypes(clause) {
  const names = /^\{([^}]*)\}\s*$/.exec(clause?.trim() ?? "")?.[1];
  return (
    names !== undefined &&
    names
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .every((name) => name.startsWith("type "))
  );
}

/** The imported file relative to the root, or undefined for a package import. */
function resolveImport(file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(file), specifier))
    .replace(/\.js$/, ".ts");
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Every elementary cycle once, starting from its alphabetically first module. */
function moduleCycles(graph) {
  const cycles = [];
  for (const start of [...graph.keys()].sort()) {
    const walk = (module, trail) => {
      for (const next of [...(graph.get(module) ?? [])].sort()) {
        if (next === start) cycles.push([...trail, start]);
        else if (next > start && !trail.includes(next))
          walk(next, [...trail, next]);
      }
    };
    walk(start, [start]);
  }
  return cycles;
}

async function sourceFiles(directory, prefix = "") {
  const entries = await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return sourceFiles(directory, child);
      return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
    }),
  );
  return nested.flat();
}

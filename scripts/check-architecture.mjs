import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const forbiddenImports = [
  /(?:^|\/)database(?:\/|$)/,
  /(?:^|\/)infrastructure(?:\/|$)/,
  /^@nestjs(?:\/|$)/,
  /^kysely(?:\/|$)/,
  /^pg$/,
];

const requestedPaths = process.argv.slice(2);
const paths = requestedPaths.length > 0 ? requestedPaths : ["src/adapters"];
const files = (
  await Promise.all(paths.map((candidate) => sourceFiles(candidate)))
).flat();

const violations = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const imported = match[1];
    if (
      imported &&
      forbiddenImports.some((pattern) => pattern.test(imported))
    ) {
      violations.push(`${file}: transport adapter imports ${imported}`);
    }
  }
}

if (violations.length > 0) {
  process.stdout.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
}

async function sourceFiles(candidate) {
  const candidateStat = await stat(candidate);
  if (candidateStat.isFile()) {
    return [candidate];
  }

  const entries = await readdir(candidate, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = path.join(candidate, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(child);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
    }),
  );
  return nested.flat();
}

#!/usr/bin/env node
// Release contract of the Telegram application: ordinal plan, migration identity and manifest.
// The release workflow and tests call it; the host gateway re-validates the manifest with jq.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const repository = "sachkov-inside/inside-telegram";
export const imageName = "ghcr.io/sachkov-inside/inside-telegram";
export const manifestSchemaVersion = "inside.telegram.release-manifest.v1";
export const releaseAssets = [
  "compose.yaml",
  "release-manifest.json",
  "telegram.caddy",
];
export const migrationsDirectory = "src/database/migrations";

const ordinalPattern = /^v[1-9][0-9]*$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

/**
 * Accepts only the next contiguous ordinal on the current main commit.
 * @param {{requestedVersion: string, sourceSha: string, currentMainSha: string,
 *   existingTags: string[], existingReleases: {version: string, immutable: boolean,
 *   assets: string[]}[]}} input
 */
export function planRelease(input) {
  const ordinal = parseOrdinal(input.requestedVersion);
  if (!shaPattern.test(input.sourceSha)) {
    throw new Error("source SHA must be a full commit SHA");
  }
  const releases = input.existingReleases.filter(({ version }) =>
    ordinalPattern.test(version),
  );
  for (const release of releases) {
    if (!release.immutable) {
      throw new Error(`${release.version} is not an immutable release`);
    }
    const missing = releaseAssets.filter(
      (asset) => !release.assets.includes(asset),
    );
    if (missing.length > 0) {
      throw new Error(`${release.version} is missing ${missing.join(", ")}`);
    }
  }
  const releaseVersions = [...new Set(releases.map(({ version }) => version))];
  const tags = [
    ...new Set(input.existingTags.filter((tag) => ordinalPattern.test(tag))),
  ];
  if (
    JSON.stringify([...tags].sort()) !==
    JSON.stringify([...releaseVersions].sort())
  ) {
    throw new Error("ordinal Git tags must exactly match immutable releases");
  }
  const ordinals = releaseVersions.map(parseOrdinal);
  const nextOrdinal = Math.max(0, ...ordinals) + 1;
  for (let expected = 1; expected < nextOrdinal; expected += 1) {
    if (!ordinals.includes(expected)) {
      throw new Error(
        `ordinal history is not contiguous: missing v${expected}`,
      );
    }
  }
  if (input.sourceSha !== input.currentMainSha) {
    throw new Error("captured source SHA is not the current main");
  }
  if (ordinal !== nextOrdinal) {
    throw new Error(
      `requested ${input.requestedVersion}, but the next release is v${nextOrdinal}`,
    );
  }
  return { version: input.requestedVersion, sourceSha: input.sourceSha };
}

/**
 * Identity of the ordered migration set: names and contents of every file.
 * Equal identities mean that two releases expect the same database schema.
 */
export async function migrationsIdentity(directory = migrationsDirectory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (names.length === 0) {
    throw new Error(`no migrations in ${directory}`);
  }
  const lines = [];
  for (const name of names) {
    const content = await readFile(path.join(directory, name));
    lines.push(`${name}\t${sha256Hex(content)}\n`);
  }
  return {
    identity: `sha256:${sha256Hex(lines.join(""))}`,
    count: names.length,
    latest: names.at(-1),
  };
}

/**
 * @param {{version: string, sourceSha: string, imageDigest: string,
 *   composePath: string, caddyPath: string, migrationsDirectory?: string,
 *   workflowRunId: number,
 *   serverUrl: string}} input
 */
export async function createManifest(input) {
  parseOrdinal(input.version);
  if (!shaPattern.test(input.sourceSha)) {
    throw new Error("source SHA must be a full commit SHA");
  }
  if (!digestPattern.test(input.imageDigest)) {
    throw new Error("image digest must be sha256:<64 hex>");
  }
  if (!Number.isSafeInteger(input.workflowRunId) || input.workflowRunId < 1) {
    throw new Error("publication workflow run id must be a positive integer");
  }
  const compose = await readFile(input.composePath);
  const caddy = await readFile(input.caddyPath);
  return {
    schemaVersion: manifestSchemaVersion,
    version: input.version,
    source: { repository, sha: input.sourceSha },
    image: `${imageName}@${input.imageDigest}`,
    migrations: await migrationsIdentity(input.migrationsDirectory),
    compose: { asset: "compose.yaml", sha256: `sha256:${sha256Hex(compose)}` },
    caddy: { asset: "telegram.caddy", sha256: `sha256:${sha256Hex(caddy)}` },
    publication: {
      workflowRunId: input.workflowRunId,
      workflowRunUrl: `${input.serverUrl}/${repository}/actions/runs/${input.workflowRunId}`,
    },
  };
}

function parseOrdinal(version) {
  if (typeof version !== "string" || !ordinalPattern.test(version)) {
    throw new Error(`release version must be vN, got ${String(version)}`);
  }
  return Number(version.slice(1));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readStandardInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function option(arguments_, name) {
  const index = arguments_.indexOf(`--${name}`);
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function main(arguments_) {
  const [command, ...rest] = arguments_;
  if (command === "plan") {
    return planRelease(JSON.parse(await readStandardInput()));
  }
  if (command === "migrations-identity") {
    return migrationsIdentity(rest[0]);
  }
  if (command === "manifest") {
    return createManifest({
      version: option(rest, "version"),
      sourceSha: option(rest, "source-sha"),
      imageDigest: option(rest, "image-digest"),
      composePath: option(rest, "compose"),
      caddyPath: option(rest, "caddy"),
      workflowRunId: Number(option(rest, "run-id")),
      serverUrl: option(rest, "server-url"),
    });
  }
  throw new Error(
    "usage: release-contract.mjs plan | migrations-identity [dir] | manifest --version vN --source-sha <sha> --image-digest <digest> --compose <file> --caddy <file> --run-id <id> --server-url <url>",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release contract: ${message}\n`);
    process.exitCode = 1;
  }
}

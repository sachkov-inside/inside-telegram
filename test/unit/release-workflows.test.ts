import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const release = readFileSync(".github/workflows/release.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
const applicationCi = readFileSync(
  ".github/workflows/application-ci.yml",
  "utf8",
);

/** Returns the shell body of one named workflow step. */
function stepScript(workflow: string, name: string): string {
  const step = workflow
    .split("      - name: ")
    .find((part) => part.startsWith(`${name}\n`));
  if (!step) throw new Error(`missing workflow step: ${name}`);
  const body = step.split("        run: |\n")[1];
  if (!body) throw new Error(`missing shell body: ${name}`);
  return body.replace(/^ {10}/gm, "");
}

/** Returns the block of one job, from its key to the next job. */
function job(workflow: string, name: string): string {
  const match = new RegExp(`^  ${name}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(
    workflow,
  );
  if (!match?.[1]) throw new Error(`missing job: ${name}`);
  return match[1];
}

function assertDeploymentBoundary(workflow: string): void {
  expect(workflow).toMatch(/^permissions: \{\}$/m);
  expect(workflow).toMatch(/^ {4}environment: Production$/m);
  expect(workflow).toMatch(/^ {6}actions: read$/m);
  expect(workflow).toMatch(/^ {6}contents: read$/m);
  expect(workflow).not.toMatch(/^ {6}(?:actions|contents|packages): write$/m);
  expect(workflow).not.toMatch(/actions\/checkout|docker build|pnpm|npm /);
  expect(workflow).toContain("StrictHostKeyChecking=yes");
  expect(workflow).toContain("BatchMode=yes");
  // A silent phase once outlived an idle network path in Platform deploy (Workspace #184).
  expect(workflow).toContain("ServerAliveInterval=15");
  expect(workflow).toContain("ConnectionAttempts=3");
  expect(workflow).toContain('"inside-telegram-deploy@$SSH_HOST"');
  expect(workflow).toContain('"$OPERATION $VERSION $GITHUB_RUN_ID"');
  expect(workflow).not.toMatch(
    /ssh root@|StrictHostKeyChecking=(?:no|accept-new)|cancel-in-progress/,
  );
}

describe("release workflow", () => {
  it("publishes only after the plan, application CI and image jobs", () => {
    expect(release).toMatch(/^permissions: \{\}$/m);
    expect(release).toMatch(/^ {2}cancel-in-progress: false$/m);
    expect(release).toContain("bash scripts/plan-release.sh");
    expect(job(release, "ci")).toContain(
      "uses: ./.github/workflows/application-ci.yml",
    );
    expect(job(release, "ci")).toContain(
      "source_sha: ${{ needs.plan.outputs.source_sha }}",
    );
    expect(job(release, "image")).toContain("needs: [plan, ci]");
    expect(job(release, "publish")).toContain("needs: [plan, ci, image]");
  });

  it("grants package and contents writes only to the jobs that need them", () => {
    expect(job(release, "plan")).not.toMatch(/: write$/m);
    expect(job(release, "image")).toMatch(/^ {6}packages: write$/m);
    expect(job(release, "image")).not.toMatch(/contents: write/);
    expect(job(release, "publish")).toMatch(/^ {6}contents: write$/m);
    expect(job(release, "publish")).not.toMatch(/packages: write/);
  });

  it("builds the production Dockerfile from the captured SHA and proves an anonymous pull", () => {
    const image = job(release, "image");
    expect(image).toContain("file: infra/production/Dockerfile");
    expect(image).toContain(
      "SOURCE_COMMIT=${{ needs.plan.outputs.source_sha }}",
    );
    expect(image).toContain("ref: ${{ needs.plan.outputs.source_sha }}");
    const proof = stepScript(release, "Prove anonymous pull by digest");
    expect(proof.indexOf("docker logout ghcr.io")).toBeLessThan(
      proof.indexOf('docker pull "$IMAGE"'),
    );
    expect(image).toContain(
      "IMAGE: ghcr.io/sachkov-inside/inside-telegram@${{ steps.build.outputs.digest }}",
    );
  });

  it("publishes a release pinned to the SHA with exactly the manifest and compose assets", () => {
    const publish = stepScript(release, "Publish the immutable GitHub Release");
    expect(publish).toContain('--target "$SOURCE_SHA"');
    expect(publish).toContain("release-assets/release-manifest.json");
    expect(publish).toContain("release-assets/compose.yaml");
    expect(publish).toContain("release-assets/telegram.caddy");
    expect(publish).toContain(".isImmutable == true");
    expect(release).not.toContain("RELEASE_SETTINGS_READ_TOKEN");
    expect(readFileSync("scripts/plan-release.sh", "utf8")).not.toMatch(
      /RELEASE_SETTINGS_READ_TOKEN|immutable-releases/,
    );
    expect(stepScript(release, "Create the release manifest")).toContain(
      "cp infra/production/compose.yaml release-assets/compose.yaml",
    );
  });

  it.each([
    [true, 0, false],
    [false, 1, true],
  ])(
    "keeps an immutable release and deletes a mutable one (immutable=%s)",
    (immutable, status, deleted) => {
      const directory = mkdtempSync(path.join(tmpdir(), "telegram-publish-"));
      try {
        mkdirSync(path.join(directory, "release-assets"));
        writeFileSync(
          path.join(directory, "release-assets/release-manifest.json"),
          JSON.stringify({
            source: { sha: "a".repeat(40) },
            image: "image",
            migrations: { identity: "m", count: 1, latest: "001.ts" },
            compose: { sha256: "c" },
            caddy: { sha256: "d" },
          }),
        );
        const gh = path.join(directory, "gh");
        writeFileSync(
          gh,
          `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FIXTURES/gh.log"
case "$1 $2" in
  'release create') ;;
  'release view') printf '{"isImmutable":${String(immutable)},"tagName":"v2","targetCommitish":"${"a".repeat(40)}"}' ;;
  'release delete') ;;
  *) exit 1 ;;
esac
`,
        );
        chmodSync(gh, 0o755);
        const result = spawnSync(
          "bash",
          ["-c", stepScript(release, "Publish the immutable GitHub Release")],
          {
            cwd: directory,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH ?? ""}`,
              FIXTURES: directory,
              RUNNER_TEMP: directory,
              GITHUB_REPOSITORY: "sachkov-inside/inside-telegram",
              VERSION: "v2",
              SOURCE_SHA: "a".repeat(40),
            },
          },
        );
        expect(result.status, result.stderr).toBe(status);
        const calls = readFileSync(path.join(directory, "gh.log"), "utf8");
        expect(
          calls.includes(
            "release delete v2 --repo sachkov-inside/inside-telegram --cleanup-tag --yes",
          ),
        ).toBe(deleted);
        if (deleted) {
          expect(result.stdout).toContain("Enable immutable releases");
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("lets the release reuse application CI for an exact commit", () => {
    expect(applicationCi).toMatch(/^ {2}workflow_call:$/m);
    expect(applicationCi).toContain(
      "ref: ${{ inputs.source_sha || github.sha }}",
    );
  });
});

describe("deploy workflow", () => {
  it("queues deploy and rollback without cancelling an active operation", () => {
    expect(deploy).toMatch(/^ {10}- deploy$/m);
    expect(deploy).toMatch(/^ {10}- rollback$/m);
    expect(deploy).toMatch(/^ {2}group: telegram-production-deployment$/m);
    expect(deploy).toMatch(/^ {2}queue: max$/m);
  });

  it("keeps the deployment execution boundary closed", () => {
    assertDeploymentBoundary(deploy);
  });

  it.each([
    [
      "checkout",
      deploy.replace(
        "    steps:\n",
        "    steps:\n      - uses: actions/checkout@v7\n",
      ),
    ],
    [
      "write permission",
      deploy.replace("      contents: read", "      contents: write"),
    ],
    [
      "lax host key",
      deploy.replace(
        "StrictHostKeyChecking=yes",
        "StrictHostKeyChecking=accept-new",
      ),
    ],
    ["cancel", deploy.replace("  queue: max", "  cancel-in-progress: true")],
    [
      "root",
      deploy.replace('"inside-telegram-deploy@$SSH_HOST"', '"root@$SSH_HOST"'),
    ],
  ])("rejects an unsafe variant: %s", (_name, unsafe) => {
    expect(() => assertDeploymentBoundary(unsafe)).toThrow();
  });

  it("verifies and rechecks the selected release outside a Git checkout", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telegram-workflow-"));
    try {
      const sourceSha = "1".repeat(40);
      const compose = "name: inside-production-telegram\n";
      const caddy = "telegram.sachkov.dev {\n}\n";
      const digest = (value: string) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`;
      const manifest = {
        schemaVersion: "inside.telegram.release-manifest.v1",
        version: "v1",
        source: {
          repository: "sachkov-inside/inside-telegram",
          sha: sourceSha,
        },
        image: `ghcr.io/sachkov-inside/inside-telegram@sha256:${"2".repeat(64)}`,
        migrations: {
          identity: `sha256:${"3".repeat(64)}`,
          count: 1,
          latest: "001.ts",
        },
        compose: { asset: "compose.yaml", sha256: digest(compose) },
        caddy: { asset: "telegram.caddy", sha256: digest(caddy) },
        publication: { workflowRunId: 91, workflowRunUrl: "https://example" },
      };
      const fixtures = path.join(directory, "fixtures");
      mkdirSync(fixtures);
      writeFileSync(
        path.join(fixtures, "release-manifest.json"),
        JSON.stringify(manifest),
      );
      writeFileSync(path.join(fixtures, "compose.yaml"), compose);
      writeFileSync(path.join(fixtures, "telegram.caddy"), caddy);
      writeFileSync(
        path.join(fixtures, "release.json"),
        JSON.stringify({
          assets: [
            { name: "release-manifest.json" },
            { name: "compose.yaml" },
            { name: "telegram.caddy" },
          ],
          isImmutable: true,
          tagName: "v1",
          targetCommitish: sourceSha,
        }),
      );
      writeFileSync(
        path.join(fixtures, "run.json"),
        JSON.stringify({
          conclusion: "success",
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: sourceSha,
          path: ".github/workflows/release.yml",
        }),
      );
      const gh = path.join(directory, "gh");
      writeFileSync(
        gh,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == release && " $* " != *" --repo sachkov-inside/inside-telegram "* ]]; then
  echo 'No repository selected outside a Git checkout' >&2
  exit 1
fi
case "$1 $2" in
  'release view') cat "$FIXTURES/release.json" ;;
  'release download')
    while [[ "$1" != --dir ]]; do shift; done
    cp "$FIXTURES/release-manifest.json" "$FIXTURES/compose.yaml" "$FIXTURES/telegram.caddy" "$2/" ;;
  'api repos/sachkov-inside/inside-telegram/actions/runs/91') cat "$FIXTURES/run.json" ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(gh, 0o755);
      const shaShim = path.join(directory, "sha256sum");
      writeFileSync(
        shaShim,
        '#!/usr/bin/env bash\nif command -v /usr/bin/sha256sum >/dev/null 2>&1; then exec /usr/bin/sha256sum "$@"; fi\nexec shasum -a 256 "$@"\n',
      );
      chmodSync(shaShim, 0o755);

      for (const name of [
        "Verify and download the selected release",
        "Recheck the selected release after waiting in the queue",
      ]) {
        const result = spawnSync("bash", ["-c", stepScript(deploy, name)], {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            FIXTURES: fixtures,
            RUNNER_TEMP: directory,
            GITHUB_ENV: path.join(directory, "github.env"),
            GITHUB_REPOSITORY: "sachkov-inside/inside-telegram",
            RELEASE_DIR: path.join(directory, "production-release"),
            OPERATION: "deploy",
            VERSION: "v1",
          },
        });
        expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      }
      expect(
        readFileSync(
          path.join(directory, "production-release/compose.yaml"),
          "utf8",
        ),
      ).toBe(compose);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("release contract", () => {
  const planInput = {
    requestedVersion: "v2",
    sourceSha: "a".repeat(40),
    currentMainSha: "a".repeat(40),
    existingTags: ["v1", "unrelated"],
    existingReleases: [
      {
        version: "v1",
        immutable: true,
        assets: ["compose.yaml", "release-manifest.json", "telegram.caddy"],
      },
    ],
  };

  function plan(input: unknown) {
    return spawnSync(
      process.execPath,
      ["scripts/release-contract.mjs", "plan"],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
      },
    );
  }

  it("plans the next ordinal on the current main", () => {
    const result = plan(planInput);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: "v2",
      sourceSha: "a".repeat(40),
    });
  });

  it.each([
    ["a skipped ordinal", { requestedVersion: "v3" }, /next release is v2/],
    ["a repeated ordinal", { requestedVersion: "v1" }, /next release is v2/],
    ["a stale SHA", { currentMainSha: "b".repeat(40) }, /not the current main/],
    ["a malformed version", { requestedVersion: "2" }, /must be vN/],
    [
      "a mutable earlier release",
      {
        existingReleases: [
          {
            version: "v1",
            immutable: false,
            assets: ["compose.yaml", "release-manifest.json", "telegram.caddy"],
          },
        ],
      },
      /not an immutable release/,
    ],
    [
      "a tag without a release",
      { existingTags: ["v1", "v2"] },
      /must exactly match/,
    ],
  ])("refuses %s", (_name, override, message) => {
    const result = plan({ ...planInput, ...override });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it("changes the migration identity when a migration changes or is added", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telegram-migrations-"));
    try {
      const identity = () => {
        const result = spawnSync(
          process.execPath,
          ["scripts/release-contract.mjs", "migrations-identity", directory],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as {
          identity: string;
          count: number;
          latest: string;
        };
      };
      writeFileSync(path.join(directory, "001-first.ts"), "one\n");
      const first = identity();
      expect(identity()).toEqual(first);
      writeFileSync(path.join(directory, "001-first.ts"), "changed\n");
      const changed = identity();
      expect(changed.identity).not.toBe(first.identity);
      writeFileSync(path.join(directory, "002-second.ts"), "two\n");
      expect(identity()).toMatchObject({ count: 2, latest: "002-second.ts" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes the manifest the gateway and deploy workflow accept", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-contract.mjs",
        "manifest",
        "--version",
        "v1",
        "--source-sha",
        "c".repeat(40),
        "--image-digest",
        `sha256:${"d".repeat(64)}`,
        "--compose",
        "infra/production/compose.yaml",
        "--caddy",
        "infra/production/telegram.caddy",
        "--run-id",
        "77",
        "--server-url",
        "https://github.com",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual([
      "caddy",
      "compose",
      "image",
      "migrations",
      "publication",
      "schemaVersion",
      "source",
      "version",
    ]);
    expect(manifest).toMatchObject({
      schemaVersion: "inside.telegram.release-manifest.v1",
      source: { repository: "sachkov-inside/inside-telegram" },
      image: `ghcr.io/sachkov-inside/inside-telegram@sha256:${"d".repeat(64)}`,
      compose: {
        asset: "compose.yaml",
        sha256: `sha256:${createHash("sha256")
          .update(readFileSync("infra/production/compose.yaml"))
          .digest("hex")}`,
      },
      caddy: {
        asset: "telegram.caddy",
        sha256: `sha256:${createHash("sha256")
          .update(readFileSync("infra/production/telegram.caddy"))
          .digest("hex")}`,
      },
      publication: {
        workflowRunId: 77,
        workflowRunUrl:
          "https://github.com/sachkov-inside/inside-telegram/actions/runs/77",
      },
    });
  });
});

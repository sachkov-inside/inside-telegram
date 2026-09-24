import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const gatewayPath = path.resolve(
  "infra/production/deploy/inside-telegram-deploy",
);
const installerPath = path.resolve(
  "infra/production/deploy/install-deploy-access.sh",
);
const gateway = readFileSync(gatewayPath, "utf8");
const repository = "sachkov-inside/inside-telegram";
const identityA = `sha256:${"a".repeat(64)}`;
const identityB = `sha256:${"b".repeat(64)}`;

interface Release {
  version: string;
  manifest: string;
  compose: string;
  caddy: string;
  image: string;
}

let root: string;
let bin: string;
let github: string;
let payloads: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "telegram-deploy-"));
  bin = path.join(root, "fake-bin");
  github = path.join(root, "fake-github");
  payloads = path.join(root, "payloads");
  for (const directory of [bin, github, payloads]) {
    mkdirSync(directory, { recursive: true });
  }
  const config = path.join(root, "host/etc/inside/telegram");
  mkdirSync(config, { recursive: true });
  for (const name of [
    "compose.env",
    "application.env",
    "compose.override.yaml",
  ]) {
    writeFileSync(path.join(config, name), `# host-owned ${name}\n`);
  }
  mkdirSync(path.join(root, "host/etc/caddy"), { recursive: true });
  writeFileSync(
    path.join(root, "host/etc/caddy/Caddyfile"),
    "import /srv/inside/runtime/caddy/*.caddy\n",
  );
  mkdirSync(caddyDirectory(), { recursive: true });
  writeExecutable(
    "caddy",
    `#!/usr/bin/env bash
printf '%s|%s\\n' "$*" "$(cat "$FAKE_ROOT/host/srv/inside/runtime/caddy/telegram.caddy" 2>/dev/null | head -1)" >>"$FAKE_ROOT/caddy.log"
if [[ -n "\${FAKE_CADDY_FAIL:-}" && "$1" == "$FAKE_CADDY_FAIL" ]] &&
   grep -q "\${FAKE_CADDY_FAIL_ON:-}" "$FAKE_ROOT/host/srv/inside/runtime/caddy/telegram.caddy" 2>/dev/null; then
  exit 1
fi
`,
  );
  writeExecutable(
    "docker",
    `#!/usr/bin/env bash
printf '%s|%s\\n' "\${TELEGRAM_IMAGE:-}" "$*" >>"$FAKE_ROOT/docker.log"
if [[ -n "\${FAKE_DOCKER_FAIL:-}" && "$*" == *"$FAKE_DOCKER_FAIL"* ]]; then
  exit 1
fi
if [[ "$*" == *" port app 3002" ]]; then
  echo 127.0.0.1:3303
fi
if [[ "$*" == *" config --format json" ]]; then
  printf '{"services":{"app":{"ports":[{"target":3002,"published":"3303","host_ip":"127.0.0.1"}]}}}\n'
fi
`,
  );
  writeExecutable(
    "curl",
    `#!/usr/bin/env bash
output=/dev/stdout
write_out=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --write-out) write_out="$2"; shift 2 ;;
    --header|--user-agent|--connect-timeout|--max-time|--retry|--retry-delay|--proto|--proto-redir) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >>"$FAKE_ROOT/curl.log"
case "$url" in
  http://127.0.0.1:3303/ready)
    printf '%s' "\${FAKE_READY_CODE:-200}" ;;
  https://api.github.com/repos/${repository}/releases/tags/*)
    cp "$FAKE_GITHUB/\${url##*/}/release.json" "$output" 2>/dev/null || exit 22 ;;
  https://github.com/${repository}/releases/download/*/release-manifest.json)
    version="\${url%/release-manifest.json}"; version="\${version##*/}"
    cp "$FAKE_GITHUB/$version/release-manifest.json" "$output" 2>/dev/null || exit 22 ;;
  https://api.github.com/repos/${repository}/actions/runs/*)
    cp "$FAKE_GITHUB/runs/\${url##*/}.json" "$output" 2>/dev/null || exit 22 ;;
  *) exit 7 ;;
esac
`,
  );
  writeExecutable(
    "flock",
    `#!/usr/bin/env bash
[[ ! -e "$FAKE_ROOT/host/var/lib/inside/telegram-deployments/operation.lock.held" ]]
`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inside-telegram-deploy gateway", { timeout: 30_000 }, () => {
  it("deploys, repeats idempotently and rolls back to the previous release", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityA);

    expectSuccess(run("deploy v1 501", v1));
    let state = readState();
    expect(state.current).toMatchObject({
      version: "v1",
      image: v1.image,
      migrationsIdentity: identityA,
      githubRunId: 501,
    });
    expect(state.previous).toBeNull();
    const firstDeploy = dockerCalls();
    expect(firstDeploy.map((call) => call.command)).toEqual([
      expect.stringMatching(/ config --quiet$/),
      expect.stringMatching(/ config --format json$/),
      `pull --quiet ${v1.image}`,
      expect.stringMatching(/ stop app$/),
      expect.stringMatching(
        / --profile operations run --rm --interactive=false migrate$/,
      ),
      expect.stringMatching(/ up --detach --no-build --wait app$/),
      expect.stringMatching(/ port app 3002$/),
    ]);
    for (const call of firstDeploy.filter(({ command }) =>
      command.startsWith("compose"),
    )) {
      expect(call.image).toBe(v1.image);
      expect(call.command).toMatch(
        new RegExp(
          `^compose --env-file ${root}/host/etc/inside/telegram/compose\\.env -f \\S+/compose\\.yaml -f ${root}/host/etc/inside/telegram/compose\\.override\\.yaml `,
        ),
      );
    }
    for (const call of firstDeploy.slice(3)) {
      expect(call.command).toContain(
        ` -f ${root}/host/srv/inside/telegram/releases/v1/compose.yaml `,
      );
    }
    expect(readFileSync(caddyTarget(), "utf8")).toBe(v1.caddy);
    expect(caddyCalls()).toEqual([
      `validate --config ${root}/host/etc/caddy/Caddyfile --adapter caddyfile|# v1`,
      `reload --config ${root}/host/etc/caddy/Caddyfile --adapter caddyfile|# v1`,
    ]);
    expect(
      readFileSync(
        path.join(root, "host/srv/inside/telegram/releases/v1/compose.yaml"),
        "utf8",
      ),
    ).toBe(v1.compose);
    expect(
      readFileSync(
        path.join(root, "host/etc/inside/telegram/compose.env"),
        "utf8",
      ),
    ).toBe("# host-owned compose.env\n");
    expect(readOperation()).toMatchObject({
      operation: "deploy",
      version: "v1",
      status: "succeeded",
      phase: "complete",
    });

    expectSuccess(run("deploy v2 502", v2));
    state = readState();
    expect(state.current).toMatchObject({ version: "v2", image: v2.image });
    expect(state.previous).toMatchObject({ version: "v1", image: v1.image });
    expect(readFileSync(caddyTarget(), "utf8")).toBe(v2.caddy);
    expect(existsSync(`${caddyTarget()}.previous`)).toBe(false);

    clearDockerLog();
    clearCaddyLog();
    const repeat = run("deploy v2 503", v2);
    expectSuccess(repeat);
    expect(caddyCalls()).toEqual([]);
    expect(repeat.stdout).toContain("already current");
    expect(dockerCommands()).not.toContainEqual(
      expect.stringMatching(/ stop app$| migrate$/),
    );
    expect(readState()).toEqual(state);

    clearDockerLog();
    expectSuccess(run("rollback v1 504", v1));
    state = readState();
    expect(state.current).toMatchObject({
      version: "v1",
      image: v1.image,
      operation: "rollback",
      githubRunId: 504,
    });
    expect(state.previous).toBeNull();
    expect(readFileSync(caddyTarget(), "utf8")).toBe(v1.caddy);
    const rollback = dockerCalls();
    expect(rollback.map(({ command }) => command)).not.toContainEqual(
      expect.stringMatching(/migrate$/),
    );
    expect(rollback.map(({ command }) => command)).toContainEqual(
      expect.stringMatching(/ stop app$/),
    );
    expect(
      rollback
        .filter(({ command }) => command.startsWith("compose"))
        .every(({ image }) => image === v1.image),
    ).toBe(true);

    clearDockerLog();
    expectSuccess(run("rollback v1 505", v1));
    expect(dockerCommands()).not.toContainEqual(
      expect.stringMatching(/ stop app$/),
    );
  });

  it("refuses a rollback across different migration sets", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityB);
    expectSuccess(run("deploy v1 601", v1));
    expectSuccess(run("deploy v2 602", v2));
    const before = readState();
    clearDockerLog();

    const result = run("rollback v1 603", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/migration sets differ.*Repair forward/s);
    expect(dockerCommands()).toEqual([]);
    expect(readState()).toEqual(before);
  });

  it("refuses a rollback to anything but the recorded previous release", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityA);
    const v3 = publishRelease("v3", identityA);
    expectSuccess(run("deploy v1 611", v1));
    expectSuccess(run("deploy v2 612", v2));
    expectSuccess(run("deploy v3 613", v3));

    const result = run("rollback v1 614", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only the recorded previous release");
  });

  it("refuses to deploy an older ordinal instead of rolling back", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityA);
    expectSuccess(run("deploy v2 621", v2));

    const result = run("deploy v1 622", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("use rollback");
  });

  it("keeps diagnostics and refuses an unsafe rollback after a failed migration", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityB);
    expectSuccess(run("deploy v1 701", v1));
    const before = readState();

    const failed = run("deploy v2 702", v2, { FAKE_DOCKER_FAIL: "migrate" });

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("phase migrate");
    expect(readOperation()).toMatchObject({
      operation: "deploy",
      version: "v2",
      phase: "migrate",
      status: "failed",
      migrationsIdentity: identityB,
    });
    expect(readState()).toEqual(before);

    const restart = run("deploy v1 703", v1);
    expect(restart.status).toBe(1);
    expect(restart.stderr).toContain("Repair forward");

    expectSuccess(run("deploy v2 704", v2));
    expect(readState().current).toMatchObject({ version: "v2" });
  });

  it("records a failed readiness check", () => {
    const v1 = publishRelease("v1", identityA);

    const result = run("deploy v1 711", v1, { FAKE_READY_CODE: "503" });

    expect(result.status).toBe(1);
    expect(readOperation()).toMatchObject({
      phase: "readiness",
      status: "failed",
    });
    expect(existsSync(stateFile())).toBe(false);
  });

  it("stops at preflight without the host-owned override", () => {
    const v1 = publishRelease("v1", identityA);
    rmSync(path.join(root, "host/etc/inside/telegram/compose.override.yaml"));

    const result = run("deploy v1 721", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("compose.override.yaml is missing");
    expect(dockerCommands()).toEqual([expect.stringMatching(/ ps --all /)]);
    expect(readOperation()).toMatchObject({
      phase: "preflight",
      status: "failed",
    });
  });

  it("restores the previous Caddy fragment when validation rejects the new one", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityA);
    expectSuccess(run("deploy v1 901", v1));
    clearCaddyLog();

    const result = run("deploy v2 902", v2, {
      FAKE_CADDY_FAIL: "validate",
      FAKE_CADDY_FAIL_ON: "# v2",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "previous fragment is back, Caddy was not reloaded",
    );
    expect(readFileSync(caddyTarget(), "utf8")).toBe(v1.caddy);
    expect(caddyCalls().map((call) => call.split(" ")[0])).toEqual([
      "validate",
    ]);
    expect(readOperation()).toMatchObject({
      phase: "routes",
      status: "failed",
    });
    expect(readState().current).toMatchObject({ version: "v1" });
  });

  it("restores and reloads the previous Caddy fragment when reload fails", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityA);
    expectSuccess(run("deploy v1 911", v1));
    clearCaddyLog();

    const result = run("deploy v2 912", v2, {
      FAKE_CADDY_FAIL: "reload",
      FAKE_CADDY_FAIL_ON: "# v2",
    });

    expect(result.status).toBe(1);
    expect(readFileSync(caddyTarget(), "utf8")).toBe(v1.caddy);
    expect(caddyCalls()).toEqual([
      expect.stringMatching(/^validate .*\|# v2$/),
      expect.stringMatching(/^reload .*\|# v2$/),
      expect.stringMatching(/^reload .*\|# v1$/),
    ]);
  });

  it("removes a first Caddy fragment that Caddy rejects", () => {
    const v1 = publishRelease("v1", identityA);

    const result = run("deploy v1 921", v1, {
      FAKE_CADDY_FAIL: "validate",
      FAKE_CADDY_FAIL_ON: "# v1",
    });

    expect(result.status).toBe(1);
    expect(existsSync(caddyTarget())).toBe(false);
  });

  it("refuses a Caddy fragment that proxies to another port", () => {
    const v1 = publishRelease("v1", identityA, { port: 3999 });

    const result = run("deploy v1 931", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not proxy to the app port");
    expect(existsSync(caddyTarget())).toBe(false);
  });

  it("allows only a newer deploy after an interrupted migration", () => {
    const v3 = publishRelease("v3", identityA);
    const v4 = publishRelease("v4", identityA);
    const v5 = publishRelease("v5", identityB);
    const v6 = publishRelease("v6", identityB);
    expectSuccess(run("deploy v3 941", v3));
    expect(
      run("deploy v5 942", v5, { FAKE_DOCKER_FAIL: "migrate" }).status,
    ).toBe(1);

    const older = run("deploy v4 943", v4);

    expect(older.status).toBe(1);
    expect(older.stderr).toContain("newer than v5");
    expectSuccess(run("deploy v6 944", v6));
  });

  it("keeps the migration guard through a later failure and a killed run", () => {
    const v3 = publishRelease("v3", identityA);
    const v4 = publishRelease("v4", identityA);
    const v5 = publishRelease("v5", identityB);
    const v6 = publishRelease("v6", identityB);
    expectSuccess(run("deploy v3 981", v3));
    expect(
      run("deploy v5 982", v5, { FAKE_DOCKER_FAIL: "migrate" }).status,
    ).toBe(1);
    expect(run("deploy v6 983", v6, { FAKE_DOCKER_FAIL: "pull" }).status).toBe(
      1,
    );

    const older = run("deploy v4 984", v4);
    expect(older.status).toBe(1);
    expect(older.stderr).toContain("newer than v5");

    const rollbackAttempt = run("rollback v3 985", v3);
    expect(rollbackAttempt.status).toBe(1);

    expectSuccess(run("deploy v6 986", v6));
    expect(existsSync(migrationGuard())).toBe(false);
  });

  it("refuses an older release after a run killed during migrations", () => {
    const v1 = publishRelease("v1", identityA);
    const v2 = publishRelease("v2", identityA);
    expectSuccess(run("deploy v1 991", v1));
    // A killed process leaves the guard and a running journal behind.
    writeFileSync(
      migrationGuard(),
      JSON.stringify({ version: "v3", migrationsIdentity: identityB }),
    );

    const result = run("deploy v2 992", v2);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("an unfinished operation of v3");
  });

  it("keeps temporary Caddy files outside the *.caddy import glob", () => {
    expect(gateway).toContain(
      'caddy_previous="$caddy_dir/telegram.caddy.previous"',
    );
    expect(gateway).toContain(
      'caddy_temporary="$caddy_dir/.telegram.caddy.tmp.$$"',
    );
  });

  it("rejects a non-regular payload entry", () => {
    const v1 = publishRelease("v1", identityA);
    const directory = path.join(payloads, "link");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "release-manifest.json"), v1.manifest);
    writeFileSync(path.join(directory, "telegram.caddy"), v1.caddy);
    symlinkSync("/etc/passwd", path.join(directory, "compose.yaml"));

    const result = runWithInput(
      "deploy v1 951",
      tarGzip(directory, [
        "release-manifest.json",
        "compose.yaml",
        "telegram.caddy",
      ]),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be regular files");
  });

  it("rejects a release published from another branch", () => {
    const v1 = publishRelease("v1", identityA, { branch: "feature" });

    const result = run("deploy v1 961", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publication workflow run is not verified");
  });

  it("refuses to act on an invalid state journal", () => {
    const v1 = publishRelease("v1", identityA);
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({
        schemaVersion: "inside.telegram.deployment-state.v1",
        current: { version: "a[$(id)]", migrationsIdentity: identityA },
        previous: null,
      }),
    );

    const result = run("deploy v1 971", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("state");
    expect(dockerCommands()).toEqual([]);
  });

  it.each([
    "bash -i",
    "deploy v1",
    "deploy v1 1 extra",
    "deploy 1 1",
    "restart v1 1",
    "deploy v01 1",
    "",
  ])("rejects the command %j before reading a payload", (command) => {
    const result = run(command, undefined);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Rejected restricted command");
    expect(existsSync(path.join(root, "curl.log"))).toBe(false);
  });

  it("rejects a payload above its byte limit", () => {
    const large = path.join(payloads, "large.tar.gz");
    writeFileSync(large, Buffer.alloc(1048577, 1));

    const result = runWithInput("deploy v1 801", readFileSync(large));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exceeds 1048576 bytes");
  });

  it("rejects a payload with unexpected entries", () => {
    const v1 = publishRelease("v1", identityA);
    const directory = path.join(payloads, "extra");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "release-manifest.json"), v1.manifest);
    writeFileSync(path.join(directory, "compose.yaml"), v1.compose);
    writeFileSync(path.join(directory, "telegram.caddy"), v1.caddy);
    writeFileSync(path.join(directory, "run.sh"), "echo root\n");

    const result = runWithInput(
      "deploy v1 802",
      tarGzip(directory, [
        "release-manifest.json",
        "compose.yaml",
        "telegram.caddy",
        "run.sh",
      ]),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only release-manifest.json");
  });

  it("rejects a self-consistent manifest that is not the GitHub release asset", () => {
    const v1 = publishRelease("v1", identityA);
    const forged = JSON.parse(v1.manifest) as { image: string };
    forged.image = `ghcr.io/${repository}@sha256:${"9".repeat(64)}`;

    const result = run("deploy v1 803", {
      ...v1,
      manifest: `${JSON.stringify(forged, null, 2)}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "does not match the immutable GitHub release",
    );
    expect(dockerCommands()).toEqual([]);
  });

  it("rejects a compose file that differs from the manifest", () => {
    const v1 = publishRelease("v1", identityA);

    const result = run("deploy v1 804", {
      ...v1,
      compose: `${v1.compose}# changed\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("compose file does not match");
  });

  it("rejects a release that is not immutable", () => {
    const v1 = publishRelease("v1", identityA, { immutable: false });

    const result = run("deploy v1 805", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("immutable GitHub release");
  });

  it("rejects a second operation while the lock is held", () => {
    expect(gateway).toContain("flock --exclusive --nonblock 9");
    const v1 = publishRelease("v1", identityA);
    const lock = path.join(
      root,
      "host/var/lib/inside/telegram-deployments/operation.lock.held",
    );
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, "held\n");

    const result = run("deploy v1 806", v1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("operation is active");
  });

  it("binds the production path to fixed HTTPS GitHub authorities and a system PATH", () => {
    expect(gateway).toContain(
      "https://api.github.com/repos/$github_repository/releases/tags/$version",
    );
    expect(gateway).toContain(
      "readonly github_repository=sachkov-inside/inside-telegram",
    );
    expect(gateway).toContain("--proto-redir '=https'");
    expect(gateway).toContain(
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(gateway).not.toMatch(/>\s*"\$config_dir\//);
  });
});

describe("install-deploy-access.sh", () => {
  it("installs the gateway behind one sudoers rule and a forced-command key", () => {
    const key = path.join(root, "deploy");
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "coordinator", "-f", key],
      { encoding: "utf8" },
    );
    expectSuccess(generated);
    const keyBody = readFileSync(`${key}.pub`, "utf8").split(" ")[1];

    const result = spawnSync("bash", [installerPath, `${key}.pub`], {
      encoding: "utf8",
      env: { ...process.env, INSIDE_TELEGRAM_DEPLOY_TEST_ROOT: `${root}/host` },
    });

    expectSuccess(result);
    expect(
      readFileSync(
        path.join(
          root,
          "host/home/inside-telegram-deploy/.ssh/authorized_keys",
        ),
        "utf8",
      ),
    ).toBe(
      `restrict,command="sudo -n /usr/local/libexec/inside/inside-telegram-deploy" ssh-ed25519 ${keyBody}\n`,
    );
    expect(
      readFileSync(
        path.join(root, "host/etc/sudoers.d/inside-telegram-deploy"),
        "utf8",
      ),
    ).toBe(
      'Defaults:inside-telegram-deploy env_keep += "SSH_ORIGINAL_COMMAND"\ninside-telegram-deploy ALL=(root) NOPASSWD: /usr/local/libexec/inside/inside-telegram-deploy\n',
    );
    expect(
      readFileSync(
        path.join(root, "host/usr/local/libexec/inside/inside-telegram-deploy"),
        "utf8",
      ),
    ).toBe(gateway);
  });

  it("refuses a key that is not one Ed25519 public key", () => {
    const key = path.join(root, "deploy.pub");
    writeFileSync(key, "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ bad\n");

    const result = spawnSync("bash", [installerPath, key], {
      encoding: "utf8",
      env: { ...process.env, INSIDE_TELEGRAM_DEPLOY_TEST_ROOT: `${root}/host` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ssh-ed25519");
  });
});

function writeExecutable(name: string, content: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function publishRelease(
  version: string,
  migrationsIdentity: string,
  options: { immutable?: boolean; branch?: string; port?: number } = {},
): Release {
  const ordinal = Number(version.slice(1));
  const sourceSha = String(ordinal).repeat(40).slice(0, 40);
  const runId = 9000 + ordinal;
  const image = `ghcr.io/${repository}@sha256:${String(ordinal).repeat(64).slice(0, 64)}`;
  const compose = `name: inside-production-telegram\n# ${version}\n`;
  const caddy = `# ${version}\ntelegram.sachkov.dev {\n\treverse_proxy 127.0.0.1:${options.port ?? 3303}\n}\n`;
  const manifest = `${JSON.stringify(
    {
      schemaVersion: "inside.telegram.release-manifest.v1",
      version,
      source: { repository, sha: sourceSha },
      image,
      migrations: {
        identity: migrationsIdentity,
        count: 23,
        latest: "022-community-tribute-readmission.ts",
      },
      compose: { asset: "compose.yaml", sha256: sha256(compose) },
      caddy: { asset: "telegram.caddy", sha256: sha256(caddy) },
      publication: {
        workflowRunId: runId,
        workflowRunUrl: `https://github.com/${repository}/actions/runs/${runId}`,
      },
    },
    null,
    2,
  )}\n`;
  const directory = path.join(github, version);
  mkdirSync(directory, { recursive: true });
  mkdirSync(path.join(github, "runs"), { recursive: true });
  writeFileSync(path.join(directory, "release-manifest.json"), manifest);
  const download = `https://github.com/${repository}/releases/download/${version}`;
  writeFileSync(
    path.join(directory, "release.json"),
    JSON.stringify({
      immutable: options.immutable ?? true,
      draft: false,
      prerelease: false,
      tag_name: version,
      target_commitish: sourceSha,
      assets: [
        {
          name: "release-manifest.json",
          browser_download_url: `${download}/release-manifest.json`,
        },
        {
          name: "compose.yaml",
          browser_download_url: `${download}/compose.yaml`,
        },
        {
          name: "telegram.caddy",
          browser_download_url: `${download}/telegram.caddy`,
        },
      ],
    }),
  );
  writeFileSync(
    path.join(github, "runs", `${runId}.json`),
    JSON.stringify({
      id: runId,
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: options.branch ?? "main",
      head_sha: sourceSha,
      path: ".github/workflows/release.yml",
    }),
  );
  return { version, manifest, compose, caddy, image };
}

function tarGzip(directory: string, entries: string[]): Buffer {
  // A file target avoids bsdtar padding a gzip stream written to stdout.
  const archive = `${directory}.tar.gz`;
  const result = spawnSync(
    "tar",
    ["-C", directory, "-czf", archive, ...entries],
    { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  expectSuccess(result);
  return readFileSync(archive);
}

function payloadFor(release: Release): Buffer {
  const directory = mkdtempSync(path.join(payloads, `${release.version}-`));
  writeFileSync(
    path.join(directory, "release-manifest.json"),
    release.manifest,
  );
  writeFileSync(path.join(directory, "compose.yaml"), release.compose);
  writeFileSync(path.join(directory, "telegram.caddy"), release.caddy);
  return tarGzip(directory, [
    "release-manifest.json",
    "compose.yaml",
    "telegram.caddy",
  ]);
}

function run(
  command: string,
  release: Release | undefined,
  environment: Record<string, string> = {},
) {
  return runWithInput(
    command,
    release ? payloadFor(release) : Buffer.alloc(0),
    environment,
  );
}

function runWithInput(
  command: string,
  input: Buffer,
  environment: Record<string, string> = {},
) {
  return spawnSync("bash", [gatewayPath], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SSH_ORIGINAL_COMMAND: command,
      INSIDE_TELEGRAM_DEPLOY_TEST_ROOT: `${root}/host`,
      FAKE_ROOT: root,
      FAKE_GITHUB: github,
      ...environment,
    },
  });
}

function expectSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, String(result.stderr)).toBe(0);
}

function stateFile(): string {
  return path.join(root, "host/var/lib/inside/telegram-deployments/state.json");
}

function readState(): {
  current: Record<string, unknown>;
  previous: Record<string, unknown> | null;
} {
  return JSON.parse(readFileSync(stateFile(), "utf8")) as never;
}

function readOperation(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      path.join(
        root,
        "host/var/lib/inside/telegram-deployments/operation.json",
      ),
      "utf8",
    ),
  ) as never;
}

function dockerCalls(): { image: string; command: string }[] {
  const log = path.join(root, "docker.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("|");
      return {
        image: line.slice(0, separator),
        command: line.slice(separator + 1),
      };
    });
}

function dockerCommands(): string[] {
  return dockerCalls().map(({ command }) => command);
}

function clearDockerLog(): void {
  rmSync(path.join(root, "docker.log"), { force: true });
}

function caddyDirectory(): string {
  return path.join(root, "host/srv/inside/runtime/caddy");
}

function caddyTarget(): string {
  return path.join(caddyDirectory(), "telegram.caddy");
}

function caddyCalls(): string[] {
  const log = path.join(root, "caddy.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trimEnd().split("\n");
}

function clearCaddyLog(): void {
  rmSync(path.join(root, "caddy.log"), { force: true });
}

function migrationGuard(): string {
  return path.join(
    root,
    "host/var/lib/inside/telegram-deployments/migration-guard.json",
  );
}

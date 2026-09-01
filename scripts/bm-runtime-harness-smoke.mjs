import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(repoRoot, "ops", "bm-runtime");
const root = mkdtempSync(path.join(tmpdir(), "bm-runtime-harness-"));

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BM_") || key === "PFTERMINAL_BIN" || key === "PFTERMINAL_SKILLS_DIR") {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runExpectFailure(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  assert.notEqual(result.status, 0, `expected ${file} to fail`);
  return { stderr: result.stderr, stdout: result.stdout };
}

function makeExecutable(file) {
  writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(file, 0o755);
}

function parseResolution(home, pathValue, overrides = {}) {
  const script = `. '${runtimeDir}/bm-env.sh'; printf '%s\\n' "$BM_TERMINAL_BIN" "$BM_TERMINAL_HOME" "$BM_SKILLS_DIR" "$BM_PROVIDER" "$BM_MODEL"`;
  return run("bash", ["-c", script], {
    env: cleanEnvironment({
      HOME: home,
      PATH: `${pathValue}:${process.env.PATH}`,
      ...overrides,
    }),
  }).trim().split("\n");
}

try {
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const corbanuBin = path.join(binDir, "corbanu");
  const legacyBin = path.join(binDir, "pfterminal");
  makeExecutable(corbanuBin);
  makeExecutable(legacyBin);

  const resolved = parseResolution(home, binDir);
  assert.equal(resolved[0], corbanuBin, "Corbanu is preferred over legacy pfterminal");
  assert.equal(resolved[1], path.join(home, ".corbanu"), "Corbanu home follows the binary");
  assert.equal(resolved[2], path.join(home, ".corbanu", "skills"), "skills follow the terminal home");
  assert.equal(resolved[3], "kimi-code", "operator-mandated provider is Kimi Code");
  assert.equal(resolved[4], "kimi-k3", "operator-mandated model is Kimi K3");

  const overriddenSkills = path.join(root, "override-skills");
  const legacy = parseResolution(home, binDir, {
    BM_TERMINAL_BIN: legacyBin,
    BM_SKILLS_DIR: overriddenSkills,
  });
  assert.equal(legacy[1], path.join(home, ".pfterminal"), "legacy binary gets legacy home");
  assert.equal(legacy[2], overriddenSkills, "explicit skills override is retained");

  const installHome = path.join(root, "install-home");
  const installedSkills = path.join(installHome, ".corbanu", "skills");
  run(path.join(runtimeDir, "bm-install-skills.sh"), [], {
    env: cleanEnvironment({
      HOME: installHome,
      PATH: `${binDir}:${process.env.PATH}`,
    }),
  });
  const sourceSkills = path.join(runtimeDir, "skills");
  assert.deepEqual(
    readdirSync(installedSkills).sort(),
    readdirSync(sourceSkills).sort(),
    "installer refreshes every board skill in the resolved Corbanu home",
  );
  for (const name of readdirSync(sourceSkills)) {
    assert.equal(
      readFileSync(path.join(installedSkills, name, "SKILL.md"), "utf8"),
      readFileSync(path.join(sourceSkills, name, "SKILL.md"), "utf8"),
      `installed ${name} matches the repository contract`,
    );
  }
  const terminalBoardSkill = readFileSync(path.join(sourceSkills, "board-pfterminal", "SKILL.md"), "utf8");
  assert.match(terminalBoardSkill, /\/home\/pfrpc\/repos\/CorbanuTerminal/);
  assert.doesNotMatch(terminalBoardSkill, /\/home\/pfrpc\/repos\/PfTerminal/);

  const proxyRuntime = path.join(root, "proxy-runtime");
  const proxyState = path.join(root, "proxy-pf-boards");
  mkdirSync(proxyRuntime, { recursive: true });
  copyFileSync(path.join(runtimeDir, "bm-env.sh"), path.join(proxyRuntime, "bm-env.sh"));
  copyFileSync(path.join(runtimeDir, "bm-proxy.sh"), path.join(proxyRuntime, "bm-proxy.sh"));
  const fakeFly = path.join(binDir, "fly");
  writeFileSync(
    fakeFly,
    "#!/bin/sh\nprintf '%s' 'No machine specified, using fake-machine-in-region iadpostgres://user:dummy@pgbouncer.abcdefghijklmnop.flympg.net/tasknode?sslmode=require\\n'\n",
    "utf8",
  );
  chmodSync(fakeFly, 0o755);
  makeExecutable(path.join(binDir, "nc"));
  makeExecutable(path.join(binDir, "tmux"));
  mkdirSync(path.join(proxyState, "state"), { recursive: true });
  writeFileSync(path.join(proxyState, "db.env"), "export DATABASE_URL=old\n", { mode: 0o600 });
  writeFileSync(path.join(proxyState, "state", "proxy.cluster"), "3x9jv02yd3dr6qp7\n", "utf8");
  const proxyOutput = run(path.join(proxyRuntime, "bm-proxy.sh"), [], {
    env: cleanEnvironment({
      HOME: path.join(root, "proxy-home"),
      PATH: `${binDir}:${process.env.PATH}`,
      BM_HOME: proxyState,
      BM_PROXY_PORT: "16399",
    }),
  });
  assert.match(proxyOutput, /cluster abcdefghijklmnop/);
  const refreshedDbEnv = readFileSync(path.join(proxyState, "db.env"), "utf8");
  assert.match(refreshedDbEnv, /export BM_MPG_CLUSTER=abcdefghijklmnop/);
  assert.match(refreshedDbEnv, /localhost:16399/);
  assert.match(refreshedDbEnv, /export TASKNODE_DATABASE_ENABLED=true/);
  assert.equal(
    statSync(path.join(proxyState, "db.env")).mode & 0o777,
    0o600,
    "refreshed DB environment remains private",
  );
  assert.equal(
    readFileSync(path.join(proxyState, "state", "proxy.cluster"), "utf8"),
    "abcdefghijklmnop\n",
    "proxy listener records the database-selected MPG cluster",
  );

  const launchHome = path.join(root, "launch-home");
  const launchState = path.join(root, "launch-pf-boards");
  const missingSkills = path.join(root, "missing-skills");
  mkdirSync(path.join(missingSkills, "board-manager"), { recursive: true });
  writeFileSync(path.join(missingSkills, "board-manager", "SKILL.md"), "manager only\n", "utf8");
  const launchEnv = cleanEnvironment({
    HOME: launchHome,
    PATH: `${binDir}:${process.env.PATH}`,
    BM_HOME: launchState,
    BM_TERMINAL_BIN: corbanuBin,
    BM_SKILLS_DIR: missingSkills,
  });
  const failure = runExpectFailure(path.join(runtimeDir, "bm-launch.sh"), ["pfterminal"], {
    env: launchEnv,
  });
  const harnessLog = readFileSync(path.join(launchState, "logs", "harness.log"), "utf8");
  assert.match(harnessLog, /required skill missing: .*board-pfterminal\/SKILL\.md/);
  assert.equal(failure.stderr, "", "launch failure is recorded through the harness log boundary");

  const terminalConfig = path.join(launchHome, ".corbanu", "config.toml");
  const launchWorkspace = path.join(launchState, "workspaces", "pfterminal");
  assert.ok(existsSync(terminalConfig), "launch creates a missing terminal config");
  assert.match(
    readFileSync(terminalConfig, "utf8"),
    new RegExp(`\\[projects\\."${launchWorkspace.replaceAll("/", "\\/")}"\\]\\ntrust_level = "trusted"`),
    "launch pre-trusts an unseen workspace in the resolved terminal config",
  );

  const successRuntime = path.join(root, "success-runtime");
  const successHome = path.join(root, "success-home");
  const successState = path.join(root, "success-pf-boards");
  mkdirSync(successRuntime, { recursive: true });
  for (const name of ["bm-env.sh", "bm-launch.sh"]) {
    copyFileSync(path.join(runtimeDir, name), path.join(successRuntime, name));
  }
  writeFileSync(path.join(successRuntime, "bm-proxy.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path.join(successRuntime, "bm-proxy.sh"), 0o755);
  makeExecutable(path.join(binDir, "tmux"));
  mkdirSync(path.join(successState, "state"), { recursive: true });
  writeFileSync(
    path.join(successState, "db.env"),
    "export DATABASE_URL=postgresql://bm-runtime-smoke@example.invalid/db\n",
    "utf8",
  );
  writeFileSync(path.join(successState, "state", "pfterminal.pending"), "old|state|3\n", "utf8");
  writeFileSync(path.join(successState, "state", "pfterminal.strikes"), "7\n", "utf8");
  run(path.join(successRuntime, "bm-launch.sh"), ["pfterminal"], {
    env: cleanEnvironment({
      HOME: successHome,
      PATH: `${binDir}:${process.env.PATH}`,
      BM_HOME: successState,
      BM_TERMINAL_BIN: corbanuBin,
      BM_SKILLS_DIR: sourceSkills,
    }),
  });
  assert.ok(
    existsSync(path.join(successState, "state", "pfterminal.launched_at")),
    "successful launch records session start",
  );
  assert.ok(
    existsSync(path.join(successState, "state", "pfterminal.skillhash")),
    "successful launch records the installed contract hash",
  );
  assert.equal(
    !existsSync(path.join(successState, "state", "pfterminal.pending")),
    true,
    "new process does not inherit an unacknowledged wake",
  );
  assert.equal(
    readFileSync(path.join(successState, "state", "pfterminal.strikes"), "utf8"),
    "0\n",
    "successful launch clears the prior liveness episode",
  );

  const whipRuntime = path.join(root, "whip-runtime");
  const whipHome = path.join(root, "whip-home");
  const whipState = path.join(root, "whip-pf-boards");
  mkdirSync(whipRuntime, { recursive: true });
  for (const name of ["bm-env.sh", "bm-launch.sh", "bm-whip.sh"]) {
    copyFileSync(path.join(runtimeDir, name), path.join(whipRuntime, name));
  }
  writeFileSync(path.join(whipRuntime, "bm-proxy.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path.join(whipRuntime, "bm-proxy.sh"), 0o755);
  mkdirSync(whipState, { recursive: true });
  writeFileSync(path.join(whipState, "enabled-boards"), "pfterminal\n", "utf8");
  run(path.join(whipRuntime, "bm-whip.sh"), [], {
    env: cleanEnvironment({
      HOME: whipHome,
      PATH: `${binDir}:${process.env.PATH}`,
      BM_HOME: whipState,
      BM_REPO: path.join(root, "empty-bm-repo"),
      BM_TERMINAL_BIN: corbanuBin,
      BM_SKILLS_DIR: missingSkills,
    }),
  });
  assert.equal(
    readFileSync(path.join(whipState, "state", "agents.generated"), "utf8"),
    "pfterminal: board_pf_terminal\n",
    "enabled-boards fallback no longer consumes the nonexistent agents.conf",
  );

  console.log("bm-runtime-harness-smoke ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

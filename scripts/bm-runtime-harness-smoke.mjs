import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAgentRegistry } from "../ops/bm-runtime/registry.mjs";
import { deliveryDecision, mergeRoundProgress } from "../ops/bm-runtime/supervisor.mjs";

const root = mkdtempSync(path.join(tmpdir(), "bm-runtime-harness-"));
const runtime = path.resolve("ops/bm-runtime");
const now = Date.now();
const round = { id: "round_fixture", state: "pending", results_json: {} };
const status = { version: 1, pid: 123, threadId: "fixture-thread", ready: true, updatedAt: new Date(now).toISOString() };
const decide = (input) => deliveryDecision({ round, status, now, pending: {}, ...input });
try {
  assert.equal(decide({}), "deliver");
  for (const bad of [null, { ...status, ready: false }, { ...status, updatedAt: "invalid" }, { ...status, updatedAt: new Date(now+1000).toISOString() }, { ...status, updatedAt: new Date(now-16000).toISOString() }, { ...status, threadId: "" }]) assert.equal(decide({ status: bad }), "wait_ready");
  assert.equal(decide({ pending: { attempts: 1, lastDeliveredAt: new Date(now-60000).toISOString() } }), "wait_completion");
  assert.equal(decide({ pending: { attempts: 3 } }), "alert_pending");
  assert.equal(decide({ round: { ...round, state: "complete" } }), "quiet");
  const stuck = { id: round.id, attempts: 3, alerted: true, progress: "{}" };
  assert.equal(mergeRoundProgress(stuck, round).attempts, 3);
  const advanced = mergeRoundProgress(stuck, { ...round, results_json: { d1: { outcome: "blocked", reason: "Explicit external dependency" } } });
  assert.equal(advanced.id, round.id); assert.equal(advanced.attempts, 0); assert.equal(advanced.alerted, false);

  const registry = readAgentRegistry();
  assert.equal(registry.agents.length, 1);
  assert.equal(registry.agents[0].boards.length, 6);
  const duplicate = structuredClone(registry); duplicate.agents.push({ ...duplicate.agents[0], alias: "duplicate" });
  const badRegistry = path.join(root, "bad-registry.json"); writeFileSync(badRegistry, JSON.stringify(duplicate));
  assert.throws(() => readAgentRegistry(badRegistry), { message: "board_agent_assignment_invalid" });

  const bin = path.join(root, "bin"), home = path.join(root, "agent"), terminalHome = path.join(root, "terminal");
  for (const directory of [bin, path.join(home, "credentials"), path.join(home, "state", "pfterminal.control")]) mkdirSync(directory, { recursive: true });
  const executable = (name, source) => writeFileSync(path.join(bin, name), `#!/usr/bin/env node
${source}`, { mode: 0o755 });
  executable("corbanu", "process.exit(0)");
  executable("ps", "if(process.env.BM_FIXTURE_ALIVE==='yes') console.log(process.argv.includes('pid=') ? '123' : 'corbanu');");
  executable("tmux", `const fs=require('fs');const args=process.argv.slice(2); fs.appendFileSync(process.env.BM_FIXTURE_CALLS, JSON.stringify(args)+String.fromCharCode(10)); if(args[0]==='has-session')process.exit(process.env.BM_FIXTURE_SESSION==='yes'?0:1); if(args[0]==='list-panes')console.log('123');`);
  const callsFile = path.join(root, "tmux-calls.jsonl");
  const credential = path.join(home, "credentials", "pfterminal.json");
  writeFileSync(credential, JSON.stringify({ token: "synthetic-unused-credential" }), { mode: 0o600 });
  const pendingFile = path.join(home, "state", "pfterminal.pending.json");
  writeFileSync(pendingFile, JSON.stringify(stuck));
  const controlFile = path.join(home, "state", "pfterminal.control", "status.json");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BM_REPO: process.cwd(), BM_HOME: home, BM_TERMINAL_BIN: path.join(bin, "corbanu"), BM_TERMINAL_HOME: terminalHome, BM_SKILLS_DIR: path.join(runtime, "skills"), BM_FIXTURE_CALLS: callsFile };
  const launch = (extra = {}, args = []) => spawnSync("bash", [path.join(runtime, "bm-launch.sh"), "pfterminal", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  writeFileSync(controlFile, JSON.stringify({ ...status, ready: false }));
  const busy = launch({ BM_FIXTURE_SESSION: "yes", BM_FIXTURE_ALIVE: "yes" });
  assert.notEqual(busy.status, 0, "a busy or legacy terminal cannot be killed");
  assert.ok(existsSync(callsFile), busy.stderr || String(busy.error));
  assert.ok(!readFileSync(callsFile,"utf8").includes('kill-session'));
  writeFileSync(controlFile, JSON.stringify({ ...status, pid: 999, updatedAt: new Date().toISOString() }));
  assert.notEqual(launch({ BM_FIXTURE_SESSION: "yes", BM_FIXTURE_ALIVE: "yes" }, ["--resume", "preserved-thread"]).status, 0, "explicit resume cannot override a mismatched live PID");
  writeFileSync(controlFile, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }));
  assert.equal(launch({ BM_FIXTURE_SESSION: "yes", BM_FIXTURE_ALIVE: "yes" }).status, 0);
  const calls = readFileSync(callsFile,"utf8").trim().split("\n").map(JSON.parse);
  const started = calls.find((args) => args[0]==="new-session");
  assert.ok(started.includes("DATABASE_URL="));
  assert.ok(started.some((arg) => arg.startsWith("BM_AGENT_TOKEN_FILE=")));
  assert.ok(started.includes(`CODEX_HOME=${terminalHome}`));
  assert.ok(started.at(-1).includes("resume fixture-thread"));
  assert.deepEqual(JSON.parse(readFileSync(pendingFile)), stuck, "launch preserves unanswered work");
  assert.ok(existsSync(path.join(terminalHome,"config.toml")));
  assert.equal(launch({}, ["--resume", "preserved-thread"]).status, 0);
  assert.ok(readFileSync(callsFile,"utf8").includes("resume preserved-thread"));
  assert.notEqual(launch({ BM_SKILLS_DIR: path.join(root,"missing") }).status, 0);
  assert.notEqual(spawnSync("bash",[path.join(runtime,"bm-launch.sh"),"not-configured"],{env}).status,0);
  // Missing deployment prerequisites must fail before changing the working cron
  // or starting a service. Exercise the installer itself with isolated tools.
  const scheduleCalls = path.join(root, "schedule-calls.jsonl");
  for (const name of ["crontab", "systemctl"]) executable(name, `require('fs').appendFileSync(${JSON.stringify(scheduleCalls)}, JSON.stringify(process.argv)+String.fromCharCode(10));`);
  const install = spawnSync("bash", [path.join(runtime, "bm-install-cron.sh")], { env: { ...env, HOME: path.join(root, "operator") }, encoding: "utf8" });
  assert.notEqual(install.status, 0);
  assert.ok(!existsSync(scheduleCalls), "a missing scoped credential/API cannot change production schedules");
  for (const command of ["help", "--help"]) {
    const help = spawnSync(process.execPath, ["scripts/bm.mjs", command], { env: { ...process.env, BM_AGENT_TOKEN_FILE: path.join(root, "absent-credential") }, encoding: "utf8" });
    assert.equal(help.status, 0, "help must work without accessing the credential or API");
    assert.ok(help.stdout.includes("round-status <round-id>"));
    assert.ok(help.stdout.includes("duty-result <round-id> <duty-id>"));
  }
  const missingRound = spawnSync(process.execPath, ["scripts/bm.mjs", "round-status"], { env: { ...process.env, BM_AGENT_TOKEN_FILE: path.join(root, "absent-credential") }, encoding: "utf8" });
  assert.equal(missingRound.status, 1);
  assert.ok(missingRound.stderr.includes("supervisor work order"));
  console.log(JSON.stringify({ ok:true, boards:6, readiness:"structured", busyPreserved:true, pendingResume:true, scopedEnvironment:true, partialProgress:true }));
} finally { rmSync(root, { recursive: true, force: true }); }

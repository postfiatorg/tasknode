import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  createCrashIsolatingTickRunner,
  installProcessHardening,
} from "../server/process-hardening.js";
import { startBackgroundWorkers } from "../server/background-workers.js";

function runSubprocess(source, { timeoutMs = 3000, unhandledRejections = "throw" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--unhandled-rejections=${unhandledRejections}`,
      "--input-type=module",
      "--eval",
      source,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker_crash_resilience_subprocess_timeout"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function jsonRecords(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const fakeProcess = new EventEmitter();
const fakeRecords = [];
const fakeExitCodes = [];
let flushCount = 0;
const firstInstall = installProcessHardening({
  processImpl: fakeProcess,
  logger: { error: (line) => fakeRecords.push(JSON.parse(line)) },
  flush: async () => { flushCount += 1; },
  flushTimeoutMs: 100,
  exit: (code) => fakeExitCodes.push(code),
});
const secondInstall = installProcessHardening({ processImpl: fakeProcess });
assert.equal(firstInstall, secondInstall, "process hardening installation must be idempotent");
fakeProcess.emit("unhandledRejection", new Error("injected_unhandled_rejection"));
assert.equal(fakeRecords.length, 1);
assert.equal(fakeRecords[0].event, "unhandled_rejection");
fakeProcess.emit("uncaughtException", new Error("injected_uncaught_exception"), "smoke");
fakeProcess.emit("uncaughtException", new Error("duplicate_uncaught_exception"), "smoke");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(fakeExitCodes, [1], "fatal handler exits exactly once");
assert.equal(flushCount, 1, "fatal handler flushes once");
assert.equal(fakeRecords.filter((record) => record.event === "uncaught_exception").length, 1);
firstInstall.uninstall();

assert.throws(
  () => startBackgroundWorkers({
    role: "worker:airdrop",
    runWorker: () => { throw new Error("forced_background_startup_failure"); },
  }),
  /forced_background_startup_failure/
);

const hardeningUrl = new URL("../server/process-hardening.js", import.meta.url).href;
const backgroundWorkersUrl = new URL("../server/background-workers.js", import.meta.url).href;
const startupFailure = await runSubprocess(`
import { installProcessHardening } from ${JSON.stringify(hardeningUrl)};
installProcessHardening();
const { startBackgroundWorkers } = await import(${JSON.stringify(backgroundWorkersUrl)});
startBackgroundWorkers({
  role: "worker:airdrop",
  runWorker: () => { throw new Error("forced_background_startup_failure"); },
});
`);
assert.equal(startupFailure.code, 1, "background startup failure must remain fatal");
const startupFailureRecord = jsonRecords(startupFailure.stderr).find((record) => record.event === "uncaught_exception");
assert.equal(startupFailureRecord?.error?.message, "forced_background_startup_failure");

const unhandledSurvives = await runSubprocess(`
import { installProcessHardening } from ${JSON.stringify(hardeningUrl)};
installProcessHardening();
Promise.reject(new Error("forced_unhandled_rejection"));
setTimeout(() => {
  process.stdout.write(JSON.stringify({ event: "unhandled_rejection_survived" }) + "\\n");
  process.exit(0);
}, 25);
`);
assert.equal(unhandledSurvives.code, 0, "unhandled rejection handler must keep the process alive");
const unhandledRecord = jsonRecords(unhandledSurvives.stderr).find((record) => record.event === "unhandled_rejection");
assert.equal(unhandledRecord?.error?.message, "forced_unhandled_rejection");
assert.equal(
  jsonRecords(unhandledSurvives.stdout).find((record) => record.event === "unhandled_rejection_survived")?.event,
  "unhandled_rejection_survived"
);

const legacy = await runSubprocess(`
process.once("unhandledRejection", (error) => {
  process.stderr.write(JSON.stringify({
    event: "legacy_unhandled_tick_rejection",
    error: error?.message || String(error),
  }) + "\\n");
  process.exit(1);
});
setInterval(async () => {
  throw new Error("forced_legacy_tick_rejection");
}, 0);
`);
assert.equal(legacy.code, 1, `legacy fixture must exit after an unhandled tick rejection: ${legacy.stderr}`);
const legacyRecord = jsonRecords(legacy.stderr).find((record) => record.event === "legacy_unhandled_tick_rejection");
assert.deepEqual(legacyRecord, {
  event: "legacy_unhandled_tick_rejection",
  error: "forced_legacy_tick_rejection",
});

const postFix = await runSubprocess(`
import { createCrashIsolatingTickRunner } from ${JSON.stringify(hardeningUrl)};
let ticks = 0;
let failSafe = null;
const runner = createCrashIsolatingTickRunner({
  name: "post_fix_forced_tick",
  intervalMs: 5,
  maxBackoffMs: 20,
  logger: console,
  tick: async () => {
    ticks += 1;
    if (ticks === 1) throw new Error("forced_post_fix_tick_rejection");
    if (ticks < 3) return;
    runner.stop();
    process.stdout.write(JSON.stringify({ event: "post_fix_runner_survived", ticks }) + "\\n");
    clearTimeout(failSafe);
    setTimeout(() => process.exit(0), 0);
  },
});
failSafe = setTimeout(() => {
  process.stderr.write(JSON.stringify({ event: "post_fix_runner_timeout", ticks }) + "\\n");
  process.exit(2);
}, 1000);
runner.start({ immediate: true });
`);
assert.equal(postFix.code, 0, `post-fix runner must survive tick rejection: ${postFix.stderr}`);
const postFixRecord = jsonRecords(postFix.stdout).find((record) => record.event === "post_fix_runner_survived");
assert.ok(postFixRecord?.ticks >= 3, "post-fix runner must execute at least three ticks");
const tickFailure = jsonRecords(postFix.stderr).find((record) => record.event === "scheduled_tick_failed");
assert.equal(tickFailure?.error?.message, "forced_post_fix_tick_rejection");

const fatal = await runSubprocess(`
import { installProcessHardening } from ${JSON.stringify(hardeningUrl)};
installProcessHardening({ flush: async () => {} });
setTimeout(() => {
  throw new Error("forced_uncaught_exception");
}, 0);
`);
assert.equal(fatal.code, 1, `fatal handler must exit 1: ${fatal.stderr}`);
const fatalRecord = jsonRecords(fatal.stderr).find((record) => record.event === "uncaught_exception");
assert.equal(fatalRecord?.schema, "tasknode.process_hardening.v1");
assert.equal(fatalRecord?.error?.message, "forced_uncaught_exception");

console.log("worker-crash-resilience-smoke ok", JSON.stringify({
  startupFailureExitCode: startupFailure.code,
  unhandledRejectionSurvived: unhandledSurvives.code === 0,
  legacyExitCode: legacy.code,
  postFixTicks: postFixRecord.ticks,
  fatalExitCode: fatal.code,
}));

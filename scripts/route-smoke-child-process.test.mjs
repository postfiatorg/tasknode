import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const fixtureFlag = "--route-smoke-child-fixture";
const sourceUrl = new URL("./route-smoke.mjs", import.meta.url);
const profile = "/fixture/route-smoke-profile";
const handoffError = "fixture reached CDP startup";

// A worker contains EventEmitter's real unhandled-error behavior on the old
// script. VM imports replace all external effects, never the script's bodies.
function runScenario(scenario) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules",
    fileURLToPath(import.meta.url),
    fixtureFlag,
    scenario,
  ], {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  return { ...result, events };
}

function assertCleanup(result, stopped) {
  assert.equal(result.status, 1, "the controlled startup failure must remain a failure");
  assert.equal(result.events.filter((event) => event.type === "remove-profile").length, 1);
  assert.deepEqual(
    result.events.filter((event) => event.type === "signal").map(({ role, signal, group }) => ({ role, signal, group })),
    stopped.map((role) => ({ role, signal: "SIGTERM", group: role !== "chrome" })),
  );
  assert.ok(!result.events.some((event) => event.type === "invalid-signal"));
  assert.ok(result.events.some((event) => event.type === "script-exit"));
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
}

async function runFixture(scenario) {
  const children = [];
  const roles = ["api", "vite", "chrome"];
  const trace = (type, detail = {}) => writeSync(1, `${JSON.stringify({ type, ...detail })}\n`);
  let elapsed = 0;

  function terminate(child, signal, group) {
    if (!Number.isInteger(child?.pid) || child.pid <= 0) {
      trace("invalid-signal", { role: child?.role, signal, group });
      throw new Error("fixture rejected a signal without an owned PID");
    }
    trace("signal", { role: child.role, signal, group });
    setImmediate(() => {
      child.exitCode = 0;
      child.emit("exit", 0, signal);
    });
    return true;
  }

  function spawn(command, args) {
    const role = roles[children.length];
    assert.ok(role, "the script must not spawn an unexpected fourth child");
    if (role === "api") assert.equal(args[0], "server/index.js");
    if (role === "vite") assert.equal(command, "./node_modules/.bin/vite");
    if (role === "chrome") assert.equal(command, "fixture-chrome");
    const failed = scenario === `fail-${role}`;
    const missingPid = failed || (scenario === "missing-pid" && role === "chrome");
    const child = new EventEmitter();
    Object.assign(child, {
      role,
      pid: missingPid ? undefined : 4100 + children.length,
      exitCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (signal) => terminate(child, signal, false),
    });
    children.push(child);
    trace("spawn-request", { role });
    setImmediate(() => {
      if (failed) {
        trace("spawn-error", { role });
        child.emit("error", Object.assign(new Error(`spawn ${role} ENOENT`), { code: "ENOENT" }));
        child.emit("close", -2, null);
        return;
      }
      trace("spawned", { role });
      child.emit("spawn");
      if (scenario === "already-exited" && role === "chrome") {
        for (const item of children) {
          item.exitCode = 0;
          item.emit("exit", 0, null);
        }
      }
    });
    return child;
  }

  class FixtureWebSocket {
    constructor(url) {
      assert.equal(url, "ws://fixture.invalid/devtools/page/1");
      trace("cdp-startup");
      // Successful child startup is delegated to the unchanged CDP client.
      // Stop here: this fixture makes no browser or rendered-route claims.
      throw new Error(handoffError);
    }
  }

  const context = vm.createContext({
    process: {
      env: {
        ...process.env,
        ROUTE_SMOKE_PORT: "5194",
        ROUTE_SMOKE_API_PORT: "5195",
        ROUTE_SMOKE_CHROME_PORT: "9331",
        ROUTE_SMOKE_BASE_URL: "http://127.0.0.1:5194",
        ROUTE_SMOKE_USE_EXISTING: "0",
        CHROME_BIN: "fixture-chrome",
      },
      execPath: process.execPath,
      kill: (pid, signal) => terminate(children.find((child) => child.pid === -pid), signal, true),
      exit: (code) => { trace("script-exit", { code }); process.exit(code); },
    },
    console: {
      log: (...args) => trace("log", { message: args.join(" ") }),
      warn: (...args) => trace("warning", { message: args.join(" ") }),
      error: (...args) => trace("error", { message: args.join(" ") }),
    },
    Date: class extends Date { static now() { return elapsed; } },
    setTimeout,
    fetch: async (url) => {
      assert.ok([
        "http://127.0.0.1:5195/health",
        "http://127.0.0.1:5194",
        "http://127.0.0.1:9331/json/list",
      ].includes(url), `unexpected fixture request: ${url}`);
      trace("fetch", { url });
      await new Promise((resolve) => setImmediate(resolve));
      return {
        ok: true,
        json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://fixture.invalid/devtools/page/1" }],
      };
    },
  });
  const imports = {
    "node:child_process": { spawn },
    "node:fs": {
      mkdtempSync: () => { trace("create-profile"); return profile; },
      rmSync: (path, options) => {
        assert.equal(path, profile);
        assert.equal(options.recursive, true);
        assert.equal(options.force, true);
        trace("remove-profile");
      },
    },
    "node:os": { tmpdir: () => "/fixture" },
    "node:path": { join },
    "node:timers/promises": {
      setTimeout: async (delay) => {
        trace("sleep", { delay });
        elapsed += delay;
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
    ws: { default: FixtureWebSocket },
  };
  const module = new vm.SourceTextModule(readFileSync(sourceUrl, "utf8"), { context, identifier: String(sourceUrl) });
  await module.link((specifier) => {
    const exports = imports[specifier];
    assert.ok(exports, `unexpected route-smoke import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
}

if (process.argv[2] === fixtureFlag) {
  await runFixture(process.argv[3]);
} else {
  for (const [role, stopped] of [["api", []], ["vite", ["api"]], ["chrome", ["vite", "api"]]]) {
    test(`asynchronous ${role} spawn failure reaches cleanup and preserves ENOENT`, () => {
      const result = runScenario(`fail-${role}`);
      assertCleanup(result, stopped);
      const error = result.events.find((event) => event.type === "error");
      assert.match(error?.message || "", new RegExp(`spawn ${role} ENOENT`));
      assert.ok(!result.events.some((event) => event.type === "cdp-startup"));
      assert.equal(result.events.filter((event) => event.type === "spawn-request").length, ["api", "vite", "chrome"].indexOf(role) + 1);
    });
  }

  test("cleanup ignores children that have already exited", () => {
    const result = runScenario("already-exited");
    assertCleanup(result, []);
    assert.ok(!result.events.some((event) => event.type === "sleep"));
  });

  test("cleanup does not signal or await a child without a PID", () => {
    const result = runScenario("missing-pid");
    assertCleanup(result, ["vite", "api"]);
    assert.match(result.events.find((event) => event.type === "error")?.message || "", /fixture reached CDP startup/);
    assert.equal(result.events.filter((event) => event.type === "sleep").length, 2);
  });

  test("successful child startup still delegates to CDP and cleans owned children in reverse order", () => {
    const result = runScenario("success");
    assertCleanup(result, ["chrome", "vite", "api"]);
    assert.deepEqual(result.events.filter((event) => event.type === "spawned").map((event) => event.role), ["api", "vite", "chrome"]);
    assert.equal(result.events.filter((event) => event.type === "cdp-startup").length, 1);
    assert.equal(result.events.filter((event) => event.type === "fetch").length, 3);
    assert.match(result.events.find((event) => event.type === "error")?.message || "", /fixture reached CDP startup/);
  });
}

#!/usr/bin/env node

// Guards the NaN-safe numeric env helpers and keeps the unsafe
// `Math.max(..., Number(process.env.X || default))` idiom out of server/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { envNumber, envNumberAtLeast, envNumberBetween } from "../server/env-number.js";

const NAME = "ENV_NUMBER_SMOKE_VALUE";

function withEnv(value, fn) {
  const previous = process.env[NAME];
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[NAME];
    else process.env[NAME] = previous;
  }
}

// Unset, empty and blank keep the fallback.
for (const value of [undefined, "", "   "]) {
  assert.equal(withEnv(value, () => envNumber(NAME, 15000)), 15000, `value ${JSON.stringify(value)}`);
}

// Non-numeric and non-finite spellings keep the fallback instead of NaN/Infinity.
for (const value of ["15s", "3m", "abc", "NaN", "Infinity", "-Infinity", "1e999", "12,000"]) {
  const parsed = withEnv(value, () => envNumber(NAME, 15000));
  assert.equal(parsed, 15000, `value ${JSON.stringify(value)} -> ${parsed}`);
  assert.equal(withEnv(value, () => envNumberAtLeast(NAME, 15000, 5000)), 15000);
  assert.equal(withEnv(value, () => envNumberBetween(NAME, 3, 1, 25)), 3);
}

// Numeric spellings Number() understands still load, including exponent and padding.
assert.equal(withEnv("7000", () => envNumber(NAME, 15000)), 7000);
assert.equal(withEnv("5e3", () => envNumber(NAME, 15000)), 5000);
assert.equal(withEnv(" 7000 ", () => envNumber(NAME, 15000)), 7000);
assert.equal(withEnv("0.5", () => envNumber(NAME, 15000)), 0.5);

// Minimum and maximum clamp exactly as the inline Math.max/Math.min did.
assert.equal(withEnv("0", () => envNumberAtLeast(NAME, 15000, 5000)), 5000);
assert.equal(withEnv("-1", () => envNumberAtLeast(NAME, 15000, 5000)), 5000);
assert.equal(withEnv("9000", () => envNumberAtLeast(NAME, 15000, 5000)), 9000);
assert.equal(withEnv("0", () => envNumberBetween(NAME, 3, 1, 25)), 1);
assert.equal(withEnv("40", () => envNumberBetween(NAME, 3, 1, 25)), 25);
assert.equal(withEnv("12", () => envNumberBetween(NAME, 3, 1, 25)), 12);
// A fallback below the minimum is clamped too, as before.
assert.equal(withEnv(undefined, () => envNumberAtLeast(NAME, 100, 5000)), 5000);

// The inline idiom produced NaN; the helper never does.
const inline = withEnv("15s", () => Math.max(5000, Number(process.env[NAME] || 15000)));
assert.ok(Number.isNaN(inline), "the inline idiom is expected to yield NaN for a mistyped value");
assert.equal(withEnv("15s", () => envNumberAtLeast(NAME, 15000, 5000)), 15000);

// No server module may read a numeric env through the NaN-propagating idiom.
const UNSAFE = /Math\.(?:max|min)\([^\n]*Number\(process\.env\.[A-Z0-9_]+ \|\|/;
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".js")) out.push(path);
  }
  return out;
}
const offenders = [];
for (const file of walk("server")) {
  if (file.endsWith("env-number.js")) continue; // the helper documents the idiom it replaces
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (UNSAFE.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}
assert.deepEqual(offenders, [], `NaN-propagating numeric env reads:\n${offenders.join("\n")}`);

// Every module that routes a setting through the helper must still load with
// junk values set: the module-level constants are computed at import time.
const JUNK = {
  TASKNODE_MEMORY_INTERVAL_MS: "15s",
  TASKNODE_BM_NARRATOR_INTERVAL_MS: "3m",
  DATABASE_STATEMENT_TIMEOUT_MS: "5000ms",
  TASKNODE_REALTIME_MAX_STREAMS_PER_ACCOUNT: "four",
  TASKNODE_AGENT_HIVE_CHAT_RATE_LIMIT_MAX: "six",
  TASKNODE_HIVE_SECRETARY_PROVIDER_TIMEOUT_MS: "4m",
};
const routed = walk("server").filter((file) =>
  /from "(?:\.\.\/)*(?:\.\/)?env-number\.js"/.test(readFileSync(file, "utf8"))
);
assert.ok(routed.length >= 19, `expected the routed modules to import env-number.js, found ${routed.length}`);
for (const file of routed) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify("./" + file)}); process.exit(0);`],
    { env: { ...process.env, ...JUNK }, encoding: "utf8", timeout: 30000 }
  );
  assert.equal(result.status, 0, `${file} failed to load with junk numeric env values:\n${result.stderr}`);
}

console.log(`env-number smoke passed (${routed.length} routed modules load with junk values)`);

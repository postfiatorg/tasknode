// MIT License, Copyright (c) 2026 Post Fiat contributors.
// AI-assisted metadata regression. No wallet authentication, signing or service calls.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDate } from "node:util/types";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptRoot, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pins = {
  baseline: "d22abc6b83c05f34e4266125b3fa94f34f6f8460ea244564fc61285f78271dc7",
  fixed: "542c46be7a3fcc9852821ee4ca512500c5c84c0e8abc3c9e8ab22a14149a755c",
  fixtures: "61d03608b2311d877a963d3ab2dd1f49ca3ef706e46d9066ff9022c8433d87c0",
  oracle: "76cc8e13bc56c0fea6a6ac5a0a1ec8d8c9c6e8434c2d89e70eec1ebfceffd8e7",
};
const options = { stage: "fixed", source: "server/runtime-store-wallet.js" };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1];
  if (!["--stage", "--source", "--output"].includes(flag) || !value) throw new Error("invalid regression arguments");
  options[flag.slice(2)] = value;
}
if (!["baseline", "fixed"].includes(options.stage)) throw new Error("invalid stage");
if (process.versions.node !== "24.21.0") throw new Error("this pinned replay requires Node 24.21.0");
const startupKeys = Object.keys(process.env);
if (startupKeys.includes("__CF_USER_TEXT_ENCODING")) {
  if (process.platform !== "darwin" || !/^[0-9xA-Fa-f]+:[0-9xA-Fa-f]+:[0-9xA-Fa-f]+$/.test(process.env.__CF_USER_TEXT_ENCODING)) throw new Error("unexpected startup marker");
  delete process.env.__CF_USER_TEXT_ENCODING;
}
if (Object.keys(process.env).length) throw new Error("launch this closed replay with an empty environment");
const permittedSources = ["server/runtime-store-wallet.js", "preparation/runtime-wallet-before.txt"];
if (!permittedSources.includes(options.source)) throw new Error("source path outside selected files");
function readPinned(relative, pin) {
  const filename = path.join(root, relative);
  if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename) || fs.lstatSync(filename).isSymbolicLink() || !fs.lstatSync(filename).isFile()) throw new Error("pinned input is not an owned regular file");
  const bytes = fs.readFileSync(filename);
  if (sha256(bytes) !== pin) throw new Error(`input pin mismatch: ${relative}`);
  return bytes;
}
const sourceBytes = readPinned(options.source, pins[options.stage]);
const fixtures = JSON.parse(readPinned("scripts/fixtures/runtime-wallet-address-key.fixtures.json", pins.fixtures));
const oracle = JSON.parse(readPinned("scripts/fixtures/runtime-wallet-address-key.oracle.json", pins.oracle));
const preparation = path.join(root, "preparation");
if (!fs.existsSync(preparation)) fs.mkdirSync(preparation);
const output = path.resolve(root, options.output || `preparation/${options.stage}-observations.json`);
if (path.dirname(output) !== preparation || !/^[a-z0-9-]+-observations\.json$/.test(path.basename(output)) || fs.realpathSync(preparation) !== preparation || fs.existsSync(output)) throw new Error("output must be a new observations file inside the owned preparation directory");
if (fixtures.sequences.length !== 7 || oracle.case_count !== 7 || oracle.step_count !== 13) throw new Error("unexpected frozen fixture size");

function typed(value, seen = new Set()) {
  if (value === undefined) return { $undefined: true };
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("unexpected nonfinite capture");
    return value;
  }
  if (isDate(value)) return { $date: Date.prototype.toISOString.call(value) };
  if (typeof value !== "object" || seen.has(value)) throw new Error("non-data or cyclic capture");
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((entry) => typed(entry, seen));
  else {
    result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new Error("capture accessor forbidden");
      result[key] = typed(descriptor.value, seen);
    }
  }
  seen.delete(value);
  return result;
}
function differences(actual, expected, location = "$") {
  if (typeof actual !== typeof expected || actual === null || expected === null) return Object.is(actual, expected) ? [] : [{ location, actual, expected }];
  if (typeof actual !== "object") return Object.is(actual, expected) ? [] : [{ location, actual, expected }];
  if (Array.isArray(actual) !== Array.isArray(expected)) return [{ location, actual, expected }];
  const actualKeys = Object.keys(actual).sort(), expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return [{ location, actual_keys: actualKeys, expected_keys: expectedKeys }];
  return actualKeys.flatMap((key) => differences(actual[key], expected[key], `${location}.${key}`));
}

const report = {
  schema: "runtime-wallet-address-key-observations/v1", stage: options.stage,
  source_sha256: sha256(sourceBytes), fixtures_sha256: pins.fixtures,
  oracle_sha256: pins.oracle, runtime: process.version, cases: [],
  completed: false, boundary_failures: [],
};
let current = null, state = null;
function forbidden(method) {
  const violation = { method, step_id: current?.fixture.id || null };
  report.boundary_failures.push(violation);
  if (current) current.record.forbidden_effects.push(violation);
  throw new Error(`closed metadata boundary: ${method}`);
}
function check(condition, method) { if (!condition) forbidden(method); }
function effect(method, args, result, extras = {}) {
  check(current !== null, "callback outside selected step");
  current.record.effects.push({ stage: current.phase, method, args: typed(args), kwargs: {}, outcome: { return: typed(result) }, ...extras });
  return result;
}
const reject = (name) => (..._args) => forbidden(name);
const blocked = (name) => new Proxy(Object.create(null), { get: () => forbidden(name), set: () => forbidden(name) });
class FixtureDate extends Date {
  constructor(...args) {
    check(current !== null && args.length === 0, "parameterized or unselected Date");
    super(Date.parse(current.clock));
    current.record.date_construct_count += 1;
    effect("Date.construct", args, this);
  }
  toISOString(...args) {
    check(args.length === 0, "Date formatting arguments");
    return effect("Date.prototype.toISOString", args, Date.prototype.toISOString.call(this));
  }
  static now() { if (current) current.record.date_now_count += 1; return forbidden("Date.now"); }
  static parse() { return forbidden("Date.parse"); }
  static UTC() { return forbidden("Date.UTC"); }
}
const context = vm.createContext({
  Date: FixtureDate, process: blocked("process"), console: blocked("console"),
  fetch: reject("fetch"), WebSocket: reject("WebSocket"), require: reject("require"),
  setTimeout: reject("timer"), setInterval: reject("interval"), setImmediate: reject("immediate"),
  Buffer: blocked("Buffer"), global: blocked("global"),
}, { name: "public-runtime-wallet-metadata", codeGeneration: { strings: false, wasm: false } });
const cryptoModule = new vm.SyntheticModule(["randomUUID"], function () {
  this.setExport("randomUUID", (...args) => {
    check(current !== null && args.length === 0 && typeof current.fixture.uuid === "string" && current.record.uuid_count === 0, "undeclared UUID");
    current.record.uuid_count += 1;
    return effect("crypto.randomUUID", args, current.fixture.uuid);
  });
}, { context, identifier: "fixture-node:crypto" });
const subject = new vm.SourceTextModule(sourceBytes.toString("utf8"), {
  context, identifier: "server/runtime-store-wallet.js",
  importModuleDynamically: () => forbidden("dynamic import/database mirror"),
});
function materialize(value) {
  context.__fixtureJson = JSON.stringify(value);
  try { return vm.runInContext("JSON.parse(__fixtureJson)", context); }
  finally { delete context.__fixtureJson; }
}
const persist = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
try {
  await subject.link((request) => { check(request === "node:crypto", "unselected static import"); return cryptoModule; });
  await subject.evaluate();
  for (const sequence of fixtures.sequences) {
    state = materialize(fixtures.initial_state);
    const callbacks = {
      state,
      safeId(...args) {
        check(args.length === 2 && args[1] === "account" && typeof args[0] === "string" && Object.hasOwn(state.accounts, args[0]), "safeId arguments");
        return effect("safeId", args, args[0]);
      },
      stableId(...args) {
        check(args.length === 2 && args[1] === "sig" && args[0] === current.fixture.link_input.signature, "stableId arguments");
        return effect("stableId", args, "fixture-sig:" + args[0]);
      },
      saveState(...args) {
        check(args.length === 0, "saveState arguments");
        current.record.save_count += 1;
        return effect("saveState", args, undefined, { state_at_call: typed(state) });
      },
      walletLoginChallengeMaxActive: 0,
    };
    for (const name of fixtures.dependency_contract.unused_callbacks) callbacks[name] = reject(`unused callback ${name}`);
    current = null;
    const store = subject.namespace.createRuntimeWalletStore(callbacks);
    const captured = { id: sequence.id, steps: [] };
    report.cases.push(captured);
    for (const step of sequence.steps) {
      const record = { step_id: step.id, effects: [], date_construct_count: 0, date_now_count: 0, uuid_count: 0, save_count: 0, forbidden_effects: [] };
      captured.steps.push(record);
      current = { fixture: step, clock: fixtures.clocks[step.clock_ref], phase: "link", record };
      check(typeof current.clock === "string" && step.link_input.databaseMirror === false, "clock/mirror fixture");
      const link = materialize(step.link_input), getter = materialize(step.getter_input);
      record.link_return = typed(store.linkWalletToAccount(link));
      current.phase = "getter";
      record.getter_return = typed(store.getLinkedWallet(getter));
      record.state_after = typed(state);
      record.input_after = { link: typed(link), getter: typed(getter) };
      if (report.boundary_failures.length) throw new Error("persistent metadata boundary failure");
    }
  }
  report.completed = true;
  report.comparisons = { declared_stage: [], corrected_contract: [] };
  for (const captured of report.cases) {
    const expected = oracle.cases.find((entry) => entry.id === captured.id);
    check(Boolean(expected), "unknown oracle sequence");
    report.comparisons.declared_stage.push({ id: captured.id, differences: differences(captured.steps, expected.expected[options.stage]) });
    report.comparisons.corrected_contract.push({ id: captured.id, differences: differences(captured.steps, expected.expected.fixed) });
  }
  const declaredMatches = report.comparisons.declared_stage.every((entry) => !entry.differences.length);
  const correctedMatches = report.comparisons.corrected_contract.every((entry) => !entry.differences.length);
  report.summary = { cases: report.cases.length, steps: report.cases.reduce((n, entry) => n + entry.steps.length, 0), declared_matches: declaredMatches, corrected_matches: correctedMatches, forbidden_effects: report.boundary_failures.length };
  persist();
  console.log(JSON.stringify(report.summary));
  if (!declaredMatches) throw new Error("actual observations differ from frozen stage oracle");
  if (!correctedMatches) throw new Error("runtime metadata correction regression is RED");
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  persist();
  throw error;
}

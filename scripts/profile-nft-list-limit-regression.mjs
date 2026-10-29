// MIT License, Copyright (c) 2026 Post Fiat contributors.
// AI-assisted metadata binding regression; no actual database or NFT actions.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isNativeError } from "node:util/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pins = {
  baseline: "4f93481b354e5fb17ec42d1d6f7d1f39354a656097e0a109edeaea0109c5e03c",
  fixed: "a1d06e42dc4e7720cc407a5bbecd0be5ff33eb3a30b962a9d97aabaf211c07c7",
  helper: "ad5fbbd8c555521d04c417a8a1f9c76cdd0cbc3560595be52760dbb4be641bd0",
  art: "42f3fbdd003028c82eb4e33c516c99cedd6056459ace169c29049e276e9def6e",
  fixtures: "14b4a64b8c57c75b41ac882ba83a63e73d2950f3282253f15f36a0de66f9be56",
  oracle: "fb0be811504c32b22019ae43e2b99ea0da5ed07e9ce370f33f3fcf3b23db4262",
};
const options = { stage: "fixed", source: "server/repositories/profile-nfts.js" };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1];
  if (!["--stage", "--source", "--output"].includes(flag) || !value) throw new Error("invalid regression arguments");
  options[flag.slice(2)] = value;
}
if (!["baseline", "fixed"].includes(options.stage)) throw new Error("invalid stage");
if (process.versions.node !== "24.21.0") throw new Error("this pinned regression requires Node 24.21.0");
if (Object.hasOwn(process.env, "__CF_USER_TEXT_ENCODING")) {
  if (process.platform !== "darwin" || !/^[0-9xA-Fa-f]+:[0-9xA-Fa-f]+:[0-9xA-Fa-f]+$/.test(process.env.__CF_USER_TEXT_ENCODING)) throw new Error("unexpected startup marker");
  delete process.env.__CF_USER_TEXT_ENCODING;
}
if (Object.keys(process.env).length) throw new Error("launch with an empty environment");
if (!["server/repositories/profile-nfts.js", "preparation/profile-nfts-before.txt"].includes(options.source)) throw new Error("unselected source path");
function readPinned(relative, expected) {
  const filename = path.join(root, relative);
  if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename) || !fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error("pinned input must be an owned regular file");
  const bytes = fs.readFileSync(filename);
  if (hash(bytes) !== expected) throw new Error(`input pin mismatch: ${relative}`);
  return bytes;
}
const source = readPinned(options.source, pins[options.stage]);
const helperSource = readPinned("server/repositories/task-projection-integrity.js", pins.helper);
const artSource = readPinned("shared/profile-nft-art.js", pins.art);
const fixtures = JSON.parse(readPinned("scripts/fixtures/profile-nft-limit-fixtures.json", pins.fixtures));
const oracle = JSON.parse(readPinned("scripts/fixtures/profile-nft-limit-oracle.json", pins.oracle));
if (oracle.case_count !== 16 || oracle.cases.length !== 16) throw new Error("unexpected frozen case count");
const preparation = path.join(root, "preparation");
if (!fs.existsSync(preparation)) fs.mkdirSync(preparation);
const output = path.resolve(root, options.output || `preparation/${options.stage}-observations.json`);
if (path.dirname(output) !== preparation || !/^[a-z0-9-]+-observations\.json$/.test(path.basename(output)) || fs.realpathSync(preparation) !== preparation || fs.existsSync(output)) throw new Error("output must be a new owned observations file");

function fixtureRef(reference) {
  let value = fixtures;
  for (const part of reference.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Error(`unknown frozen fixture reference: ${reference}`);
    value = value[part];
  }
  return value;
}
function resolve(value) {
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "$fixture")) return resolve(fixtureRef(value.$fixture));
  if (Array.isArray(value)) return value.map(resolve);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
}
function typed(value, seen = new Set()) {
  if (value === undefined) return { $undefined: true };
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { $number: String(value) };
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("non-data or cyclic observation");
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((entry) => typed(entry, seen));
  else {
    result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, "value")) throw new Error("observation accessor forbidden");
      result[key] = typed(descriptor.value, seen);
    }
  }
  seen.delete(value);
  return result;
}
function errorProjection(error) {
  if (!isNativeError(error)) throw new Error("non-native error escaped selected call");
  const own_properties = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(error))) {
    if (key === "stack") continue;
    if (!Object.hasOwn(descriptor, "value")) throw new Error("error accessor forbidden");
    own_properties[key] = isNativeError(descriptor.value) ? errorProjection(descriptor.value) : typed(descriptor.value);
  }
  return { name: error.name, message: error.message, constructor_name: error.constructor.name, own_properties };
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
  schema: "profile-nft-limit-observations/v1", stage: options.stage,
  source_sha256: hash(source), helper_sha256: hash(helperSource), art_sha256: hash(artSource),
  fixtures_sha256: pins.fixtures, oracle_sha256: pins.oracle, runtime: process.version,
  cases: [], completed: false, boundary_failures: [],
};
let current = null;
function forbidden(method) {
  const violation = { method, id: current?.id || null };
  report.boundary_failures.push(violation);
  if (current) current.forbidden_effects.push(violation);
  throw new Error(`closed metadata boundary: ${method}`);
}
const deny = (name) => (..._args) => forbidden(name);
const blocked = (name) => new Proxy(Object.create(null), { get: () => forbidden(name), set: () => forbidden(name) });
const ForbiddenDate = new Proxy(function () {}, { apply: () => forbidden("Date"), construct: () => forbidden("Date"), get: () => forbidden("Date") });
const persist = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
function expectedRecord(test, stage) {
  return resolve({
    id: test.id, input_before: test.input_before, input_after: test.input_after,
    response_before: test.response_before, response_after: test.response_after,
    error_before: test.error_before, error_after: test.error_after,
    calls: test[stage].calls, observed: test[stage].observed,
    forbidden_effects: test[stage].forbidden_effects,
  });
}
try {
  for (const test of oracle.cases) {
    current = { id: test.id, calls: [], forbidden_effects: [] };
    report.cases.push(current);
    const context = vm.createContext({
      process: blocked("process"), console: blocked("console"), Date: ForbiddenDate,
      fetch: deny("fetch"), WebSocket: deny("WebSocket"), require: deny("require"),
      setTimeout: deny("timer"), setInterval: deny("interval"), setImmediate: deny("immediate"),
      clearTimeout: deny("clearTimeout"), clearInterval: deny("clearInterval"), clearImmediate: deny("clearImmediate"),
      Buffer: blocked("Buffer"), global: blocked("global"),
    }, { name: "profile-metadata-read", codeGeneration: { strings: false, wasm: false } });
    function materialize(value) {
      context.__fixtureJson = JSON.stringify(value);
      try { return vm.runInContext("JSON.parse(__fixtureJson)", context); }
      finally { delete context.__fixtureJson; }
    }
    const input = materialize(fixtureRef(test.input_ref));
    const response = test.query_response_ref ? materialize(fixtureRef(test.query_response_ref)) : null;
    let queryError = null;
    if (test.query_error_ref) {
      const definition = fixtureRef(test.query_error_ref);
      const causeDefinition = definition.own_properties.cause;
      const cause = new Error(causeDefinition.message);
      for (const [key, value] of Object.entries(causeDefinition.own_properties)) if (key !== "message") cause[key] = resolve(value);
      queryError = new Error(definition.message, { cause });
      for (const [key, value] of Object.entries(definition.own_properties)) if (!["message", "cause"].includes(key)) queryError[key] = resolve(value);
    }
    current.input_before = typed(input);
    current.response_before = typed(response);
    current.error_before = queryError ? errorProjection(queryError) : null;
    const cryptoModule = new vm.SyntheticModule(["randomUUID"], function () {
      this.setExport("randomUUID", deny("randomUUID"));
    }, { context, identifier: "fixture-node:crypto" });
    const poolModule = new vm.SyntheticModule(["databaseEnabled", "query", "transaction"], function () {
      this.setExport("databaseEnabled", (...args) => {
        if (args.length !== 0) forbidden("databaseEnabled arguments");
        current.calls.push({ method: "databaseEnabled", args: [], outcome: { return: test.database_enabled } });
        return test.database_enabled;
      });
      this.setExport("query", async (...args) => {
        if (args.length !== 2 || !Object.values(fixtures.sql).includes(args[0]) || !Array.isArray(args[1]) || ![2, 4].includes(args[1].length)) forbidden("unselected SQL/query signature");
        const call = { method: "query", args: typed(args) };
        current.calls.push(call);
        if (queryError) {
          call.outcome = { throw: errorProjection(queryError) };
          throw queryError;
        }
        if (response === null) forbidden("undeclared query response");
        call.outcome = { return: typed(response) };
        return response;
      });
      this.setExport("transaction", deny("transaction"));
    }, { context, identifier: "fixture-db-pool" });
    const helper = new vm.SourceTextModule(helperSource.toString("utf8"), { context, identifier: "server/repositories/task-projection-integrity.js", importModuleDynamically: () => forbidden("dynamic import") });
    const art = new vm.SourceTextModule(artSource.toString("utf8"), { context, identifier: "shared/profile-nft-art.js", importModuleDynamically: () => forbidden("dynamic import") });
    const subject = new vm.SourceTextModule(source.toString("utf8"), { context, identifier: "server/repositories/profile-nfts.js", importModuleDynamically: () => forbidden("dynamic import") });
    await subject.link((request, from) => {
      if (from !== subject) forbidden("pure helper unexpected import");
      if (request === "node:crypto") return cryptoModule;
      if (request === "../db/pool.js") return poolModule;
      if (request === "./task-projection-integrity.js") return helper;
      if (request === "../../shared/profile-nft-art.js") return art;
      return forbidden("unselected static import");
    });
    await subject.evaluate({ timeout: 1000 });
    try {
      const value = await subject.namespace.listProfileNfts(input);
      current.observed = { kind: "return", value: typed(value) };
    } catch (error) {
      current.observed = { kind: "error", error: errorProjection(error), same_error_object: error === queryError, same_cause_object: Boolean(queryError) && error.cause === queryError.cause };
    }
    current.input_after = typed(input);
    current.response_after = typed(response);
    current.error_after = queryError ? errorProjection(queryError) : null;
    if (report.boundary_failures.length) throw new Error("persistent metadata boundary failure");
  }
  report.completed = true;
  report.comparisons = { declared_stage: [], corrected_contract: [] };
  for (const record of report.cases) {
    const test = oracle.cases.find((entry) => entry.id === record.id);
    report.comparisons.declared_stage.push({ id: record.id, differences: differences(record, expectedRecord(test, options.stage)) });
    report.comparisons.corrected_contract.push({ id: record.id, differences: differences(record, expectedRecord(test, "fixed")) });
  }
  const nonintegerBindings = report.cases.filter((entry) => entry.calls.some((call) => call.method === "query" && !Number.isInteger(call.args[1][1]))).map((entry) => entry.id);
  const declaredMatches = report.comparisons.declared_stage.every((entry) => entry.differences.length === 0);
  const correctedMatches = report.comparisons.corrected_contract.every((entry) => entry.differences.length === 0);
  report.summary = { cases: report.cases.length, declared_matches: declaredMatches, corrected_matches: correctedMatches, noninteger_bindings: nonintegerBindings, forbidden_effects: report.boundary_failures.length };
  persist();
  console.log(JSON.stringify(report.summary));
  if (!declaredMatches) throw new Error("actual observations differ from frozen stage oracle");
  if (!correctedMatches || nonintegerBindings.length) throw new Error("profile metadata integer-parameter regression is RED");
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  persist();
  throw error;
}

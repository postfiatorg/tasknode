#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeGraph } from "./build-runtime-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runtimePackage(role) {
  return JSON.parse(readFileSync(path.join(root, `runtime/${role}/package.json`), "utf8"));
}

function assertRole(role, entries) {
  const graph = runtimeGraph(entries);
  assert.deepEqual(graph.missing, [], `${role} runtime has unresolved local imports`);
  const declared = Object.keys(runtimePackage(role).dependencies || {}).sort();
  assert.deepEqual(declared, graph.packages, `${role} runtime dependency manifest drifted from its source closure`);
  return graph;
}

const web = assertRole("web", ["server/index.js"]);
const worker = assertRole("worker", ["server/worker-entry.js", "scripts/hive-board-secretary-worker.mjs"]);

assert.ok(!web.files.includes("server/background-workers.js"), "web runtime must not import worker orchestration");
assert.ok(worker.files.includes("server/background-workers.js"), "worker runtime must own worker orchestration");
assert.ok(!worker.files.includes("server/index.js"), "worker runtime must not import the HTTP server");
assert.ok(!worker.packages.includes("sharp"), "worker dependency graph must not include the web image proxy");
assert.ok(!worker.packages.includes("pdfjs-dist"), "worker dependency graph must not include web evidence extraction");
assert.ok(web.files.length !== worker.files.length, "runtime source graphs must be independently derived");

console.log(
  `runtime role boundary ok: web ${web.files.length} files/${web.packages.length} packages; ` +
  `worker ${worker.files.length} files/${worker.packages.length} packages`
);

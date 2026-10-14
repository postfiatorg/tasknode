import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--worker") {
  const require = createRequire(import.meta.url);
  const { SourceMapConsumer, SourceMapGenerator } = require("source-map-js");
  const version = require("source-map-js/package.json").version;
  const fixture = JSON.parse(process.argv[3]);
  const flat = { version: 3, sources: ["fixture.js"], names: [], mappings: "AAAA", sourcesContent: ["const fixture = 1;\n"] };
  const indexed = (line, column, map) => ({ version: 3, sections: [{ offset: { line, column }, map }] });
  let line = fixture.line;
  if (fixture.specialLine === "Infinity") line = Infinity;
  if (fixture.specialLine === "NaN") line = NaN;
  const inner = fixture.nestedLine === undefined ? flat : indexed(fixture.nestedLine, 0, flat);
  const map = fixture.kind === "flat" ? flat : indexed(line, fixture.column, inner);
  let result;
  try {
    const consumer = new SourceMapConsumer(map);
    result = { observed: "accept", version };
    // Large offsets are constructor validation only: never materialize or
    // flatten mappings, generate a flat map or perform SourceNode conversion.
    if (fixture.kind === "flat") {
      result.original = consumer.originalPositionFor({ line: 1, column: 0 });
      result.roundTrip = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(consumer).toJSON())
        .originalPositionFor({ line: 1, column: 0 });
      assert.equal(result.original.source, "fixture.js");
      assert.deepEqual(result.roundTrip, result.original);
    }
  } catch (error) {
    result = { observed: "reject", version, errorType: error.name };
  }
  console.log(JSON.stringify(result));
} else {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/source-map-section-offsets.json", import.meta.url)));
  const reports = [];
  for (const fixture of fixtures) {
    const child = spawnSync(process.execPath,
      ["--max-old-space-size=128", fileURLToPath(import.meta.url), "--worker", JSON.stringify(fixture)],
      { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 1500, maxBuffer: 16384 });
    let actual = { observed: "worker_failed" };
    if (child.status === 0) {
      try { actual = JSON.parse(child.stdout); } catch { /* classify malformed child output */ }
    }
    const report = { case: fixture.id, expected: fixture.expect, ...actual,
      pass: child.status === 0 && actual.observed === fixture.expect };
    console.log(JSON.stringify(report));
    reports.push(report);
  }
  const failed = reports.filter((report) => !report.pass).map((report) => report.case);
  console.log(JSON.stringify({ cases: reports.length, passed: reports.length - failed.length, failed,
    childMemoryLimitMiB: 128, childTimeoutMs: 1500, largeOffsetConstructionOnly: true }));
  assert.equal(failed.length, 0, "indexed source maps must reject unsafe offsets before materializing mappings");
}

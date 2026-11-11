import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const run = promisify(execFile);
const databaseUrl = process.env.TASKNODE_BUNDLE_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.startsWith("/tasknode_bundle_test")) throw new Error("isolated_bundle_test_database_required");

test("real publisher stores on-demand encrypted files atomically and preserves the preceding version", { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.TASKNODE_DATABASE_ENABLED = "true";
  const { closePool, query } = await import("../server/db/pool.js");
  const { getIndex } = await import("../server/repositories/index-viewer.js");
  const { createBundleFileLoader, fetchBundleFile } = await import("../server/validator-bundle-files.js");
  const { decryptValidatorBundle } = await import("../server/validator-bundles.js");
  const db = new pg.Client({ connectionString: databaseUrl });
  const temporary = await mkdtemp(path.join(tmpdir(), "bundle-files-test-"));
  const indexId = "bundle-file-test";
  try {
    await db.connect();
    for (const file of ["149_index_viewer.sql", "153_validator_bundles.sql", "159_validator_bundle_files.sql"]) {
      await db.query(await readFile(new URL(`../server/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    await mkdir(path.join(temporary, "models/AAPL"), { recursive: true });
    await writeFile(path.join(temporary, "index.html"), "<h1>Finance Hub fixture</h1>");
    await writeFile(path.join(temporary, "models/AAPL/outputs.json"), '{"revenue":123,"target":456}');
    const publish = async (directory = temporary) => JSON.parse((await run(process.execPath,
      ["scripts/publish-validator-bundle.mjs", "--directory", directory, "--id", indexId, "--publish"],
      { env: process.env, maxBuffer: 1024 * 1024 })).stdout);
    const first = await publish(), ix1 = await getIndex(indexId);
    assert.equal(first.fileCount, 2);
    let bytesRead = 0, pathsRead = [];
    const loader = createBundleFileLoader({ fetchFile: async (id, ix, name) => {
      const row = await fetchBundleFile(query, id, ix, name);
      bytesRead += row?.encryptedBytes.length || 0; pathsRead.push(name);
      return row;
    } });
    assert.equal((await loader.load(indexId, ix1, "index.html")).toString(), "<h1>Finance Hub fixture</h1>");
    assert.deepEqual(pathsRead, ["index.html"]);
    assert.ok(bytesRead < 150);
    const raw = (await query("SELECT encrypted_bytes FROM index_viewer_bundles WHERE index_id=$1", [indexId])).rows[0].encrypted_bytes;
    assert.equal(decryptValidatorBundle(raw, ix1.contentKey, ix1.contentHash)["index.html"], Buffer.from("<h1>Finance Hub fixture</h1>").toString("base64"));

    await writeFile(path.join(temporary, "index.html"), "<h1>Next version</h1>");
    const second = await publish(), ix2 = await getIndex(indexId);
    assert.notEqual(first.contentHash, second.contentHash);
    assert.equal((await loader.load(indexId, ix2, "index.html")).toString(), "<h1>Next version</h1>");
    assert.ok(await fetchBundleFile(query, indexId, ix1, "index.html"));

    // Inject a file-write failure after the catalog/archive writes. All changes
    // must roll back, preserving the readable previous publication.
    await db.query("ALTER TABLE index_viewer_bundle_files ADD CONSTRAINT fixture_reject_publication CHECK (file_path <> 'index.html') NOT VALID");
    await assert.rejects(publish());
    assert.equal((await getIndex(indexId)).contentHash, ix2.contentHash);
    assert.equal((await query("SELECT count(DISTINCT bundle_hash)::int n FROM index_viewer_bundle_files")).rows[0].n, 2);
    await db.query("ALTER TABLE index_viewer_bundle_files DROP CONSTRAINT fixture_reject_publication");
    await publish();
    assert.equal(await fetchBundleFile(query, indexId, ix1, "index.html"), null);
    assert.ok(await fetchBundleFile(query, indexId, ix2, "index.html"));

    if (process.env.FINANCE_HUB_EXPORT) {
      const directory = path.resolve(process.env.FINANCE_HUB_EXPORT);
      const publication = await publish(directory), ix = await getIndex(indexId);
      const inventory = JSON.parse(await readFile(path.join(directory, "models.json"), "utf8"));
      bytesRead = 0; pathsRead = [];
      const start = performance.now();
      const initial = ["index.html", "app.js", "style.css", "models.json",
        ...["movers", "calendar", "brief", "freshness", "coverage", "goodbrief", "updates", "changes"].map((n) => `hub/${n}.json`)];
      await Promise.all(initial.map(async (name) => {
        assert.deepEqual(await loader.load(indexId, ix, name), await readFile(path.join(directory, name)));
      }));
      const homeMs = performance.now() - start, homeBytes = bytesRead;
      assert.ok(!pathsRead.some((name) => name.startsWith("models/")));
      assert.ok(homeBytes < publication.encryptedBytes / 10);
      for (const { dir } of inventory) {
        const name = `models/${dir}/outputs.json`;
        assert.deepEqual(await loader.load(indexId, ix, name), await readFile(path.join(directory, name)));
      }
      const report = { publication, modelsMatched: inventory.length, homeFiles: initial.length,
        homeEncryptedBytesRead: homeBytes, homeMs, archiveEncryptedBytes: publication.encryptedBytes,
        homeReadReductionPercent: 100 * (1 - homeBytes / publication.encryptedBytes) };
      if (process.env.FINANCE_HUB_EVIDENCE) await writeFile(process.env.FINANCE_HUB_EVIDENCE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
    }
  } finally {
    await db.end();
    await closePool();
    await rm(temporary, { recursive: true, force: true });
  }
});

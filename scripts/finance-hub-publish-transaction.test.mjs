// Review 447-01: a signed publication becomes visible in one commit. The real
// Postgres publish store, pool wrapper and index repository run against an
// in-process pg double; no database is contacted.
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

const committed = []; // one entry per commit: the statements that became visible together
let failOn = "";
function fakeClient() {
  const pending = [];
  return {
    on() {}, off() {}, removeListener() {}, release() {},
    async query(text) {
      const sql = typeof text === "string" ? text : text.text;
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      if (sql === "COMMIT") { committed.push(pending.splice(0)); return { rows: [], rowCount: 0 }; }
      if (sql === "ROLLBACK") { pending.splice(0); return { rows: [], rowCount: 0 }; }
      if (failOn && sql.includes(failOn)) throw new Error("simulated storage failure");
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) pending.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("current_version")) return { rows: [{ current_version: 0 }], rowCount: 1 };
      if (sql.includes("RETURNING *")) return { rows: [{ index_id: "goodbrief", metadata_json: {} }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}
pg.Pool.prototype.connect = async function connect() { return fakeClient(); };
pg.Pool.prototype.query = async function query(text) {
  const sql = typeof text === "string" ? text : text.text;
  if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) committed.push([sql.trim().split(/\s+/).slice(0, 3).join(" ")]);
  return { rows: [{ index_id: "goodbrief", metadata_json: {} }], rowCount: 1 };
};
process.env.DATABASE_URL = "postgres://not-contacted.invalid/none";
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { createPostgresPublishStore } = await import("../server/finance-hub-publish.js");

const publish = () => createPostgresPublishStore().withIndexLock("goodbrief", (tx) => tx.commitPublish({
  payload: {
    index_id: "goodbrief", version: 1, operation: "publish", nonce: "n1", issued_at: "2026-11-27T10:00:00Z",
    title: "Review", tier: "finance_hub", allowed_bases: ["validator"], files: [{}], total_bytes: 4,
    signature: { key_id: "review", algorithm: "hmac-sha256" },
  },
  manifestSha256: "a".repeat(64),
  decodedFiles: [{ path: "index.html", bytes: Buffer.from("test") }],
}));

test("a failed file insert leaves nothing published, not even the index pointer", async () => {
  committed.length = 0;
  failOn = "INSERT INTO index_viewer_bundle_files";
  await assert.rejects(publish(), /simulated storage failure/);
  assert.deepEqual(committed, []);
});

test("a successful publication commits the pointer, files, nonce and version together", async () => {
  committed.length = 0;
  failOn = "";
  await publish();
  assert.deepEqual(committed, [[
    "INSERT INTO index_viewer_indices",
    "INSERT INTO index_viewer_bundle_files",
    "INSERT INTO finance_hub_publish_nonces",
    "INSERT INTO finance_hub_publish_manifests",
    "DELETE FROM finance_hub_publish_nonces",
  ]]);
});

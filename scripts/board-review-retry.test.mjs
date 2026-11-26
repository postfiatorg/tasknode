import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { transientDatabaseError } from "../server/db/transient-errors.js";

test("only known transient database failures qualify for retry", () => {
  assert.equal(transientDatabaseError(new Error("Query read timeout")), true);
  assert.equal(transientDatabaseError({ code: "40001" }), true);
  assert.equal(transientDatabaseError({ code: "23505" }), false);
  assert.equal(transientDatabaseError({ status: 409 }), false);
});

test("PostgreSQL: review timeout rolls back; lost COMMIT acknowledgement replays one receipt", {
  skip: !process.env.TASKNODE_DIAG_TEST_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.TASKNODE_DIAG_TEST_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.ok(url.pathname.endsWith("_test"));
  const schema = `review_retry_${process.pid}`;
  const admin = new pg.Client({ connectionString: url.href }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href; process.env.TASKNODE_DATABASE_ENABLED = "true";
  const { query, getPool, closePool } = await import("../server/db/pool.js");
  const { executeBoardAgentCommand } = await import("../server/board-agent-routes.js");
  const token = "fixture-token-not-a-production-credential";
  let loseCommit = false, disposed = 0;
  try {
    await query(await readFile(new URL("../server/db/migrations/135_board_agent_commands.sql", import.meta.url), "utf8"));
    await query("CREATE TABLE fixture_effects (id text)");
    await query(`INSERT INTO board_agent_credentials(id,token_hash,actor,board_ids,expires_at)
      VALUES ('fixture',$1,'fixture','[]',now()+interval '1 hour')`, [createHash("sha256").update(token).digest("hex")]);
    const pool = getPool(), connect = pool.connect.bind(pool);
    t.mock.method(pool, "connect", (...args) => args.length ? connect(...args) : connect().then(client => {
      const originalQuery = client.query.bind(client), originalRelease = client.release.bind(client);
      client.query = (sql, ...rest) => {
        const result = originalQuery(sql, ...rest);
        if ((typeof sql === "string" ? sql : sql.text) === "COMMIT" && loseCommit) {
          loseCommit = false;
          return result.then(() => { throw new Error("Query read timeout"); });
        }
        return result;
      };
      client.release = error => {
        if (error) disposed++;
        client.query = originalQuery; client.release = originalRelease;
        return originalRelease(error);
      };
      return client;
    }));
    const invoke = (key, dispatch, command = "review") => executeBoardAgentCommand({ token,
      payload: { requestKey: key, argv: [command, "fixture-task"] } }, { dispatch });
    let calls = 0;
    const first = await invoke("rollback", async () => {
      calls++; await query("INSERT INTO fixture_effects VALUES ('rollback')");
      if (calls === 1) throw new Error("Query read timeout");
      return { accepted: true };
    });
    assert.equal(calls, 2); assert.equal(first.replayed, false);
    assert.equal((await query("SELECT count(*)::int n FROM fixture_effects WHERE id='rollback'")).rows[0].n, 1);
    loseCommit = true; calls = 0;
    const lost = await invoke("commit-lost", async () => {
      calls++; await query("INSERT INTO fixture_effects VALUES ('commit-lost')"); return { accepted: true };
    });
    assert.equal(calls, 1); assert.equal(lost.replayed, true);
    assert.equal((await query("SELECT count(*)::int n FROM fixture_effects WHERE id='commit-lost'")).rows[0].n, 1);
    calls = 0;
    await assert.rejects(invoke("persistent", async () => { calls++; throw new Error("Query read timeout"); }), /Query read timeout/);
    assert.equal(calls, 2, "one retry maximum");
    calls = 0;
    await assert.rejects(invoke("other-mutation", async () => { calls++; throw new Error("Query read timeout"); }, "journal"), /Query read timeout/);
    assert.equal(calls, 1, "other mutations may have external side effects");
    assert.ok(disposed >= 4, "timed-out clients are destroyed");
    assert.equal((await query("SELECT count(*)::int n FROM board_agent_commands")).rows[0].n, 2);
  } finally {
    await closePool(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

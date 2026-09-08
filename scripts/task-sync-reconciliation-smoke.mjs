import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, closePool, databaseEnabled } from "../server/db/pool.js";
import { taskReadIntegrityByTaskId, taskRequestHandoffState } from "../server/repositories/tasks.js";
const account = `sync_fixture_${randomUUID()}`;
assert.ok(databaseEnabled(), "Use an isolated PostgreSQL fixture database");
const cases = ["applied", "different_cid", "missing_event", "different_owner", "different_wallet", "different_projection", "empty_projection", "later_recorded_head", "earlier_recorded_head"];
try {
  for (const name of cases) {
    const id = `${account}_${name}`;
    await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,status,last_event_tx_hash,last_event_cid,event_count,source)
      VALUES ($1,$2,'rFixture','rewarded',$3,'cid_fixture',$4,'direct_write')`, [id, name === "different_owner" ? `${account}_other` : account, name === "different_projection" ? "tx_newer" : "tx_fixture", name === "empty_projection" ? 0 : 1]);
    if (name !== "missing_event") await query(`INSERT INTO task_events(id,task_id,account_id,wallet_address,event_type,source_tx_hash,source_cid)
      VALUES ($1,$1,$2,'rFixture','pf.reward.v1','tx_fixture','cid_fixture')`, [id, account]);
    await query(`INSERT INTO pftl_cache_reducer_events(dedupe_key,wallet_address,account_id,tx_hash,cid,task_id,reducer_kind,pointer_kind,status,last_error)
      VALUES ($1,$2,$3,'tx_fixture',$4,$1,'task_projection_replay','REWARD','failed','context_ipfs_fetch_failed')`, [id, name === "different_wallet" ? "rOther" : "rFixture", account, name === "different_cid" ? "cid_other" : "cid_fixture"]);
  }
  for (const name of ["later_recorded_head","earlier_recorded_head"]) {
    const id = `${account}_${name}`;
    await query("UPDATE task_events SET occurred_at='2026-06-02T00:00:00Z' WHERE id=$1",[id]);
    await query(`INSERT INTO task_events(id,task_id,account_id,wallet_address,event_type,source_tx_hash,source_cid,occurred_at)
      VALUES ($1,$2,$3,'rFixture','pf.reward.v1','tx_head','cid_head',$4)`,
      [id+"_head",id,account,name==="later_recorded_head"?"2026-06-03T00:00:00Z":"2026-06-01T00:00:00Z"]);
    await query("UPDATE task_projections SET last_event_tx_hash='tx_head',last_event_cid='cid_head',event_count=2 WHERE task_id=$1",[id]);
  }
  const state = await taskReadIntegrityByTaskId({ taskIds: cases.map(name => `${account}_${name}`), accountId: account, walletAddress: "rFixture" });
  for (const name of cases) assert.equal(state.byTaskId.get(`${account}_${name}`).failedReducerCount, ["applied","later_recorded_head"].includes(name) ? 0 : 1, name);
  assert.equal(state.totals.failedReducerCount, 7);
  assert.equal(Number((await query("SELECT count(*) AS n FROM pftl_cache_reducer_events WHERE account_id=$1 AND status='failed'", [account])).rows[0].n), 9, "historical errors remain available for audit");
  const handoff = taskRequestHandoffState({ requests: { items: [
    { requestId: "old_failure", status: "failed", updatedAt: "2026-01-01T00:00:00Z" },
    { requestId: "current", status: "proposed", updatedAt: "2026-09-06T00:00:00Z", generatedTaskId: "task_current" },
  ] }, taskItems: [{ taskId: "task_current" }] });
  assert.equal(handoff.latestRequestId, "current");
  assert.equal(handoff.generatedTaskVisible, true);
  console.log(JSON.stringify({ ok: true, appliedFailureIgnored: true, laterAppliedFailureIgnored: true, unmatchedFailuresPreserved: 7, auditRowsPreserved: 9, chronologicalHandoff: true }));
} finally {
  await query("DELETE FROM pftl_cache_reducer_events WHERE account_id=$1", [account]);
  await query("DELETE FROM task_events WHERE account_id=$1", [account]);
  await query("DELETE FROM task_projections WHERE account_id=ANY($1::text[])", [[account, `${account}_other`]]);
  await closePool();
}

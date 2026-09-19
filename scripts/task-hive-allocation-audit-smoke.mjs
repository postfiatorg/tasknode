import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deliveryDecision, mergeRoundProgress } from "../ops/bm-runtime/supervisor.mjs";
import { idleEligibleContributors } from "./bm/lib.mjs";
import { routingDuty } from "../server/board-task-policy.js";
import { query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  claimTaskGenerationRequests,
  reclaimStaleTaskGenerationRequests,
  retryOwnedTaskRequest,
} from "../server/repositories/task-requests.js";

const url = new URL(process.env.DATABASE_URL);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Fixture must use local Postgres");
assert.equal(url.pathname, "/tasknode_hive_audit_20260919", "Fixture must use its dedicated disposable database");
const prefix = "hive_audit_" + randomUUID();
const ids = Array.from({ length: 13 }, (_, index) => prefix + "_" + String(index + 1).padStart(2, "0"));
const requestId = prefix + "_exhausted";
const day = 86400000;
const base = Date.parse("2026-09-10T21:38:20.272Z");
const round = { id: "fixture_pending_round", state: "pending", results_json: {} };
const pending = { id: round.id, attempts: 3, alerted: true, progress: "{}", lastDeliveredAt: new Date(base).toISOString() };
const results = [];

for (const days of [1, 9, 30]) {
  const now = base + days * day;
  const status = { version: 1, pid: 123, threadId: "fixture-restarted-thread", ready: true, updatedAt: new Date(now).toISOString() };
  assert.equal(deliveryDecision({ round, pending: mergeRoundProgress(pending, round), status, now }), "alert_pending");
}
const now = base + 9 * day;
const status = { version: 1, pid: 123, threadId: "fixture-thread", ready: true, updatedAt: new Date(now).toISOString() };
const progress = mergeRoundProgress(pending, { ...round, results_json: { duty: { outcome: "blocked", reason: "A real durable outcome exists." } } });
assert.equal(deliveryDecision({ round, pending: progress, status, now }), "deliver");
results.push({ case: "supervisor_exhaustion", reproduced: true, horizonsDays: [1, 9, 30], afterRealDurableProgress: "deliver", restartedReadyTerminalAlone: "alert_pending" });

try {
  await migrateDatabase();
  for (const [index, id] of ids.entries()) {
    const handle = "audit-fixture-" + String(index + 1).padStart(2, "0") + "-" + prefix.slice(-6);
    await query("INSERT INTO app_accounts(account_id,account_json,hive_handle) VALUES($1,$2::jsonb,$3)", [id, JSON.stringify({ id, hiveHandle: handle, status: "active" }), handle]);
    await query("INSERT INTO account_linked_wallets(account_id,wallet_address,status) VALUES($1,$2,'linked')", [id, "rAuditFixture" + index]);
    await query("INSERT INTO account_network_badges(id,account_id,badge_id,status,selected_default) VALUES($1,$1,'kol','verified',true)", [id]);
    if (index < 12) await query("INSERT INTO task_projections(task_id,account_id,subject_wallet,status,task_kind) VALUES($1,$1,$2,'rewarded','personal')", [id, "rAuditFixture" + index]);
  }
  const first = await idleEligibleContributors();
  const second = await idleEligibleContributors();
  assert.equal(first.filter(member => ids.includes(member.account_id)).length, 12);
  assert.deepEqual(first.map(member => member.account_id), second.map(member => member.account_id));
  assert.equal(first.some(member => member.account_id === ids[12]), false);
  const excludedHandle = "audit-fixture-13-" + prefix.slice(-6);
  const board = { id: "fixture_restricted_board", routing_constraints: { assignable_handles: [excludedHandle] } };
  assert.equal(routingDuty(board, first, 0), null);
  assert.ok(routingDuty(board, [{ account_id: ids[12], public_handle: excludedHandle, badges: ["kol"], delivery_wallet: "rAuditFixture12", free_slots: 1, engine_verdict: "eligible" }], 0));
  results.push({ case: "candidate_starvation", reproduced: true, eligible: 13, surfaced: 12, stableAcrossRepeatedRounds: true, omittedAllowedContributorSuppressesRestrictedBoardDuty: true });

  await query("INSERT INTO task_requests(request_id,account_id,subject_wallet,source,status,request_bundle_cid,worker_attempt_count,worker_retry_after,created_at,updated_at) VALUES($1,$2,'rAuditFixture12','pfterminal','queued',$3,3,now()-interval '11 days',now()-interval '11 days',now()-interval '11 days')", [requestId, ids[12], "postgres:" + requestId]);
  const claimed = await claimTaskGenerationRequests({ workerId: prefix, limit: 10, maxAttempts: 3 });
  assert.equal(claimed.some(item => (item.requestId || item.request_id) === requestId), false);
  await reclaimStaleTaskGenerationRequests({ maxAttempts: 3, staleSeconds: 5 });
  const retried = await retryOwnedTaskRequest({ accountId: ids[12], requestId, expectedAttemptCount: 3 });
  assert.equal(retried.status, "queued");
  const stuck = (await query("SELECT status,worker_attempt_count,metadata_json FROM task_requests WHERE request_id=$1", [requestId])).rows[0];
  assert.equal(stuck.status, "queued");
  assert.equal(stuck.worker_attempt_count, 3);
  assert.equal(stuck.metadata_json.manualRetryAttemptBase, undefined);
  results.push({ case: "queued_exhausted_request", reproduced: true, claimed: false, staleReclaimerRepairs: false, ownerRetryRepairs: false, status: "queued", attempts: 3 });

  console.log(JSON.stringify({ ok: true, expectedFailureModesReproduced: results, productionMutations: 0 }, null, 2));
} finally {
  await query("DELETE FROM task_requests WHERE request_id=$1", [requestId]);
  await query("DELETE FROM task_projections WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM account_network_badges WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM account_linked_wallets WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM app_accounts WHERE account_id=ANY($1::text[])", [ids]);
  await closePool();
}

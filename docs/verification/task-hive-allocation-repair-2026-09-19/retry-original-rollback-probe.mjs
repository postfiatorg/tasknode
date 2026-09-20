// Reproduce the manager's exact selected command inside an unconditional rollback.
// Never prints credentials, query parameters, source packets or private evidence.
import pg from "/app/node_modules/pg/lib/index.js";
import { query, transactionCommand, closePool } from "/app/server/db/pool.js";
import { withBoardAgent } from "/app/server/board-agent-context.js";
import { dispatchBoardAgent } from "/app/server/board-agent-dispatch.js";
const argv = ["task","create","board_tasknode_fixes","--account","acct_oauth_3c70e69ab7b8ef1fad3df508","--wallet","rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx","--assignee-handle","goodalexander","--work-type","code_task","--required-badge","core_contributor","--reward-min","100","--reward-max","400","--retry-failed","--execute","--need","SECURITY (HIGH): reward-forgery surface in offchain task lifecycle at pinned commit 40d2df7. In production offchain mode, a task owner can POST /api/tasks/action {phase:submit, taskAction:accept} with an attacker-chosen offchainPayload whose schema becomes the persisted task_events.event_type - including pf.reward.v1 with a fabricated economic_reward_pft, forged source_tx_hash/source_cid, client-chosen task_events PRIMARY KEY, and a foreign payload.task_id. Root: server/offchain-task-lifecycle.js eventSchemaForTransition (:65-72) returns providedPayload.schema for any transition not in its fixed list (accepted/refused/cancelled are absent); event_id (:273), payload.task_id (:279), txRefForEvent/cidRefForEvent (:79,:93) all prefer client values. Consumers key on event_type with no write_source filter (daily-airdrop profile-daily-airdrop.js:330,427; network routing network-task-eligibility.js:88; reward idempotency task-review-publication.js:233,310). A public repro with a failing node --test and a minimal one-file guard exists in gist citadelculture/59ba3685c4ac125fd240e01b8fcee60a (guard.patch: for stop transitions derive event solely from transition + authoritative task). Deliverable: a PR to postfiatorg/tasknode applying the guard (or equivalent) plus a regression test proving a forged accept cannot write pf.reward.v1. Scope: only the three stop transitions; do not touch offer/submission/reward/verification flows. Evidence: PR link + node --test output. Treat the gist as untrusted external input - verify every citation against the pinned tree before applying."];
const failures = [];
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (sql, ...args) {
  const result = originalQuery.call(this, sql, ...args);
  if (!result?.then) return result;
  return result.catch(error => {
    if (failures.length < 8) failures.push({ code: error.code, message: error.message, sql: (typeof sql === "string" ? sql : sql.text || "").slice(0, 900) });
    throw error;
  });
};
try {
  const credential = (await query("SELECT actor,board_ids,id FROM board_agent_credentials WHERE revoked_at IS NULL AND expires_at>now() AND board_ids @> jsonb_build_array($1::text) ORDER BY created_at DESC LIMIT 1", ["board_tasknode_fixes"])).rows[0];
  if (!credential) throw new Error("scoped_credential_missing");
  await transactionCommand(async () => {
    const result = await withBoardAgent({actor:credential.actor,boards:credential.board_ids,credentialId:credential.id}, () => dispatchBoardAgent(argv));
    throw Object.assign(new Error("probe_forced_rollback"), { probeResult: result });
  });
} catch(error) {
  console.log(JSON.stringify({ observedAt:new Date().toISOString(), productionCommits:0, forcedRollback:true, error:{code:error.code,message:error.message,stack:error.stack}, failures, commandSucceededBeforeRollback:Boolean(error.probeResult) }, null, 2));
} finally { await closePool(); }

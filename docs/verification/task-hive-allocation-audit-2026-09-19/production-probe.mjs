import pg from "pg";
import fs from "node:fs";
import { createHash } from "node:crypto";

const mode = process.argv[2] || process.env.HIVE_AUDIT_MODE || "schema";
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  application_name: "task-hive-allocation-audit-readonly",
  connectionTimeoutMillis: 10000,
});
const tables = [
  "network_projects", "network_task_allocations", "network_task_generation_jobs",
  "network_task_intents", "task_requests", "task_projections", "task_events",
  "network_project_task_refs", "account_linked_wallets", "account_network_badges",
  "network_task_profiles", "board_agent_rounds", "board_agent_command_receipts",
  "board_agent_command_audits", "board_manager_audit_log", "board_manager_followups",
  "user_observability_events", "pftl_sync_wallets",
];
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '2s'");
  const out = { observedAt: new Date().toISOString(), mode, transaction: (await client.query("SHOW transaction_read_only")).rows[0] };
  if (mode === "schema") {
    out.tables = (await client.query(
      "SELECT table_name, array_agg(column_name ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='public' AND (table_name = ANY($1::text[]) OR table_name LIKE 'board_agent%' OR table_name LIKE 'agent_board%') GROUP BY table_name ORDER BY table_name", [tables],
    )).rows;
    out.sourceHashes = {};
    for (const file of ["server/repositories/network-task-eligibility.js", "server/repositories/network-task-enqueue.js", "server/repositories/network-task-capacity.js", "server/repositories/network-task-generation-jobs.js", "server/network-task-generation-worker.js", "server/task-generation-worker.js", "server/task-generation-readiness.js", "server/repositories/task-requests.js", "scripts/bm/lib.mjs", "server/board-task-policy.js", "server/board-agent-rounds.js", "server/task-intent-assessment.js", "server/offchain-task-lifecycle.js", "server/repositories/tasks.js", "src/features/tasks/task-refresh-policy.js", "server/system-status-task-workers.js", "ops/bm-runtime/supervisor.mjs"]) {
      if (fs.existsSync(file)) out.sourceHashes[file] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  if (mode === "snapshot") {
    const queries = {
      schemaExtras: "SELECT table_name, array_agg(column_name ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE 'bm_%' OR table_name LIKE 'board_agent%') GROUP BY table_name",
      projects: "SELECT id,status,metadata_json->'board_manager' AS manager FROM network_projects WHERE id LIKE 'board_%' ORDER BY id",
      allocationStatuses: "SELECT allocation_status,count(*)::int AS count, min(created_at) AS oldest,max(created_at) AS newest FROM network_task_allocations GROUP BY 1 ORDER BY 1",
      jobStatuses: "SELECT status,count(*)::int AS count,min(created_at) AS oldest,max(created_at) AS newest,max(updated_at) AS last_update FROM network_task_generation_jobs GROUP BY 1 ORDER BY 1",
      requestStatuses: "SELECT source,status,count(*)::int AS count,min(created_at) AS oldest,max(created_at) AS newest FROM task_requests WHERE created_at >= '2026-09-12T00:00:00Z' OR status IN ('queued','generating') GROUP BY 1,2 ORDER BY 1,2",
      networkDaily: "SELECT created_at::date AS day,count(*)::int AS allocated,count(DISTINCT candidate_account_id)::int AS contributors,count(*) FILTER(WHERE generated_task_id <> '')::int AS linked_tasks FROM network_task_allocations WHERE created_at >= '2026-09-01T00:00:00Z' GROUP BY 1 ORDER BY 1",
      recentByBoard: "SELECT a.project_id,count(*)::int AS allocated,count(DISTINCT a.candidate_account_id)::int AS contributors,count(*) FILTER(WHERE tp.task_id IS NOT NULL)::int AS visible,count(*) FILTER(WHERE tp.status IN ('accepted','submitted','verification_requested','verification_response_submitted','rewarded'))::int AS accepted_or_later FROM network_task_allocations a LEFT JOIN task_projections tp ON tp.task_id=a.generated_task_id WHERE a.created_at>='2026-09-12T00:00:00Z' GROUP BY 1 ORDER BY 1",
      pendingChains: "SELECT j.id AS job_id,j.project_id,j.status AS job_status,j.attempt_count,j.created_at,j.updated_at,j.next_attempt_at,j.worker_heartbeat_at,j.lease_expires_at,split_part(j.last_error,':',1) AS error_code,r.status AS request_status,r.worker_attempt_count,split_part(r.last_error,':',1) AS request_error,a.allocation_status FROM network_task_generation_jobs j LEFT JOIN task_requests r ON r.request_id=j.request_id LEFT JOIN network_task_allocations a ON a.id=j.allocation_id WHERE j.status IN ('queued','running','link_failed') OR (a.allocation_status='queued' AND a.generated_task_id='') ORDER BY j.created_at LIMIT 100",
      failureReasons: "SELECT project_id,status,split_part(last_error,':',1) AS error_code,count(*)::int AS count,min(updated_at) AS first,max(updated_at) AS last FROM network_task_generation_jobs WHERE status='failed' AND updated_at>='2026-09-12T00:00:00Z' GROUP BY 1,2,3 ORDER BY count(*) DESC",
      chainIntegrity: "SELECT count(*)::int AS allocations,count(*) FILTER(WHERE j.id IS NULL)::int AS missing_job,count(*) FILTER(WHERE j.request_id<>'' AND r.request_id IS NULL)::int AS missing_request,count(*) FILTER(WHERE a.generated_task_id<>'' AND t.task_id IS NULL)::int AS missing_projection,count(*) FILTER(WHERE t.task_id IS NOT NULL AND ref.task_id IS NULL)::int AS missing_hive_ref,count(*) FILTER(WHERE t.task_id IS NOT NULL AND t.status<>a.allocation_status)::int AS status_mismatches FROM network_task_allocations a LEFT JOIN network_task_generation_jobs j ON j.allocation_id=a.id LEFT JOIN task_requests r ON r.request_id=j.request_id LEFT JOIN task_projections t ON t.task_id=a.generated_task_id LEFT JOIN network_project_task_refs ref ON ref.task_id=t.task_id AND ref.project_id=a.project_id",
      duplicateRequests: "SELECT request_id,count(*)::int AS tasks FROM task_projections WHERE request_id<>'' GROUP BY 1 HAVING count(*)>1 ORDER BY count(*) DESC LIMIT 20",
      recentRounds: "SELECT state,count(*)::int AS rounds,min(created_at) AS oldest,max(created_at) AS newest,max(completed_at) AS last_completed FROM board_agent_rounds WHERE created_at>='2026-09-12T00:00:00Z' OR state='pending' GROUP BY 1",
      recentCommands: "SELECT command,count(*)::int AS count,max(completed_at) AS last_completed FROM board_agent_commands WHERE created_at>='2026-09-12T00:00:00Z' GROUP BY 1 ORDER BY count(*) DESC LIMIT 25",
      pendingRoundDuties: "SELECT r.id,r.created_at,d->>'type' AS duty_type,d->>'board_id' AS board_id FROM board_agent_rounds r CROSS JOIN LATERAL jsonb_array_elements(r.duties_json) d WHERE r.state='pending' ORDER BY r.created_at LIMIT 50",
      observabilityReasons: "SELECT event_type,result_status,reason_code,count(*)::int AS count,max(occurred_at) AS last_seen FROM user_observability_events WHERE occurred_at>='2026-09-12T00:00:00Z' AND event_type LIKE 'user.network_task.%' GROUP BY 1,2,3 ORDER BY count(*) DESC LIMIT 40"
    };
    out.windowStart = "2026-09-12T00:00:00Z";
    for (const [name, sql] of Object.entries(queries)) {
      await client.query("SAVEPOINT audit_query");
      try { out[name] = (await client.query(sql)).rows; }
      catch (error) { out[name] = { error: error.code, message: error.message }; await client.query("ROLLBACK TO SAVEPOINT audit_query"); }
      await client.query("RELEASE SAVEPOINT audit_query");
    }
  }
  if (mode === "forensics") {
    const queries = {
      budgets: "SELECT b.board_id,b.daily_budget_pft>0 AS daily_budget_positive,b.per_task_cap_pft>0 AS per_task_cap_positive,b.daily_budget_pft>COALESCE((SELECT sum(s.reward_pft) FROM board_reward_spend s WHERE s.board_id=b.board_id AND s.created_at>=date_trunc(\'day\',now())),0) AS budget_remaining FROM board_reward_budgets b ORDER BY board_id",
      currentAllocations: "SELECT a.id,a.project_id,a.allocation_status,t.status AS canonical_status,t.task_id,t.created_at,t.last_event_at,'contributor_'||substr(encode(sha256(convert_to('hive-audit-20260919:'||a.candidate_account_id,'UTF8')),'hex'),1,10) AS contributor FROM network_task_allocations a LEFT JOIN task_projections t ON t.task_id=a.generated_task_id WHERE a.allocation_status IN ('proposed','accepted','queued','submitted','verification_requested','verification_response_submitted') OR (t.task_id IS NOT NULL AND a.allocation_status<>t.status) ORDER BY a.created_at",
      queuedOrdinaryRequests: "SELECT r.request_id,r.source,r.status,r.created_at,r.updated_at,r.worker_attempt_count,r.worker_retry_after,r.generated_task_id,r.request_bundle_cid<>'' AS has_bundle,COALESCE((r.metadata_json->>'manualRetryAttemptBase')::int,0) AS retry_base,r.worker_attempt_count-COALESCE((r.metadata_json->>'manualRetryAttemptBase')::int,0) AS cycle_attempts,t.status AS task_status FROM task_requests r LEFT JOIN task_projections t ON t.task_id=r.generated_task_id WHERE r.status IN ('queued','generating') ORDER BY r.created_at",
      duplicateDetails: "SELECT t.request_id,t.task_id,t.task_kind,t.status,t.created_at,(SELECT count(*) FROM task_events e WHERE e.task_id=t.task_id AND e.event_type='pf.task.offer.v1') AS offer_events FROM task_projections t WHERE t.request_id IN (SELECT request_id FROM task_projections WHERE request_id<>'' GROUP BY 1 HAVING count(*)>1) ORDER BY t.request_id,t.created_at",
      lastFailedNetworks: "SELECT id,project_id,status,attempt_count,split_part(last_error,':',1) AS error_code,split_part(last_error,':',2) AS assessment_relationship,generated_task_payload->'intentAssessment'->>'error' AS assessment_error,created_at,updated_at FROM network_task_generation_jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 8",
      roundOutcomes: "SELECT r.id,r.state,r.created_at,r.completed_at,jsonb_array_length(r.duties_json) AS duties,(SELECT count(*) FROM jsonb_object_keys(r.results_json)) AS result_count,(SELECT jsonb_agg(DISTINCT value->>'outcome') FROM jsonb_each(r.results_json)) AS outcomes FROM board_agent_rounds r ORDER BY created_at DESC LIMIT 8",
      recentRoutingOutcomes: "SELECT r.id,r.created_at,d->>'board_id' AS board_id,result->>'outcome' AS outcome,length(result->>'reason') AS reason_characters FROM board_agent_rounds r CROSS JOIN LATERAL jsonb_array_elements(r.duties_json) d LEFT JOIN LATERAL (SELECT r.results_json->(d->>'id') AS result) x ON true WHERE r.created_at>='2026-09-10T20:00:00Z' AND d->>'type'='routing_due' ORDER BY r.created_at DESC LIMIT 12",
      lastCommandAudit: "SELECT command,count(*)::int AS count,max(created_at) AS latest FROM bm_audit_log WHERE created_at>='2026-09-01T00:00:00Z' GROUP BY 1 ORDER BY max(created_at) DESC",
      networkEventDaily: "SELECT e.occurred_at::date AS day,count(*)::int AS offers FROM task_events e WHERE e.event_type='pf.task.offer.v1' AND e.occurred_at>='2026-09-01T00:00:00Z' AND EXISTS(SELECT 1 FROM network_task_allocations a WHERE a.generated_task_id=e.task_id) GROUP BY 1 ORDER BY 1"
    };
    for (const [name, sql] of Object.entries(queries)) {
      await client.query("SAVEPOINT audit_query");
      try { out[name] = (await client.query(sql)).rows; }
      catch (error) { out[name] = { error: error.code, message: error.message }; await client.query("ROLLBACK TO SAVEPOINT audit_query"); }
      await client.query("RELEASE SAVEPOINT audit_query");
    }
  }
  await client.query("ROLLBACK");
  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.code || error.name, message: error.message }));
  process.exitCode = 1;
} finally {
  await client.end();
}

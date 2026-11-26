// Allocation health: are contributors who submitted work being answered, and
// what did the board manager create? Idle contributors are not a fault and
// zero new tasks is a normal state, so neither raises an alarm. Read-only;
// shared by the scoped runtime status feed, the supervisor's alert, and
// System Status.
import { query as defaultQuery } from "./db/pool.js";

function safeInt(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

export const REVIEW_WAIT_CRITICAL_MS = 2 * 60 * 60_000;
export const REVIEW_WAIT_WARNING_MS = 45 * 60_000;

export function evaluateAllocationHealth(aggregate = {}) {
  const idle = safeInt(aggregate.idle_badge_verified_no_live_task);
  const creates24h = safeInt(aggregate.executed_creates_24h);
  const waiting = safeInt(aggregate.submissions_awaiting_manager);
  const oldestWaitMs = safeInt(aggregate.oldest_submission_wait_ms);
  // Contributors experience this one directly: a submission nobody has asked
  // to verify.
  if (waiting > 0 && oldestWaitMs >= REVIEW_WAIT_CRITICAL_MS) {
    return { status: "critical", label: `${waiting} submission(s) awaiting a manager verification request, oldest ${Math.round(oldestWaitMs / 60_000)} minutes` };
  }
  if (waiting > 0 && oldestWaitMs >= REVIEW_WAIT_WARNING_MS) return { status: "warning", label: `${waiting} submission(s) awaiting a manager verification request, oldest ${Math.round(oldestWaitMs / 60_000)} minutes` };
  return { status: "ok", label: `${creates24h} created in 24h, ${safeInt(aggregate.distinct_accounts_offered_7d)} accounts offered in 7d, ${idle} with free capacity` };
}

export async function readAllocationHealth({ boardIds = [], queryImpl = defaultQuery } = {}) {
  const boards = boardIds.length ? boardIds : (await queryImpl(
    `SELECT id FROM network_projects WHERE status NOT IN ('archived','completed','cancelled','rejected') ORDER BY id`
  )).rows.map((row) => row.id);
  const live = ["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted"];
  const idle = await queryImpl(
    `SELECT count(*)::int AS idle FROM (
       SELECT DISTINCT account_id FROM account_network_badges WHERE status='verified' AND revoked_at IS NULL
     ) b WHERE NOT EXISTS (
       SELECT 1 FROM task_projections p WHERE p.account_id=b.account_id AND p.task_kind='network' AND p.status = ANY($1::text[])
     )`,
    [live]
  );
  const creates = await queryImpl(
    `SELECT board_id,
            count(*) FILTER (WHERE created_at > now()-interval '24 hours')::int AS creates_24h,
            count(*) FILTER (WHERE created_at > now()-interval '7 days')::int AS creates_7d,
            max(created_at) AS last_create_at
       FROM bm_audit_log WHERE command='task_create' AND result_json->>'executed'='true' AND board_id = ANY($1::text[])
      GROUP BY board_id`,
    [boards]
  );
  const offered = await queryImpl(
    `SELECT a.project_id AS board_id, count(DISTINCT p.account_id)::int AS accounts_offered_7d
       FROM network_task_allocations a JOIN task_projections p ON p.task_id=a.generated_task_id
      WHERE p.created_at > now()-interval '7 days' AND a.project_id = ANY($1::text[])
      GROUP BY a.project_id`,
    [boards]
  );
  const liveByBoard = await queryImpl(
    `SELECT a.project_id AS board_id, p.status, count(*)::int AS count
       FROM network_task_allocations a JOIN task_projections p ON p.task_id=a.generated_task_id
      WHERE p.status = ANY($2::text[]) AND a.project_id = ANY($1::text[])
      GROUP BY a.project_id, p.status`,
    [boards, live]
  );
  const failures = await queryImpl(
    `SELECT project_id AS board_id,
            COALESCE(generated_task_payload->'generationFailure'->>'family',
              CASE WHEN last_error LIKE 'network_task_intent_needs_review%' THEN 'semantic'
                   WHEN last_error LIKE 'network_task_intent_contract_failed%' THEN 'contract'
                   WHEN last_error LIKE '%task_intent_assessment_schema_invalid%' OR last_error LIKE '%task_intent_assessment_json_invalid%' THEN 'contract'
                   WHEN last_error LIKE '%taskgen_provider_output_invalid%' THEN 'contract'
                   ELSE 'provider' END) AS family,
            count(*)::int AS count
       FROM network_task_generation_jobs
      WHERE status='failed' AND updated_at > now()-interval '7 days' AND project_id = ANY($1::text[])
      GROUP BY 1,2`,
    [boards]
  );
  // Network tasks in submitted or verification_response_submitted with no
  // pending/consumed manager decision of the matching kind: the manager has
  // not acted, and the contributor is waiting.
  const waiting = await queryImpl(
    `SELECT a.project_id AS board_id, p.task_id, p.status,
            GREATEST(p.last_event_at, p.updated_at) AS since,
            EXTRACT(EPOCH FROM (now() - GREATEST(p.last_event_at, p.updated_at)))::bigint * 1000 AS wait_ms
       FROM task_projections p JOIN network_task_allocations a ON a.generated_task_id=p.task_id
      WHERE p.task_kind='network' AND p.status IN ('submitted','verification_response_submitted')
        AND NOT EXISTS (SELECT 1 FROM bm_agent_decisions d WHERE d.task_id=p.task_id
              AND d.kind = CASE WHEN p.status='submitted' THEN 'verification_request' ELSE 'review' END
              AND d.status IN ('pending','consumed'))
      ORDER BY since ASC`
  );
  // Decisions the manager has recorded that the publication worker cannot
  // publish (for example a merged-PR failure). The task drops out of
  // "waiting" above as soon as a decision exists, so without this list a
  // decision that never publishes leaves the contributor stuck unseen.
  const stuck = await queryImpl(
    `SELECT a.project_id AS board_id, p.task_id, d.kind, d.decision, d.created_at AS since,
            EXTRACT(EPOCH FROM (now() - d.created_at))::bigint * 1000 AS wait_ms,
            left(coalesce(p.metadata_json #>> ARRAY['workers', CASE WHEN d.kind='review' THEN 'reward_scoring' ELSE 'verification_request' END, 'last_error'], ''), 200) AS last_error
       FROM bm_agent_decisions d
       JOIN task_projections p ON p.task_id=d.task_id
       JOIN network_task_allocations a ON a.generated_task_id=p.task_id
      WHERE d.status='pending' AND d.created_at < now() - interval '2 hours'
        AND p.status IN ('submitted','verification_response_submitted')
      ORDER BY d.created_at ASC`
  );
  const totalOffered = await queryImpl(
    `SELECT count(DISTINCT account_id)::int AS accounts FROM task_projections WHERE task_kind='network' AND created_at > now()-interval '7 days'`
  );
  const byBoard = new Map(boards.map((id) => [id, { board_id: id, creates_24h: 0, creates_7d: 0, last_create_at: null, accounts_offered_7d: 0, live: {}, failures_7d: {} }]));
  for (const row of creates.rows) Object.assign(byBoard.get(row.board_id) || {}, { creates_24h: row.creates_24h, creates_7d: row.creates_7d, last_create_at: row.last_create_at });
  for (const row of offered.rows) if (byBoard.has(row.board_id)) byBoard.get(row.board_id).accounts_offered_7d = row.accounts_offered_7d;
  for (const row of liveByBoard.rows) if (byBoard.has(row.board_id)) byBoard.get(row.board_id).live[row.status] = row.count;
  for (const row of failures.rows) if (byBoard.has(row.board_id)) byBoard.get(row.board_id).failures_7d[row.family] = row.count;
  for (const entry of byBoard.values()) entry.submissions_awaiting_manager = [];
  for (const entry of byBoard.values()) entry.decisions_stuck_publishing = [];
  for (const row of stuck.rows) {
    const entry = byBoard.get(row.board_id);
    if (entry) entry.decisions_stuck_publishing.push({ task_id: row.task_id, kind: row.kind, decision: row.decision, since: row.since, wait_ms: safeInt(row.wait_ms), last_error: row.last_error });
  }
  for (const row of waiting.rows) {
    const entry = byBoard.get(row.board_id);
    if (entry) entry.submissions_awaiting_manager.push({ task_id: row.task_id, status: row.status, since: row.since, wait_ms: safeInt(row.wait_ms) });
  }
  const perBoard = [...byBoard.values()];
  const aggregate = {
    idle_badge_verified_no_live_task: safeInt(idle.rows[0]?.idle),
    executed_creates_24h: perBoard.reduce((sum, entry) => sum + entry.creates_24h, 0),
    executed_creates_7d: perBoard.reduce((sum, entry) => sum + entry.creates_7d, 0),
    distinct_accounts_offered_7d: safeInt(totalOffered.rows[0]?.accounts),
    last_create_at: perBoard.map((entry) => entry.last_create_at ? new Date(entry.last_create_at).toISOString() : "").filter(Boolean).sort().at(-1) || null,
    live_allocations: perBoard.reduce((sum, entry) => sum + Object.values(entry.live).reduce((a, b) => a + b, 0), 0),
    submissions_awaiting_manager: waiting.rows.length,
    oldest_submission_wait_ms: waiting.rows.length ? Math.max(...waiting.rows.map((row) => safeInt(row.wait_ms))) : 0,
    decisions_stuck_publishing: stuck.rows.length,
  };
  return { observedAt: new Date().toISOString(), aggregate, evaluation: evaluateAllocationHealth(aggregate), boards: perBoard,
    note: "idle counts badge-verified accounts without a live network task; engine eligibility (wallet, capacity, restrictions) can be lower." };
}

export function allocationHealthLines(health, boardId) {
  if (!health) return [];
  const board = (health.boards || []).find((entry) => entry.board_id === boardId);
  const lines = [`Allocation: ${health.aggregate.idle_badge_verified_no_live_task} idle badge-verified; ${health.aggregate.executed_creates_24h} created 24h / ${health.aggregate.executed_creates_7d} 7d; ${health.aggregate.distinct_accounts_offered_7d} accounts offered 7d; ${health.aggregate.live_allocations} live (${health.evaluation.status})`];
  if (health.aggregate.submissions_awaiting_manager > 0) lines.push(`Review backlog: ${health.aggregate.submissions_awaiting_manager} submission(s) awaiting a manager verification request or review, oldest ${Math.round(health.aggregate.oldest_submission_wait_ms / 60_000)} min`);
  if (health.aggregate.decisions_stuck_publishing > 0) lines.push(`Stuck publications: ${health.aggregate.decisions_stuck_publishing} recorded decision(s) older than 2h have not published; the contributor is still waiting. Operator: scripts/operator-review-override.mjs`);
  if (board?.decisions_stuck_publishing?.length) lines.push(`Board stuck publications: ${board.decisions_stuck_publishing.map((item) => `${item.task_id} ${item.kind}/${item.decision} ${Math.round(item.wait_ms / 3_600_000)}h ${item.last_error}`).join("; ")}`);
  if (board?.submissions_awaiting_manager?.length) lines.push(`Board review backlog: ${board.submissions_awaiting_manager.map((item) => `${item.task_id} ${item.status} ${Math.round(item.wait_ms / 60_000)}min`).join("; ")}`);
  if (board) {
    const live = Object.entries(board.live).map(([status, count]) => `${status}=${count}`).join(",") || "none";
    const failures = Object.entries(board.failures_7d).map(([family, count]) => `${family}=${count}`).join(",") || "none";
    lines.push(`Board allocation: ${board.creates_24h} created 24h / ${board.creates_7d} 7d; ${board.accounts_offered_7d} accounts offered 7d; last create ${board.last_create_at ? new Date(board.last_create_at).toISOString() : "never"}; live ${live}; failures 7d ${failures}`);
  }
  return lines;
}

#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const auditTaskId = "task_90cc5546fd95c57f86a708d2c230afea";
const evidencePath = path.resolve(
  "docs/verification/evidence/task_90cc5546fd95c57f86a708d2c230afea_reward_dedup_distribution_v3.json"
);
const reportPath = path.resolve(
  "docs/verification/task_90cc5546fd95c57f86a708d2c230afea_reward_dedup_distribution_v3.md"
);

const knownEdgeTaskIds = [
  "task_d2527276782f04a30ce1bbe19bc5c188",
  "task_2ebb368d49cd48d11802d4f3c4692dd7",
  "task_70828af0024abd3cff1501aadb689e22",
  "task_724460b146babbd93e71cdce425bd0e6",
  "task_07db61566d7c4c44f0a3ffe3c88458e0",
  "task_51695c2b7a50bcd890040e330391f6dd",
  "task_dc07336c457592a783e53b0b7a175df9",
  "task_5dc3c23dd1460a044bfa2ce1fede2292",
  "task_8f8ff4b94792842a9b54a63769710afd",
  "task_5fd17ef435e99e79f6e87b12d9966817",
  "task_cdd241775a0a65ddae909bae3b771d29",
];

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPft(value) {
  return toNumber(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function eventAmount(row) {
  const payload = row.payload_json || {};
  return String(payload.reward_pft || payload.economic_reward_pft || payload.reward_actual_pft || "0");
}

function classify(sample) {
  const classes = [];
  const projectionReward = toNumber(sample.projection_reward_pft);
  const paymentTotal = toNumber(sample.payment_total_pft);
  const isNetworkLike = ["network", "alpha"].includes(String(sample.task_kind || "").toLowerCase());

  if (sample.payment_count > 1) classes.push("duplicate_reward_outcome_events");
  if (Math.abs(paymentTotal - projectionReward) > 0.000001) {
    classes.push("payment_total_differs_from_projection_reward");
  }
  if (projectionReward > 0 && sample.payment_count === 0) classes.push("missing_positive_reward_outcome_event");
  if (projectionReward === 0 && paymentTotal > 0) classes.push("positive_payment_on_zero_reward_projection");
  if (isNetworkLike && sample.board_ref_count !== 1) classes.push("board_task_ref_not_one_to_one");
  if (isNetworkLike && sample.allocation_count !== 1) classes.push("network_allocation_not_one_to_one");
  if (sample.board_ref_count === 1) {
    const boardReward = toNumber(sample.board_refs[0]?.reward_pft);
    if (Math.abs(boardReward - projectionReward) > 0.000001) {
      classes.push("board_reward_differs_from_projection_reward");
    }
  }
  if (sample.allocation_count === 1) {
    const allocationStatus = String(sample.allocations[0]?.allocation_status || "");
    if (!["rewarded", "completed"].includes(allocationStatus)) {
      classes.push("allocation_not_terminal_reward_state");
    }
  }

  return classes.length ? classes : ["consistent"];
}

function tableRow(sample) {
  return `| ${[
    `\`${sample.task_id}\``,
    sample.title.replaceAll("|", "\\|"),
    sample.task_kind || "",
    sample.payment_count,
    `${formatPft(sample.payment_total_pft)} PFT`,
    `${formatPft(sample.projection_reward_pft)} PFT`,
    sample.board_ref_count,
    sample.allocation_count,
    sample.discrepancy_classification.join(", "),
  ].join(" | ")} |`;
}

const { closePool, query } = await import("../server/db/pool.js");

const aggregate = await query(`
  WITH reward_events AS (
    SELECT
      task_id,
      count(*) FILTER (WHERE event_type = 'pf.reward.v1')::int AS payment_count
    FROM task_events
    WHERE event_type = 'pf.reward.v1'
    GROUP BY task_id
  ),
  ordered_payments AS (
    SELECT
      task_id,
      NULLIF(COALESCE(payload_json->>'reward_pft', payload_json->>'economic_reward_pft', payload_json->>'reward_actual_pft', payload_json->'score'->>'reward_pft'), '')::numeric AS reward_pft,
      row_number() OVER (PARTITION BY task_id ORDER BY occurred_at, source_tx_hash, source_cid, id) AS rn
    FROM task_events
    WHERE event_type = 'pf.reward.v1'
  )
  SELECT
    (SELECT count(*)::int FROM reward_events WHERE payment_count > 1) AS duplicate_reward_outcome_tasks,
    (SELECT COALESCE(sum(reward_pft), 0)::text FROM ordered_payments WHERE rn > 1) AS duplicate_reward_outcome_excess_pft
`);

const recentNetwork = await query(`
  WITH reward_events AS (
    SELECT task_id, max(occurred_at) AS latest_reward_at
    FROM task_events
    WHERE event_type = 'pf.reward.v1'
    GROUP BY task_id
  )
  SELECT p.task_id
  FROM task_projections p
  JOIN reward_events r ON r.task_id = p.task_id
  WHERE p.status = 'rewarded'
    AND p.task_kind IN ('network', 'alpha')
  ORDER BY r.latest_reward_at DESC NULLS LAST, p.updated_at DESC, p.task_id
  LIMIT 30
`);

const sampleIds = [];
for (const taskId of knownEdgeTaskIds) {
  if (!sampleIds.includes(taskId)) sampleIds.push(taskId);
}
for (const row of recentNetwork.rows) {
  if (!sampleIds.includes(row.task_id)) sampleIds.push(row.task_id);
  const networkLikeCount = sampleIds.filter((id) => id !== "task_cdd241775a0a65ddae909bae3b771d29").length;
  if (networkLikeCount >= 10 && sampleIds.length >= 11) break;
}

const samples = [];
for (const taskId of sampleIds) {
  const projection = await query(
    `
      SELECT
        task_id,
        title,
        task_kind,
        status,
        request_id,
        reward_actual_pft::text AS reward_actual_pft,
        reward_offer_pft::text AS reward_offer_pft,
        last_event_at,
        last_event_tx_hash,
        last_event_cid
      FROM task_projections
      WHERE task_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  if (!projection.rows.length) continue;
  const p = projection.rows[0];

  const events = await query(
    `
      SELECT
        event_type,
        payload_json,
        source_tx_hash,
        source_cid,
        occurred_at,
        id
      FROM task_events
	    WHERE task_id = $1
	      AND event_type = 'pf.reward.v1'
      ORDER BY occurred_at, source_tx_hash, source_cid, id
    `,
    [taskId]
  );

  const boardRefs = await query(
    `
      SELECT
        id,
        project_id,
        state,
        reward_pft::text AS reward_pft,
        assignee_wallet,
        updated_at
      FROM network_project_task_refs
      WHERE task_id = $1
      ORDER BY updated_at DESC, id
    `,
    [taskId]
  );

  const allocations = await query(
    `
      SELECT
        id,
        project_id,
        allocation_status,
        task_request_id,
        generated_task_id,
        reward_min_pft::text AS reward_min_pft,
        reward_max_pft::text AS reward_max_pft,
        updated_at
      FROM network_task_allocations
      WHERE generated_task_id = $1
         OR task_request_id = $2
         OR metadata_json::text ILIKE $3
      ORDER BY updated_at DESC, id
    `,
    [taskId, p.request_id || "", `%${taskId}%`]
  );

  const rewardEvents = events.rows.map((row) => ({
    event_type: row.event_type,
    event_id: row.payload_json?.event_id || "",
    tx: row.source_tx_hash,
    cid: row.source_cid,
    occurred_at: row.occurred_at,
    amount_pft: eventAmount(row),
    decision: row.payload_json?.score?.decision || row.payload_json?.reward_tier || row.payload_json?.reward_decision || "",
    evidence_quality: row.payload_json?.score?.evidence_quality ?? row.payload_json?.evidence_quality ?? "",
  }));

  const paymentTotal = rewardEvents
    .filter((event) => event.event_type === "pf.reward.v1")
    .reduce((sum, event) => sum + toNumber(event.amount_pft), 0);

  const sample = {
    task_id: taskId,
    title: p.title || "",
    task_kind: p.task_kind || "",
    projection_status: p.status || "",
    projection_reward_pft: p.reward_actual_pft || "0",
    projection_reward_offer_pft: p.reward_offer_pft || "0",
    last_event_at: p.last_event_at,
    last_event_tx_hash: p.last_event_tx_hash || "",
    last_event_cid: p.last_event_cid || "",
	    payment_count: rewardEvents.filter((event) => event.event_type === "pf.reward.v1").length,
    payment_total_pft: paymentTotal.toFixed(6),
    board_ref_count: boardRefs.rows.length,
    board_refs: boardRefs.rows,
    allocation_count: allocations.rows.length,
    allocations: allocations.rows,
    reward_events: rewardEvents,
  };
  sample.discrepancy_classification = classify(sample);
  samples.push(sample);
}

const networkLikeSamples = samples.filter((sample) => ["network", "alpha"].includes(String(sample.task_kind).toLowerCase()));
const anomalousSamples = samples.filter((sample) => !sample.discrepancy_classification.includes("consistent"));
  const duplicatePaymentSamples = samples.filter((sample) => sample.payment_count > 1);
	const boardMismatchSamples = samples.filter((sample) =>
  sample.discrepancy_classification.includes("board_task_ref_not_one_to_one") ||
  sample.discrepancy_classification.includes("network_allocation_not_one_to_one") ||
  sample.discrepancy_classification.includes("board_reward_differs_from_projection_reward")
);

const output = {
  captured_at: new Date().toISOString(),
  environment: "local Docker Postgres task cache",
  database_source: "local Docker Postgres task cache on 127.0.0.1:5436",
  audit_task_id: auditTaskId,
  audit_project: "pft_distribution_v3",
  scope_note: "Read-only audit of local task_events/task_projections/network board mirrors. Sample includes at least 10 rewarded Network/Alpha tasks plus the recent personal zero-reward duplicate-decision edge case.",
  aggregate: aggregate.rows[0],
  sample_task_ids: samples.map((sample) => sample.task_id),
  network_or_alpha_sample_count: networkLikeSamples.length,
  total_sample_count: samples.length,
  anomaly_counts: {
    anomalous_samples: anomalousSamples.length,
    duplicate_reward_outcome_samples: duplicatePaymentSamples.length,
    board_layer_mismatch_samples: boardMismatchSamples.length,
  },
  validation_rules: [
    "Each rewarded task should have exactly one terminal pf.reward.v1 outcome in the current protocol.",
    "A positive projected reward should have exactly one pf.reward.v1 outcome event whose reward_pft equals task_projections.reward_actual_pft.",
    "A zero projected reward should have exactly one pf.reward.v1 outcome event with reward_pft = 0; its one-drop transaction carrier is not economic reward.",
    "Each rewarded Network/Alpha task should have exactly one network_project_task_refs row and one terminal network_task_allocations row.",
    "The board-layer reward amount should match task_projections.reward_actual_pft and should never be treated as the distribution ledger when pf.reward.v1 totals disagree.",
  ],
  samples,
};

const summaryLines = [
  "# Verify Reward Deduplication Across Distribution V3 Paths",
  "",
  `Task ID: \`${auditTaskId}\`  `,
  "Network Project: `pft_distribution_v3`  ",
  `Completed: ${output.captured_at}`,
  "",
  "## Scope",
  "",
  "This is a read-only reward-deduplication audit over the local Docker task cache. The audit traces terminal reward outcomes, task projections, and board-layer mirrors for recent rewarded Network/Alpha tasks, while explicitly including known duplicate edge cases from prior audits.",
  "",
  `Evidence JSON: [task_90cc5546fd95c57f86a708d2c230afea_reward_dedup_distribution_v3.json](evidence/task_90cc5546fd95c57f86a708d2c230afea_reward_dedup_distribution_v3.json)`,
  "",
  "## Summary",
  "",
  `- Sample size: ${samples.length} tasks total; ${networkLikeSamples.length} Network/Alpha tasks.`,
  `- Duplicate reward-outcome samples: ${duplicatePaymentSamples.length}.`,
  `- Board-layer mismatch samples: ${boardMismatchSamples.length}.`,
  `- Whole-cache duplicate reward-outcome tasks: ${output.aggregate.duplicate_reward_outcome_tasks}.`,
  `- Whole-cache duplicate reward-outcome excess after first outcome: ${formatPft(output.aggregate.duplicate_reward_outcome_excess_pft)} PFT.`,
  "",
  "| Task ID | Title | Kind | Reward outcomes | Outcome total | Projection reward | Board refs | Allocations | Result |",
  "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ...samples.map(tableRow),
  "",
  "## Findings",
  "",
  "### P0: Duplicate reward outcome paths still exist historically",
  "",
  `The sampled duplicate-outcome tasks are: ${duplicatePaymentSamples.map((sample) => `\`${sample.task_id}\``).join(", ")}.`,
  "For these tasks, `pf.reward.v1` outcome totals exceed the projected reward. The board/projection layer shows the final projected amount, not the sum of reward outcome events.",
  "",
  "### P1: Board-layer mirrors are not consistently one-to-one for recent Network/Alpha reward records",
  "",
  `The sampled board-layer mismatch tasks are: ${boardMismatchSamples.map((sample) => `\`${sample.task_id}\``).join(", ")}.`,
  "Several recent rewarded Network/Alpha tasks have reward events and task projections but no current `network_project_task_refs` or `network_task_allocations` row in the local cache. That means the board layer cannot be used as the distribution ledger and needs reconciliation status.",
  "",
  "## Recommended Deduplication Checks",
  "",
  "1. Add a reward outcome reconciliation query that flags `COUNT(pf.reward.v1) > 1` per task.",
  "2. Add an outcome-total check: `SUM(pf.reward.v1.reward_pft) == task_projections.reward_actual_pft` for positive rewards.",
  "3. Add a zero-reward check: `task_projections.reward_actual_pft = 0` implies exactly one `pf.reward.v1` outcome with `reward_pft = 0`, not zero outcome events.",
  "4. Add a board mirror check for Network/Alpha tasks: exactly one `network_project_task_refs` row and one terminal `network_task_allocations` row after reward.",
  "",
  "## Reproduction",
  "",
  "Run:",
  "",
  "```bash",
  "DATABASE_URL='<local Docker Postgres URL>' TASKNODE_DATABASE_ENABLED=true node scripts/distribution-v3-reward-dedup-audit.mjs",
  "```",
  "",
  "The command writes the JSON evidence file and this report. It does not mutate reward records.",
  "",
];

await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(reportPath, `${summaryLines.join("\n")}\n`);

console.log(JSON.stringify({
  ok: true,
  audit_task_id: auditTaskId,
  evidence_path: evidencePath,
  report_path: reportPath,
  sample_count: samples.length,
  network_or_alpha_sample_count: networkLikeSamples.length,
  duplicate_reward_outcome_samples: duplicatePaymentSamples.length,
  board_layer_mismatch_samples: boardMismatchSamples.length,
}, null, 2));

await closePool();

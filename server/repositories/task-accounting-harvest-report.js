import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";
import {
  intValue,
  iso,
  jsonValue,
  safeArray,
  safeObject,
  safeText,
} from "./task-accounting-harvest-contract.js";

const harvestReportBatchSize = 3;
const harvestReportVersion = 2;
const harvestReportResolvedDetailLimit = 60;

function compactIdentifier(value = "", head = 12, tail = 8) {
  const text = safeText(value, 180);
  if (!text) return "";
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function plainLabel(value = "") {
  return safeText(value, 160)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Unknown";
}

function firstSentence(value = "", max = 320) {
  const text = safeText(value, 4000).replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] || text;
  return safeText(sentence, max);
}

function sourceContributorLabel(row = {}) {
  const handle = safeText(row.contributor_public_handle, 120).replace(/^@+/, "");
  if (handle) return `@${handle}`;
  return compactIdentifier(row.account_id || row.subject_wallet, 10, 6) || "unknown contributor";
}

function operatorLabel(row = {}) {
  const orcHandle = safeText(row.resolver_orc_handle || row.checkout_orc_handle, 120).replace(/^@+/, "");
  if (orcHandle) return `@${orcHandle}`;
  const displayName = safeText(row.resolver_display_name || "", 160).replace(/^@+/, "");
  if (displayName) return displayName.startsWith("acct_") ? compactIdentifier(displayName) : displayName;
  return compactIdentifier(row.resolved_by_account_id || row.checkout_account_id || row.checkout_wallet_address, 12, 8) || "unknown operator";
}

function deploymentStatusLine(row = {}) {
  const note = `${row.resolution_note || ""} ${row.suggested_action || ""}`.toLowerCase();
  const outcome = safeText(row.resolution_outcome, 80);
  if (outcome === "not_a_bug") return "No deployment needed; the closeout says this was not a product bug.";
  if (outcome === "already_fixed") return "No new deployment claimed; the closeout says the problem was already fixed.";
  if (outcome === "duplicate") return "No separate deployment claimed; the closeout points to an existing owner/item.";
  if (/\b(deployed|production|shipped|released|merged|commit|pushed|pr\b|pull request|regression|smoke|test)\b/.test(note)) {
    return "Deployment or verification evidence was named in the closeout.";
  }
  if (outcome === "fixed") return "Marked fixed, but the closeout should still be checked for explicit deploy evidence.";
  return "Deployment status was not explicit in the closeout.";
}

function issueLine(row = {}) {
  const problem = firstSentence(row.assessment_summary || row.task_proposal || row.title, 380) ||
    "The rewarded task produced a follow-up that needed operator review.";
  return `- ${row.title || row.task_id}: ${problem} Source: ${sourceContributorLabel(row)}. Actioned by: ${operatorLabel(row)}.`;
}

function solutionLine(row = {}) {
  const outcome = plainLabel(row.resolution_outcome || "resolved");
  const note = firstSentence(row.resolution_note, 520) || "The harvest row was closed without a detailed note.";
  return `- ${row.task_id}: ${outcome}. ${note} ${deploymentStatusLine(row)}`;
}

function initiatorNeed(row = {}) {
  const outcome = safeText(row.resolution_outcome, 80);
  if (outcome === "fixed") return "Watch the affected workflow for regressions and keep deploy/test evidence attached to future closeouts.";
  if (outcome === "already_fixed") return "Keep the source task linked to the existing fix so duplicate work is not routed.";
  if (outcome === "not_a_bug") return "Communicate the product expectation clearly so the same report does not re-enter the backlog.";
  if (outcome === "duplicate") return "Track the named existing task, issue, PR, commit, or harvest as the real owner.";
  return "Keep the closeout tied to a concrete product action, not a documentation packet.";
}

function groupByOperator(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const label = operatorLabel(row);
    const current = groups.get(label) || { label, rows: [] };
    current.rows.push(row);
    groups.set(label, current);
  }
  return Array.from(groups.values());
}

function backlogBluf(summary = {}, rows = []) {
  const openActionable = Number(summary.requires_action || 0);
  const checkedOut = Number(summary.checked_out || 0);
  const unresolved = Number(summary.unresolved || 0);
  const resolved = Number(summary.resolved || 0);
  const detailed = rows.length;
  if (!resolved) {
    return "No harvests have been resolved yet. The backlog still needs real closeouts before a Harvest Report can say what changed.";
  }
  if (!openActionable) {
    return `The harvest backlog is currently clear of actionable unresolved items. ${resolved} harvests are resolved overall, with ${detailed} detailed in this report.`;
  }
  if (checkedOut >= openActionable) {
    return `The backlog is active but owned: ${openActionable} actionable unresolved harvests remain and ${checkedOut} are checked out. ${resolved} harvests are resolved overall, with ${detailed} detailed in this report.`;
  }
  return `The backlog still needs ownership: ${openActionable} actionable unresolved harvests remain, ${checkedOut} are checked out, and ${Math.max(openActionable - checkedOut, 0)} need an operator. ${resolved} harvests are resolved overall, with ${detailed} detailed in this report. Total unresolved harvests: ${unresolved}.`;
}

function takeawayLines(summary = {}, rows = []) {
  const categories = new Map();
  const outcomes = new Map();
  for (const row of rows) {
    const category = plainLabel(row.action_category || row.classification || "general");
    categories.set(category, (categories.get(category) || 0) + 1);
    const outcome = plainLabel(row.resolution_outcome || "resolved");
    outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);
  }
  const categoryText = Array.from(categories.entries()).map(([label, count]) => `${label} (${count})`).join(", ") || "none";
  const outcomeText = Array.from(outcomes.entries()).map(([label, count]) => `${label} (${count})`).join(", ") || "none";
  const lines = [
    `- Resolved work detailed here clustered around: ${categoryText}.`,
    `- Closeout outcomes detailed here: ${outcomeText}.`,
  ];
  if (Number(summary.requires_action || 0) > 0) {
    lines.push(`- Operators should focus next on the ${summary.requires_action} actionable unresolved harvests, especially rows not yet checked out.`);
  } else {
    lines.push("- Operators can use the current resolved history as regression memory before routing more follow-up work.");
  }
  lines.push("- Keep the standard: a harvest is resolved only when the actual problem is fixed, already fixed, clearly not a bug, or owned by a named duplicate.");
  return lines;
}

function buildHarvestReportMarkdown({ bucket = 0, rows = [], summary = {} } = {}) {
  const start = Math.max(bucket - harvestReportBatchSize + 1, 1);
  const resolved = Number(summary.resolved || 0);
  const sourceTaskIds = rows.map((row) => safeText(row.task_id, 180)).filter(Boolean);
  const operatorGroups = groupByOperator(rows);
  const scopeLine = rows.length < resolved
    ? `This report regenerates every ${harvestReportBatchSize} resolved harvests. It summarizes the full resolved-history state at generation time: ${resolved} resolved harvests overall. To keep the report readable, the detailed issue list shows the latest ${rows.length} resolved harvests. The latest trigger window was resolved harvests ${start}-${bucket}.`
    : `This report regenerates every ${harvestReportBatchSize} resolved harvests. It summarizes the full resolved-history state at generation time: ${resolved} resolved harvest${resolved === 1 ? "" : "s"} overall. The latest trigger window was resolved harvests ${start}-${bucket}.`;
  const lines = [
    "# Harvest Report",
    "",
    "## Overall BLUF",
    backlogBluf(summary, rows),
    "",
    scopeLine,
    "",
    `Detailed resolved harvest task IDs: ${sourceTaskIds.join(", ") || "no source task IDs"}.`,
    "",
    "## Key Issues Resolved",
    ...(rows.length ? rows.map(issueLine) : ["- No resolved harvest rows were available for this report."]),
    "",
    "## Solutions And Deployment",
    ...(rows.length ? rows.map(solutionLine) : ["- No solutions were recorded because no resolved source rows were available."]),
    "",
    "## Productive Takeaways",
    ...takeawayLines(summary, rows),
    "",
    "## Initiators And What They Need To Know",
    ...(operatorGroups.length
      ? operatorGroups.map((group) => {
          const taskIds = group.rows.map((row) => row.task_id).filter(Boolean).join(", ");
          const needs = Array.from(new Set(group.rows.map(initiatorNeed))).join(" ");
          return `- ${group.label} drove ${group.rows.length} closeout${group.rows.length === 1 ? "" : "s"} (${taskIds}). They need to know: ${needs}`;
        })
      : ["- No resolving operator was recorded for this report bucket."]),
  ];
  return lines.join("\n");
}

function harvestReportRow(row = {}) {
  if (!row) return null;
  return {
    id: safeText(row.id, 180),
    reportBucket: Number(row.report_bucket || 0),
    resolvedCount: Number(row.resolved_count || 0),
    unresolvedCount: Number(row.unresolved_count || 0),
    requiresActionCount: Number(row.requires_action_count || 0),
    checkedOutCount: Number(row.checked_out_count || 0),
    sourceTaskIds: safeArray(row.source_task_ids_json),
    summary: safeObject(row.summary_json),
    bodyMarkdown: row.body_markdown || "",
    generatedAt: iso(row.generated_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function taskAccountingHarvestBacklogSummary() {
  const result = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved,
      count(*) FILTER (WHERE resolved_at IS NULL AND requires_action = true)::int AS requires_action,
      count(*) FILTER (WHERE resolved_at IS NULL AND checked_out_at IS NOT NULL)::int AS checked_out,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'queued')::int AS queued,
      count(*) FILTER (WHERE status = 'harvesting')::int AS harvesting,
      count(*) FILTER (WHERE status = 'harvested')::int AS harvested
    FROM task_accounting_harvests
  `);
  const row = result.rows[0] || {};
  return {
    total: Number(row.total || 0),
    resolved: Number(row.resolved || 0),
    unresolved: Number(row.unresolved || 0),
    requires_action: Number(row.requires_action || 0),
    checked_out: Number(row.checked_out || 0),
    failed: Number(row.failed || 0),
    queued: Number(row.queued || 0),
    harvesting: Number(row.harvesting || 0),
    harvested: Number(row.harvested || 0),
  };
}

async function latestHarvestReportRow() {
  const result = await query(`
    SELECT *
    FROM task_accounting_harvest_reports
    ORDER BY report_bucket DESC, generated_at DESC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

async function resolvedRowsForHarvestReport({ maxSequence = 0, limit = harvestReportResolvedDetailLimit } = {}) {
  const safeMaxSequence = Math.max(0, Math.trunc(Number(maxSequence || 0)));
  const safeLimit = intValue(limit, harvestReportResolvedDetailLimit, { min: 1, max: 200 });
  const result = await query(
    `
      WITH resolved AS (
        SELECT
          harvest.*,
          row_number() OVER (ORDER BY harvest.resolved_at ASC, harvest.task_id ASC) AS resolution_seq
        FROM task_accounting_harvests harvest
        WHERE harvest.resolved_at IS NOT NULL
      )
      SELECT
        resolved.*,
        COALESCE(identity.public_handle, '') AS contributor_public_handle,
        COALESCE(hive.display_name, identity.public_handle, '') AS contributor_display_name,
        COALESCE(checkout.account_id, '') AS checkout_account_id,
        COALESCE(checkout.wallet_address, '') AS checkout_wallet_address,
        COALESCE(resolver_hive.display_name, resolver_identity.public_handle, '') AS resolver_display_name,
        COALESCE(resolver_orc.handle, '') AS resolver_orc_handle,
        COALESCE(checkout_orc.handle, '') AS checkout_orc_handle
      FROM resolved
      LEFT JOIN LATERAL (
        SELECT event.account_id, event.wallet_address
        FROM task_accounting_harvest_checkout_events event
        WHERE event.task_id = resolved.task_id
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT 1
      ) checkout ON true
      LEFT JOIN LATERAL (
        SELECT display_name
        FROM hive_context_entries entry
        WHERE entry.account_id = resolved.account_id
          AND entry.deleted_at IS NULL
          AND entry.display_name <> ''
        ORDER BY entry.created_at DESC, entry.id DESC
        LIMIT 1
      ) hive ON true
      LEFT JOIN LATERAL (
        SELECT public_handle
        FROM account_identity_approvals approval
        WHERE approval.account_id = resolved.account_id
          AND approval.status = 'active'
          AND approval.public_handle <> ''
          AND approval.revoked_at IS NULL
        ORDER BY approval.updated_at DESC, approval.id DESC
        LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT display_name
        FROM hive_context_entries entry
        WHERE entry.account_id = resolved.resolved_by_account_id
          AND entry.deleted_at IS NULL
          AND entry.display_name <> ''
        ORDER BY entry.created_at DESC, entry.id DESC
        LIMIT 1
      ) resolver_hive ON true
      LEFT JOIN LATERAL (
        SELECT public_handle
        FROM account_identity_approvals approval
        WHERE approval.account_id = resolved.resolved_by_account_id
          AND approval.status = 'active'
          AND approval.public_handle <> ''
          AND approval.revoked_at IS NULL
        ORDER BY approval.updated_at DESC, approval.id DESC
        LIMIT 1
      ) resolver_identity ON true
      LEFT JOIN LATERAL (
        SELECT handle
        FROM orc_agents agent
        WHERE agent.account_id = resolved.resolved_by_account_id
          AND agent.handle <> ''
        ORDER BY agent.active DESC, agent.updated_at DESC, agent.id DESC
        LIMIT 1
      ) resolver_orc ON true
      LEFT JOIN LATERAL (
        SELECT handle
        FROM orc_agents agent
        WHERE (
            agent.account_id = checkout.account_id
            OR lower(agent.wallet_address) = lower(checkout.wallet_address)
          )
          AND agent.handle <> ''
        ORDER BY agent.active DESC, agent.updated_at DESC, agent.id DESC
        LIMIT 1
      ) checkout_orc ON true
      WHERE ($1::int = 0 OR resolved.resolution_seq <= $1::int)
      ORDER BY resolved.resolved_at DESC, resolved.task_id DESC
      LIMIT $2
    `,
    [safeMaxSequence, safeLimit]
  );
  return result.rows;
}

async function generateTaskAccountingHarvestReportForBucket(bucket = 0, summary = {}) {
  const normalizedBucket = Math.max(0, Math.trunc(Number(bucket || 0)));
  const maxSequence = Math.max(Number(summary.resolved || 0), normalizedBucket);
  const rows = await resolvedRowsForHarvestReport({ maxSequence });
  const sourceTaskIds = rows.map((row) => safeText(row.task_id, 180)).filter(Boolean);
  const bodyMarkdown = buildHarvestReportMarkdown({ bucket: normalizedBucket, rows, summary });
  const reportSummary = {
    ...summary,
    reportVersion: harvestReportVersion,
    triggerResolvedCount: normalizedBucket,
    coveredTaskIds: sourceTaskIds,
    coveredResolvedRows: Number(summary.resolved || rows.length),
    detailedResolvedRows: rows.length,
    detailLimit: harvestReportResolvedDetailLimit,
    batchSize: harvestReportBatchSize,
  };
  const result = await query(
    `
      INSERT INTO task_accounting_harvest_reports (
        id,
        report_bucket,
        resolved_count,
        unresolved_count,
        requires_action_count,
        checked_out_count,
        source_task_ids_json,
        summary_json,
        body_markdown,
        generated_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, now(), now())
      ON CONFLICT (report_bucket) DO UPDATE SET
        resolved_count = EXCLUDED.resolved_count,
        unresolved_count = EXCLUDED.unresolved_count,
        requires_action_count = EXCLUDED.requires_action_count,
        checked_out_count = EXCLUDED.checked_out_count,
        source_task_ids_json = EXCLUDED.source_task_ids_json,
        summary_json = EXCLUDED.summary_json,
        body_markdown = EXCLUDED.body_markdown,
        generated_at = EXCLUDED.generated_at,
        updated_at = now()
      RETURNING *
    `,
    [
      `harvestreport_${randomUUID()}`,
      normalizedBucket,
      Number(summary.resolved || 0),
      Number(summary.unresolved || 0),
      Number(summary.requires_action || 0),
      Number(summary.checked_out || 0),
      JSON.stringify(sourceTaskIds),
      jsonValue(reportSummary),
      bodyMarkdown,
    ]
  );
  return harvestReportRow(result.rows[0]);
}

export async function maybeGenerateTaskAccountingHarvestReport({ force = false } = {}) {
  if (!databaseEnabled()) {
    return { ok: true, skipped: true, reason: "database_not_configured", report: null };
  }
  const summary = await taskAccountingHarvestBacklogSummary();
  const targetBucket = Math.floor(Number(summary.resolved || 0) / harvestReportBatchSize) * harvestReportBatchSize;
  const latestRow = await latestHarvestReportRow();
  let latest = harvestReportRow(latestRow);
  const latestVersion = Number(latest?.summary?.reportVersion || 0);
  if (targetBucket < harvestReportBatchSize) {
    return {
      ok: true,
      pending: true,
      nextAtResolvedCount: harvestReportBatchSize,
      resolvedUntilNextReport: Math.max(harvestReportBatchSize - Number(summary.resolved || 0), 0),
      summary,
      report: latest,
    };
  }
  if (!force && latest?.reportBucket >= targetBucket && latestVersion >= harvestReportVersion) {
    return { ok: true, generated: false, summary, report: latest };
  }
  let startBucket = latest?.reportBucket >= harvestReportBatchSize && latestVersion >= harvestReportVersion
    ? latest.reportBucket + harvestReportBatchSize
    : harvestReportBatchSize;
  if (force) {
    startBucket = targetBucket;
  }
  if (latest?.reportBucket >= targetBucket && latestVersion < harvestReportVersion) {
    startBucket = targetBucket;
  }
  for (let bucket = startBucket; bucket <= targetBucket; bucket += harvestReportBatchSize) {
    latest = await generateTaskAccountingHarvestReportForBucket(bucket, summary);
  }
  return { ok: true, generated: true, summary, report: latest };
}

export async function getLatestTaskAccountingHarvestReport({ generate = true } = {}) {
  if (!databaseEnabled()) {
    return { ok: true, skipped: true, reason: "database_not_configured", report: null };
  }
  if (generate) return maybeGenerateTaskAccountingHarvestReport();
  const summary = await taskAccountingHarvestBacklogSummary();
  return {
    ok: true,
    generated: false,
    summary,
    report: harvestReportRow(await latestHarvestReportRow()),
  };
}

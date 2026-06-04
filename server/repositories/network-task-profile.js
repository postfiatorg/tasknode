import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { getChatMemoryContext } from "./chat-memory.js";
import { getContextDocument } from "./context.js";
import { buildPublicProfileSnapshotInput, getLatestPublicProfileSnapshot } from "./profile-public.js";
import { normalizeTaskStatus, taskStatusLabel, taskStatusTab } from "../../shared/task-lifecycle.js";
import { formatTaskTimestamp } from "../../shared/task-time-format.js";

const maxClaimLimit = 5;
const failedAttemptLimit = 3;
const autoRefreshMs = 24 * 60 * 60 * 1000;
const rewardThresholdDefault = 2;
export const networkTaskProfilePromptVersion = "network_task_profile_v2";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 180);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function digestJson(value) {
  return sha256(JSON.stringify(value));
}

function stableDigestValue(value) {
  if (Array.isArray(value)) return value.map(stableDigestValue);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set(["generated_at", "computed_at"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .map(([key, item]) => [key, stableDigestValue(item)])
  );
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function oneLine(value = "", max = 320) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function truncateWithEllipsis(value = "", max = 700) {
  const text = oneLine(value, max + 80);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function stripHtmlForPacket(value = "") {
  return String(value || "")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function publicProfileFromRow(row = {}) {
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask);
  const rewardOutcome = safeObject(row.reward_outcome_payload);
  const rewardScore = safeObject(rewardOutcome.reward_score || rewardOutcome.score);
  const stopPayload = safeObject(row.stop_payload);
  const statusKey = normalizeTaskStatus(row.status);
  return {
    taskId: safeText(row.task_id, 180),
    title: safeText(row.title || generatedTask.title, 240),
    kind: safeText(row.task_kind || generatedTask.task_kind || "task", 80),
    statusKey,
    statusLabel: taskStatusLabel(statusKey),
    tab: taskStatusTab(statusKey),
    description: safeText(row.description || generatedTask.description, 1400),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: toIso(row.updated_at || row.last_event_at),
    updatedAtDisplay: formatTaskTimestamp(row.updated_at || row.last_event_at, { locale: "en-US" }),
    rewardOutcome: {
      summary: safeText(
        rewardScore.user_feedback ||
          rewardScore.reason ||
          rewardOutcome.reward_summary ||
          rewardOutcome.user_feedback ||
          rewardOutcome.reason ||
          "",
        900
      ),
      decision: safeText(rewardScore.decision || rewardOutcome.reward_decision || rewardOutcome.decision || "", 80),
    },
    stopOutcome: {
      summary: safeText(
        stopPayload.reason ||
          stopPayload.refusal_reason ||
          stopPayload.refusalReason ||
          stopPayload.note ||
          "",
        600
      ),
    },
  };
}

function isRoutableTask(task = {}) {
  if (!task.taskId || task.statusKey === "unknown") return false;
  return Boolean(task.title || task.description);
}

function taskLine(task = {}) {
  const taskName = task.title || truncateWithEllipsis(task.description, 120);
  const lines = [
    `- Task Name: ${taskName}`,
    `  State: ${task.statusKey || "unknown"}`,
  ];
  if (task.description) lines.push(`  Description: ${truncateWithEllipsis(task.description, 420)}`);
  if (task.rewardActualPft > 0) {
    lines.push(`  Reward: ${task.rewardActualPft} PFT paid`);
  } else if (task.rewardOfferPft > 0) {
    lines.push(`  Reward: ${task.rewardOfferPft} PFT offered`);
  }
  const outcome = task.rewardOutcome?.summary || task.stopOutcome?.summary || "";
  if (outcome) lines.push(`  Outcome: ${truncateWithEllipsis(outcome, 420)}`);
  return lines.join("\n");
}

function groupTitle(title = "", tasks = []) {
  return `${title} (${tasks.length})`;
}

function groupText(title = "", tasks = [], { empty = "None" } = {}) {
  const items = tasks.map(taskLine).filter(Boolean);
  return [groupTitle(title, tasks), items.length ? items.join("\n") : empty].join("\n");
}

export function formatLiveTaskRoutingContext(tasks = []) {
  const normalized = safeArray(tasks).filter(isRoutableTask);
  const proposed = normalized.filter((task) => task.statusKey === "proposed");
  const outstanding = normalized.filter((task) => task.tab === "outstanding" && task.statusKey !== "proposed");
  const verification = normalized.filter((task) => task.tab === "verification");
  const refused = normalized.filter((task) => task.tab === "refused").slice(0, 6);
  const rewarded = normalized.filter((task) => task.tab === "rewarded").slice(0, 6);
  const displayedTotal = proposed.length + outstanding.length + verification.length + refused.length + rewarded.length;
  const text = [
    groupText("Proposed", proposed),
    "",
    groupText("Outstanding", outstanding),
    "",
    groupText("Verification", verification),
    "",
    groupText("Refused", refused),
    "",
    groupText("Rewarded", rewarded),
  ].join("\n");

  return {
    text,
    groups: { proposed, outstanding, verification, refused, rewarded },
    counts: {
      proposed: proposed.length,
      outstanding: outstanding.length,
      verification: verification.length,
      refused: refused.length,
      rewarded: rewarded.length,
      total: displayedTotal,
      available: normalized.length,
    },
  };
}

export function formatNetworkContextInputs({
  liveTaskContext = null,
  profileInput = null,
  latestProfileSnapshot = null,
} = {}) {
  return [
    "NETWORK CONTEXT INPUTS",
    "",
    "Profile",
    profileSnapshotText({ profileInput, latestProfileSnapshot }),
    "",
    "Task State",
    liveTaskContext?.text || "No task state is available.",
  ].join("\n");
}

export function formatNetworkTaskProfileOutput(output = {}) {
  const currentFocus = safeArray(output.current_focus).map((item) => safeText(item, 360)).filter(Boolean).slice(0, 6);
  const contribution = safeArray(output.primary_contribution_ability).map((item) => safeText(item, 420)).filter(Boolean).slice(0, 6);
  const domain = safeArray(output.domain_expertise).map((item) => safeText(item, 480)).filter(Boolean).slice(0, 10);
  return [
    safeText(output.profile_title, 160) || "Network Task Profile",
    "",
    currentFocus.length ? ["Current focus:", ...currentFocus.map((item) => `- ${item}`)].join("\n") : "",
    contribution.length ? ["Primary contribution ability:", ...contribution.map((item) => `- ${item}`)].join("\n") : "",
    domain.length
      ? ["Companies this User Would Move the Needle At:", ...domain.map((item) => `- ${item}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
}

function publicProfile(row = null) {
  if (!row) return null;
  const output = safeObject(row.output_json);
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    output,
    outputText: row.output_text || formatNetworkTaskProfileOutput(output),
    provider: row.provider || "",
    model: row.model || "",
    promptVersion: row.prompt_version || networkTaskProfilePromptVersion,
    promptDigest: row.prompt_digest || "",
    usage: row.usage_json || {},
    error: row.error || "",
    createdAt: toIso(row.created_at),
    completedAt: toIso(row.completed_at),
  };
}

function publicJob(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    reason: row.reason,
    sourcePacketDigest: row.source_packet_digest,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function compactTask(task = {}) {
  const outcome = task.rewardOutcome?.summary || task.stopOutcome?.summary || "";
  return {
    title: task.title,
    kind: task.kind,
    status: task.statusKey,
    reward: task.rewardActualPft > 0 ? `${task.rewardActualPft} PFT paid` : `${task.rewardOfferPft} PFT offered`,
    summary: truncateWithEllipsis(task.description, 700),
    outcome: truncateWithEllipsis(outcome, 700),
  };
}

function profileSnapshotText({ profileInput = {}, latestProfileSnapshot = null } = {}) {
  const metrics = safeObject(profileInput.reward_totals);
  const alignment = safeObject(profileInput.alignment);
  const tier = safeObject(profileInput.contribution_tier);
  const identity = safeObject(profileInput.identity);
  const snapshot = latestProfileSnapshot || {};
  const skills = safeArray(snapshot.skills).join(", ");
  return [
    `Account: ${profileInput.account_id || "unknown"}`,
    `Primary wallet: ${identity.primary_wallet || identity.active_wallet || "not linked"}`,
    snapshot.roleTitle ? `Public role: ${snapshot.roleTitle}` : "",
    snapshot.roleSummary ? `Public role summary: ${snapshot.roleSummary}` : "",
    skills ? `Public skills: ${skills}` : "",
    `Lifetime task rewards: ${numeric(metrics.lifetimeTaskRewardPft)} PFT`,
    `Trailing 30 day rewarded tasks: ${Number(metrics.trailing30dRewardedTasks || 0)}`,
    `Trailing 30 day task rewards: ${numeric(metrics.trailing30dTaskRewardPft)} PFT`,
    alignment.score0To100 !== null && alignment.score0To100 !== undefined
      ? `Alignment score: ${alignment.score0To100}/100`
      : "",
    tier.tier ? `Contribution tier: ${tier.tier} (${tier.basis || "no basis recorded"})` : "",
  ].filter(Boolean).join("\n");
}

export function buildNetworkTaskProfileSourcePacket({
  accountId = "",
  contextDocument = null,
  memoryContext = null,
  liveTaskContext = null,
  profileInput = null,
  latestProfileSnapshot = null,
} = {}) {
  const now = new Date().toISOString();
  const deepMemories = safeArray(memoryContext?.deepMemories).slice(0, 3);
  const contextText = stripHtmlForPacket(contextDocument?.body || "");
  const networkContextInputsText = formatNetworkContextInputs({
    liveTaskContext,
    profileInput,
    latestProfileSnapshot,
  });
  const allTasks = [
    ...safeArray(liveTaskContext?.groups?.proposed),
    ...safeArray(liveTaskContext?.groups?.outstanding),
    ...safeArray(liveTaskContext?.groups?.verification),
    ...safeArray(liveTaskContext?.groups?.refused),
    ...safeArray(liveTaskContext?.groups?.rewarded),
  ];
  const sourceJson = {
    schema: "pf.memory.network_task_profile_source.v1",
    generated_at: now,
    account_id: safeAccountId(accountId),
    profile_snapshot: profileInput || {},
    latest_public_profile_snapshot: latestProfileSnapshot || null,
    network_context_inputs: {
      text: networkContextInputsText,
      counts: liveTaskContext?.counts || {},
    },
    context_document: {
      title: contextDocument?.title || "Task Node Context",
      revision: Number(contextDocument?.revision || 0),
      updated_at: contextDocument?.updatedAt || null,
      body_text: contextText,
    },
    deep_memory: deepMemories.map((entry) => ({
      created_at: entry.createdAt,
      user_request_summary: entry.userRequestSummary,
      system_response_summary: entry.systemResponseSummary,
      memory_text: entry.memoryText,
    })),
    current_tasks: {
      proposed: safeArray(liveTaskContext?.groups?.proposed).map(compactTask),
      outstanding: safeArray(liveTaskContext?.groups?.outstanding).map(compactTask),
      verification: safeArray(liveTaskContext?.groups?.verification).map(compactTask),
    },
    recently_refused_tasks: safeArray(liveTaskContext?.groups?.refused).slice(0, 6).map(compactTask),
    recently_rewarded_tasks: safeArray(liveTaskContext?.groups?.rewarded).slice(0, 6).map(compactTask),
  };
  const digestSourceJson = stableDigestValue(sourceJson);
  const sourceText = [
    "NETWORK TASK PROFILE SOURCE PACKET",
    "",
    "Generated At",
    now,
    "",
    "Account",
    safeAccountId(accountId),
    "",
    "Network Context Inputs",
    networkContextInputsText,
    "",
    "Context Document",
    contextText || "No context document text saved yet.",
    "",
    "Deep Memory",
    deepMemories.length
      ? deepMemories.map((entry, index) => [
        `Deep Memory ${index + 1}`,
        `User: ${safeText(entry.userRequestSummary, 1400)}`,
        `Assistant: ${safeText(entry.systemResponseSummary, 1400)}`,
        `Memory: ${safeText(entry.memoryText, 1800)}`,
      ].join("\n")).join("\n\n")
      : "No deep memory generated yet.",
    "",
    "Recently Refused Tasks",
    safeArray(liveTaskContext?.groups?.refused).length
      ? safeArray(liveTaskContext.groups.refused).slice(0, 6).map((task) => {
        const compact = compactTask(task);
        return [
          `Task: ${compact.title}`,
          `Kind: ${compact.kind}`,
          `Status: ${compact.status}`,
          `Reward: ${compact.reward}`,
          `Summary: ${compact.summary}`,
          compact.outcome ? `Outcome: ${compact.outcome}` : "",
        ].filter(Boolean).join("\n");
      }).join("\n\n")
      : "No recent refused tasks.",
    "",
    "Recently Rewarded Tasks",
    safeArray(liveTaskContext?.groups?.rewarded).length
      ? safeArray(liveTaskContext.groups.rewarded).slice(0, 6).map((task) => {
        const compact = compactTask(task);
        return [
          `Task: ${compact.title}`,
          `Kind: ${compact.kind}`,
          `Status: ${compact.status}`,
          `Reward: ${compact.reward}`,
          `Summary: ${compact.summary}`,
          compact.outcome ? `Outcome: ${compact.outcome}` : "",
        ].filter(Boolean).join("\n");
      }).join("\n\n")
      : "No recent rewarded tasks.",
  ].join("\n");
  return {
    sourceJson,
    sourceText,
    sourcePacketDigest: digestJson(digestSourceJson),
    sourceCounts: {
      deepMemoryCount: deepMemories.length,
      contextDocumentCount: contextText ? 1 : 0,
      proposedTaskCount: liveTaskContext?.counts?.proposed || 0,
      outstandingTaskCount: liveTaskContext?.counts?.outstanding || 0,
      verificationTaskCount: liveTaskContext?.counts?.verification || 0,
      refusedTaskCount: liveTaskContext?.counts?.refused || 0,
      rewardedTaskCount: liveTaskContext?.counts?.rewarded || 0,
      totalTaskCount: allTasks.length,
    },
  };
}

export async function getLiveTaskRoutingContext({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId || !useDatabase()) {
    return formatLiveTaskRoutingContext([]);
  }

  const result = await query(
    `
      SELECT p.*,
             (
               SELECT e.payload_json
	               FROM task_events e
	               WHERE e.task_id = p.task_id
	                 AND e.event_type = 'pf.reward.v1'
	               ORDER BY e.occurred_at DESC, e.id DESC
	               LIMIT 1
	             ) AS reward_outcome_payload,
             (
               SELECT e.payload_json
               FROM task_events e
               WHERE e.task_id = p.task_id
                 AND e.event_type = 'pf.task.update.v1'
                 AND (
                   e.payload_json->>'transition' IN ('refused', 'cancelled', 'rejected')
                   OR e.payload_json->>'status_after' IN ('refused', 'cancelled', 'rejected')
                 )
               ORDER BY e.occurred_at DESC, e.id DESC
               LIMIT 1
             ) AS stop_payload
      FROM task_projections p
      WHERE p.account_id = $1
        AND p.status <> 'unknown'
      ORDER BY p.updated_at DESC, p.task_id DESC
      LIMIT 200
    `,
    [normalizedAccountId]
  );
  return formatLiveTaskRoutingContext(result.rows.map(publicProfileFromRow));
}

export async function buildNetworkTaskProfileSource({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) throw new Error("network_task_profile_account_required");
  const [contextDocument, memoryContext, liveTaskContext, profileInput, latestProfileSnapshot] = await Promise.all([
    getContextDocument({ accountId: normalizedAccountId }),
    getChatMemoryContext({ accountId: normalizedAccountId, deepLimit: 3, turnLimit: 36 }),
    getLiveTaskRoutingContext({ accountId: normalizedAccountId }),
    buildPublicProfileSnapshotInput({ accountId: normalizedAccountId }).catch(() => null),
    getLatestPublicProfileSnapshot({ accountId: normalizedAccountId }).catch(() => null),
  ]);
  const networkContextInputs = {
    text: formatNetworkContextInputs({
      liveTaskContext,
      profileInput,
      latestProfileSnapshot,
    }),
    counts: liveTaskContext.counts,
  };
  return {
    liveTaskContext,
    networkContextInputs,
    ...buildNetworkTaskProfileSourcePacket({
      accountId: normalizedAccountId,
      contextDocument,
      memoryContext,
      liveTaskContext,
      profileInput,
      latestProfileSnapshot,
    }),
  };
}

export async function getLatestNetworkTaskProfile({ accountId = "" } = {}) {
  if (!useDatabase()) return null;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return null;
  const result = await query(
    `
      SELECT *
      FROM network_task_profiles
      WHERE account_id = $1
        AND status = 'completed'
        AND superseded_at IS NULL
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  return publicProfile(result.rows[0] || null);
}

export async function getLatestNetworkTaskProfileJob({ accountId = "" } = {}) {
  if (!useDatabase()) return null;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return null;
  const result = await query(
    `
      SELECT *
      FROM network_task_profile_jobs
      WHERE account_id = $1
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  return publicJob(result.rows[0] || null);
}

export async function enqueueNetworkTaskProfileJob({
  accountId = "",
  sourcePacket = null,
  reason = "memory_page",
} = {}) {
  if (!useDatabase()) return { queued: false, reason: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId || !sourcePacket?.sourcePacketDigest) {
    return { queued: false, reason: "missing_source_packet" };
  }
  const result = await query(
    `
      INSERT INTO network_task_profile_jobs (
        id,
        account_id,
        reason,
        source_packet_digest,
        source_packet_json,
        source_packet_text
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (account_id, source_packet_digest)
        WHERE status IN ('pending', 'processing')
      DO UPDATE SET
        reason = EXCLUDED.reason,
        source_packet_json = EXCLUDED.source_packet_json,
        source_packet_text = EXCLUDED.source_packet_text,
        updated_at = now()
      RETURNING *
    `,
    [
      `nettaskprofilejob_${randomUUID()}`,
      normalizedAccountId,
      safeText(reason, 120),
      sourcePacket.sourcePacketDigest,
      jsonValue(sourcePacket.sourceJson),
      sourcePacket.sourceText,
    ]
  );
  return { queued: true, job: publicJob(result.rows[0]) };
}

async function positiveRewardStats({ accountId = "" } = {}) {
  if (!useDatabase()) return { positiveRewardedTaskCount: 0, lastRewardedTaskAt: null };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { positiveRewardedTaskCount: 0, lastRewardedTaskAt: null };
  const result = await query(
    `
      SELECT COUNT(task_id)::integer AS rewarded_task_count,
             MAX(updated_at) AS last_rewarded_task_at
      FROM task_projections
      WHERE account_id = $1
        AND reward_actual_pft > 0
    `,
    [normalizedAccountId]
  );
  const row = result.rows[0] || {};
  return {
    positiveRewardedTaskCount: Number(row.rewarded_task_count || 0),
    lastRewardedTaskAt: toIso(row.last_rewarded_task_at),
  };
}

export async function enqueueNetworkTaskProfileForRewardThreshold({
  accountId = "",
  reason = "rewarded_task_threshold",
  minRewardedTasks = rewardThresholdDefault,
} = {}) {
  if (!useDatabase()) return { queued: false, reason: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { queued: false, reason: "missing_account_id" };

  const threshold = Math.max(1, Number(minRewardedTasks || rewardThresholdDefault));
  const stats = await positiveRewardStats({ accountId: normalizedAccountId });
  if (stats.positiveRewardedTaskCount < threshold) {
    return {
      queued: false,
      reason: "reward_threshold_not_met",
      minRewardedTasks: threshold,
      ...stats,
    };
  }

  const source = await buildNetworkTaskProfileSource({ accountId: normalizedAccountId });
  const [latest, activeJob] = await Promise.all([
    getLatestNetworkTaskProfile({ accountId: normalizedAccountId }),
    getLatestNetworkTaskProfileJob({ accountId: normalizedAccountId }),
  ]);
  const currentCompletedProfile = Boolean(
    latest?.sourcePacketDigest === source.sourcePacketDigest &&
      latest?.promptVersion === networkTaskProfilePromptVersion
  );
  if (currentCompletedProfile) {
    return {
      queued: false,
      reason: "network_task_profile_current",
      minRewardedTasks: threshold,
      sourcePacketDigest: source.sourcePacketDigest,
      ...stats,
    };
  }
  if (activeJob?.sourcePacketDigest === source.sourcePacketDigest) {
    return {
      queued: false,
      reason: "network_task_profile_job_already_active",
      minRewardedTasks: threshold,
      job: activeJob,
      sourcePacketDigest: source.sourcePacketDigest,
      ...stats,
    };
  }

  const queued = await enqueueNetworkTaskProfileJob({
    accountId: normalizedAccountId,
    sourcePacket: source,
    reason,
  });
  return {
    ...queued,
    reason: queued.reason || reason,
    minRewardedTasks: threshold,
    sourcePacketDigest: source.sourcePacketDigest,
    ...stats,
  };
}

export async function enqueueNetworkTaskProfilesForRewardedAccounts({
  limit = 2,
  minRewardedTasks = rewardThresholdDefault,
  reason = "rewarded_task_threshold_backfill",
} = {}) {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured" };
  const threshold = Math.max(1, Number(minRewardedTasks || rewardThresholdDefault));
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), 10);
  const result = await query(
    `
      WITH reward_accounts AS (
        SELECT account_id,
               COUNT(task_id)::integer AS rewarded_task_count,
               MAX(updated_at) AS last_rewarded_task_at
        FROM task_projections
        WHERE account_id <> ''
          AND reward_actual_pft > 0
        GROUP BY account_id
        HAVING COUNT(task_id) >= $1
      ),
      latest_profiles AS (
        SELECT DISTINCT ON (account_id)
               account_id,
               source_packet_digest,
               prompt_version,
               completed_at,
               created_at
        FROM network_task_profiles
        WHERE status = 'completed'
          AND superseded_at IS NULL
        ORDER BY account_id, completed_at DESC NULLS LAST, created_at DESC, id DESC
      ),
      active_jobs AS (
        SELECT DISTINCT account_id
        FROM network_task_profile_jobs
        WHERE status IN ('pending', 'processing')
      )
      SELECT reward_accounts.account_id,
             reward_accounts.rewarded_task_count,
             reward_accounts.last_rewarded_task_at
      FROM reward_accounts
      LEFT JOIN latest_profiles
        ON latest_profiles.account_id = reward_accounts.account_id
      LEFT JOIN active_jobs
        ON active_jobs.account_id = reward_accounts.account_id
      WHERE active_jobs.account_id IS NULL
        AND (
          latest_profiles.account_id IS NULL
          OR latest_profiles.prompt_version <> $2
          OR COALESCE(latest_profiles.completed_at, latest_profiles.created_at)
               < reward_accounts.last_rewarded_task_at
        )
      ORDER BY reward_accounts.last_rewarded_task_at ASC,
               reward_accounts.account_id ASC
      LIMIT $3
    `,
    [threshold, networkTaskProfilePromptVersion, normalizedLimit]
  );

  const results = [];
  for (const row of result.rows) {
    try {
      results.push(await enqueueNetworkTaskProfileForRewardThreshold({
        accountId: row.account_id,
        reason,
        minRewardedTasks: threshold,
      }));
    } catch (error) {
      results.push({
        queued: false,
        reason: "reward_threshold_enqueue_failed",
        accountId: safeAccountId(row.account_id),
        error: safeText(error?.message || error, 1000),
      });
    }
  }

  return {
    ok: true,
    scanned: result.rows.length,
    queuedCount: results.filter((item) => item.queued).length,
    failedCount: results.filter((item) => item.reason === "reward_threshold_enqueue_failed").length,
    results,
  };
}

export async function getNetworkTaskProfileState({
  accountId = "",
  force = false,
  reason = "memory_page",
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { ok: false, status: 401, error: "network_task_profile_login_required" };
  const source = await buildNetworkTaskProfileSource({ accountId: normalizedAccountId });
  const latest = await getLatestNetworkTaskProfile({ accountId: normalizedAccountId });
  const latestCompletedAt = latest?.completedAt ? Date.parse(latest.completedAt) : 0;
  const stale = !latestCompletedAt || Date.now() - latestCompletedAt > autoRefreshMs;
  const digestChanged = latest?.sourcePacketDigest !== source.sourcePacketDigest;
  const promptChanged = latest?.promptVersion !== networkTaskProfilePromptVersion;
  let enqueue = null;

  if (!latest || force || promptChanged || (digestChanged && stale)) {
    enqueue = await enqueueNetworkTaskProfileJob({
      accountId: normalizedAccountId,
      sourcePacket: source,
      reason,
    });
  }

  const job = await getLatestNetworkTaskProfileJob({ accountId: normalizedAccountId });
  return {
    ok: true,
    liveTaskContext: source.liveTaskContext,
    networkContextInputs: source.networkContextInputs,
    profile: latest,
    job: job || enqueue?.job || null,
    sourcePacket: {
      text: source.sourceText,
      digest: source.sourcePacketDigest,
      counts: source.sourceCounts,
    },
    refresh: {
      stale,
      digestChanged,
      promptChanged,
      queued: Boolean(enqueue?.queued),
      reason: enqueue?.reason || reason,
    },
  };
}

export async function resetNetworkTaskProfileMemory({ accountId = "" } = {}) {
  if (!useDatabase()) return { ok: false, status: 503, error: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    return { ok: false, status: 400, error: "network_task_profile_reset_missing_account", message: "Sign in before resetting the diagnostic report." };
  }

  return transaction(async (client) => {
    const jobs = await client.query(
      `
        DELETE FROM network_task_profile_jobs
        WHERE account_id = $1
      `,
      [normalizedAccountId]
    );
    const profiles = await client.query(
      `
        DELETE FROM network_task_profiles
        WHERE account_id = $1
      `,
      [normalizedAccountId]
    );

    return {
      ok: true,
      action: "reset_network_profile",
      deleted: {
        jobs: jobs.rowCount,
        profiles: profiles.rowCount,
      },
      message: "Diagnostic report reset.",
    };
  });
}

export async function claimNetworkTaskProfileJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), maxClaimLimit);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE network_task_profile_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - interval '5 minutes'
      `
    );

    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM network_task_profile_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE network_task_profile_jobs AS job
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            locked_at = now(),
            updated_at = now()
        FROM picked
        WHERE job.id = picked.id
        RETURNING job.*
      `,
      [normalizedLimit]
    );
    return result.rows;
  });
}

export async function completeNetworkTaskProfileJob({
  job,
  output = {},
  provider = "",
  model = "",
  promptDigest = "",
  usage = {},
} = {}) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const outputJson = safeObject(output);
  const outputText = formatNetworkTaskProfileOutput(outputJson);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE network_task_profiles
        SET superseded_at = now()
        WHERE account_id = $1
          AND status = 'completed'
          AND superseded_at IS NULL
      `,
      [safeAccountId(job.account_id)]
    );
    const inserted = await client.query(
      `
        INSERT INTO network_task_profiles (
          id,
          account_id,
          status,
          source_packet_json,
          source_packet_text,
          source_packet_digest,
          output_json,
          output_text,
          provider,
          model,
          prompt_version,
          prompt_digest,
          usage_json,
          completed_at
        )
        VALUES ($1, $2, 'completed', $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, now())
        RETURNING *
      `,
      [
        `nettaskprofile_${randomUUID()}`,
        safeAccountId(job.account_id),
        jsonValue(job.source_packet_json),
        safeText(job.source_packet_text, 120_000),
        safeText(job.source_packet_digest, 120),
        jsonValue(outputJson),
        outputText,
        safeText(provider, 80),
        safeText(model, 160),
        networkTaskProfilePromptVersion,
        safeText(promptDigest, 120),
        jsonValue(usage),
      ]
    );
    await client.query(
      `
        UPDATE network_task_profile_jobs
        SET status = 'completed',
            locked_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [job.id]
    );
    return { ok: true, profile: publicProfile(inserted.rows[0]) };
  });
}

export async function failNetworkTaskProfileJob(job, error) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(900, Math.max(30, 30 * attemptCount * attemptCount));
  await query(
    `
      UPDATE network_task_profile_jobs
      SET status = $2,
          next_attempt_at = CASE
            WHEN $2 = 'failed' THEN next_attempt_at
            ELSE now() + ($3::text || ' seconds')::interval
          END,
          locked_at = NULL,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      job.id,
      finalFailure ? "failed" : "pending",
      String(backoffSeconds),
      safeText(error?.message || error || "network_task_profile_job_failed", 1000),
    ]
  );
  return { ok: true, retry: !finalFailure };
}

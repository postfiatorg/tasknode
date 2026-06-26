import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";
import { getAccountIdentityProfile } from "../runtime-store.js";
import { getHiveProjectsDocument } from "./hive-projects.js";
import { hiveReportTypeIds, latestHiveReport } from "./hive-reports.js";
import { buildBadgeEligibilityForCandidates } from "./network-badges.js";
import { listNetworkTaskCandidateCapacityChecks } from "./network-task-capacity.js";
import { listEligibleNetworkTaskCandidates } from "./network-tasks.js";

export const hiveDecisionAgentVersion = "hive_decision_agent.v1";

export const hiveDecisionActions = Object.freeze([
  "create_board",
  "archive_board",
  "create_task",
  "cancel_task",
  "cancel_network_task",
  "message_user",
  "do_nothing",
]);

const terminalTaskStatuses = Object.freeze([
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "failed",
  "completed",
  "rewarded",
  "paid",
]);

const activeTaskStatuses = Object.freeze([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

const reportBodyMaxChars = 12_000;
const reportMetadataMaxChars = 4_000;
const discussionBodyMaxChars = 2_000;

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function iso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function boundedText(value = "", max = 1000) {
  const text = String(value || "").trim();
  return {
    text: text.slice(0, max),
    originalLength: text.length,
    truncated: text.length > max,
  };
}

function digestValue(value = {}) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeKey(value = "", max = 260) {
  return safeText(value, max)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identitySummary(accountId = "", fallback = {}) {
  const profile = accountId ? getAccountIdentityProfile({ accountId }) || {} : {};
  const hiveHandle = safeText(profile.hiveHandle || profile.handle || fallback.hiveHandle || fallback.handle, 120).replace(/^@+/, "");
  const displayName = safeText(
    profile.publicDisplayName || profile.displayName || fallback.displayName || (hiveHandle ? `@${hiveHandle}` : "") || accountId,
    160
  );
  return {
    accountId: safeText(accountId, 180),
    displayName,
    hiveHandle,
    primaryProvider: safeText(profile.primaryProvider || fallback.primaryProvider, 80),
  };
}

function reportInput(report = null) {
  if (!report) return null;
  const body = boundedText(report.bodyMarkdown || "", reportBodyMaxChars);
  const metadataText = JSON.stringify(safeObject(report.metadata));
  return {
    id: safeText(report.id, 180),
    type: safeText(report.type, 80),
    label: safeText(report.label, 120),
    generatedAt: safeText(report.generatedAt, 80),
    model: safeText(report.model, 180),
    bodyMarkdown: body.text,
    bodyMarkdownTruncated: body.truncated,
    bodyMarkdownOriginalLength: body.originalLength,
    metadata: metadataText.length > reportMetadataMaxChars
      ? {
          truncated: true,
          originalLength: metadataText.length,
          excerpt: metadataText.slice(0, reportMetadataMaxChars),
        }
      : safeObject(report.metadata),
  };
}

function compactProject(project = {}) {
  return {
    id: safeText(project.id, 180),
    name: safeText(project.name || project.title, 180),
    type: safeText(project.type, 120),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    summary: safeText(project.summary || project.objective || project.about, 800),
    taskCount: Number(project.taskCount || safeArray(project.tasks).length || 0),
    contributorCount: Number(project.contributorCount || safeArray(project.contributors).length || 0),
    pendingGenerationCount: Number(project.pendingGenerationCount || 0),
    tasks: safeArray(project.tasks).slice(0, 10).map((task) => ({
      taskId: safeText(task.taskId, 180),
      title: safeText(task.title, 240),
      state: safeText(task.state, 80),
      assigneeAccountId: safeText(task.assigneeAccountId, 180),
      assigneeHandle: safeText(task.assigneeHandle || task.assigneeDisplayName, 160),
      pft: numeric(task.pft),
      updatedAt: iso(task.updatedAt),
    })),
  };
}

function compactTaskMetadata(value = {}) {
  const metadata = safeObject(value);
  const txs = safeObject(metadata.txs);
  const cids = safeObject(metadata.cids);
  const generatedTask = safeObject(metadata.generatedTask);
  const networkTask = safeObject(generatedTask.network_task || metadata.network_task);
  const taskgen = safeObject(metadata.taskgen);
  return {
    lastEventTxHash: safeText(txs.last_event?.tx_hash || metadata.last_event_tx_hash || metadata.txHash, 140),
    lastEventCid: safeText(cids.last_event || metadata.lastEventCid, 140),
    requestBundleCid: safeText(cids.request_bundle || metadata.requestBundleCid, 140),
    contextDocCid: safeText(cids.context_doc || metadata.contextDocCid, 140),
    sourceRunId: safeText(metadata.runId || metadata.run_id, 180),
    taskgen: {
      promptVersion: safeText(taskgen.promptVersion || taskgen.prompt_version || metadata.promptVersion, 120),
      provider: safeText(taskgen.provider || metadata.provider, 80),
      model: safeText(taskgen.model || metadata.model, 180),
    },
    generatedLane: {
      projectId: safeText(networkTask.project_id || generatedTask.project_id, 180),
      requiredBadgeId: safeText(networkTask.required_badge_id || generatedTask.required_badge_id, 80),
      operatingBadgeId: safeText(networkTask.operating_badge_id || generatedTask.operating_badge_id, 80),
      taskWorkType: safeText(networkTask.task_work_type || generatedTask.task_work_type, 120),
    },
    cancellation: {
      cancelled: metadata.agent_cancelled === true,
      cancelledAt: safeText(metadata.agent_cancelled_at, 80),
      cancelledBy: safeText(metadata.agent_cancelled_by, 180),
      reason: safeText(metadata.agent_cancelled_reason, 500),
      referencedTaskIds: safeArray(metadata.agent_cancelled_referenced_task_ids)
        .map((item) => safeText(item, 180))
        .filter(Boolean)
        .slice(0, 10),
    },
  };
}

function taskRow(row = {}) {
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    accountId: safeText(row.account_id, 180),
    walletAddress: safeText(row.subject_wallet, 120),
    operator: identitySummary(row.account_id),
    status: safeText(row.status, 80),
    title: safeText(row.title, 260),
    description: safeText(row.description, 1200),
    submissionRequirement: safeText(row.submission_requirement_text, 900),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: iso(row.updated_at),
    lastEventAt: iso(row.last_event_at),
    metadata: compactTaskMetadata(row.metadata_json),
  };
}

function discussionRow(row = {}) {
  const body = boundedText(row.body || "", discussionBodyMaxChars);
  return {
    id: safeText(row.id, 180),
    accountId: safeText(row.account_id, 180),
    speaker: identitySummary(row.account_id, { displayName: row.display_name }),
    displayName: safeText(row.display_name, 160),
    body: body.text,
    bodyTruncated: body.truncated,
    bodyOriginalLength: body.originalLength,
    sourceConversationTitle: safeText(row.source_conversation_title, 160),
    createdAt: iso(row.created_at),
    metadata: safeObject(row.metadata_json),
  };
}

function compactCandidate(candidate = {}, capacity = null, badge = null) {
  const accountId = safeText(candidate.accountId || candidate.account_id, 180);
  const walletAddress = safeText(candidate.walletAddress || candidate.wallet_address, 120);
  return {
    accountId,
    walletAddress,
    identity: identitySummary(accountId),
    availableForNetworkTask: capacity ? capacity.availableForNetworkTask === true : false,
    blockers: safeArray(capacity?.blockers).slice(0, 5),
    verifiedBadges: safeArray(badge?.verifiedBadges).map((item) => safeText(item, 80)).filter(Boolean),
    defaultBadge: safeText(badge?.defaultBadge, 80),
    allowedWorkTypes: safeArray(badge?.allowedWorkTypes).map((item) => safeText(item, 120)).filter(Boolean),
    rewardCaps: safeObject(badge?.rewardCaps),
    badgeDetails: safeArray(badge?.badgeDetails).slice(0, 8).map((item) => ({
      badgeId: safeText(item.badgeId || item.badge_id, 80),
      label: safeText(item.label, 120),
      maxPayoutPft: numeric(item.maxPayoutPft || item.max_payout_pft),
      allowedWorkTypes: safeArray(item.allowedWorkTypes || item.allowed_work_types)
        .map((workType) => safeText(workType, 120))
        .filter(Boolean),
    })),
    profileSummary: safeText(candidate.profileSummary || candidate.summary || candidate.outputText || candidate.output_text, 900),
  };
}

async function latestReports() {
  const entries = await Promise.all(hiveReportTypeIds.map(async (type) => [type, await latestHiveReport({ type }).catch(() => null)]));
  return Object.fromEntries(entries.map(([type, report]) => [type, reportInput(report)]));
}

async function liveTaskRows() {
  const [outstanding, recentTerminal, generationJobs] = await Promise.all([
    query(
      `
        SELECT *
        FROM task_projections
        WHERE lower(task_kind) = 'network'
          AND lower(status) = ANY($1::text[])
        ORDER BY updated_at DESC, task_id DESC
        LIMIT 100
      `,
      [activeTaskStatuses]
    ).catch(() => ({ rows: [] })),
    query(
      `
        SELECT *
        FROM task_projections
        WHERE lower(task_kind) = 'network'
          AND lower(status) = ANY($1::text[])
        ORDER BY updated_at DESC, task_id DESC
        LIMIT 160
      `,
      [terminalTaskStatuses]
    ).catch(() => ({ rows: [] })),
    query(
      `
        SELECT id, project_id, status, allocation_id, request_id, task_id, candidate_account_id,
               candidate_wallet_address, project_need_summary, task_work_type, required_badge_id,
               operating_badge_id, reward_min_pft, reward_max_pft, created_at, updated_at
        FROM network_task_generation_jobs
        WHERE status IN ('queued', 'running', 'generated', 'link_failed')
        ORDER BY updated_at DESC, id DESC
        LIMIT 80
      `
    ).catch(() => ({ rows: [] })),
  ]);
  return {
    outstandingNetworkTasks: outstanding.rows.map(taskRow),
    recentTerminalNetworkTasks: recentTerminal.rows.map(taskRow),
    pendingGenerationJobs: generationJobs.rows.map((row) => ({
      id: safeText(row.id, 180),
      projectId: safeText(row.project_id, 180),
      status: safeText(row.status, 80),
      allocationId: safeText(row.allocation_id, 180),
      requestId: safeText(row.request_id, 180),
      taskId: safeText(row.task_id, 180),
      accountId: safeText(row.candidate_account_id, 180),
      walletAddress: safeText(row.candidate_wallet_address, 120),
      projectNeedSummary: safeText(row.project_need_summary, 700),
      taskWorkType: safeText(row.task_work_type, 120),
      requiredBadgeId: safeText(row.required_badge_id, 80),
      operatingBadgeId: safeText(row.operating_badge_id, 80),
      rewardMinPft: numeric(row.reward_min_pft),
      rewardMaxPft: numeric(row.reward_max_pft),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
  };
}

async function boardDiscussions() {
  const result = await query(
    `
      SELECT entry.*
      FROM hive_context_entries entry
      WHERE entry.deleted_at IS NULL
        AND entry.created_at >= now() - interval '72 hours'
        AND (
          EXISTS (
            SELECT 1
            FROM account_network_badges badge
            WHERE badge.account_id = entry.account_id
              AND badge.badge_id = 'project_leader'
              AND badge.status = 'verified'
              AND badge.revoked_at IS NULL
              AND (badge.expires_at IS NULL OR badge.expires_at > now())
          )
          OR entry.body ~* '(project|board|route|task|hive|priority|ship|build|qa|kol|developer|contributor)'
        )
      ORDER BY entry.created_at DESC, entry.id DESC
      LIMIT 80
    `
  ).catch(() => ({ rows: [] }));
  return result.rows.map(discussionRow);
}

async function projectSnapshot() {
  const document = await getHiveProjectsDocument({ includeEmptyActive: true }).catch(() => null);
  return {
    generatedAt: document?.generatedAt || new Date().toISOString(),
    stats: safeObject(document?.stats),
    projects: Object.values(safeObject(document?.projects)).map(compactProject).slice(0, 40),
  };
}

async function candidateSnapshot() {
  const candidates = await listEligibleNetworkTaskCandidates({ limit: 40 }).catch(() => []);
  const [badgeEligibility, capacityChecks] = await Promise.all([
    buildBadgeEligibilityForCandidates(candidates).catch(() => ({ candidates: [] })),
    listNetworkTaskCandidateCapacityChecks(candidates).catch(() => []),
  ]);
  const badgeByAccount = new Map(safeArray(badgeEligibility.candidates).map((item) => [safeText(item.accountId, 180), item]));
  const capacityByAccount = new Map(safeArray(capacityChecks).map((item) => [safeText(item.accountId, 180), item]));
  const rows = candidates.map((candidate) => {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    return compactCandidate(candidate, capacityByAccount.get(accountId), badgeByAccount.get(accountId));
  });
  return {
    candidates: rows,
    idleEligibleContributors: rows.filter((candidate) =>
      candidate.availableForNetworkTask &&
      candidate.verifiedBadges.length > 0
    ),
    badgeEligibility,
    capacityChecks,
  };
}

function dedupItemFromTask(task = {}) {
  const summary = normalizeKey([task.title, task.description, task.submissionRequirement].filter(Boolean).join(" "), 360);
  return {
    source: "task_projection",
    taskId: task.taskId,
    requestId: task.requestId,
    accountId: task.accountId,
    walletAddress: task.walletAddress,
    status: task.status,
    title: task.title,
    summaryKey: summary,
    active: activeTaskStatuses.includes(String(task.status || "").toLowerCase()),
    terminal: terminalTaskStatuses.includes(String(task.status || "").toLowerCase()),
    updatedAt: task.updatedAt,
  };
}

function dedupItemFromJob(job = {}) {
  return {
    source: "network_task_generation_jobs",
    jobId: job.id,
    taskId: job.taskId,
    requestId: job.requestId,
    accountId: job.accountId,
    walletAddress: job.walletAddress,
    status: job.status,
    title: job.projectNeedSummary,
    summaryKey: normalizeKey([job.projectNeedSummary, job.taskWorkType, job.requiredBadgeId].join(" "), 360),
    active: true,
    terminal: false,
    updatedAt: job.updatedAt,
  };
}

function buildDedupIndex(taskState = {}) {
  return [
    ...safeArray(taskState.outstandingNetworkTasks).map(dedupItemFromTask),
    ...safeArray(taskState.recentTerminalNetworkTasks).map(dedupItemFromTask),
    ...safeArray(taskState.pendingGenerationJobs).map(dedupItemFromJob),
  ];
}

export async function buildHiveDecisionSourcePacket({
  scope = "global_hive",
  trigger = "manual_shadow",
  now = new Date(),
  phase = "shadow",
} = {}) {
  const [
    reports,
    taskState,
    discussions,
    projects,
    candidateState,
  ] = await Promise.all([
    latestReports(),
    liveTaskRows(),
    boardDiscussions(),
    projectSnapshot(),
    candidateSnapshot(),
  ]);
  const packet = {
    schema: "pf.hive.decision_agent.source.v1",
    version: hiveDecisionAgentVersion,
    scope: safeText(scope, 120) || "global_hive",
    trigger: safeText(trigger, 160) || "manual_shadow",
    generatedAt: now.toISOString(),
    actionRegistry: hiveDecisionActions,
    phase: safeText(phase, 40) === "active" ? "active" : "shadow",
    reports,
    liveTaskState: taskState,
    projects,
    boardDiscussions: discussions,
    candidates: {
      all: candidateState.candidates,
      idleEligibleContributors: candidateState.idleEligibleContributors,
    },
    guardrails: {
      routeOnlyToIdleEligibleContributors: true,
      structuralDedupRequired: true,
      shadowOnlyNoMutations: safeText(phase, 40) !== "active",
      activeExecutionFeatureFlag: "TASKNODE_HIVE_DECISION_AGENT_ACTIVE",
      candidateCapacitySource: "listNetworkTaskCandidateCapacityChecks",
      dedupIndex: buildDedupIndex(taskState),
    },
  };
  return {
    ...packet,
    sourcePacketDigest: digestValue(packet),
  };
}

function normalizeDecisionAction(value = "") {
  const action = safeText(value, 80).toLowerCase();
  if (action === "cancel_network_task") return action;
  return hiveDecisionActions.includes(action) ? action : "do_nothing";
}

export function normalizeHiveDecisionOutput(value = {}) {
  const input = safeObject(value);
  const action = normalizeDecisionAction(input.action || input.selected_action || input.selectedAction);
  return {
    schema: "pf.hive.decision_agent.output.v1",
    explanation: safeText(input.explanation || input.reasoning || input.reasoning_text || "", 6000),
    optionsConsidered: safeArray(input.options_considered || input.optionsConsidered).slice(0, 8).map((item) => {
      const option = safeObject(item);
      return {
        action: normalizeDecisionAction(option.action),
        summary: safeText(option.summary || option.option || "", 800),
        rejectedBecause: safeText(option.rejected_because || option.rejectedBecause || option.reason || "", 1200),
      };
    }),
    informedBy: {
      reportIds: safeArray(input.informed_by?.report_ids || input.informedBy?.reportIds || input.report_ids || input.reportIds)
        .map((item) => safeText(item, 180)).filter(Boolean),
      taskStateRefs: safeArray(input.informed_by?.task_state_refs || input.informedBy?.taskStateRefs || input.task_state_refs)
        .map((item) => safeText(item, 180)).filter(Boolean),
      discussionIds: safeArray(input.informed_by?.discussion_ids || input.informedBy?.discussionIds || input.discussion_ids)
        .map((item) => safeText(item, 180)).filter(Boolean),
    },
    action,
    payload: safeObject(input.payload || input.action_payload || input.actionPayload),
    confidence: Math.max(0, Math.min(1, Number(input.confidence || 0))),
  };
}

function actionTaskText(payload = {}) {
  return normalizeKey([
    payload.title,
    payload.task_title,
    payload.project_need_summary,
    payload.summary,
    payload.description,
    payload.work_type,
    payload.task_work_type,
  ].filter(Boolean).join(" "), 420);
}

function sameCandidate(item = {}, payload = {}) {
  const accountId = safeText(payload.candidate_account_id || payload.candidateAccountId || payload.account_id || payload.accountId, 180);
  const walletAddress = safeText(payload.candidate_wallet_address || payload.candidateWalletAddress || payload.wallet_address || payload.walletAddress, 120);
  return (
    (accountId && item.accountId === accountId) ||
    (walletAddress && item.walletAddress === walletAddress)
  );
}

function duplicateMatches(decision = {}, sourcePacket = {}) {
  const payload = safeObject(decision.payload);
  const text = actionTaskText(payload);
  if (!text) return [];
  const keyWords = new Set(text.split(" ").filter((word) => word.length >= 4).slice(0, 30));
  return safeArray(sourcePacket.guardrails?.dedupIndex)
    .filter((item) => sameCandidate(item, payload))
    .map((item) => {
      const itemText = safeText(item.summaryKey, 500);
      const itemWords = new Set(itemText.split(" ").filter((word) => word.length >= 4));
      const overlap = [...keyWords].filter((word) => itemWords.has(word)).length;
      const exactTitle = normalizeKey(item.title, 260) && normalizeKey(item.title, 260) === normalizeKey(payload.title || payload.task_title, 260);
      return {
        ...item,
        overlap,
        exactTitle,
        duplicateLikely: exactTitle || overlap >= Math.min(5, Math.max(3, Math.floor(keyWords.size * 0.35))),
      };
    })
    .filter((item) => item.active || item.terminal)
    .filter((item) => item.duplicateLikely)
    .slice(0, 12);
}

function idleCandidateMatches(decision = {}, sourcePacket = {}) {
  const payload = safeObject(decision.payload);
  const accountId = safeText(payload.candidate_account_id || payload.candidateAccountId || payload.account_id || payload.accountId, 180);
  const walletAddress = safeText(payload.candidate_wallet_address || payload.candidateWalletAddress || payload.wallet_address || payload.walletAddress, 120);
  const requiredBadge = safeText(payload.required_badge_id || payload.requiredBadgeId || payload.badge_id || payload.badgeId, 80);
  return safeArray(sourcePacket.candidates?.idleEligibleContributors).filter((candidate) => {
    const same = (accountId && candidate.accountId === accountId) || (walletAddress && candidate.walletAddress === walletAddress);
    if (!same) return false;
    return !requiredBadge || candidate.verifiedBadges.includes(requiredBadge);
  });
}

function badgeLaneViolations({ decision = {}, idleMatches = [] } = {}) {
  const payload = safeObject(decision.payload);
  const requiredBadge = safeText(payload.required_badge_id || payload.requiredBadgeId || payload.badge_id || payload.badgeId, 80);
  const operatingBadge = safeText(payload.operating_badge_id || payload.operatingBadgeId || requiredBadge, 80);
  const workType = safeText(
    payload.badge_work_type ||
      payload.badgeWorkType ||
      payload.task_work_type ||
      payload.taskWorkType,
    120
  );
  const rewardMax = numeric(payload.reward_max_pft ?? payload.rewardMaxPft, 0);
  const rewardMin = numeric(payload.reward_min_pft ?? payload.rewardMinPft, 0);
  const violations = [];
  for (const candidate of safeArray(idleMatches)) {
    const allowedWorkTypes = safeArray(candidate.allowedWorkTypes);
    const rewardCaps = safeObject(candidate.rewardCaps);
    const badgeKnown = !requiredBadge || safeArray(candidate.verifiedBadges).includes(requiredBadge);
    const operatingKnown = !operatingBadge || safeArray(candidate.verifiedBadges).includes(operatingBadge);
    const workTypeAllowed = !workType || allowedWorkTypes.includes(workType) || Number(rewardCaps[workType] || 0) > 0;
    const cap = numeric(rewardCaps[workType], 0);
    if (!badgeKnown || !operatingKnown || !workTypeAllowed || (cap > 0 && (rewardMax > cap || rewardMin > cap))) {
      violations.push({
        accountId: candidate.accountId,
        walletAddress: candidate.walletAddress,
        requiredBadge,
        operatingBadge,
        workType,
        rewardMinPft: rewardMin,
        rewardMaxPft: rewardMax,
        allowedWorkTypes,
        rewardCapPft: cap,
        badgeKnown,
        operatingKnown,
        workTypeAllowed,
      });
    }
  }
  return violations;
}

export function applyHiveDecisionGuardrails({ decision = {}, sourcePacket = {} } = {}) {
  const action = normalizeDecisionAction(decision.action);
  const active = sourcePacket.phase === "active";
  const result = {
    ok: true,
    shadowOnly: !active,
    action,
    blocked: false,
    reasons: [],
    notes: [
      active
        ? "Phase 3 Decision Agent active mode: deterministic executor may mutate after guardrails pass."
        : "Decision Agent shadow mode: no mutations are executed.",
    ],
  };
  if (action !== "create_task") {
    return result;
  }
  const idleMatches = idleCandidateMatches(decision, sourcePacket);
  if (!idleMatches.length) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("candidate_not_idle_badge_eligible_or_at_capacity");
  }
  const laneViolations = badgeLaneViolations({ decision, idleMatches });
  if (laneViolations.length) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("badge_lane_or_reward_cap_mismatch");
    result.badgeLaneViolations = laneViolations;
  }
  const duplicates = duplicateMatches(decision, sourcePacket);
  if (duplicates.length) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("structural_dedup_match");
    result.duplicates = duplicates;
  }
  result.idleEligibleMatches = idleMatches.slice(0, 4);
  return result;
}

function runRow(row = {}, { includeSourcePacket = true } = {}) {
  const sourcePacketBytes = Number(row.source_packet_bytes || 0);
  return {
    id: safeText(row.id, 180),
    scope: safeText(row.scope, 120),
    trigger: safeText(row.trigger, 160),
    status: safeText(row.status, 80),
    shadow: row.shadow !== false,
    sourcePacketDigest: safeText(row.source_packet_digest, 120),
    sourcePacketBytes,
    sourcePacketOmitted: !includeSourcePacket && sourcePacketBytes > 0,
    inputReportIds: safeArray(row.input_report_ids),
    taskStatusSnapshot: safeObject(row.task_status_snapshot_json),
    discussionIds: safeArray(row.discussion_ids),
    sourcePacket: includeSourcePacket ? safeObject(row.source_packet_json) : {},
    reasoningText: row.reasoning_text || "",
    optionsConsidered: safeArray(row.options_considered_json),
    informedBy: safeObject(row.informed_by_json),
    selectedAction: safeText(row.selected_action, 80),
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    guardrailResult: safeObject(row.guardrail_result_json),
    result: safeObject(row.result_json),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 180),
    reasoningEffort: safeText(row.reasoning_effort, 40),
    outputText: row.output_text || "",
    error: row.error || "",
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function startHiveDecisionRun({
  scope = "global_hive",
  trigger = "shadow_tick",
  sourcePacket = {},
  provider = "openrouter",
  model = "",
  reasoningEffort = "high",
  shadow = true,
} = {}) {
  if (!useDatabase()) throw new Error("hive_decision_database_not_configured");
  const id = `hivedec_${randomUUID()}`;
  const inputReportIds = Object.values(safeObject(sourcePacket.reports)).map((report) => safeText(report?.id, 180)).filter(Boolean);
  const discussionIds = safeArray(sourcePacket.boardDiscussions).map((discussion) => discussion.id).filter(Boolean);
  const taskStatusSnapshot = {
    outstandingNetworkTaskCount: safeArray(sourcePacket.liveTaskState?.outstandingNetworkTasks).length,
    recentTerminalNetworkTaskCount: safeArray(sourcePacket.liveTaskState?.recentTerminalNetworkTasks).length,
    pendingGenerationJobCount: safeArray(sourcePacket.liveTaskState?.pendingGenerationJobs).length,
    idleEligibleContributorCount: safeArray(sourcePacket.candidates?.idleEligibleContributors).length,
  };
  const result = await query(
    `
      INSERT INTO hive_decision_runs (
        id, scope, trigger, status, shadow, source_packet_digest, input_report_ids,
        task_status_snapshot_json, discussion_ids, source_packet_json, provider, model,
        reasoning_effort, started_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'running', $12, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, now(), now(), now())
      RETURNING *
    `,
    [
      id,
      safeText(scope, 120) || "global_hive",
      safeText(trigger, 160) || "shadow_tick",
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue(inputReportIds),
      jsonValue(taskStatusSnapshot),
      jsonValue(discussionIds),
      jsonValue(sourcePacket),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(reasoningEffort, 40),
      Boolean(shadow),
    ]
  );
  return runRow(result.rows[0]);
}

export async function completeHiveDecisionRun({
  runId = "",
  decision = {},
  guardrailResult = {},
  executionResult = null,
  shadow = true,
  outputText = "",
  usage = {},
  provider = "",
  model = "",
} = {}) {
  const normalized = normalizeHiveDecisionOutput(decision);
  const result = await query(
    `
      UPDATE hive_decision_runs
      SET status = 'completed',
          reasoning_text = $2,
          options_considered_json = $3::jsonb,
          informed_by_json = $4::jsonb,
          selected_action = $5,
          action_payload_json = $6::jsonb,
          decision_json = $7::jsonb,
          guardrail_result_json = $8::jsonb,
          result_json = $9::jsonb,
          provider = COALESCE(NULLIF($10, ''), provider),
          model = COALESCE(NULLIF($11, ''), model),
          output_text = $12,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING *
    `,
    [
      safeText(runId, 180),
      normalized.explanation,
      jsonValue(normalized.optionsConsidered),
      jsonValue(normalized.informedBy),
      normalized.action,
      jsonValue(normalized.payload),
      jsonValue(normalized),
      jsonValue(guardrailResult),
      jsonValue({
        shadow: Boolean(shadow),
        executed: executionResult?.executed === true,
        executionResult,
        usage,
        guardrailOk: guardrailResult?.ok === true,
      }),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(outputText, 250_000),
    ]
  );
  if (!result.rows[0]) throw new Error("hive_decision_run_not_running");
  return runRow(result.rows[0]);
}

export async function failHiveDecisionRun({ runId = "", error = "", outputText = "" } = {}) {
  const result = await query(
    `
      UPDATE hive_decision_runs
      SET status = 'failed',
          error = $2,
          output_text = $3,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING *
    `,
    [safeText(runId, 180), safeText(error, 2000), safeText(outputText, 250_000)]
  );
  return result.rows[0] ? runRow(result.rows[0]) : null;
}

export async function failStaleHiveDecisionRuns({ staleMinutes = 30, limit = 20 } = {}) {
  if (!useDatabase()) return [];
  const minutes = Math.min(Math.max(Number(staleMinutes) || 30, 5), 1440);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await query(
    `
      UPDATE hive_decision_runs
      SET status = 'failed',
          error = COALESCE(NULLIF(error, ''), 'hive_decision_stale_running_reclaimed'),
          result_json = COALESCE(result_json, '{}'::jsonb)
            || jsonb_build_object('reclaimed', true, 'staleMinutes', $1::int),
          completed_at = now(),
          updated_at = now()
      WHERE id IN (
        SELECT id
        FROM hive_decision_runs
        WHERE status = 'running'
          AND started_at < now() - ($1::text || ' minutes')::interval
        ORDER BY started_at ASC, id ASC
        LIMIT $2
      )
      RETURNING *
    `,
    [minutes, safeLimit]
  );
  return result.rows.map(runRow);
}

export async function listHiveDecisionRuns({ limit = 20, page = 1, action = "all" } = {}) {
  if (!useDatabase()) return { ok: true, runs: [], page: 1, pageSize: 0, hasMore: false };
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 80);
  const normalizedPage = Math.min(Math.max(Number(page) || 1, 1), 1000);
  const filters = [];
  const params = [];
  const normalizedAction = safeText(action, 80);
  if (normalizedAction && normalizedAction !== "all") {
    params.push(normalizedAction);
    filters.push(`selected_action = $${params.length}`);
  }
  params.push(normalizedLimit + 1, (normalizedPage - 1) * normalizedLimit);
  const result = await query(
    `
      SELECT id, scope, trigger, status, shadow, source_packet_digest, input_report_ids,
             task_status_snapshot_json, discussion_ids, reasoning_text, options_considered_json,
             informed_by_json, selected_action, action_payload_json, decision_json,
             guardrail_result_json, result_json, provider, model, reasoning_effort,
             output_text, error, started_at, completed_at, created_at, updated_at,
             '{}'::jsonb AS source_packet_json
      FROM hive_decision_runs
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params
  );
  return {
    ok: true,
    runs: result.rows.slice(0, normalizedLimit).map(runRow),
    page: normalizedPage,
    pageSize: normalizedLimit,
    hasMore: result.rows.length > normalizedLimit,
    filters: { action: normalizedAction || "all" },
  };
}

export async function getHiveDecisionRun({ runId = "", includeSourcePacket = true } = {}) {
  const normalizedRunId = safeText(runId, 180);
  if (!normalizedRunId) return { ok: false, status: 400, error: "hive_decision_run_id_required" };
  if (!useDatabase()) return { ok: false, status: 503, error: "hive_decision_database_not_configured" };
  const sourceSelect = includeSourcePacket ? "source_packet_json" : "'{}'::jsonb AS source_packet_json";
  const result = await query(
    `
      SELECT id, scope, trigger, status, shadow, source_packet_digest, input_report_ids,
             task_status_snapshot_json, discussion_ids, ${sourceSelect}, reasoning_text,
             options_considered_json, informed_by_json, selected_action, action_payload_json,
             decision_json, guardrail_result_json, result_json, provider, model,
             reasoning_effort, output_text, error, started_at, completed_at, created_at, updated_at,
             pg_column_size(source_packet_json) AS source_packet_bytes
      FROM hive_decision_runs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedRunId]
  );
  const row = result.rows[0] || null;
  if (!row) return { ok: false, status: 404, error: "hive_decision_run_not_found" };
  return { ok: true, run: runRow(row, { includeSourcePacket }) };
}

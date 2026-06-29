import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";
import { buildHiveDecisionSourcePacket } from "./hive-decision-agent.js";
import { buildNetworkTaskProfileSource } from "./network-task-profile.js";
import { enqueueNetworkTaskGenerationFromBoardDecision } from "./network-tasks.js";

export const hiveTaskManagerVersion = "hive_task_manager.v1";
export const hiveTaskManagerActions = Object.freeze(["create_task", "do_nothing"]);

const activeTaskStatuses = new Set([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function digestValue(value = {}) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeKey(value = "", max = 360) {
  return safeText(value, max)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipTask(task = {}) {
  return {
    title: safeText(task.title, 220),
    kind: safeText(task.kind, 80),
    status: safeText(task.status, 80),
    reward: safeText(task.reward, 120),
    summary: safeText(task.summary, 700),
    outcome: safeText(task.outcome, 700),
  };
}

function compactOperatorPacket(candidate = {}, profileSource = null) {
  const sourceJson = safeObject(profileSource?.sourceJson);
  const latestProfile = safeObject(sourceJson.latest_public_profile_snapshot);
  const contextDocument = safeObject(sourceJson.context_document);
  const networkInputs = safeObject(sourceJson.network_context_inputs);
  return {
    accountId: safeText(candidate.accountId, 180),
    walletAddress: safeText(candidate.walletAddress, 120),
    identity: safeObject(candidate.identity),
    verifiedBadges: safeArray(candidate.verifiedBadges).slice(0, 8),
    defaultBadge: safeText(candidate.defaultBadge, 80),
    allowedWorkTypes: safeArray(candidate.allowedWorkTypes).slice(0, 20),
    rewardCaps: safeObject(candidate.rewardCaps),
    badgeDetails: safeArray(candidate.badgeDetails).slice(0, 8),
    availableForNetworkTask: candidate.availableForNetworkTask === true,
    blockers: safeArray(candidate.blockers).slice(0, 6),
    publicProfile: {
      roleTitle: safeText(latestProfile.roleTitle, 180),
      roleSummary: safeText(latestProfile.roleSummary, 1200),
      skills: safeArray(latestProfile.skills).slice(0, 12),
      bestFit: safeText(latestProfile.bestFit, 900),
      profileSummary: safeText(candidate.profileSummary, 900),
    },
    memory: {
      contextTitle: safeText(contextDocument.title, 160),
      contextUpdatedAt: safeText(contextDocument.updated_at, 80),
      contextExcerpt: safeText(contextDocument.body_text, 2000),
      deepMemory: safeArray(sourceJson.deep_memory).slice(0, 3).map((entry) => ({
        createdAt: safeText(entry.created_at, 80),
        memoryText: safeText(entry.memory_text, 900),
      })),
    },
    taskState: {
      counts: safeObject(networkInputs.counts),
      currentTasks: {
        proposed: safeArray(sourceJson.current_tasks?.proposed).slice(0, 4).map(clipTask),
        outstanding: safeArray(sourceJson.current_tasks?.outstanding).slice(0, 4).map(clipTask),
        verification: safeArray(sourceJson.current_tasks?.verification).slice(0, 4).map(clipTask),
      },
      refused: safeArray(sourceJson.recently_refused_tasks).slice(0, 6).map(clipTask),
      rewarded: safeArray(sourceJson.recently_rewarded_tasks).slice(0, 6).map(clipTask),
    },
    sourcePacketDigest: safeText(profileSource?.sourcePacketDigest, 120),
  };
}

function compactBoardPacket(project = {}) {
  return {
    projectId: safeText(project.id, 180),
    title: safeText(project.name || project.title, 220),
    type: safeText(project.type, 120),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    summary: safeText(project.summary, 1200),
    taskCount: Number(project.taskCount || 0),
    tasksInFlight: Number(project.tasksInFlight || 0),
    terminalTaskCount: Number(project.terminalTaskCount || 0),
    contributorCount: Number(project.contributorCount || 0),
    pendingGenerationCount: Number(project.pendingGenerationCount || 0),
    tasks: safeArray(project.tasks).slice(0, 12),
  };
}

function reportIds(reports = {}) {
  return Object.values(safeObject(reports))
    .map((report) => safeText(report?.id, 180))
    .filter(Boolean);
}

function discussionIds(sourcePacket = {}) {
  return safeArray(sourcePacket.boardDiscussions).map((discussion) => safeText(discussion.id, 180)).filter(Boolean);
}

function taskStatusSnapshot(sourcePacket = {}) {
  return {
    outstandingNetworkTaskCount: safeArray(sourcePacket.liveTaskState?.outstandingNetworkTasks).length,
    recentTerminalNetworkTaskCount: safeArray(sourcePacket.liveTaskState?.recentTerminalNetworkTasks).length,
    pendingGenerationJobCount: safeArray(sourcePacket.liveTaskState?.pendingGenerationJobs).length,
    eligibleOperatorCount: safeArray(sourcePacket.eligibleSelectionPool).length,
  };
}

export async function buildHiveTaskManagerSourcePacket({
  scope = "global_hive",
  trigger = "periodic_tick",
  now = new Date(),
  phase = "active",
} = {}) {
  const base = await buildHiveDecisionSourcePacket({
    scope: safeText(scope, 120) || "global_hive",
    trigger,
    now,
    phase,
  });
  const activeBoards = safeArray(base.projects?.projects)
    .filter((project) => safeText(project.status, 80) === "active")
    .map(compactBoardPacket)
    .slice(0, 40);
  const eligibleOperators = safeArray(base.candidates?.idleEligibleContributors)
    .filter((candidate) => candidate.availableForNetworkTask === true && safeArray(candidate.verifiedBadges).length > 0)
    .slice(0, 12);
  const operatorEntries = await Promise.all(eligibleOperators.map(async (candidate) => {
    const profileSource = await buildNetworkTaskProfileSource({ accountId: candidate.accountId }).catch((error) => ({
      error: safeText(error?.message || error, 300),
    }));
    return [candidate.accountId, compactOperatorPacket(candidate, profileSource)];
  }));
  const operatorPacketsByAccount = Object.fromEntries(operatorEntries);
  const boardPacketsByProjectId = Object.fromEntries(activeBoards.map((board) => [board.projectId, board]));
  const packet = {
    ...base,
    schema: "pf.hive.task_manager.source.v1",
    version: hiveTaskManagerVersion,
    manager: "hive_task_manager",
    cadenceSeconds: 300,
    generatedAt: now.toISOString(),
    phase: safeText(phase, 40) === "active" ? "active" : "shadow",
    actionRegistry: hiveTaskManagerActions,
    selectionContract: {
      step1: "Select exactly one active board and one idle badge-eligible operator from eligibleSelectionPool.",
      step2: "Pass boardPacket and operatorPacket into the existing Network Task generator after guardrails pass.",
      contributorBadgeRequired: true,
      liveTasksRequired: true,
      refusalHistoryRequired: true,
      userMemoryRequired: true,
      maxTasksPerRun: 1,
      taskGeneratorPrompt: "prompts/task_engine/taskgen_network_v1.md",
      selectorPrompt: "prompts/hive/task_manager_selection_v1.md",
    },
    boardPacketsByProjectId,
    activeBoards,
    eligibleSelectionPool: eligibleOperators.map((candidate) => ({
      accountId: safeText(candidate.accountId, 180),
      walletAddress: safeText(candidate.walletAddress, 120),
      identity: safeObject(candidate.identity),
      verifiedBadges: safeArray(candidate.verifiedBadges).slice(0, 8),
      defaultBadge: safeText(candidate.defaultBadge, 80),
      allowedWorkTypes: safeArray(candidate.allowedWorkTypes).slice(0, 20),
      rewardCaps: safeObject(candidate.rewardCaps),
      badgeDetails: safeArray(candidate.badgeDetails).slice(0, 8),
      operatorPacketRef: `operatorPacketsByAccount.${safeText(candidate.accountId, 180)}`,
    })),
    operatorPacketsByAccount,
    sourceCounts: {
      activeBoardCount: activeBoards.length,
      eligibleOperatorCount: eligibleOperators.length,
      outstandingNetworkTaskCount: safeArray(base.liveTaskState?.outstandingNetworkTasks).length,
      pendingGenerationJobCount: safeArray(base.liveTaskState?.pendingGenerationJobs).length,
      recentTerminalNetworkTaskCount: safeArray(base.liveTaskState?.recentTerminalNetworkTasks).length,
      reportCount: reportIds(base.reports).length,
    },
  };
  return {
    ...packet,
    sourcePacketDigest: digestValue({
      schema: packet.schema,
      generatedAt: packet.generatedAt,
      activeBoards: packet.activeBoards,
      eligibleSelectionPool: packet.eligibleSelectionPool,
      liveTaskState: packet.liveTaskState,
      reports: packet.reports,
      operatorPacketDigests: Object.fromEntries(Object.entries(operatorPacketsByAccount).map(([accountId, value]) => [
        accountId,
        digestValue(value),
      ])),
    }),
  };
}

function normalizeAction(value = "") {
  const action = safeText(value, 80).toLowerCase();
  return hiveTaskManagerActions.includes(action) ? action : "do_nothing";
}

export function normalizeTaskManagerOutput(value = {}) {
  const input = safeObject(value);
  return {
    schema: "pf.hive.task_manager.output.v1",
    explanation: safeText(input.explanation || input.reasoning || "", 6000),
    action: normalizeAction(input.action || input.selected_action || input.selectedAction),
    boardSelection: {
      projectId: safeText(input.board_selection?.project_id || input.boardSelection?.projectId || input.project_id, 180),
      title: safeText(input.board_selection?.title || input.boardSelection?.title, 220),
      whyThisBoard: safeText(input.board_selection?.why_this_board || input.boardSelection?.whyThisBoard, 1200),
    },
    operatorSelection: {
      accountId: safeText(input.operator_selection?.account_id || input.operatorSelection?.accountId || input.account_id, 180),
      walletAddress: safeText(input.operator_selection?.wallet_address || input.operatorSelection?.walletAddress || input.wallet_address, 120),
      requiredBadgeId: safeText(input.operator_selection?.required_badge_id || input.operatorSelection?.requiredBadgeId, 80),
      operatingBadgeId: safeText(input.operator_selection?.operating_badge_id || input.operatorSelection?.operatingBadgeId, 80),
      taskWorkType: safeText(input.operator_selection?.task_work_type || input.operatorSelection?.taskWorkType, 120),
      badgeWorkType: safeText(input.operator_selection?.badge_work_type || input.operatorSelection?.badgeWorkType, 120),
      whyThisOperator: safeText(input.operator_selection?.why_this_operator || input.operatorSelection?.whyThisOperator, 1200),
    },
    taskIntent: {
      title: safeText(input.task_intent?.title || input.taskIntent?.title, 220),
      projectNeedSummary: safeText(input.task_intent?.project_need_summary || input.taskIntent?.projectNeedSummary, 2400),
      routingReason: safeText(input.task_intent?.routing_reason || input.taskIntent?.routingReason, 1800),
      dedupBasis: safeText(input.task_intent?.dedup_basis || input.taskIntent?.dedupBasis, 1200),
      actionOutput: safeText(input.task_intent?.action_output || input.taskIntent?.actionOutput, 1200),
      deliverySurface: safeText(input.task_intent?.delivery_surface || input.taskIntent?.deliverySurface, 160),
      recipientOrReviewer: safeText(input.task_intent?.recipient_or_reviewer || input.taskIntent?.recipientOrReviewer, 240),
      escalationStage: safeText(input.task_intent?.escalation_stage || input.taskIntent?.escalationStage, 120),
      rewardMinPft: numeric(input.task_intent?.reward_min_pft ?? input.taskIntent?.rewardMinPft, 0),
      rewardMaxPft: numeric(input.task_intent?.reward_max_pft ?? input.taskIntent?.rewardMaxPft, 0),
    },
    constraintsChecked: {
      contributorBadge: input.constraints_checked?.contributor_badge === true || input.constraintsChecked?.contributorBadge === true,
      operatorIdle: input.constraints_checked?.operator_idle === true || input.constraintsChecked?.operatorIdle === true,
      refusalHistory: input.constraints_checked?.refusal_history === true || input.constraintsChecked?.refusalHistory === true,
      rewardedHistory: input.constraints_checked?.rewarded_history === true || input.constraintsChecked?.rewardedHistory === true,
      notDuplicative: input.constraints_checked?.not_duplicative === true || input.constraintsChecked?.notDuplicative === true,
      coldStartProblem: input.constraints_checked?.cold_start_problem === true || input.constraintsChecked?.coldStartProblem === true,
    },
    confidence: Math.max(0, Math.min(1, numeric(input.confidence, 0))),
  };
}

function candidateForSelection(selection = {}, sourcePacket = {}) {
  const accountId = selection.operatorSelection.accountId;
  const walletAddress = selection.operatorSelection.walletAddress;
  return safeArray(sourcePacket.eligibleSelectionPool).find((candidate) => (
    (!accountId || candidate.accountId === accountId) &&
    (!walletAddress || candidate.walletAddress === walletAddress)
  )) || null;
}

function activeBoardForSelection(selection = {}, sourcePacket = {}) {
  const projectId = selection.boardSelection.projectId;
  return safeArray(sourcePacket.activeBoards).find((board) => board.projectId === projectId) || null;
}

function duplicateMatches(selection = {}, sourcePacket = {}) {
  const candidate = selection.operatorSelection;
  const intentText = normalizeKey([
    selection.taskIntent.title,
    selection.taskIntent.projectNeedSummary,
    selection.taskIntent.actionOutput,
  ].filter(Boolean).join(" "), 520);
  if (!intentText) return [];
  const words = new Set(intentText.split(" ").filter((word) => word.length >= 4).slice(0, 36));
  return safeArray(sourcePacket.guardrails?.dedupIndex)
    .filter((item) => (
      (candidate.accountId && item.accountId === candidate.accountId) ||
      (candidate.walletAddress && item.walletAddress === candidate.walletAddress)
    ))
    .map((item) => {
      const itemText = normalizeKey([item.title, item.summaryKey].filter(Boolean).join(" "), 520);
      const itemWords = new Set(itemText.split(" ").filter((word) => word.length >= 4));
      const overlap = [...words].filter((word) => itemWords.has(word)).length;
      const exactTitle = normalizeKey(item.title, 260) && normalizeKey(item.title, 260) === normalizeKey(selection.taskIntent.title, 260);
      return {
        source: safeText(item.source, 80),
        taskId: safeText(item.taskId, 180),
        jobId: safeText(item.jobId, 180),
        status: safeText(item.status, 80),
        title: safeText(item.title, 240),
        active: item.active === true || activeTaskStatuses.has(safeText(item.status, 80).toLowerCase()),
        overlap,
        exactTitle,
      };
    })
    .filter((item) => item.exactTitle || item.overlap >= Math.min(5, Math.max(3, Math.floor(words.size * 0.35))))
    .slice(0, 8);
}

export function applyTaskManagerGuardrails({ selection = {}, sourcePacket = {} } = {}) {
  const normalized = normalizeTaskManagerOutput(selection);
  const result = {
    ok: true,
    blocked: false,
    action: normalized.action,
    reasons: [],
    notes: [],
  };
  if (normalized.action !== "create_task") {
    result.notes.push("Task Manager chose no task for this tick.");
    return result;
  }
  const board = activeBoardForSelection(normalized, sourcePacket);
  if (!board) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("selected_board_not_active");
  }
  const candidate = candidateForSelection(normalized, sourcePacket);
  if (!candidate) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("selected_operator_not_in_eligible_pool");
  } else {
    const requiredBadge = normalized.operatorSelection.requiredBadgeId || candidate.defaultBadge || candidate.verifiedBadges?.[0] || "";
    const operatingBadge = normalized.operatorSelection.operatingBadgeId || requiredBadge;
    const workType = normalized.operatorSelection.badgeWorkType || normalized.operatorSelection.taskWorkType || candidate.allowedWorkTypes?.[0] || "";
    const rewardMax = normalized.taskIntent.rewardMaxPft;
    const rewardMin = normalized.taskIntent.rewardMinPft;
    const cap = numeric(candidate.rewardCaps?.[workType] || candidate.badgeDetails?.find((badge) => badge.badgeId === requiredBadge)?.maxPayoutPft, 0);
    if (!safeArray(candidate.verifiedBadges).includes(requiredBadge) || !safeArray(candidate.verifiedBadges).includes(operatingBadge)) {
      result.ok = false;
      result.blocked = true;
      result.reasons.push("selected_operator_missing_required_badge");
    }
    if (workType && !safeArray(candidate.allowedWorkTypes).includes(workType) && !Number(candidate.rewardCaps?.[workType] || 0)) {
      result.ok = false;
      result.blocked = true;
      result.reasons.push("selected_work_type_not_allowed_for_badge");
    }
    if (cap > 0 && (rewardMax > cap || rewardMin > cap)) {
      result.ok = false;
      result.blocked = true;
      result.reasons.push("selected_reward_exceeds_badge_cap");
      result.rewardCapPft = cap;
    }
  }
  if (!normalized.taskIntent.projectNeedSummary) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("missing_project_need_summary");
  }
  const duplicates = duplicateMatches(normalized, sourcePacket);
  if (duplicates.length) {
    result.ok = false;
    result.blocked = true;
    result.reasons.push("structural_dedup_match");
    result.duplicates = duplicates;
  }
  result.board = board;
  result.candidate = candidate;
  return result;
}

export function translateTaskManagerSelectionToBoardDecision({ selection = {}, sourcePacket = {} } = {}) {
  const normalized = normalizeTaskManagerOutput(selection);
  const candidate = candidateForSelection(normalized, sourcePacket) || {};
  const board = activeBoardForSelection(normalized, sourcePacket) || {};
  const requiredBadgeId = normalized.operatorSelection.requiredBadgeId || candidate.defaultBadge || candidate.verifiedBadges?.[0] || "";
  const taskWorkType = normalized.operatorSelection.taskWorkType || candidate.allowedWorkTypes?.[0] || "capability_gating_task";
  const operatingBadgeId = normalized.operatorSelection.operatingBadgeId || requiredBadgeId;
  const badgeWorkType = normalized.operatorSelection.badgeWorkType || taskWorkType;
  const rewardCap = numeric(candidate.rewardCaps?.[badgeWorkType] || candidate.badgeDetails?.find((badge) => badge.badgeId === requiredBadgeId)?.maxPayoutPft, 0);
  const rewardMax = normalized.taskIntent.rewardMaxPft || rewardCap || 50000;
  const rewardMin = normalized.taskIntent.rewardMinPft || Math.min(rewardMax, Math.max(100, Math.floor(rewardMax * 0.2)));
  const projectNeed = [
    normalized.taskIntent.title,
    normalized.taskIntent.projectNeedSummary,
  ].filter(Boolean).join("\n\n");
  return {
    action: "initiate_network_task",
    target_type: "network_project",
    target_id: normalized.boardSelection.projectId,
    reason: normalized.taskIntent.routingReason || normalized.explanation,
    confidence: normalized.confidence,
    decision_basis: {
      source_facts: [
        normalized.boardSelection.projectId,
        normalized.operatorSelection.accountId,
        normalized.operatorSelection.walletAddress,
      ].filter(Boolean),
      rejected_actions: [normalized.taskIntent.dedupBasis].filter(Boolean),
      task_manager_selection: normalized,
    },
    payload: {
      summary: safeText(projectNeed || normalized.explanation, 1200),
      project: {
        id: board.projectId || normalized.boardSelection.projectId,
        type: board.type || "",
      },
      network_task: {
        task_class: board.type === "alpha_generation" ? "alpha" : "network",
        task_work_type: taskWorkType,
        required_badge_id: requiredBadgeId,
        operating_badge_id: operatingBadgeId,
        badge_work_type: badgeWorkType,
        badge_reason: normalized.operatorSelection.whyThisOperator || normalized.taskIntent.routingReason,
        badge_reward_cap_pft: rewardCap,
        discord_evidence_required: true,
        candidate_account_id: normalized.operatorSelection.accountId,
        candidate_wallet_address: normalized.operatorSelection.walletAddress,
        project_need_summary: safeText(projectNeed, 2400),
        routing_reason: safeText(normalized.taskIntent.routingReason || normalized.operatorSelection.whyThisOperator, 1800),
        cadence_reason: "hive_task_manager_5_minute_tick",
        action_output: normalized.taskIntent.actionOutput,
        delivery_surface: normalized.taskIntent.deliverySurface || "task_node",
        recipient_or_reviewer: normalized.taskIntent.recipientOrReviewer,
        escalation_stage: normalized.taskIntent.escalationStage || "normal",
        why_not_duplicate: normalized.taskIntent.dedupBasis,
        reward_min_pft: rewardMin,
        reward_max_pft: rewardMax,
        accept_window_hours: 24,
      },
    },
  };
}

export async function startHiveTaskManagerRun({
  scope = "global_hive",
  trigger = "periodic_tick",
  sourcePacket = {},
  provider = "openrouter",
  model = "",
  reasoningEffort = "high",
  shadow = false,
} = {}) {
  if (!useDatabase()) throw new Error("hive_task_manager_database_not_configured");
  const id = `hivetaskmgr_${randomUUID()}`;
  const result = await query(
    `
      INSERT INTO hive_decision_runs (
        id, scope, trigger, status, shadow, source_packet_digest, input_report_ids,
        task_status_snapshot_json, discussion_ids, source_packet_json, provider, model,
        reasoning_effort, started_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'running', $12, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, now(), now(), now())
      RETURNING id
    `,
    [
      id,
      `hive_task_manager:${safeText(scope, 120) || "global_hive"}`,
      safeText(trigger, 160) || "periodic_tick",
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue(reportIds(sourcePacket.reports)),
      jsonValue(taskStatusSnapshot(sourcePacket)),
      jsonValue(discussionIds(sourcePacket)),
      jsonValue(sourcePacket),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(reasoningEffort, 40),
      Boolean(shadow),
    ]
  );
  return { id: result.rows[0]?.id || id };
}

export async function completeHiveTaskManagerRun({
  runId = "",
  selection = {},
  guardrailResult = {},
  executionResult = null,
  outputText = "",
  usage = {},
  provider = "",
  model = "",
} = {}) {
  const normalized = normalizeTaskManagerOutput(selection);
  await query(
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
    `,
    [
      safeText(runId, 180),
      normalized.explanation,
      jsonValue([]),
      jsonValue({
        boardId: normalized.boardSelection.projectId,
        accountId: normalized.operatorSelection.accountId,
        walletAddress: normalized.operatorSelection.walletAddress,
      }),
      normalized.action,
      jsonValue(normalized),
      jsonValue(normalized),
      jsonValue(guardrailResult),
      jsonValue({ executed: executionResult?.executed === true, executionResult, usage }),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(outputText, 250_000),
    ]
  );
}

export async function failHiveTaskManagerRun({ runId = "", error = "", outputText = "" } = {}) {
  if (!runId || !useDatabase()) return;
  await query(
    `
      UPDATE hive_decision_runs
      SET status = 'failed',
          error = $2,
          output_text = $3,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
        AND status = 'running'
    `,
    [safeText(runId, 180), safeText(error, 2000), safeText(outputText, 250_000)]
  );
}

export async function failStaleHiveTaskManagerRuns({ staleMinutes = 8, limit = 10 } = {}) {
  if (!useDatabase()) return [];
  const minutes = Math.min(Math.max(Number(staleMinutes) || 8, 5), 1440);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const result = await query(
    `
      UPDATE hive_decision_runs
      SET status = 'failed',
          error = COALESCE(NULLIF(error, ''), 'hive_task_manager_stale_running_reclaimed'),
          completed_at = now(),
          updated_at = now()
      WHERE id IN (
        SELECT id
        FROM hive_decision_runs
        WHERE status = 'running'
          AND scope LIKE 'hive_task_manager:%'
          AND started_at < now() - ($1::text || ' minutes')::interval
        ORDER BY started_at ASC, id ASC
        LIMIT $2
      )
      RETURNING id
    `,
    [minutes, safeLimit]
  );
  return result.rows;
}

export async function executeTaskManagerSelection({ runId = "", selection = {}, sourcePacket = {} } = {}) {
  const normalized = normalizeTaskManagerOutput(selection);
  if (normalized.action !== "create_task") {
    return { executed: false, skipped: true, reason: "task_manager_no_task_selected" };
  }
  const decision = translateTaskManagerSelectionToBoardDecision({ selection: normalized, sourcePacket });
  return enqueueNetworkTaskGenerationFromBoardDecision({
    runId,
    decision,
    sourcePacket: {
      ...sourcePacket,
      taskManager: {
        selection: normalized,
        promptVersion: "task_manager_selection_v1",
      },
      boardPacketsByProjectId: safeObject(sourcePacket.boardPacketsByProjectId),
      operatorPacketsByAccount: safeObject(sourcePacket.operatorPacketsByAccount),
    },
  });
}

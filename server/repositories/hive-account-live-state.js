import { databaseEnabled, query } from "../db/pool.js";
import { getNetworkTaskEligibility } from "./network-tasks.js";
import {
  networkTaskProfileRewardThreshold,
  positiveRewardStats,
} from "./network-task-profile.js";
import {
  activeAllocationStatuses,
  digestJson,
  numeric,
  safeArray,
  safeObject,
  safeText,
  toIso,
} from "./network-tasks-utils.js";

const terminalTaskStatuses = new Set([
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "rewarded",
  "completed",
  "failed",
]);

const waitingForUserStatuses = new Set([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
]);

function useDatabase() {
  return databaseEnabled();
}

function normalizeStatus(value = "") {
  return safeText(value, 80).toLowerCase();
}

function publicTask(row = {}) {
  const taskStatus = normalizeStatus(row.task_status || row.projection_status || row.ref_state);
  const allocationStatus = normalizeStatus(row.allocation_status);
  const rewardMinPft = numeric(row.reward_min_pft, 0);
  const rewardMaxPft = numeric(row.reward_max_pft, 0);
  const rewardOfferPft = numeric(row.reward_offer_pft, rewardMaxPft || rewardMinPft);
  return {
    allocationId: safeText(row.allocation_id || row.id, 180),
    generationJobId: safeText(row.generation_job_id, 180),
    projectId: safeText(row.project_id, 180),
    taskId: safeText(row.task_id || row.generated_task_id, 180),
    requestId: safeText(row.request_id || row.task_request_id, 180),
    title: safeText(row.title, 240),
    projectNeedSummary: safeText(row.project_need_summary, 600),
    allocationStatus,
    taskStatus: taskStatus || allocationStatus || normalizeStatus(row.generation_status),
    generationStatus: normalizeStatus(row.generation_status),
    rewardMinPft,
    rewardMaxPft,
    rewardOfferPft,
    rewardActualPft: numeric(row.reward_actual_pft, 0),
    acceptBy: toIso(row.accept_by),
    deadlineAt: toIso(row.deadline_at),
    waitingForUser: waitingForUserStatuses.has(taskStatus || allocationStatus),
    terminal: terminalTaskStatuses.has(taskStatus || allocationStatus),
    expiresAt: toIso(row.expires_at),
    updatedAt: toIso(row.updated_at || row.projection_updated_at),
  };
}

function publicFollowup(row = {}) {
  return {
    id: safeText(row.id, 180),
    runId: safeText(row.run_id, 180),
    accountId: safeText(row.account_id, 180),
    projectId: safeText(row.project_id, 180),
    blockerType: safeText(row.blocker_type, 120),
    blockerSummary: safeText(row.blocker_summary, 600),
    expectedResponse: safeText(row.expected_response, 600),
    metadata: safeObject(row.metadata_json),
    lastSentAt: toIso(row.last_sent_at),
    expiresAt: toIso(row.expires_at),
  };
}

function publicBoardMessage(row = {}) {
  return {
    id: safeText(row.id, 180),
    runId: safeText(row.run_id, 180),
    messagePreview: safeText(row.message_text, 260),
    sourcePacketDigest: safeText(row.source_packet_digest, 120),
    createdAt: toIso(row.created_at),
  };
}

function publicRelevantRun(row = {}) {
  return {
    runId: safeText(row.id, 180),
    trigger: safeText(row.trigger, 120),
    status: safeText(row.status, 80),
    action: safeText(row.selected_action, 80),
    targetType: safeText(row.target_type, 120),
    targetId: safeText(row.target_id, 180),
    reason: safeText(row.reason, 300),
    completedAt: toIso(row.completed_at),
    startedAt: toIso(row.started_at),
  };
}

function publicHiveEntry(row = {}) {
  return {
    id: safeText(row.id, 180),
    body: safeText(row.body || row.body_text || row.message_text || row.content, 1200),
    createdAt: toIso(row.created_at),
  };
}

function compactNumber(value = "") {
  const normalized = safeText(value, 40).replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function extractReservationRatePft(text = "") {
  const value = safeText(text, 3000);
  if (!value) return null;
  const candidates = [];
  const patterns = [
    /\b(?:reservation(?:\s+rate)?|minimum|min(?:imum)?|floor|line|price|rate)\b[^.\n]{0,120}?(\d[\d,]*(?:\.\d+)?)\s*(k|pft)?\b/gi,
    /\b(?:under|below|less\s+than|lower\s+than)\b[^.\n]{0,120}?(\d[\d,]*(?:\.\d+)?)\s*(k|pft)\b/gi,
    /\b(\d[\d,]*(?:\.\d+)?)\s*(k|pft)\b[^.\n]{0,120}?\b(?:minimum|reservation|floor|or\s+no|or\s+i\s+won'?t|or\s+do\s+not)\b/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(value);
    while (match) {
      const raw = compactNumber(match[1]);
      const unit = safeText(match[2], 8).toLowerCase();
      const amount = unit === "k" ? raw * 1000 : raw;
      if (amount >= 1_000 && amount <= 1_000_000) {
        candidates.push(amount);
      }
      match = pattern.exec(value);
    }
  }
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function latestReservationRate(entries = []) {
  for (const entry of safeArray(entries)) {
    const rate = extractReservationRatePft(entry.body);
    if (rate) {
      return {
        minPft: rate,
        sourceEntryId: entry.id,
        sourceCreatedAt: entry.createdAt,
      };
    }
  }
  return null;
}

async function accountNetworkTasks({ accountId = "", walletAddress = "", limit = 12 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  if (!normalizedAccountId && !normalizedWallet) return [];
  const result = await query(
    `
      SELECT
        alloc.id AS allocation_id,
        alloc.project_id,
        alloc.allocation_status,
        alloc.task_request_id,
        alloc.generated_task_id,
        alloc.project_need_summary,
        alloc.reward_min_pft,
        alloc.reward_max_pft,
        alloc.expires_at,
        alloc.updated_at,
        job.id AS generation_job_id,
        job.status AS generation_status,
        job.request_id,
        COALESCE(NULLIF(proj.task_id, ''), NULLIF(refs.task_id, ''), NULLIF(job.task_id, ''), NULLIF(alloc.generated_task_id, '')) AS task_id,
        COALESCE(NULLIF(proj.status, ''), NULLIF(refs.state, '')) AS task_status,
        COALESCE(NULLIF(proj.title, ''), NULLIF(refs.title, ''), NULLIF(alloc.project_need_summary, '')) AS title,
        proj.reward_offer_pft,
        proj.reward_actual_pft,
        proj.accept_by,
        proj.deadline_at,
        proj.updated_at AS projection_updated_at
      FROM network_task_allocations alloc
      LEFT JOIN network_task_generation_jobs job
        ON job.allocation_id = alloc.id
      LEFT JOIN network_project_task_refs refs
        ON refs.task_id = alloc.generated_task_id
        OR refs.request_id = alloc.task_request_id
      LEFT JOIN task_projections proj
        ON proj.task_id = COALESCE(NULLIF(alloc.generated_task_id, ''), NULLIF(job.task_id, ''), NULLIF(refs.task_id, ''))
      WHERE ($1::text <> '' AND alloc.candidate_account_id = $1)
         OR ($2::text <> '' AND alloc.candidate_wallet_address = $2)
         OR ($1::text <> '' AND proj.account_id = $1)
         OR ($2::text <> '' AND proj.subject_wallet = $2)
      ORDER BY alloc.updated_at DESC, alloc.id DESC
      LIMIT $3
    `,
    [normalizedAccountId, normalizedWallet, Math.min(Math.max(Number(limit) || 12, 1), 40)]
  );
  return result.rows.map(publicTask);
}

async function accountOpenFollowups({ accountId = "", limit = 8 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return [];
  const result = await query(
    `
      SELECT *
      FROM board_manager_followups
      WHERE account_id = $1
        AND status = 'open'
        AND expires_at > now()
      ORDER BY last_sent_at DESC, id DESC
      LIMIT $2
    `,
    [normalizedAccountId, Math.min(Math.max(Number(limit) || 8, 1), 20)]
  );
  return result.rows.map(publicFollowup);
}

async function accountBoardMessages({ accountId = "", limit = 6 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return [];
  const result = await query(
    `
      SELECT id, run_id, message_text, source_packet_digest, created_at
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [normalizedAccountId, Math.min(Math.max(Number(limit) || 6, 1), 20)]
  );
  return result.rows.map(publicBoardMessage);
}

async function accountRelevantBoardRuns({ accountId = "", walletAddress = "", limit = 8 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  if (!normalizedAccountId && !normalizedWallet) return [];
  const result = await query(
    `
      SELECT
        runs.id,
        runs.trigger,
        runs.status,
        runs.selected_action,
        runs.started_at,
        runs.completed_at,
        results.target_type,
        results.target_id,
        COALESCE(results.result_json->>'reason', runs.decision_json->>'reason', '') AS reason
      FROM board_manager_runs runs
      LEFT JOIN board_manager_action_results results
        ON results.run_id = runs.id
      WHERE ($1::text <> '' AND (
          results.target_id = $1
          OR results.result_json->>'accountId' = $1
          OR results.result_json->>'candidateAccountId' = $1
          OR runs.action_payload_json #>> '{network_task,candidate_account_id}' = $1
          OR runs.action_payload_json #>> '{networkTask,candidateAccountId}' = $1
        ))
        OR ($2::text <> '' AND (
          results.result_json->>'candidateWalletAddress' = $2
          OR runs.action_payload_json #>> '{network_task,candidate_wallet_address}' = $2
          OR runs.action_payload_json #>> '{networkTask,candidateWalletAddress}' = $2
        ))
      ORDER BY runs.started_at DESC, runs.id DESC
      LIMIT $3
    `,
    [normalizedAccountId, normalizedWallet, Math.min(Math.max(Number(limit) || 8, 1), 20)]
  );
  return result.rows.map(publicRelevantRun);
}

async function accountHiveEntries({ accountId = "", limit = 40 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return [];
  const result = await query(
    `
      SELECT id, body, created_at
      FROM hive_context_entries
      WHERE account_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [normalizedAccountId, Math.min(Math.max(Number(limit) || 40, 1), 80)]
  );
  return result.rows.map(publicHiveEntry);
}

async function accountNetworkTaskEligibility({ accountId = "", walletAddress = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return null;
  const [eligibility, rewardStats] = await Promise.all([
    getNetworkTaskEligibility({
      accountId: normalizedAccountId,
      walletAddress,
      recordCapacityEvent: false,
    }),
    positiveRewardStats({ accountId: normalizedAccountId }),
  ]);
  return {
    status: safeText(eligibility.status, 80),
    label: safeText(eligibility.label, 160),
    nextAction: safeText(eligibility.nextAction, 240),
    walletLinked: Boolean(eligibility.wallet?.linked),
    walletSynced: Boolean(eligibility.wallet?.synced),
    diagnosticReportStatus: safeText(eligibility.profile?.status || "missing", 80),
    capacityAvailable: Boolean(eligibility.capacity?.available),
    blockedGates: safeArray(eligibility.gates)
      .filter((gate) => gate.id !== "board_routing" && gate.status !== "complete")
      .map((gate) => `${safeText(gate.id, 40)}=${safeText(gate.status, 40)}`),
    positiveRewardedTaskCount: Number(rewardStats?.positiveRewardedTaskCount || 0),
    autoReportRewardedTaskThreshold: networkTaskProfileRewardThreshold,
  };
}

function summarizeConstraints({ entries = [], tasks = [] } = {}) {
  const reservationRate = latestReservationRate(entries);
  const recentRefusals = safeArray(tasks)
    .filter((task) => normalizeStatus(task.allocationStatus || task.taskStatus) === "refused")
    .slice(0, 6)
    .map((task) => ({
      allocationId: task.allocationId,
      taskId: task.taskId,
      title: task.title,
      rewardMaxPft: task.rewardMaxPft,
      updatedAt: task.updatedAt,
    }));
  return {
    reservationRate,
    recentRefusals,
  };
}

export async function buildHiveAccountLiveState({
  accountId = "",
  walletAddress = "",
  limit = 12,
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  const snapshotAt = new Date().toISOString();
  if (!useDatabase()) {
    return {
      ok: false,
      schema: "tasknode.hive.account_live_state.v1",
      status: "database_not_configured",
      accountId: normalizedAccountId,
      walletAddress: normalizedWallet,
      snapshotAt,
      networkTasks: [],
      openFollowups: [],
      recentBoardMessages: [],
      latestRelevantBoardRuns: [],
      routingConstraints: {},
      networkTaskEligibility: null,
      digest: "",
    };
  }
  try {
    const [networkTasks, openFollowups, recentBoardMessages, latestRelevantBoardRuns, hiveEntries, networkTaskEligibility] = await Promise.all([
      accountNetworkTasks({ accountId: normalizedAccountId, walletAddress: normalizedWallet, limit }),
      accountOpenFollowups({ accountId: normalizedAccountId }),
      accountBoardMessages({ accountId: normalizedAccountId }),
      accountRelevantBoardRuns({ accountId: normalizedAccountId, walletAddress: normalizedWallet }),
      accountHiveEntries({ accountId: normalizedAccountId }),
      accountNetworkTaskEligibility({ accountId: normalizedAccountId, walletAddress: normalizedWallet }).catch(() => null),
    ]);
    const routingConstraints = summarizeConstraints({ entries: hiveEntries, tasks: networkTasks });
    const liveState = {
      ok: true,
      schema: "tasknode.hive.account_live_state.v1",
      status: "ready",
      accountId: normalizedAccountId,
      walletAddress: normalizedWallet,
      snapshotAt,
      networkTasks,
      openFollowups,
      recentBoardMessages,
      latestRelevantBoardRuns,
      routingConstraints,
      networkTaskEligibility,
    };
    return {
      ...liveState,
      digest: digestJson(liveState),
    };
  } catch (error) {
    return {
      ok: false,
      schema: "tasknode.hive.account_live_state.v1",
      status: "query_failed",
      error: safeText(error?.message || String(error), 600),
      accountId: normalizedAccountId,
      walletAddress: normalizedWallet,
      snapshotAt,
      networkTasks: [],
      openFollowups: [],
      recentBoardMessages: [],
      latestRelevantBoardRuns: [],
      routingConstraints: {},
      networkTaskEligibility: null,
      digest: "",
    };
  }
}

function taskPromptLine(task = {}) {
  return [
    `- ${safeText(task.title || task.taskId || task.allocationId || "Network task", 220)}`,
    task.taskId ? `task=${task.taskId}` : "",
    task.allocationId ? `allocation=${task.allocationId}` : "",
    task.projectId ? `project=${task.projectId}` : "",
    task.taskStatus ? `task_status=${task.taskStatus}` : "",
    task.allocationStatus ? `allocation_status=${task.allocationStatus}` : "",
    task.generationStatus ? `generation_status=${task.generationStatus}` : "",
    task.rewardOfferPft ? `reward_offer_pft=${task.rewardOfferPft}` : "",
    task.rewardMaxPft ? `reward_max_pft=${task.rewardMaxPft}` : "",
    task.acceptBy ? `accept_by=${task.acceptBy}` : "",
    task.deadlineAt ? `deadline_at=${task.deadlineAt}` : "",
    task.waitingForUser ? "waiting_for_user=yes" : "waiting_for_user=no",
    task.terminal ? "terminal=yes" : "",
    task.updatedAt ? `updated=${task.updatedAt}` : "",
  ].filter(Boolean).join(" | ");
}

function followupPromptLine(followup = {}) {
  return [
    `- ${safeText(followup.blockerSummary || followup.id || "Open follow-up", 220)}`,
    followup.projectId ? `project=${followup.projectId}` : "",
    followup.expectedResponse ? `expects=${safeText(followup.expectedResponse, 180)}` : "",
    followup.lastSentAt ? `last_sent=${followup.lastSentAt}` : "",
  ].filter(Boolean).join(" | ");
}

function networkTaskEligibilityPromptLines(eligibility = null) {
  if (!eligibility || !eligibility.status) {
    return [
      "- network_task_eligibility: unavailable in this snapshot. Do not assert a specific eligibility blocker; explain the standard gate chain instead.",
    ];
  }
  const blockedGates = safeArray(eligibility.blockedGates).filter(Boolean);
  return [
    [
      `- network_task_eligibility: status=${safeText(eligibility.status, 80)}`,
      `wallet_linked=${eligibility.walletLinked ? "yes" : "no"}`,
      `wallet_synced=${eligibility.walletSynced ? "yes" : "no"}`,
      `diagnostic_report=${safeText(eligibility.diagnosticReportStatus, 80) || "missing"}`,
      `capacity_available=${eligibility.capacityAvailable ? "yes" : "no"}`,
      `rewarded_tasks=${Number(eligibility.positiveRewardedTaskCount || 0)}/${Number(eligibility.autoReportRewardedTaskThreshold || 0)} toward automatic Network Diagnostic Report generation`,
    ].join(" | "),
    blockedGates.length
      ? `- network_task_eligibility blocked gates: ${blockedGates.join(", ")} | next_action=${safeText(eligibility.nextAction, 240) || "none"}`
      : "- network_task_eligibility blocked gates: none; the account is routable and waits on Board Manager project need.",
  ];
}

export function formatHiveAccountLiveStateForPrompt(liveState = {}) {
  const state = safeObject(liveState);
  const tasks = safeArray(state.networkTasks);
  const followups = safeArray(state.openFollowups);
  const constraints = safeObject(state.routingConstraints);
  const reservation = safeObject(constraints.reservationRate);
  return [
    "ACCOUNT LIVE STATE - AUTHORITATIVE",
    `- account=${safeText(state.accountId, 180) || "unknown"}`,
    `- wallet=${safeText(state.walletAddress, 120) || "unknown"}`,
    `- snapshot=${safeText(state.snapshotAt, 80) || "unknown"}`,
    `- status=${safeText(state.status, 80) || "unknown"}`,
    ...networkTaskEligibilityPromptLines(state.networkTaskEligibility),
    reservation.minPft
      ? `- routing_constraint: user-stated minimum Network Task reward is ${reservation.minPft} PFT (source=${reservation.sourceEntryId || "recent_hive_context"})`
      : "- routing_constraint: no explicit user-stated minimum reward found in recent account context",
    "Network tasks for this account:",
    tasks.length ? tasks.slice(0, 8).map(taskPromptLine).join("\n") : "- none",
    "Open Board Manager follow-ups for this account:",
    followups.length ? followups.slice(0, 6).map(followupPromptLine).join("\n") : "- none",
    "Recent Board Manager messages to this account:",
    safeArray(state.recentBoardMessages).length
      ? safeArray(state.recentBoardMessages).slice(0, 4).map((message) => `- ${message.createdAt || "unknown"} ${safeText(message.messagePreview, 220)}`).join("\n")
      : "- none",
    "Latest relevant Board Manager runs for this account:",
    safeArray(state.latestRelevantBoardRuns).length
      ? safeArray(state.latestRelevantBoardRuns).slice(0, 4).map((run) => [
          `- ${safeText(run.action || run.status || "run", 80)}`,
          run.runId ? `run=${run.runId}` : "",
          run.targetType || run.targetId ? `target=${[run.targetType, run.targetId].filter(Boolean).join("/")}` : "",
          run.completedAt || run.startedAt ? `at=${run.completedAt || run.startedAt}` : "",
          run.reason ? `reason=${safeText(run.reason, 180)}` : "",
        ].filter(Boolean).join(" | ")).join("\n")
      : "- none",
    "Rules:",
    "- If this section conflicts with chat history, compressed Hive context, or secretary packets, trust this section.",
    "- Answer Network Task eligibility questions from the network_task_eligibility lines above: name the blocked gate and its next_action instead of guessing or inventing a prerequisite ladder.",
    "- Do not say this user has a proposed task, open follow-up, capacity blocker, or reservation-rate conflict unless it appears here.",
    "- If a task here is refused, rewarded, completed, cancelled, expired, rejected, rerouted, or failed, do not describe it as waiting on the user.",
  ].join("\n");
}

export async function buildHiveRoutingConstraintsSnapshot({ limit = 80 } = {}) {
  if (!useDatabase()) return { ok: false, status: "database_not_configured", accounts: [] };
  try {
    const [contextResult, refusalResult] = await Promise.all([
      query(
      `
        SELECT account_id, id, body, created_at
        FROM hive_context_entries
        WHERE account_id <> ''
          AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT $1
      `,
      [Math.min(Math.max(Number(limit) || 80, 1), 200)]
      ),
      query(
        `
          SELECT
            candidate_account_id AS account_id,
            count(*)::int AS recent_refusal_count,
            max(updated_at) AS last_refusal_at,
            max(reward_max_pft) AS highest_refused_reward_pft
          FROM network_task_allocations
          WHERE candidate_account_id <> ''
            AND allocation_status = 'refused'
            AND updated_at > now() - interval '45 days'
          GROUP BY candidate_account_id
          ORDER BY last_refusal_at DESC
          LIMIT 40
        `
      ).catch(() => ({ rows: [] })),
    ]);
    const byAccount = new Map();
    for (const row of contextResult.rows) {
      const accountId = safeText(row.account_id, 180);
      if (!accountId) continue;
      if (!byAccount.has(accountId)) byAccount.set(accountId, []);
      byAccount.get(accountId).push(publicHiveEntry(row));
    }
    const refusalByAccount = new Map(refusalResult.rows.map((row) => [
      safeText(row.account_id, 180),
      {
        count45d: Number(row.recent_refusal_count || 0),
        lastRefusalAt: toIso(row.last_refusal_at),
        highestRefusedRewardPft: numeric(row.highest_refused_reward_pft, 0),
      },
    ]));
    const accountIds = new Set([...byAccount.keys(), ...refusalByAccount.keys()]);
    const accounts = [...accountIds]
      .map((accountId) => ({
        accountId,
        reservationRate: latestReservationRate(byAccount.get(accountId) || []),
        recentRefusals: refusalByAccount.get(accountId) || null,
      }))
      .filter((account) => account.reservationRate?.minPft || account.recentRefusals?.count45d)
      .slice(0, 20);
    const snapshot = {
      ok: true,
      status: "ready",
      generatedAt: new Date().toISOString(),
      activeAllocationStatuses,
      accounts,
    };
    return {
      ...snapshot,
      digest: digestJson(snapshot),
    };
  } catch (error) {
    return {
      ok: false,
      status: "query_failed",
      error: safeText(error?.message || String(error), 600),
      accounts: [],
    };
  }
}

export const hiveAccountLiveStateInternals = {
  extractReservationRatePft,
  terminalTaskStatuses,
  waitingForUserStatuses,
};

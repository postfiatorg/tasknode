import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "./db/pool.js";
import { enqueueHiveSecretaryJob } from "./repositories/hive-context.js";
import {
  boardManagerPromptVersion,
  normalizeBoardManagerDecision,
  recordBoardManagerActionResult,
} from "./repositories/board-manager.js";
import { scheduleHiveSecretaryQueue } from "./hive-secretary-worker.js";
import { scheduleNetworkTaskGenerationQueue } from "./network-task-generation-worker.js";
import {
  buildHiveProjectProductDocSourcePacket,
  completeHiveProjectProductDoc,
} from "./repositories/hive-project-product-docs.js";
import { applyCanonicalHiveProject } from "./hive-project-canonical.js";
import { deterministicBoardsEnabled } from "./board-config.js";
import {
  enqueueNetworkTaskGenerationFromBoardDecision,
  syncNetworkTaskProjection,
} from "./repositories/network-tasks.js";
import { buildHiveAccountLiveState } from "./repositories/hive-account-live-state.js";
import { executeBoardManagerMessageUser } from "./board-manager-message-action.js";

export {
  evaluateBoardManagerMessagePrecondition,
  guardBoardManagerMessageUserFreshness,
} from "./board-manager-message-policy.js";

const projectTypes = new Set([
  "protocol_marketing",
  "protocol_development",
  "alpha_generation",
  "protocol_applications",
  "network_validation",
]);

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

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function slug(value = "") {
  const normalized = safeText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || `project_${randomUUID().slice(0, 12)}`;
}

function tokenSet(value = "") {
  return new Set(
    safeText(value, 600)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  );
}

function tokenOverlapScore(left = "", right = "") {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function projectHasOperatorArchiveLock(project = {}) {
  const metadata = safeObject(project.metadata_json || project.metadata);
  return metadata.operator_archived === true ||
    metadata.operator_archived === "true" ||
    Boolean(metadata.archive_lock_source) ||
    Boolean(metadata.archive_lock_applied_at);
}

function reportInput(sourcePacket = {}) {
  const report = sourcePacket?.hiveSecretary?.report || {};
  return {
    report_id: safeText(report.id, 180),
    source_packet_digest: safeText(report.sourcePacketDigest || sourcePacket?.hiveSecretarySource?.digest, 180),
    completed_at: report.completedAt || null,
    title: report.output?.title || "Hive Secretary Report",
  };
}

function projectLeaderInputsFromSourcePacket(sourcePacket = {}) {
  return safeArray(sourcePacket.projectLeaderInputs || sourcePacket.project_leader_inputs)
    .slice(0, 16)
    .map((input) => safeObject(input))
    .map((input) => ({
      sourceEntryId: safeText(input.sourceEntryId || input.source_entry_id, 180),
      accountId: safeText(input.accountId || input.account_id, 180),
      displayName: safeText(input.displayName || input.display_name, 120),
      hiveHandle: safeText(input.hiveHandle || input.hive_handle || input.handle, 120),
      walletAddress: safeText(input.walletAddress || input.wallet_address, 120),
      sourceConversationId: safeText(input.sourceConversationId || input.source_conversation_id, 180),
      authority: safeArray(input.authority).slice(0, 8).map((item) => safeText(item, 120)).filter(Boolean),
    }))
    .filter((input) => input.sourceEntryId || input.accountId || input.hiveHandle);
}

function sourceContributorCandidates(sourcePacket = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = ({ accountId = "", walletAddress = "", displayName = "" } = {}) => {
    const normalizedWallet = safeText(walletAddress, 120);
    if (!normalizedWallet) return;
    const normalizedAccount = safeText(accountId, 180);
    const key = `${normalizedAccount}:${normalizedWallet}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      accountId: normalizedAccount,
      walletAddress: normalizedWallet,
      displayName: safeText(displayName, 120),
    });
  };

  for (const candidate of sourcePacket?.actionTargetRegistry?.contributorCandidates || []) {
    addCandidate({
      accountId: candidate.accountId || candidate.account_id,
      displayName: candidate.displayName || candidate.display_name,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
  }

  for (const entry of sourcePacket?.actionTargetRegistry?.hiveContextEntries || []) {
    if (!entry?.walletValidated) continue;
    addCandidate({
      accountId: entry.accountId || entry.account_id,
      displayName: entry.displayName || entry.display_name,
      walletAddress: entry.walletAddress || entry.wallet_address,
    });
  }

  for (const group of sourcePacket?.hiveContext?.groups || []) {
    const groupAccountId = safeText(group.accountId, 180);
    const groupDisplayName = safeText(group.displayName, 120);
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      if (!entry?.walletValidated) continue;
      addCandidate({
        accountId: entry.accountId || groupAccountId,
        displayName: entry.displayName || groupDisplayName,
        walletAddress: entry.walletAddress,
      });
    }
  }

  for (const candidate of sourcePacket?.networkTaskCandidates || []) {
    addCandidate({
      accountId: candidate.accountId || candidate.account_id,
      displayName: candidate.displayName || candidate.display_name,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
  }

  for (const candidate of sourcePacket?.orcOperations?.routingCandidates || sourcePacket?.orc_operations?.routingCandidates || []) {
    addCandidate({
      accountId: candidate.accountId || candidate.account_id,
      displayName: candidate.handle || candidate.displayName || candidate.display_name,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
  }

  return candidates;
}

async function recordResult({ runId, decision, result }) {
  if (!runId) return { ok: true, skipped: true, reason: "run_not_recorded", result };
  return recordBoardManagerActionResult({
    runId,
    action: decision.action,
    targetType: decision.target_type,
    targetId: decision.target_id,
    result,
  });
}


async function executeRefreshHiveSecretary({ decision }) {
  const queued = await enqueueHiveSecretaryJob({
    reason: "board_manager_refresh",
    sourceEntryId: safeText(decision.target_id, 180),
  });
  if (queued?.queued) {
    scheduleHiveSecretaryQueue({ delayMs: 250 });
  }
  return {
    executed: true,
    queued: Boolean(queued?.queued),
    jobId: queued?.job?.id || "",
    sourcePacketDigest: queued?.sourcePacket?.sourcePacketDigest || "",
    reason: queued?.reason || "",
  };
}

async function executeCreateProject({ runId, decision, sourcePacket }) {
  const project = applyCanonicalHiveProject(safeObject(decision.payload.project));
  const title = safeText(project.title, 180);
  const summary = safeText(project.summary, 600);
  const objective = safeText(project.objective, 900);
  const about = safeText(project.about, 2000);
  const id = slug(project.id || decision.target_id || title);
  const type = projectTypes.has(project.type) ? project.type : "protocol_development";
  if (!title || !summary || !objective) throw new Error("board_manager_create_project_missing_required_fields");
  const registry = await query(
    `
      SELECT id, title, summary, objective, status, metadata_json
      FROM network_projects
      ORDER BY updated_at DESC, id ASC
      LIMIT 200
    `
  );
  const exact = registry.rows.find((row) => row.id === id);
  if (exact?.status === "archived") {
    const canonicalProjectId = safeText(project.canonical_project_id, 180);
    if (canonicalProjectId === id && !projectHasOperatorArchiveLock(exact)) {
      // Continue into the upsert below. Canonical project creation is allowed
      // to reactivate an agent-archived canonical board instead of creating
      // another facet board.
    } else {
      return {
        executed: false,
        skipped: true,
        reason: "board_manager_create_project_archived_project_requires_restore",
        projectId: exact.id,
        title: exact.title,
        operatorLocked: projectHasOperatorArchiveLock(exact),
        recommendedAction: projectHasOperatorArchiveLock(exact) ? "operator_review" : "restore_project",
      };
    }
  }
  const titleSlug = slug(title);
  const similar = registry.rows.find((row) => {
    if (row.id === id) return false;
    const rowTitle = safeText(row.title, 180);
    if (!rowTitle) return false;
    if (slug(rowTitle) === titleSlug) return true;
    if (tokenOverlapScore(`${title} ${summary} ${objective}`, `${row.title} ${row.summary} ${row.objective}`) >= 0.62) {
      return true;
    }
    return false;
  });
  if (similar) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_create_project_similar_project_exists",
      projectId: similar.id,
      title: similar.title,
      status: similar.status,
      operatorLocked: projectHasOperatorArchiveLock(similar),
      recommendedAction: similar.status === "archived" && !projectHasOperatorArchiveLock(similar)
        ? "restore_project"
        : "append_or_refresh_existing_project",
    };
  }
  const hiveSecretary = reportInput(sourcePacket);
  const projectLeaderInputs = projectLeaderInputsFromSourcePacket(sourcePacket);
  const result = await query(
    `
      INSERT INTO network_projects (
        id,
        type,
        title,
        summary,
        objective,
        about,
        status,
        priority,
        origin,
        proposed_by,
        proposed_at,
        phase_label,
        phase_current,
        phase_total,
        pft_routed,
        task_count,
        contributor_count,
        source_hive_secretary_report_id,
        source_hive_secretary_report_digest,
        source_inputs_json,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'active', $7, 'board_manager', 'board_manager',
        CURRENT_DATE, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        objective = EXCLUDED.objective,
        about = EXCLUDED.about,
        status = 'active',
        priority = EXCLUDED.priority,
        origin = EXCLUDED.origin,
        proposed_by = EXCLUDED.proposed_by,
        phase_label = EXCLUDED.phase_label,
        phase_current = EXCLUDED.phase_current,
        phase_total = EXCLUDED.phase_total,
        pft_routed = EXCLUDED.pft_routed,
        task_count = EXCLUDED.task_count,
        contributor_count = EXCLUDED.contributor_count,
        source_hive_secretary_report_id = EXCLUDED.source_hive_secretary_report_id,
        source_hive_secretary_report_digest = EXCLUDED.source_hive_secretary_report_digest,
        source_inputs_json = EXCLUDED.source_inputs_json,
        metadata_json = network_projects.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING id, title, status
    `,
    [
      id,
      type,
      title,
      summary,
      objective,
      about || objective,
      intValue(project.priority, 100),
      safeText(project.phase_label, 100),
      intValue(project.phase_current),
      intValue(project.phase_total),
      0,
      0,
      0,
      hiveSecretary.report_id,
      hiveSecretary.source_packet_digest,
      jsonValue({
        inputs: [
          "board_manager_action",
          "hive_secretary_report",
          ...(projectLeaderInputs.length ? ["project_leader_hive_input"] : []),
        ],
        board_manager: {
          run_id: runId,
          source_packet_digest: sourcePacket.sourcePacketDigest,
        },
        hive_secretary: hiveSecretary,
        project_leader_inputs: projectLeaderInputs,
      }),
      jsonValue({
        board_manager_reason: decision.reason,
        board_manager_created_at: new Date().toISOString(),
        project_leader_authority: {
          present: projectLeaderInputs.length > 0,
          badge_id: projectLeaderInputs.length ? "project_leader" : "",
          requirement: projectLeaderInputs.length ? "Discretionary" : "",
          source_entry_ids: projectLeaderInputs.map((input) => input.sourceEntryId).filter(Boolean),
          handles: projectLeaderInputs.map((input) => input.hiveHandle).filter(Boolean),
        },
      }),
    ]
  );
  return {
    executed: true,
    projectId: result.rows[0]?.id || id,
    status: result.rows[0]?.status || "active",
    projectLeaderInputCount: projectLeaderInputs.length,
  };
}

async function executeArchiveProject({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_archive_project_missing_project");
  const archiveReason = safeText(decision.payload.archive_reason || decision.reason, 1000);
  const existing = await query(
    `
      SELECT id, title, status
      FROM network_projects
      WHERE id = $1
      LIMIT 1
    `,
    [projectId]
  );
  if (!existing.rows[0]) throw new Error("board_manager_archive_project_not_found");

  const result = await query(
    `
      UPDATE network_projects
      SET status = 'archived',
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, title, status
    `,
    [
      projectId,
      jsonValue({
        agent_archived: true,
        agent_archived_reason: archiveReason,
        agent_archived_by: "board_manager",
        agent_archived_run_id: safeText(runId, 180),
        agent_archived_source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        agent_archived_at: new Date().toISOString(),
        resurrection_policy: "planner_may_reactivate_unless_operator_archived_lock_is_present",
      }),
    ]
  );
  return {
    executed: true,
    projectId,
    status: result.rows[0].status,
    archiveReason,
  };
}

async function executeRestoreProject({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_restore_project_missing_project");
  const restoreReason = safeText(decision.payload.summary || decision.reason, 1000);
  const existing = await query(
    `
      SELECT id, title, status, metadata_json
      FROM network_projects
      WHERE id = $1
      LIMIT 1
    `,
    [projectId]
  );
  const project = existing.rows[0];
  if (!project) throw new Error("board_manager_restore_project_not_found");
  if (projectHasOperatorArchiveLock(project)) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_restore_project_operator_locked",
      projectId,
      title: project.title,
      status: project.status,
    };
  }
  if (project.status !== "archived") {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_restore_project_not_archived",
      projectId,
      title: project.title,
      status: project.status,
    };
  }

  const result = await query(
    `
      UPDATE network_projects
      SET status = 'active',
          metadata_json = (COALESCE(metadata_json, '{}'::jsonb) - 'agent_archived') || $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, title, status
    `,
    [
      projectId,
      jsonValue({
        agent_archive_restored: true,
        agent_archive_restored_reason: restoreReason,
        agent_archive_restored_by: "board_manager",
        agent_archive_restored_run_id: safeText(runId, 180),
        agent_archive_restored_source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        agent_archive_restored_at: new Date().toISOString(),
      }),
    ]
  );
  return {
    executed: true,
    projectId,
    title: result.rows[0]?.title || project.title,
    status: result.rows[0]?.status || "active",
    restoreReason,
  };
}

async function executeAssignContributor({ runId, decision, sourcePacket }) {
  const contributor = safeObject(decision.payload.contributor);
  const projectId = safeText(contributor.project_id || decision.target_id, 180);
  const walletAddress = safeText(contributor.wallet_address, 120);
  const accountId = safeText(contributor.account_id, 180);
  if (!projectId) throw new Error("board_manager_assign_contributor_missing_project");
  if (!walletAddress) throw new Error("board_manager_assign_contributor_missing_wallet");
  const exists = await query("SELECT id FROM network_projects WHERE id = $1 AND status <> 'archived'", [projectId]);
  if (!exists.rows[0]) throw new Error("board_manager_assign_contributor_project_not_found");
  const candidates = sourceContributorCandidates(sourcePacket);
  const sourceCandidate = candidates.find((candidate) => (
    candidate.walletAddress === walletAddress &&
    (!accountId || !candidate.accountId || candidate.accountId === accountId)
  ));
  if (!sourceCandidate) {
    throw new Error("board_manager_assign_contributor_not_in_source_packet");
  }
  const result = await query(
    `
      INSERT INTO network_project_contributors (
        project_id,
        wallet_address,
        codename,
        archetype,
        allotted,
        cap,
        load,
        status,
        role_label,
        sort_order,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (project_id, wallet_address) DO UPDATE SET
        codename = EXCLUDED.codename,
        archetype = EXCLUDED.archetype,
        allotted = EXCLUDED.allotted,
        cap = EXCLUDED.cap,
        load = EXCLUDED.load,
        status = EXCLUDED.status,
        role_label = EXCLUDED.role_label,
        sort_order = EXCLUDED.sort_order,
        metadata_json = network_project_contributors.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING project_id, wallet_address, status
    `,
    [
      projectId,
      walletAddress,
      safeText(contributor.codename, 120) || sourceCandidate.displayName || accountId || "Operator",
      safeText(contributor.archetype, 180),
      Boolean(contributor.allotted),
      intValue(contributor.cap),
      intValue(contributor.load),
      safeText(contributor.status, 80) || "active",
      safeText(contributor.role_label, 80),
      intValue(contributor.sort_order, 100),
      jsonValue({
        account_id: accountId || sourceCandidate.accountId,
        board_manager_run_id: safeText(runId, 180),
        board_manager_reason: decision.reason,
        source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
      }),
    ]
  );
  return {
    executed: true,
    projectId: result.rows[0]?.project_id || projectId,
    walletAddress: result.rows[0]?.wallet_address || walletAddress,
    status: result.rows[0]?.status || "active",
  };
}

async function executeRefreshProjectDocument({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_refresh_project_document_missing_project");
  const exists = await query("SELECT id FROM network_projects WHERE id = $1 AND status <> 'archived'", [projectId]);
  if (!exists.rows[0]) throw new Error("board_manager_refresh_project_document_project_not_found");
  const document = safeObject(decision.payload.project_document);
  if (!safeText(document.project_status || document.projectStatus, 1800)) {
    throw new Error("board_manager_refresh_project_document_missing_project_status");
  }
  const source = await buildHiveProjectProductDocSourcePacket({
    projectId,
    boardSourcePacket: sourcePacket,
  });
  const run = runId
    ? await query("SELECT model, reasoning_effort FROM board_manager_runs WHERE id = $1 LIMIT 1", [runId])
    : { rows: [] };
  const completed = await completeHiveProjectProductDoc({
    projectId,
    output: document,
    sourcePacket: source,
    boardManagerRunId: runId,
    provider: "codex_exec",
    model: safeText(run.rows[0]?.model || "board_manager", 160),
    promptVersion: boardManagerPromptVersion,
    usage: {
      source: "board_manager_decision",
      reasoningEffort: safeText(run.rows[0]?.reasoning_effort, 40),
    },
  });
  return {
    executed: true,
    projectId,
    productDocId: completed.doc?.id || "",
    sourcePacketDigest: source.sourcePacketDigest,
    title: completed.doc?.title || "",
    model: completed.doc?.model || "",
    promptVersion: completed.doc?.promptVersion || boardManagerPromptVersion,
  };
}

async function executeInitiateNetworkTask({ runId, decision, sourcePacket }) {
  const networkTask = safeObject(decision.payload?.network_task || decision.payload?.networkTask);
  const candidateAccountId = safeText(networkTask.candidate_account_id || networkTask.candidateAccountId, 180);
  const candidateWalletAddress = safeText(networkTask.candidate_wallet_address || networkTask.candidateWalletAddress, 120);
  if (candidateAccountId || candidateWalletAddress) {
    const accountLiveState = await buildHiveAccountLiveState({
      accountId: candidateAccountId,
      walletAddress: candidateWalletAddress,
      limit: 8,
    });
    const reservationMinPft = numberValue(accountLiveState.routingConstraints?.reservationRate?.minPft, 0);
    const rewardMaxPft = numberValue(networkTask.reward_max_pft || networkTask.rewardMaxPft, 0);
    if (accountLiveState.ok && reservationMinPft > 0 && rewardMaxPft > 0 && rewardMaxPft < reservationMinPft) {
      return {
        executed: false,
        skipped: true,
        reason: "board_manager_network_task_below_reservation_rate",
        candidateAccountId,
        candidateWalletAddress,
        reservationMinPft,
        rewardMaxPft,
        accountLiveStateDigest: safeText(accountLiveState.digest, 120),
      };
    }
  }
  let enqueued;
  try {
    enqueued = await enqueueNetworkTaskGenerationFromBoardDecision({
      runId,
      decision,
      sourcePacket,
    });
  } catch (error) {
    if (error?.message === "network_task_candidate_at_capacity") {
      return {
        executed: false,
        skipped: true,
        reason: "network_task_candidate_at_capacity",
      };
    }
    throw error;
  }
  const scheduled = scheduleNetworkTaskGenerationQueue({
    delayMs: 250,
    limit: 2,
    reason: "board_manager_initiate_network_task",
  });
  return {
    ...enqueued,
    workerScheduled: scheduled,
  };
}

async function executeCancelNetworkTask({ runId, decision, sourcePacket }) {
  const cancelTarget = safeObject(decision.payload?.cancel_target);
  const taskId = safeText(
    cancelTarget.task_id || cancelTarget.taskId || decision.target_id,
    180
  );
  if (!taskId) throw new Error("board_manager_cancel_network_task_missing_task_id");
  const cancelReason = safeText(cancelTarget.reason || decision.reason, 1000);
  const referencedTaskIds = safeArray(cancelTarget.referenced_task_ids || cancelTarget.referencedTaskIds)
    .map((item) => safeText(item, 180))
    .filter(Boolean)
    .slice(0, 12);

  // Only the Board Manager issues Network Tasks, so it may retract its own
  // proposed/accepted offers. Confirm the target is a cancellable NETWORK task
  // before mutating anything; personal/engineering tasks are never touched.
  const existing = await query(
    `
      SELECT tp.task_id, tp.status, tp.title, tp.reward_actual_pft,
             (refs.task_id IS NOT NULL) AS is_network_task
      FROM task_projections tp
      LEFT JOIN network_project_task_refs refs
        ON refs.task_id = tp.task_id AND refs.source = 'network_task_generation'
      WHERE tp.task_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  const task = existing.rows[0];
  if (!task) {
    return { executed: false, skipped: true, reason: "board_manager_cancel_task_not_found", taskId };
  }
  if (!task.is_network_task) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_not_network",
      taskId,
      status: task.status,
    };
  }
  const status = String(task.status || "").toLowerCase();
  // proposed/accepted only: pre-submission. Anything past acceptance may already
  // hold delivered work; canceling there is an economic decision for the operator.
  if (!["proposed", "accepted"].includes(status)) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_not_cancellable_state",
      taskId,
      status,
    };
  }
  // Defense-in-depth on reward integrity: never terminalize anything that
  // already paid. Unreachable given the status guard, but reward safety never
  // depends on a single check.
  if (status === "rewarded" || Number(task.reward_actual_pft || 0) > 0) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_already_rewarded",
      taskId,
      status,
    };
  }

  // proposed -> refused, accepted -> cancelled (matches shared/task-lifecycle.js
  // stop transitions). Race-safe: the WHERE only mutates rows still in a
  // cancellable state, so a concurrent transition cannot be clobbered.
  const transition = status === "proposed" ? "refused" : "cancelled";
  const audit = {
    agent_cancelled: true,
    agent_cancelled_by: "board_manager",
    agent_cancelled_reason: cancelReason,
    agent_cancelled_run_id: safeText(runId, 180),
    agent_cancelled_source_packet_digest: safeText(sourcePacket?.sourcePacketDigest, 120),
    agent_cancelled_transition: transition,
    agent_cancelled_referenced_task_ids: referencedTaskIds,
    agent_cancelled_at: new Date().toISOString(),
  };
  const updated = await query(
    `
      UPDATE task_projections
      SET status = $2,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
      WHERE task_id = $1
        AND status = ANY($4::text[])
      RETURNING task_id, status
    `,
    [taskId, transition, jsonValue(audit), ["proposed", "accepted"]]
  );
  if (!updated.rows[0]) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_cancel_task_state_changed",
      taskId,
      status,
    };
  }

  // Propagate the terminal status to the network-task mirror tables
  // (network_project_task_refs / network_task_allocations / intents / project
  // counts / followups) so they do not lag behind the projection. The projection
  // terminal write above is the reward-safety boundary; this sync is consistency
  // only. Best-effort: a failure leaves mirrors stale until the next batch sync
  // and does not undo the cancel.
  let mirrorSync = { ok: true, skipped: true, reason: "not_invoked" };
  try {
    mirrorSync = await syncNetworkTaskProjection({ taskId });
  } catch (error) {
    mirrorSync = { ok: false, error: safeText(error?.message || error, 500) };
  }

  // Capacity is released automatically: listNetworkTaskCapacityBlockers excludes
  // tasks whose task_projections.status is terminal, so this cancelled/refused
  // task no longer blocks the candidate. The agent_cancelled metadata marker,
  // together with the reducer guard in repositories/tasks.js and the direct-write
  // guard in offchain-task-lifecycle.js, prevents stale lifecycle events from
  // reviving or rewarding this task after Board Manager terminalizes it.
  return {
    executed: true,
    taskId,
    status: updated.rows[0].status,
    transition,
    cancelReason,
    referencedTaskIds,
    mirrorSync,
  };
}

export async function executeBoardManagerDecision({
  runId = "",
  decision = {},
  sourcePacket = {},
  dryRun = true,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedDecision = normalizeBoardManagerDecision(decision);
  if (dryRun) {
    const result = { executed: false, dryRun: true, action: normalizedDecision.action };
    await recordResult({ runId, decision: normalizedDecision, result });
    return { ok: true, result };
  }

  const projectMutationActions = new Set(["create_project", "archive_project", "restore_project"]);
  if (projectMutationActions.has(normalizedDecision.action) && deterministicBoardsEnabled()) {
    // Boards are operator-seeded by migration 098; model actions must not
    // create, archive, or restore network projects.
    const result = {
      executed: false,
      skipped: true,
      action: normalizedDecision.action,
      reason: "deterministic_boards_enabled",
    };
    await recordResult({ runId, decision: normalizedDecision, result });
    return { ok: true, result };
  }

  let result;
  try {
    switch (normalizedDecision.action) {
      case "do_nothing":
        result = { executed: true, action: "do_nothing" };
        break;
      case "message_user":
        result = await executeBoardManagerMessageUser({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "refresh_hive_secretary":
        result = await executeRefreshHiveSecretary({ decision: normalizedDecision });
        break;
      case "create_project":
        result = await executeCreateProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "archive_project":
        result = await executeArchiveProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "restore_project":
        result = await executeRestoreProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "assign_contributor":
        result = await executeAssignContributor({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "refresh_project_document":
        result = await executeRefreshProjectDocument({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      case "initiate_network_task":
        result = await executeInitiateNetworkTask({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      case "cancel_network_task":
        result = await executeCancelNetworkTask({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      default:
        throw new Error(`board_manager_action_not_implemented:${normalizedDecision.action}`);
    }
  } catch (error) {
    const failure = {
      executed: false,
      error: error?.message || String(error),
      action: normalizedDecision.action,
    };
    await recordResult({ runId, decision: normalizedDecision, result: failure }).catch(() => null);
    throw error;
  }
  await recordResult({ runId, decision: normalizedDecision, result });
  return { ok: true, result };
}

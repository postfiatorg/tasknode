import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";
import {
  buildHiveSecretarySourcePacket,
  getHiveContextDocument,
  getHiveSecretaryState,
} from "./hive-context.js";
import { latestHiveProjectPlanningState } from "./hive-project-planning.js";
import { getHiveProjectsDocument } from "./hive-projects.js";
import {
  getNetworkTaskContentSnapshot,
  listEligibleNetworkTaskCandidates,
  normalizeNetworkTaskRewardBand,
} from "./network-tasks.js";
import {
  formatBoardManagerAgentJob,
  buildBoardManagerRunMicroSummary,
  compactBoardManagerRunForSourcePacket,
  formatBoardManagerAgentRun,
} from "./board-manager-run-summary.js";
import { activeBoardManagerJobs } from "./board-manager-agent-jobs.js";
import { buildBoardManagerActionPressure } from "./board-manager-health.js";
import { listNetworkTaskCandidateCapacityChecks } from "./network-task-capacity.js";
import {
  expireOpenBoardManagerFollowups,
  listOpenBoardManagerFollowups,
  resolveStaleBoardManagerFollowups,
} from "./board-manager-state.js";
import { buildHiveRoutingConstraintsSnapshot } from "./hive-account-live-state.js";
import {
  compactHiveProjectsForBoardManager,
  compactNetworkTaskContentForBoardManager,
  compactProjectRegistryForBoardManager,
  compactTaskRequestsForBoardManager,
  compactTaskStateForBoardManager,
} from "./board-manager-source-compact.js";

export { formatBoardManagerAgentJob, formatBoardManagerAgentRun } from "./board-manager-run-summary.js";

export const boardManagerPromptVersion = "board_manager_v1";
export const boardManagerActions = Object.freeze([
  "do_nothing",
  "refresh_hive_secretary",
  "message_user",
  "create_project",
  "archive_project",
  "restore_project",
  "refresh_project_document",
  "assign_contributor",
  "initiate_network_task",
  "cancel_network_task",
]);

export const boardManagerInternalActions = Object.freeze([
  "daily_airdrop",
]);

const actionSet = new Set([...boardManagerActions, ...boardManagerInternalActions]);
const emptyBoardManagerPayload = Object.freeze({
  summary: "",
  next_steps: [],
  message_text: "",
  archive_reason: "",
  project: {
    id: "",
    type: "",
    title: "",
    summary: "",
    objective: "",
    about: "",
    priority: 0,
    phase_label: "",
    phase_current: 0,
    phase_total: 0,
    pft_routed: 0,
    task_count: 0,
    contributor_count: 0,
  },
  project_document: {
    title: "",
    summary: "",
    project_status: "",
    key_points: [],
    blocked_or_unclear: [],
    next_actions: [],
  },
  contributor: {
    project_id: "",
    account_id: "",
    wallet_address: "",
    codename: "",
    archetype: "",
    role_label: "",
    status: "",
    allotted: false,
    cap: 0,
    load: 0,
    sort_order: 0,
  },
  network_task: {
    task_class: "",
    candidate_account_id: "",
    candidate_wallet_address: "",
    project_need_summary: "",
    routing_reason: "",
    cadence_reason: "",
    action_output: "",
    delivery_surface: "",
    recipient_or_reviewer: "",
    escalation_stage: "",
    lineage_task_ids: [],
    referenced_outputs: [],
    deduped_against: [],
    why_not_duplicate: "",
    reward_min_pft: 10000,
    reward_max_pft: 50000,
    accept_window_hours: 24,
    allow_over_capacity: false,
  },
  message_precondition: {
    intent: "",
    project_id: "",
    related_task_id: "",
    related_allocation_id: "",
    expected_task_status: [],
    expected_allocation_status: [],
    expected_followup_status: "",
    expected_min_reward_pft: 0,
    allow_terminal_task: false,
  },
  cancel_target: {
    task_id: "",
    reason: "",
    referenced_task_ids: [],
  },
});

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

function normalizeLineageTaskIds(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => safeText(item, 180))
    .filter(Boolean);
}

function normalizeReferencedOutputs(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        task_id: safeText(input.task_id || input.taskId, 180),
        cid: safeText(input.cid || input.source_cid || input.sourceCid, 240),
        tx_hash: safeText(input.tx_hash || input.txHash || input.source_tx_hash || input.sourceTxHash, 180),
        summary: safeText(input.summary || input.title || input.description, 700),
        how_used: safeText(input.how_used || input.howUsed, 700),
      };
    })
    .filter((item) => item.task_id || item.cid || item.tx_hash || item.summary);
}

function normalizeDedupedAgainst(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        task_id: safeText(input.task_id || input.taskId, 180),
        theme: safeText(input.theme || input.title, 240),
        reason_not_repeated: safeText(input.reason_not_repeated || input.reasonNotRepeated || input.reason, 700),
      };
    })
    .filter((item) => item.task_id || item.theme || item.reason_not_repeated);
}

function normalizePayload(payload = {}) {
  const input = safeObject(payload);
  const project = safeObject(input.project);
  const projectDocument = safeObject(input.project_document || input.projectDocument);
  const contributor = safeObject(input.contributor);
  const networkTask = safeObject(input.network_task || input.networkTask);
  const messagePrecondition = safeObject(input.message_precondition || input.messagePrecondition);
  const cancelTarget = safeObject(input.cancel_target || input.cancelTarget);
  const rewardBand = normalizeNetworkTaskRewardBand({
    min: networkTask.reward_min_pft ?? networkTask.rewardMinPft,
    max: networkTask.reward_max_pft ?? networkTask.rewardMaxPft,
  });
  return {
    summary: safeText(input.summary, 2000),
    next_steps: safeArray(input.next_steps || input.nextSteps).slice(0, 8).map((item) => safeText(item, 500)).filter(Boolean),
    message_text: safeText(input.message_text || input.messageText, 4000),
    archive_reason: safeText(input.archive_reason || input.archiveReason, 1000),
    project: {
      id: safeText(project.id, 180),
      type: safeText(project.type, 80),
      title: safeText(project.title, 180),
      summary: safeText(project.summary, 600),
      objective: safeText(project.objective, 900),
      about: safeText(project.about, 2000),
      priority: Math.max(0, Math.round(Number(project.priority || 0) || 0)),
      phase_label: safeText(project.phase_label || project.phaseLabel, 100),
      phase_current: Math.max(0, Math.round(Number(project.phase_current ?? project.phaseCurrent ?? 0) || 0)),
      phase_total: Math.max(0, Math.round(Number(project.phase_total ?? project.phaseTotal ?? 0) || 0)),
      pft_routed: Math.max(0, Number(project.pft_routed ?? project.pftRouted ?? 0) || 0),
      task_count: Math.max(0, Math.round(Number(project.task_count ?? project.taskCount ?? 0) || 0)),
      contributor_count: Math.max(0, Math.round(Number(project.contributor_count ?? project.contributorCount ?? 0) || 0)),
    },
    project_document: {
      title: safeText(projectDocument.title, 180),
      summary: safeText(projectDocument.summary, 1200),
      project_status: safeText(projectDocument.project_status || projectDocument.projectStatus, 1800),
      key_points: safeArray(projectDocument.key_points || projectDocument.keyPoints).slice(0, 8).map((item) => safeText(item, 700)).filter(Boolean),
      blocked_or_unclear: safeArray(projectDocument.blocked_or_unclear || projectDocument.blockedOrUnclear).slice(0, 6).map((item) => safeText(item, 700)).filter(Boolean),
      next_actions: safeArray(projectDocument.next_actions || projectDocument.nextActions).slice(0, 6).map((item) => safeText(item, 700)).filter(Boolean),
    },
    contributor: {
      project_id: safeText(contributor.project_id || contributor.projectId, 180),
      account_id: safeText(contributor.account_id || contributor.accountId, 180),
      wallet_address: safeText(contributor.wallet_address || contributor.walletAddress, 120),
      codename: safeText(contributor.codename, 120),
      archetype: safeText(contributor.archetype, 180),
      role_label: safeText(contributor.role_label || contributor.roleLabel, 80),
      status: safeText(contributor.status, 80),
      allotted: Boolean(contributor.allotted),
      cap: Math.max(0, Math.round(Number(contributor.cap || 0) || 0)),
      load: Math.max(0, Math.round(Number(contributor.load || 0) || 0)),
      sort_order: Math.max(0, Math.round(Number(contributor.sort_order ?? contributor.sortOrder ?? 0) || 0)),
    },
    network_task: {
      task_class: safeText(networkTask.task_class || networkTask.taskClass, 40),
      candidate_account_id: safeText(networkTask.candidate_account_id || networkTask.candidateAccountId, 180),
      candidate_wallet_address: safeText(networkTask.candidate_wallet_address || networkTask.candidateWalletAddress, 120),
      project_need_summary: safeText(networkTask.project_need_summary || networkTask.projectNeedSummary, 2000),
      routing_reason: safeText(networkTask.routing_reason || networkTask.routingReason, 1800),
      cadence_reason: safeText(networkTask.cadence_reason || networkTask.cadenceReason, 700),
      action_output: safeText(networkTask.action_output || networkTask.actionOutput, 1200),
      delivery_surface: safeText(networkTask.delivery_surface || networkTask.deliverySurface, 120),
      recipient_or_reviewer: safeText(networkTask.recipient_or_reviewer || networkTask.recipientOrReviewer, 240),
      escalation_stage: safeText(networkTask.escalation_stage || networkTask.escalationStage, 120),
      lineage_task_ids: normalizeLineageTaskIds(networkTask.lineage_task_ids || networkTask.lineageTaskIds),
      referenced_outputs: normalizeReferencedOutputs(networkTask.referenced_outputs || networkTask.referencedOutputs),
      deduped_against: normalizeDedupedAgainst(networkTask.deduped_against || networkTask.dedupedAgainst),
      why_not_duplicate: safeText(networkTask.why_not_duplicate || networkTask.whyNotDuplicate, 1200),
      reward_min_pft: rewardBand.min,
      reward_max_pft: rewardBand.max,
      accept_window_hours: Math.min(
        336,
        Math.max(1, Math.round(Number(networkTask.accept_window_hours ?? networkTask.acceptWindowHours ?? 24) || 24))
      ),
      allow_over_capacity: Boolean(networkTask.allow_over_capacity || networkTask.allowOverCapacity),
    },
    message_precondition: {
      intent: safeText(messagePrecondition.intent, 80),
      project_id: safeText(messagePrecondition.project_id || messagePrecondition.projectId, 180),
      related_task_id: safeText(messagePrecondition.related_task_id || messagePrecondition.relatedTaskId, 180),
      related_allocation_id: safeText(
        messagePrecondition.related_allocation_id || messagePrecondition.relatedAllocationId,
        180
      ),
      expected_task_status: safeArray(messagePrecondition.expected_task_status || messagePrecondition.expectedTaskStatus)
        .map((item) => safeText(item, 80).toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
      expected_allocation_status: safeArray(
        messagePrecondition.expected_allocation_status || messagePrecondition.expectedAllocationStatus
      )
        .map((item) => safeText(item, 80).toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
      expected_followup_status: safeText(
        messagePrecondition.expected_followup_status || messagePrecondition.expectedFollowupStatus,
        80
      ).toLowerCase(),
      expected_min_reward_pft: Math.max(
        0,
        Number(messagePrecondition.expected_min_reward_pft ?? messagePrecondition.expectedMinRewardPft ?? 0) || 0
      ),
      allow_terminal_task: Boolean(messagePrecondition.allow_terminal_task || messagePrecondition.allowTerminalTask),
    },
    cancel_target: {
      task_id: safeText(cancelTarget.task_id || cancelTarget.taskId, 180),
      reason: safeText(cancelTarget.reason, 1000),
      referenced_task_ids: safeArray(cancelTarget.referenced_task_ids || cancelTarget.referencedTaskIds)
        .map((item) => safeText(item, 180))
        .filter(Boolean)
        .slice(0, 12),
    },
  };
}

function normalizeDecisionBasis(decision = {}, fallbackReason = "") {
  const input = safeObject(decision.decision_basis || decision.decisionBasis);
  const sourceFacts = safeArray(input.source_facts || input.sourceFacts)
    .map((item) => safeText(item, 500))
    .filter(Boolean)
    .slice(0, 8);
  const tradeoffs = safeArray(input.tradeoffs)
    .map((item) => safeText(item, 500))
    .filter(Boolean)
    .slice(0, 6);
  const rejectedActions = safeArray(input.rejected_actions || input.rejectedActions)
    .map((item) => {
      const action = safeText(item?.action, 80);
      if (!boardManagerActions.includes(action)) return null;
      return {
        action,
        reason: safeText(item?.reason, 500),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  const riskNotes = safeArray(input.risk_notes || input.riskNotes)
    .map((item) => safeText(item, 500))
    .filter(Boolean)
    .slice(0, 6);
  return {
    source_facts: sourceFacts.length ? sourceFacts : [safeText(fallbackReason, 500) || "No structured source facts were recorded for this run."],
    tradeoffs,
    rejected_actions: rejectedActions,
    risk_notes: riskNotes,
    next_check: safeText(input.next_check || input.nextCheck, 700),
  };
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function ageMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

function compactContextDocument(document = {}) {
  return {
    id: safeText(document.id, 120),
    generatedAt: document.generatedAt,
    entryCount: Number(document.entryCount || 0),
    userCount: Number(document.userCount || 0),
    groups: safeArray(document.groups).slice(0, 24).map((group) => ({
      accountId: safeText(group.accountId, 160),
      displayName: safeText(group.displayName, 120),
      latestAt: group.latestAt || null,
      entryCount: Number(group.entryCount || 0),
      entries: safeArray(group.entries).slice(0, 12).map((entry) => ({
        id: safeText(entry.id, 180),
        accountId: safeText(entry.accountId, 160),
        displayName: safeText(entry.displayName, 120),
        body: safeText(entry.body, 3600),
        sourceConversationId: safeText(entry.sourceConversationId, 180),
        walletValidated: Boolean(entry.walletValidated),
        walletAddress: safeText(entry.walletAddress, 120),
        createdAt: entry.createdAt || null,
      })),
    })),
  };
}

function compactSecretarySourcePacket(packet = {}) {
  return {
    digest: safeText(packet.sourcePacketDigest, 120),
    counts: safeObject(packet.counts),
    sourceJson: safeObject(packet.sourceJson),
    sourceText: safeText(packet.sourceText, 24000),
  };
}

function compactTask(row = {}) {
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    status: safeText(row.status, 80),
    title: safeText(row.title, 240),
    kind: safeText(row.task_kind, 80),
    rewardOfferPft: Number(row.reward_offer_pft || 0),
    rewardActualPft: Number(row.reward_actual_pft || 0),
    subjectWallet: safeText(row.subject_wallet, 120),
    updatedAt: iso(row.updated_at),
    lastEventAt: iso(row.last_event_at),
  };
}

async function currentProjectRegistry({ limit = 50 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT id, type, title, summary, objective, about, status, priority, origin,
             phase_label, phase_current, phase_total, pft_routed, task_count,
             contributor_count, source_hive_secretary_report_id,
             source_hive_secretary_report_digest, metadata_json, updated_at, created_at
      FROM network_projects
      ORDER BY
        CASE status
          WHEN 'active' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'archived' THEN 3
          WHEN 'completed' THEN 4
          ELSE 5
        END,
        priority ASC,
        updated_at DESC,
        id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    objective: row.objective,
    about: row.about,
    status: row.status,
    priority: Number(row.priority || 0),
    origin: row.origin,
    phaseLabel: row.phase_label,
    phaseCurrent: Number(row.phase_current || 0),
    phaseTotal: Number(row.phase_total || 0),
    pftRouted: Number(row.pft_routed || 0),
    taskCount: Number(row.task_count || 0),
    contributorCount: Number(row.contributor_count || 0),
    sourceHiveSecretaryReportId: row.source_hive_secretary_report_id,
    sourceHiveSecretaryReportDigest: row.source_hive_secretary_report_digest,
    metadata: safeObject(row.metadata_json),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
  }));
}

async function currentTaskState({ limit = 30 } = {}) {
  if (!useDatabase()) return { counts: [], recent: [] };
  const [counts, recent] = await Promise.all([
    query(
      `
        SELECT status, count(*)::int AS count
        FROM task_projections
        GROUP BY status
        ORDER BY status ASC
      `
    ),
    query(
      `
        SELECT task_id, request_id, status, title, task_kind, reward_offer_pft,
               reward_actual_pft, subject_wallet, updated_at, last_event_at
        FROM task_projections
        ORDER BY updated_at DESC, task_id ASC
        LIMIT $1
      `,
      [Math.min(Math.max(Number(limit) || 30, 1), 80)]
    ),
  ]);
  return {
    counts: counts.rows.map((row) => ({ status: row.status, count: Number(row.count || 0) })),
    recent: recent.rows.map(compactTask),
  };
}

async function currentTaskRequests({ limit = 20 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT request_id, account_id, subject_wallet, source, source_conversation_id,
             source_conversation_title, request_text, user_detail_text,
             requested_task_kind, status, generated_task_id, worker_attempt_count,
             last_error, created_at, updated_at
      FROM task_requests
      ORDER BY updated_at DESC, request_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 20, 1), 60)]
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    accountId: row.account_id,
    subjectWallet: row.subject_wallet,
    source: row.source,
    sourceConversationId: row.source_conversation_id,
    sourceConversationTitle: row.source_conversation_title,
    requestText: safeText(row.request_text, 800),
    userDetailText: safeText(row.user_detail_text, 1600),
    requestedTaskKind: row.requested_task_kind,
    status: row.status,
    generatedTaskId: row.generated_task_id,
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

export function buildHiveGenerationQualityPolicy({ operatorConstraintsSummary = "" } = {}) {
  return {
    schema: "pf.hive.generation_quality_policy.v1",
    documentationOnlyDefault: "low_value_unless_action_coupled",
    requiresConcreteActionOutput: true,
    escalationLadder: "document_to_action_v1",
    operatorConstraintsSummary: safeText(operatorConstraintsSummary, 1200),
  };
}

export const boardManagerTaskWorkTypeVocabulary = Object.freeze([
  {
    id: "code_task",
    label: "Code task",
    definition: "Requires changing, reviewing, or proving access to code, pull requests, commits, deployment artifacts, or repository state.",
    evidence_standard: "Needs a resolvable PR/commit/build artifact or an approved capability proof before private-repo work is sensible.",
  },
  {
    id: "documentation_task",
    label: "Documentation task",
    definition: "Produces a report, memo, friction list, map, audit note, or recommendation without requiring the contributor to take an external action.",
    evidence_standard: "Low-value unless explicitly coupled to a concrete action/output and prior-output lineage.",
  },
  {
    id: "capability_gating_task",
    label: "Capability-gating task",
    definition: "Asks the contributor to prove they can access or deliver on a surface before routing the substantive work.",
    evidence_standard: "Needs a capability proof artifact such as an accessible PR URL, integration-backed access check, or operator-reviewed attestation.",
  },
  {
    id: "evidence_evaluation_packet",
    label: "Evidence-evaluation packet",
    definition: "A concise review packet that classifies submitted evidence as verified, unverifiable, or self-attested and recommends the next board action.",
    evidence_standard: "Advisory context only; never a reward verdict or hidden task lifecycle mutation.",
  },
]);

function normalizeCapabilityType(value = "") {
  return safeText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unspecified_capability";
}

function capabilityScopeDigest(value = "") {
  const normalized = safeText(value, 500).toLowerCase();
  if (!normalized) return "";
  return digestJson({ scope: normalized }).slice(0, 16);
}

function normalizeCapabilityRequirement(value = {}, { projectId = "" } = {}) {
  const input = typeof value === "string" ? { capability_type: value } : safeObject(value);
  const capabilityType = normalizeCapabilityType(
    input.capability_type || input.capabilityType || input.type || input.id || input.capability || "unspecified_capability"
  );
  const rawScope = safeText(
    input.scope || input.scope_ref || input.scopeRef || input.repository || input.repo || input.channel || "",
    500
  );
  const scopeLabel = safeText(
    input.scope_label || input.scopeLabel || input.surface_label || input.surfaceLabel || input.label || capabilityType,
    180
  );
  const visibility = safeText(input.visibility || input.exposure || "internal", 80).toLowerCase();
  return {
    requirement_id: safeText(input.requirement_id || input.requirementId || `${projectId || "project"}:${capabilityType}`, 240),
    project_id: safeText(projectId, 180),
    capability_type: capabilityType,
    scope_label: scopeLabel || capabilityType,
    scope_digest: capabilityScopeDigest(rawScope || scopeLabel || capabilityType),
    visibility: ["public", "internal", "private"].includes(visibility) ? visibility : "internal",
    status: "required",
    proof_task_type: "capability_gating_task",
    public_exposure: "do_not_expose_private_membership",
  };
}

function capabilityRequirementsFromProject(project = {}) {
  const metadata = safeObject(project.metadata || project.metadata_json);
  const routing = safeObject(metadata.routing_constraints || metadata.routingConstraints);
  const rawRequirements = [
    ...safeArray(metadata.required_capabilities),
    ...safeArray(metadata.requiredCapabilities),
    ...safeArray(metadata.capability_requirements),
    ...safeArray(metadata.capabilityRequirements),
    ...safeArray(routing.required_capabilities),
    ...safeArray(routing.requiredCapabilities),
  ];
  const seen = new Set();
  return rawRequirements
    .map((item) => normalizeCapabilityRequirement(item, { projectId: project.id }))
    .filter((item) => {
      const key = `${item.project_id}:${item.capability_type}:${item.scope_digest}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return item.capability_type;
    })
    .slice(0, 8);
}

function normalizeCandidateCapabilityEvidence(value = {}, { source = "candidate_profile" } = {}) {
  const input = typeof value === "string" ? { capability_type: value } : safeObject(value);
  const rawType = input.capability_type || input.capabilityType || input.type || input.id || input.capability || "";
  if (!safeText(rawType, 120)) return null;
  const capabilityType = normalizeCapabilityType(rawType);
  const rawScope = safeText(
    input.scope || input.scope_ref || input.scopeRef || input.repository || input.repo || input.channel || "",
    500
  );
  return {
    capability_type: capabilityType,
    scope_label: safeText(input.scope_label || input.scopeLabel || input.surface_label || input.surfaceLabel || input.label || capabilityType, 180),
    scope_digest: capabilityScopeDigest(rawScope || input.scope_label || input.scopeLabel || capabilityType),
    status: safeText(input.status || source, 80).toLowerCase(),
    evidence_task_id: safeText(input.evidence_task_id || input.evidenceTaskId || input.task_id || input.taskId, 180),
    source,
  };
}

function candidateCapabilityEvidence(candidate = {}) {
  const profileOutput = safeObject(candidate.profileOutput || candidate.profile_output || candidate.output_json);
  const capabilityBlock = safeObject(profileOutput.capabilities || profileOutput.capability_profile || profileOutput.capabilityProfile);
  const verifiedRaw = [
    ...safeArray(profileOutput.verified_capabilities),
    ...safeArray(profileOutput.verifiedCapabilities),
    ...safeArray(capabilityBlock.verified),
    ...safeArray(capabilityBlock.verified_capabilities),
    ...safeArray(capabilityBlock.verifiedCapabilities),
  ];
  const declaredRaw = [
    ...safeArray(profileOutput.declared_capabilities),
    ...safeArray(profileOutput.declaredCapabilities),
    ...safeArray(capabilityBlock.declared),
    ...safeArray(capabilityBlock.declared_capabilities),
    ...safeArray(capabilityBlock.declaredCapabilities),
    ...safeArray(capabilityBlock.items),
  ];
  const verified = verifiedRaw
    .map((item) => normalizeCandidateCapabilityEvidence(item, { source: "verified_profile_capability" }))
    .filter(Boolean)
    .slice(0, 12);
  const declared = declaredRaw
    .map((item) => normalizeCandidateCapabilityEvidence(item, { source: "declared_profile_capability" }))
    .filter(Boolean)
    .filter((item) => !verified.some((verifiedItem) =>
      verifiedItem.capability_type === item.capability_type && verifiedItem.scope_digest === item.scope_digest
    ))
    .slice(0, 12);
  return { verified, declared };
}

function candidateSatisfiesRequirement(candidate = {}, requirement = {}) {
  return safeArray(candidate.verified_capabilities).some((capability) => {
    if (capability.capability_type !== requirement.capability_type) return false;
    if (!requirement.scope_digest) return true;
    return capability.scope_digest === requirement.scope_digest || !capability.scope_digest;
  });
}

export function buildBoardManagerCapabilityInstrumentation({
  projectRegistry = [],
  networkTaskCandidates = [],
} = {}) {
  const projects = safeArray(projectRegistry).slice(0, 24);
  const candidates = safeArray(networkTaskCandidates).slice(0, 20).map((candidate) => {
    const evidence = candidateCapabilityEvidence(candidate);
    return {
      account_id: safeText(candidate.accountId || candidate.account_id, 180),
      wallet_address: safeText(candidate.walletAddress || candidate.wallet_address, 120),
      profile_id: safeText(candidate.profileId || candidate.profile_id, 180),
      verified_capabilities: evidence.verified,
      declared_capabilities: evidence.declared,
      capability_source: evidence.verified.length || evidence.declared.length
        ? "network_task_profile_output"
        : "none_recorded_phase_a",
    };
  });
  const projectCapabilityRequirements = projects
    .flatMap((project) => capabilityRequirementsFromProject(project))
    .slice(0, 40);
  const capabilityGaps = [];
  for (const requirement of projectCapabilityRequirements) {
    for (const candidate of candidates) {
      if (!candidate.account_id && !candidate.wallet_address) continue;
      if (candidateSatisfiesRequirement(candidate, requirement)) continue;
      capabilityGaps.push({
        project_id: requirement.project_id,
        candidate_account_id: candidate.account_id,
        candidate_wallet_address: candidate.wallet_address,
        capability_type: requirement.capability_type,
        scope_label: requirement.scope_label,
        scope_digest: requirement.scope_digest,
        candidate_status: "missing_verified_capability",
        recommended_task_work_type: "capability_gating_task",
        privacy_note: "Do not expose private repo/channel membership; route proof-gathering work or ask the operator for verification.",
      });
      if (capabilityGaps.length >= 48) break;
    }
    if (capabilityGaps.length >= 48) break;
  }
  return {
    schema: "pf.hive.board_manager.capability_instrumentation.v1",
    status: "phase_a_instrumentation_only_no_enforcement",
    task_work_type_vocabulary: boardManagerTaskWorkTypeVocabulary,
    capability_profile_status: "persistent_capability_profiles_not_yet_implemented_phase_b",
    project_capability_requirements: projectCapabilityRequirements,
    candidate_capabilities: candidates,
    capability_gaps: capabilityGaps,
    summary: {
      requirement_count: projectCapabilityRequirements.length,
      candidate_count: candidates.length,
      gap_count: capabilityGaps.length,
      has_private_scope_requirements: projectCapabilityRequirements.some((item) => item.visibility === "private"),
    },
    open_questions_reserved_for_alex: [
      "which repos count as private code surfaces",
      "who can mark a capability verified",
      "whether capability-gating tasks are paid",
      "which Discord channels can be system-verified",
    ],
    enforcement: "none_context_only",
  };
}

function contextEntries(document = {}) {
  return safeArray(document.groups).flatMap((group) =>
    safeArray(group.entries).map((entry) => ({
      id: safeText(entry.id, 180),
      accountId: safeText(entry.accountId || group.accountId, 180),
      displayName: safeText(entry.displayName || group.displayName, 120),
      body: safeText(entry.body, 1600),
      sourceConversationId: safeText(entry.sourceConversationId, 180),
      walletValidated: Boolean(entry.walletValidated),
      walletAddress: safeText(entry.walletAddress, 120),
      createdAt: entry.createdAt || group.latestAt || null,
    }))
  ).filter((entry) => entry.id || entry.body);
}

export function extractOperatorStandingPolicy({
  hiveContext = {},
  hiveSecretarySource = {},
  recentBoardManagerRuns: runs = [],
} = {}) {
  const entries = contextEntries(compactContextDocument(hiveContext))
    .sort((left, right) => (Date.parse(right.createdAt || "") || 0) - (Date.parse(left.createdAt || "") || 0))
    .slice(0, 16)
    .map((entry) => ({
      source_id: entry.id,
      source_account_id: entry.accountId,
      created_at: entry.createdAt || "",
      directive: entry.body,
      active_scope: "global",
      generation_implication: "Preserve as non-compressible operator context for Network Task shape, routing, and output decisions.",
    }));
  const secretaryFacts = safeArray(hiveSecretarySource?.sourceJson?.facts_to_preserve || hiveSecretarySource?.facts_to_preserve)
    .slice(0, 8)
    .map((fact, index) => ({
      source_id: `secretary_fact_${index + 1}`,
      source_account_id: "",
      created_at: hiveSecretarySource?.sourceJson?.generated_at || "",
      directive: safeText(fact, 1200),
      active_scope: "global",
      generation_implication: "Preserve from the pre-compression Secretary source as operator policy context.",
    }))
    .filter((item) => item.directive);
  const runPolicyFacts = safeArray(runs)
    .flatMap((run) => safeArray(run?.decision?.decision_basis?.source_facts || run?.decisionBasis?.sourceFacts))
    .slice(0, 8)
    .map((fact, index) => ({
      source_id: `recent_run_fact_${index + 1}`,
      source_account_id: "",
      created_at: "",
      directive: safeText(fact, 1200),
      active_scope: "global",
      generation_implication: "Preserve recent Board Manager basis as continuity context for the next generation decision.",
    }))
    .filter((item) => item.directive);
  const seen = new Set();
  return [...entries, ...secretaryFacts, ...runPolicyFacts]
    .filter((item) => {
      const key = `${item.source_id}:${item.directive}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

function compactEventSummary(payload = {}) {
  const input = safeObject(payload);
  const rewardScore = safeObject(input.reward_score || input.score);
  return safeText(
    input.submission_summary ||
      input.evidence_summary ||
      input.verification_summary ||
      input.review_summary ||
      input.summary ||
      rewardScore.user_feedback ||
      rewardScore.reason ||
      input.reward_summary ||
      input.reason ||
      "",
    900
  );
}

function compactCorpusRow(row = {}) {
  const sourcePayload = safeObject(row.source_payload_json);
  const sourceNetworkTask = safeObject(sourcePayload.networkTask || sourcePayload.network_task);
  const eventPayload = safeObject(row.latest_event_payload);
  const sourceCids = [
    row.latest_source_cid,
    safeArray(sourceNetworkTask.referencedOutputs).find((item) => item?.cid)?.cid,
  ].map((cid) => safeText(cid, 240)).filter(Boolean);
  const sourceTxHashes = [
    row.latest_source_tx_hash,
    safeArray(sourceNetworkTask.referencedOutputs).find((item) => item?.txHash || item?.tx_hash)?.txHash,
  ].map((txHash) => safeText(txHash, 180)).filter(Boolean);
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    projectId: safeText(row.project_id || sourcePayload.project?.id, 180),
    state: safeText(row.status || row.ref_state, 80),
    title: safeText(row.title || row.ref_title, 240),
    summary: safeText(row.description || row.project_need_summary || sourceNetworkTask.projectNeedSummary, 900),
    assigneeWallet: safeText(row.assignee_wallet || row.subject_wallet || row.candidate_wallet_address, 120),
    candidateAccountId: safeText(row.candidate_account_id, 180),
    rewardPft: Number(row.reward_actual_pft || row.reward_offer_pft || row.ref_reward_pft || 0),
    projectNeedSummary: safeText(row.project_need_summary || sourceNetworkTask.projectNeedSummary, 700),
    routingReason: safeText(row.allocation_reason_summary || sourceNetworkTask.allocationReasonSummary, 700),
    eventSummary: compactEventSummary(eventPayload),
    eventType: safeText(row.latest_event_type, 120),
    sourceCids: [...new Set(sourceCids)].slice(0, 4),
    sourceTxHashes: [...new Set(sourceTxHashes)].slice(0, 4),
    actionOutput: safeText(sourceNetworkTask.actionOutput || sourceNetworkTask.action_output, 700),
    deliverySurface: safeText(sourceNetworkTask.deliverySurface || sourceNetworkTask.delivery_surface, 120),
    escalationStage: safeText(sourceNetworkTask.escalationStage || sourceNetworkTask.escalation_stage, 120),
    updatedAt: iso(row.updated_at || row.ref_updated_at),
    createdAt: iso(row.created_at || row.ref_created_at),
  };
}

function corpusTheme(task = {}) {
  return safeText(task.title || task.projectNeedSummary || task.summary, 240)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(document|write|map|review|inspect|trace|draft|create|submit|task|report|friction|fixes|fix|and|the|for|with|to|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

export function compactNetworkTaskOutputCorpusForBoardManager(rows = [], { limit = 36 } = {}) {
  const outputs = safeArray(rows).map(compactCorpusRow).filter((item) => item.taskId || item.requestId).slice(0, limit);
  const projectsCovered = [...new Set(outputs.map((item) => item.projectId).filter(Boolean))].slice(0, 16);
  const themeGroups = new Map();
  for (const output of outputs) {
    const theme = corpusTheme(output);
    if (!theme) continue;
    const group = themeGroups.get(theme) || [];
    group.push(output);
    themeGroups.set(theme, group);
  }
  const repeatedThemes = [...themeGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .slice(0, 12)
    .map(([theme, items]) => `${theme}: ${items.slice(0, 5).map((item) => item.taskId || item.requestId).join(", ")}`);
  const deduplicationWatchlist = [...themeGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .slice(0, 12)
    .map(([theme, items]) => ({
      theme,
      project_id: safeText(items[0]?.projectId, 180),
      prior_task_ids: items.map((item) => item.taskId).filter(Boolean).slice(0, 8),
      prior_cids: [...new Set(items.flatMap((item) => item.sourceCids || []))].slice(0, 8),
      why_not_repeat: "Prior outputs already cover this theme; use them as lineage and choose the next concrete action.",
      next_action_suggestion: "Escalate documented findings into a PR, mock, named handoff, project patch, or verification task.",
    }));
  return {
    schema: "pf.hive.network_task_output_corpus.v1",
    generatedAt: new Date().toISOString(),
    summary: {
      projects_covered: projectsCovered,
      recent_outputs: outputs.slice(0, 12).map((item) => ({
        task_id: item.taskId,
        project_id: item.projectId,
        title: item.title,
        summary: item.eventSummary || item.summary || item.projectNeedSummary,
        state: item.state,
      })),
      repeated_themes: repeatedThemes,
      open_actionable_items: outputs
        .filter((item) => ["proposed", "accepted", "submitted", "verification_requested"].includes(item.state))
        .slice(0, 10)
        .map((item) => `${item.taskId || item.requestId}: ${item.title || item.projectNeedSummary}`),
    },
    outputs,
    deduplicationWatchlist,
  };
}

export async function getNetworkTaskOutputCorpus({ limit = 36 } = {}) {
  if (!useDatabase()) return compactNetworkTaskOutputCorpusForBoardManager([]);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 36, 1), 80);
  const result = await query(
    `
      SELECT
        refs.project_id,
        refs.task_id,
        refs.request_id,
        refs.title AS ref_title,
        refs.state AS ref_state,
        refs.assignee_wallet,
        refs.reward_pft AS ref_reward_pft,
        refs.created_at AS ref_created_at,
        refs.updated_at AS ref_updated_at,
        p.status,
        p.title,
        p.description,
        p.reward_offer_pft,
        p.reward_actual_pft,
        p.subject_wallet,
        p.created_at,
        p.updated_at,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        alloc.project_need_summary,
        alloc.allocation_reason_summary,
        job.source_payload_json,
        latest_event.event_type AS latest_event_type,
        latest_event.source_tx_hash AS latest_source_tx_hash,
        latest_event.source_cid AS latest_source_cid,
        latest_event.payload_json AS latest_event_payload
      FROM network_project_task_refs refs
      LEFT JOIN task_projections p
        ON p.task_id = refs.task_id
      LEFT JOIN network_task_generation_jobs job
        ON (
          (refs.task_id <> '' AND job.task_id = refs.task_id)
          OR (refs.request_id <> '' AND job.request_id = refs.request_id)
        )
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      LEFT JOIN LATERAL (
        SELECT e.event_type, e.source_tx_hash, e.source_cid, e.payload_json
        FROM task_events e
        WHERE e.task_id = refs.task_id
          AND e.event_type IN (
            'pf.task.submission.v1',
            'pf.task.verification_request.v1',
            'pf.task.verification_response.v1',
            'pf.reward.v1'
          )
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
      ) latest_event ON true
      WHERE refs.source = 'network_task_generation'
      ORDER BY COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at, refs.created_at) DESC,
               refs.id DESC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return compactNetworkTaskOutputCorpusForBoardManager(result.rows, { limit: normalizedLimit });
}

function internalRunFilterSql(includeInternal = false) {
  return includeInternal
    ? ""
    : "AND lower(trigger) NOT LIKE '%smoke%' AND lower(manager_id) NOT LIKE '%smoke%'";
}

function boardManagerSourceLogSnapshot(packet = {}) {
  const source = safeObject(packet);
  if (!Object.keys(source).length) return {};
  return {
    schema: safeText(source.schema, 120),
    scope: safeText(source.scope, 120),
    trigger: safeText(source.trigger, 160),
    generatedAt: source.generatedAt || null,
    sourcePacketDigest: safeText(source.sourcePacketDigest, 120),
    freshness: safeObject(source.freshness),
    boardActionPressure: safeObject(source.boardActionPressure),
    networkTaskCandidates: safeArray(source.networkTaskCandidates).slice(0, 20),
    operatorStandingPolicy: safeArray(source.operatorStandingPolicy).slice(0, 24),
    generationQualityPolicy: safeObject(source.generationQualityPolicy),
    networkTaskOutputCorpus: safeObject(source.networkTaskOutputCorpus),
    priorOutputCorpusSummary: safeObject(source.priorOutputCorpusSummary),
    deduplicationWatchlist: safeArray(source.deduplicationWatchlist).slice(0, 16),
    capabilityInstrumentation: safeObject(source.capabilityInstrumentation),
    routingConstraints: safeObject(source.routingConstraints),
    openFollowups: safeArray(source.openFollowups).slice(0, 20),
    hiveProjects: safeObject(source.hiveProjects),
    projectRegistry: safeArray(source.projectRegistry).slice(0, 40),
    networkTaskContent: safeObject(source.networkTaskContent),
    taskState: safeObject(source.taskState),
    taskRequests: safeArray(source.taskRequests).slice(0, 20),
    recentBoardManagerRuns: safeArray(source.recentBoardManagerRuns).slice(0, 20),
    executionPolicy: safeObject(source.executionPolicy),
  };
}

async function recentBoardManagerRuns({ limit = 12, includeInternal = false, includeDetails = false } = {}) {
  if (!useDatabase()) return [];
  const exists = await query("SELECT to_regclass('public.board_manager_runs') AS name");
  if (!exists.rows[0]?.name) return [];
  const result = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             selected_action, action_payload_json, decision_json, dry_run,
             model, reasoning_effort, error, codex_session_id, codex_session_path,
             session_mode, micro_summary_json, micro_summary_text,
             ${includeDetails ? "provider, output_text, source_packet_json," : ""}
             started_at, completed_at
      FROM board_manager_runs
      WHERE 1 = 1
        ${internalRunFilterSql(includeInternal)}
      ORDER BY started_at DESC, id DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 12, 1), 30)]
  );
  const actionResults = result.rows.length
    ? await query(
        `
          SELECT run_id, id, action, target_type, target_id, result_json, created_at
          FROM board_manager_action_results
          WHERE run_id = ANY($1::text[])
          ORDER BY created_at DESC, id DESC
        `,
        [result.rows.map((row) => row.id)]
      )
    : { rows: [] };
  const actionResultsByRun = new Map();
  for (const row of actionResults.rows) {
    const list = actionResultsByRun.get(row.run_id) || [];
    list.push({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      result: safeObject(row.result_json),
      createdAt: iso(row.created_at),
    });
    actionResultsByRun.set(row.run_id, list);
  }
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    managerId: row.manager_id,
    trigger: row.trigger,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    selectedAction: row.selected_action,
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    microSummary: safeObject(row.micro_summary_json),
    microSummaryText: safeText(row.micro_summary_text, 3000),
    dryRun: Boolean(row.dry_run),
    provider: safeText(row.provider, 120),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    codexSessionId: row.codex_session_id,
    codexSessionPath: row.codex_session_path,
    sessionMode: row.session_mode,
    error: row.error,
    actionResults: actionResultsByRun.get(row.id) || [],
    details: includeDetails
      ? {
          provider: safeText(row.provider, 120),
          outputText: safeText(row.output_text, 40_000),
          decision: safeObject(row.decision_json),
          actionPayload: safeObject(row.action_payload_json),
          microSummary: safeObject(row.micro_summary_json),
          microSummaryText: safeText(row.micro_summary_text, 5000),
          actionResults: actionResultsByRun.get(row.id) || [],
          sourcePacket: boardManagerSourceLogSnapshot(row.source_packet_json),
        }
      : null,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  }));
}

export async function getBoardManagerAgentFeed({ limit = 20, includeInternal = false, includeDetails = false } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 30);
  const [jobs, runs] = await Promise.all([
    activeBoardManagerJobs({ limit: Math.min(normalizedLimit, 10), includeInternal, includeDetails }),
    recentBoardManagerRuns({ limit: normalizedLimit, includeInternal, includeDetails }),
  ]);
  return [
    ...jobs.map(formatBoardManagerAgentJob),
    ...runs.map(formatBoardManagerAgentRun),
  ]
    .sort((left, right) =>
      (Date.parse(right.startedAt || right.completedAt || "") || 0) - (Date.parse(left.startedAt || left.completedAt || "") || 0)
    )
    .slice(0, normalizedLimit);
}

export async function getBoardManagerSession({ scope = "global_hive" } = {}) {
  if (!useDatabase()) return null;
  const exists = await query("SELECT to_regclass('public.board_manager_sessions') AS name");
  if (!exists.rows[0]?.name) return null;
  const result = await query(
    `
      SELECT scope, session_id, session_path, status, model, reasoning_effort,
             last_run_id, metadata_json, created_at, updated_at
      FROM board_manager_sessions
      WHERE scope = $1
        AND status = 'active'
      LIMIT 1
    `,
    [safeText(scope, 120) || "global_hive"]
  );
  const row = result.rows[0];
  if (!row?.session_id) return null;
  return {
    scope: row.scope,
    sessionId: row.session_id,
    sessionPath: row.session_path,
    status: row.status,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    lastRunId: row.last_run_id,
    metadata: safeObject(row.metadata_json),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function upsertBoardManagerSession({
  scope = "global_hive",
  sessionId = "",
  sessionPath = "",
  model = "",
  reasoningEffort = "",
  lastRunId = "",
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedSessionId = safeText(sessionId, 120);
  if (!normalizedSessionId) throw new Error("board_manager_session_id_required");
  const result = await query(
    `
      INSERT INTO board_manager_sessions (
        scope,
        session_id,
        session_path,
        status,
        model,
        reasoning_effort,
        last_run_id,
        metadata_json
      )
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7::jsonb)
      ON CONFLICT (scope) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        session_path = EXCLUDED.session_path,
        status = 'active',
        model = EXCLUDED.model,
        reasoning_effort = EXCLUDED.reasoning_effort,
        last_run_id = EXCLUDED.last_run_id,
        metadata_json = board_manager_sessions.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING *
    `,
    [
      safeText(scope, 120) || "global_hive",
      normalizedSessionId,
      safeText(sessionPath, 1000),
      safeText(model, 120),
      safeText(reasoningEffort, 40),
      safeText(lastRunId, 180),
      jsonValue(metadata),
    ]
  );
  return { ok: true, session: result.rows[0] };
}

export async function updateBoardManagerRunSession({
  runId = "",
  codexSessionId = "",
  codexSessionPath = "",
  sessionMode = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE board_manager_runs
      SET codex_session_id = $2,
          codex_session_path = $3,
          session_mode = $4,
          updated_at = now()
      WHERE id = $1
      RETURNING id, codex_session_id, codex_session_path, session_mode
    `,
    [
      safeText(runId, 180),
      safeText(codexSessionId, 120),
      safeText(codexSessionPath, 1000),
      safeText(sessionMode, 80),
    ]
  );
  return { ok: true, run: result.rows[0] || null };
}

export async function buildBoardManagerSourcePacket({
  trigger = "manual",
  scope = "global_hive",
  limit = 120,
} = {}) {
  const [
    hiveContext,
    hiveSecretarySource,
    hiveSecretaryState,
    hiveProjects,
    projectPlanning,
    projectRegistry,
	    taskState,
	    taskRequests,
	    networkTaskContent,
	    networkTaskOutputCorpus,
	    networkTaskCandidates,
	    recentRuns,
	    routingConstraints,
    openFollowups,
  ] = await Promise.all([
    getHiveContextDocument({ limit }),
    buildHiveSecretarySourcePacket({ limit }),
    getHiveSecretaryState(),
    getHiveProjectsDocument({ includeEmptyActive: true }),
    latestHiveProjectPlanningState().catch(() => null),
    currentProjectRegistry({ limit: 60 }),
	    currentTaskState({ limit: 12 }),
	    currentTaskRequests({ limit: 8 }),
	    getNetworkTaskContentSnapshot({ completedLimit: 5, outstandingLimit: 12, stoppedLimit: 6, pendingLimit: 6 }).catch(() => null),
	    getNetworkTaskOutputCorpus({ limit: 36 }).catch(() => compactNetworkTaskOutputCorpusForBoardManager([])),
	    listEligibleNetworkTaskCandidates({ limit: 12 }).catch(() => []),
	    recentBoardManagerRuns({ limit: 20 }),
	    buildHiveRoutingConstraintsSnapshot({ limit: 120 }).catch(() => ({ ok: false, status: "unavailable", accounts: [] })),
    expireOpenBoardManagerFollowups()
      .then(() => resolveStaleBoardManagerFollowups())
      .then(() => listOpenBoardManagerFollowups({ limit: 20 }))
      .catch(() => []),
  ]);

  const generatedAt = new Date().toISOString();
  const freshness = {
    hiveSecretaryAgeMs: ageMs(hiveSecretaryState?.report?.completedAt),
    latestProjectGenerationAgeMs: ageMs(projectPlanning?.generation?.completedAt),
  };
	  const compactRecentRuns = recentRuns.map(compactBoardManagerRunForSourcePacket);
	  const operatorStandingPolicy = extractOperatorStandingPolicy({
	    hiveContext,
	    hiveSecretarySource,
	    recentBoardManagerRuns: compactRecentRuns,
	  });
  const generationQualityPolicy = buildHiveGenerationQualityPolicy({
    operatorConstraintsSummary: operatorStandingPolicy.map((item) => item.directive).filter(Boolean).slice(0, 4).join(" | "),
  });
  const capabilityInstrumentation = buildBoardManagerCapabilityInstrumentation({
    projectRegistry,
    networkTaskCandidates,
  });
	  // Canonical capacity verdicts: the same shared predicate used by the
	  // executor hook and getNetworkTaskEligibility, so the Board Manager's view
  // of candidate availability cannot drift from enforcement.
  const candidateCapacityChecks = await listNetworkTaskCandidateCapacityChecks(networkTaskCandidates)
    .catch(() => null);
  const boardActionPressure = buildBoardManagerActionPressure({
    hiveProjects,
    networkTaskContent,
    networkTaskCandidates,
    candidateCapacityChecks,
    taskState,
    recentBoardManagerRuns: compactRecentRuns,
    openFollowups,
    freshness,
  });
  const packetCore = {
    schema: "pf.hive.board_manager.source.v0",
    scope: safeText(scope, 120) || "global_hive",
    trigger: safeText(trigger, 160) || "manual",
    generatedAt,
    database: databaseStatus(),
    actionRegistry: boardManagerActions,
    freshness,
    boardActionPressure,
    hiveContext: compactContextDocument(hiveContext),
    hiveSecretarySource: compactSecretarySourcePacket(hiveSecretarySource),
    hiveSecretary: hiveSecretaryState,
    hiveProjects: compactHiveProjectsForBoardManager(hiveProjects),
    projectPlanning,
    projectRegistry: compactProjectRegistryForBoardManager(projectRegistry),
    taskState: compactTaskStateForBoardManager(taskState),
	    taskRequests: compactTaskRequestsForBoardManager(taskRequests),
	    networkTaskContent: compactNetworkTaskContentForBoardManager(networkTaskContent),
	    networkTaskOutputCorpus,
	    operatorStandingPolicy,
	    generationQualityPolicy,
	    priorOutputCorpusSummary: safeObject(networkTaskOutputCorpus?.summary),
	    deduplicationWatchlist: safeArray(networkTaskOutputCorpus?.deduplicationWatchlist).slice(0, 16),
	    capabilityInstrumentation,
	    taskWorkTypeVocabulary: boardManagerTaskWorkTypeVocabulary,
	    networkTaskCandidates,
	    routingConstraints,
    openFollowups,
    recentBoardManagerRuns: compactRecentRuns,
    executionPolicy: {
      dryRunDefault: true,
      implementedActionHooks: [
        "do_nothing",
        "message_user",
        "refresh_hive_secretary",
        "create_project",
        "archive_project",
        "restore_project",
        "refresh_project_document",
        "assign_contributor",
        "initiate_network_task",
      ],
      projectDeletionPolicy: "archive_project hides a project from the active Hive board without hard deletion. restore_project reactivates a non-operator-locked archived project. Board Manager archives are soft and reversible; only explicit operator archive locks prevent planner resurrection.",
      taskLifecyclePolicy: "Network tasks must use the existing PFTL task lifecycle.",
      networkTaskPolicy: "Board Manager initiates allocation/generation jobs only. The network task generation worker writes concrete task offers through the existing task engine. Default reward band is 10000-50000 PFT. Repeated task intents for the same project, candidate, class, need hash, and reward band are suppressed before another generation job is queued.",
      userResponsePolicy: "Hive Context entries are inbound user messages. message_user responses must target a hive_context_entry when possible and are delivered back to that entry's sourceConversationId as a chat assistant message. A message_user action creates an open follow-up row; do not send another Hive message to the same account/project until new user input answers it, it expires, or a materially new blocker appears. For task-action messages, payload.message_precondition must identify the related task or allocation and the live statuses that must still hold when the runtime sends the message; stale preconditions are skipped at execution time.",
    },
  };

  return {
    ...packetCore,
    sourcePacketDigest: digestJson({ ...packetCore, generatedAt: "" }),
  };
}

export function formatBoardManagerCodexPrompt({ prompt = "", sourcePacket = {} } = {}) {
  return [
    prompt,
    "",
    "You are running inside the persistent Board Manager Codex session.",
    "Use your prior session context plus the current source packet, but treat the current packet as the live state of the app.",
    "Do not edit files. Do not run shell commands. Do not mutate database state.",
    "The Task Node app will execute supported action hooks after your final JSON only when the caller uses --execute.",
    "Read the source packet and return exactly one action JSON object that matches the provided schema.",
    "",
    "BOARD MANAGER SOURCE PACKET",
    "```json",
    JSON.stringify(sourcePacket, null, 2),
    "```",
  ].join("\n");
}

export function normalizeBoardManagerDecision(decision = {}) {
  const action = safeText(decision.action, 80);
  if (!actionSet.has(action)) {
    const error = new Error(`board_manager_invalid_action:${action || "missing"}`);
    error.status = 422;
    throw error;
  }
  const confidence = Number(decision.confidence);
  return {
    action,
    target_type: safeText(decision.target_type, 120),
    target_id: safeText(decision.target_id, 240),
    reason: safeText(decision.reason, 2000) || "No reason provided.",
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    decision_basis: normalizeDecisionBasis(decision, decision.reason),
    payload: normalizePayload({ ...emptyBoardManagerPayload, ...safeObject(decision.payload) }),
  };
}

export async function recordBoardManagerActionResult({
  runId = "",
  action = "",
  targetType = "",
  targetId = "",
  result = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const inserted = await query(
    `
      INSERT INTO board_manager_action_results (
        id,
        run_id,
        action,
        target_type,
        target_id,
        result_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
    `,
    [
      `boardaction_${randomUUID()}`,
      safeText(runId, 180),
      safeText(action, 80),
      safeText(targetType, 120),
      safeText(targetId, 240),
      jsonValue(result),
    ]
  );
  const refreshed = await refreshBoardManagerRunMicroSummary({ runId }).catch(() => null);
  return {
    ok: true,
    result: inserted.rows[0],
    microSummary: refreshed?.microSummary || null,
  };
}

export async function refreshBoardManagerRunMicroSummary({ runId = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedRunId = safeText(runId, 180);
  if (!normalizedRunId) return { ok: false, skipped: true, reason: "run_id_required" };
  const runResult = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             selected_action, action_payload_json, decision_json, dry_run,
             model, reasoning_effort, error, codex_session_id, codex_session_path,
             session_mode, started_at, completed_at
      FROM board_manager_runs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedRunId]
  );
  const row = runResult.rows[0];
  if (!row) return { ok: false, skipped: true, reason: "run_not_found" };
  const actionRows = await query(
    `
      SELECT id, action, target_type, target_id, result_json, created_at
      FROM board_manager_action_results
      WHERE run_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [normalizedRunId]
  );
  const run = {
    id: row.id,
    scope: row.scope,
    managerId: row.manager_id,
    trigger: row.trigger,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    selectedAction: row.selected_action,
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    dryRun: Boolean(row.dry_run),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    codexSessionId: row.codex_session_id,
    codexSessionPath: row.codex_session_path,
    sessionMode: row.session_mode,
    error: row.error,
    actionResults: actionRows.rows.map((actionRow) => ({
      id: actionRow.id,
      action: actionRow.action,
      targetType: actionRow.target_type,
      targetId: actionRow.target_id,
      result: safeObject(actionRow.result_json),
      createdAt: iso(actionRow.created_at),
    })),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
  const summary = buildBoardManagerRunMicroSummary(run);
  const updated = await query(
    `
      UPDATE board_manager_runs
      SET micro_summary_json = $2::jsonb,
          micro_summary_text = $3,
          updated_at = now()
      WHERE id = $1
      RETURNING id, micro_summary_json, micro_summary_text
    `,
    [normalizedRunId, jsonValue(summary.json), summary.text]
  );
  return {
    ok: true,
    run: updated.rows[0] || null,
    microSummary: summary.json,
    microSummaryText: summary.text,
  };
}

export async function getBoardManagerUserMessages({ accountId = "", limit = 12 } = {}) {
  if (!useDatabase()) return [];
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return [];
  const result = await query(
    `
      SELECT id, run_id, account_id, display_name, message_text, status,
             source_action, source_packet_digest, metadata_json, created_at, read_at
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [normalizedAccountId, Math.min(Math.max(Number(limit) || 12, 1), 50)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    accountId: row.account_id,
    displayName: row.display_name,
    body: row.message_text,
    status: row.status,
    sourceAction: row.source_action,
    sourcePacketDigest: row.source_packet_digest,
    metadata: safeObject(row.metadata_json),
    createdAt: iso(row.created_at),
    readAt: iso(row.read_at),
  }));
}

export async function claimBoardManagerLease({
  scope = "global_hive",
  managerId = `board_manager_${randomUUID()}`,
  ownerInstance = hostname(),
  ttlSeconds = 900,
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured", managerId };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const normalizedManagerId = safeText(managerId, 180) || `board_manager_${randomUUID()}`;
  const ttl = Math.min(Math.max(Number(ttlSeconds) || 900, 60), 7200);
  return transaction(async (client) => {
    const result = await client.query(
      `
        INSERT INTO board_manager_leases (
          scope, manager_id, owner_instance, status, claimed_at, heartbeat_at,
          expires_at, metadata_json
        )
        VALUES (
          $1, $2, $3, 'active', now(), now(),
          now() + ($4::text || ' seconds')::interval, $5::jsonb
        )
        ON CONFLICT (scope) DO UPDATE SET
          manager_id = EXCLUDED.manager_id,
          owner_instance = EXCLUDED.owner_instance,
          status = 'active',
          claimed_at = now(),
          heartbeat_at = now(),
          expires_at = now() + ($4::text || ' seconds')::interval,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
        WHERE board_manager_leases.status <> 'active'
           OR board_manager_leases.expires_at IS NULL
           OR board_manager_leases.expires_at < now()
           OR board_manager_leases.manager_id = $2
        RETURNING *
      `,
      [normalizedScope, normalizedManagerId, safeText(ownerInstance, 180), String(ttl), jsonValue(metadata)]
    );
    if (!result.rows[0]) {
      const active = await client.query(
        `
          SELECT scope, manager_id, owner_instance, status, claimed_at, heartbeat_at, expires_at
          FROM board_manager_leases
          WHERE scope = $1
        `,
        [normalizedScope]
      );
      return { ok: false, managerId: normalizedManagerId, active: active.rows[0] || null };
    }
    return { ok: true, managerId: normalizedManagerId, lease: result.rows[0] };
  });
}

export async function releaseBoardManagerLease({ scope = "global_hive", managerId = "" } = {}) {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE board_manager_leases
      SET status = 'released',
          heartbeat_at = now(),
          updated_at = now()
      WHERE scope = $1
        AND manager_id = $2
      RETURNING scope, manager_id, status
    `,
    [safeText(scope, 120) || "global_hive", safeText(managerId, 180)]
  );
  return { ok: true, released: result.rowCount || 0 };
}

export async function startBoardManagerRun({
  scope = "global_hive",
  managerId = "",
  trigger = "manual",
  sourcePacket = {},
  dryRun = true,
  model = "",
  reasoningEffort = "",
  codexSessionId = "",
  codexSessionPath = "",
  sessionMode = "untracked",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      INSERT INTO board_manager_runs (
        id, scope, manager_id, trigger, status, source_packet_digest,
        source_packet_json, dry_run, model, reasoning_effort,
        codex_session_id, codex_session_path, session_mode
      )
      VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `,
    [
      `boardrun_${randomUUID()}`,
      safeText(scope, 120) || "global_hive",
      safeText(managerId, 180),
      safeText(trigger, 160),
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue(sourcePacket),
      Boolean(dryRun),
      safeText(model, 120),
      safeText(reasoningEffort, 40),
      safeText(codexSessionId, 120),
      safeText(codexSessionPath, 1000),
      safeText(sessionMode, 80),
    ]
  );
  return { ok: true, run: result.rows[0] };
}

export async function completeBoardManagerRun({
  runId = "",
  decision = {},
  outputText = "",
  status = "completed",
  error = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedDecision = status === "completed" ? normalizeBoardManagerDecision(decision) : {};
  const result = await query(
    `
      UPDATE board_manager_runs
      SET status = $2,
          selected_action = $3,
          action_payload_json = $4::jsonb,
          decision_json = $5::jsonb,
          output_text = $6,
          error = $7,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(runId, 180),
      status === "failed" ? "failed" : "completed",
      normalizedDecision.action || "",
      jsonValue(normalizedDecision.payload || {}),
      jsonValue(normalizedDecision),
      safeText(outputText, 120_000),
      safeText(error, 2000),
    ]
  );
  const completedRun = result.rows[0] || null;
  const refreshed = completedRun
    ? await refreshBoardManagerRunMicroSummary({ runId: completedRun.id }).catch(() => null)
    : null;
  return {
    ok: true,
    run: completedRun,
    decision: normalizedDecision,
    microSummary: refreshed?.microSummary || null,
  };
}

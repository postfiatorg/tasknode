import { databaseStatus } from "../db/pool.js";
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
} from "./network-tasks.js";
import { buildBadgeEligibilityForCandidates } from "./network-badges.js";
import { compactBoardManagerRunForSourcePacket } from "./board-manager-run-summary.js";
import { buildBoardManagerActionPressure } from "./board-manager-health.js";
import { listNetworkTaskCandidateCapacityChecks } from "./network-task-capacity.js";
import {
  expireOpenBoardManagerFollowups,
  listOpenBoardManagerFollowups,
  resolveStaleBoardManagerFollowups,
} from "./board-manager-state.js";
import { buildHiveRoutingConstraintsSnapshot } from "./hive-account-live-state.js";
import {
  compactBoardActionPressureForBoardManager,
  compactCapabilityInstrumentationForBoardManager,
  compactEvidenceEvaluationRefreshForBoardManager,
  compactEvidenceEvaluationPacketsForBoardManager,
  compactHiveSecretaryStateForBoardManager,
  compactHiveProjectsForBoardManager,
  compactNetworkTaskCandidatesForBoardManager,
  compactNetworkTaskContentForBoardManager,
  compactNetworkTaskOutputCorpusPacketForBoardManager,
  compactOpenFollowupsForBoardManager,
  compactOperatorStandingPolicyForBoardManager,
  compactOrcOperationsForBoardManager,
  compactProjectRegistryForBoardManager,
  compactProjectPlanningForBoardManager,
  compactRoutingConstraintsForBoardManager,
  compactSecretarySourceForBoardManager,
  compactTaskRequestsForBoardManager,
  compactTaskStateForBoardManager,
} from "./board-manager-source-compact.js";
import { listCapabilityProfilesForBoardManager } from "./capability-profiles.js";
import { listEvidenceEvaluationPacketsForBoardManager } from "./evidence-evaluation-packets.js";
import { getBoardManagerOrcOperations } from "./orc-operations.js";
import {
  ageMs,
  boardManagerActions,
  compactContextDocument,
  digestJson,
  safeArray,
  safeObject,
  safeText,
} from "./board-manager-contract.js";
import {
  buildBoardManagerCapabilityInstrumentation,
  buildHiveGenerationQualityPolicy,
  boardManagerTaskWorkTypeVocabulary,
  compactNetworkTaskOutputCorpusForBoardManager,
  currentProjectRegistry,
  currentTaskRequests,
  currentTaskState,
  ensureRecentEvidenceEvaluationPackets,
  extractProjectLeaderInputs,
  extractOperatorStandingPolicy,
  getNetworkTaskOutputCorpus,
  recentBoardManagerRuns,
} from "./board-manager-source-data.js";

export function isBoardManagerSourceReadTimeout(error) {
  const code = safeText(error?.code, 80).toUpperCase();
  if (["57014", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) return true;
  const message = safeText(error?.message || error, 1000).toLowerCase();
  return [
    /^(?:connection|query|read|statement)(?: read)? timeout\b/,
    /^connection terminated due to connection timeout\b/,
    /^(?:connection|query|read|statement)\b[^\n]*\btimed out\b/,
    /^timeout exceeded when trying to connect\b/,
    /\btimeout expired\b/,
  ].some((pattern) => pattern.test(message));
}

function boardManagerReadFallback(reader, error) {
  if (!Object.hasOwn(reader, "fallback")) throw error;
  return typeof reader.fallback === "function" ? reader.fallback(error) : reader.fallback;
}

export async function runBoardManagerSourceReads(
  readers = [],
  {
    // Match the board-manager database pool instead of launching every source
    // query at once. This trades some packet latency for lower pool pressure.
    concurrency = 3,
    maxAttempts = 3,
    retryDelayMs = 25,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  const queue = safeArray(readers);
  const results = new Array(queue.length);
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), Math.max(1, queue.length));
  let cursor = 0;

  async function runOne(reader, index) {
    if (typeof reader?.read !== "function") {
      throw new TypeError(`board_manager_source_read_invalid:${safeText(reader?.label, 120) || index}`);
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        results[index] = await reader.read();
        return;
      } catch (error) {
        if (!isBoardManagerSourceReadTimeout(error)) {
          results[index] = boardManagerReadFallback(reader, error);
          return;
        }
        if (attempt >= maxAttempts) {
          // Persistent timeouts fail the packet even for optional sources.
          // Routing on silently incomplete corpus data is less safe than
          // retrying the entire packet after the database recovers.
          error.boardManagerSourceRead = safeText(reader.label, 120) || `read_${index}`;
          error.boardManagerSourceAttempts = attempt;
          throw error;
        }
        await sleep(Math.max(0, Number(retryDelayMs) || 0) * attempt);
      }
    }
  }

  async function worker() {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      await runOne(queue[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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
    orcOperations,
    openFollowups,
  ] = await runBoardManagerSourceReads([
    {
      label: "hive_context",
      read: () => getHiveContextDocument({ limit }),
    },
    {
      label: "hive_secretary_source",
      read: () => buildHiveSecretarySourcePacket({ limit }),
    },
    {
      label: "hive_secretary_state",
      read: () => getHiveSecretaryState(),
    },
    {
      label: "hive_projects",
      read: () => getHiveProjectsDocument({ includeEmptyActive: true }),
    },
    {
      label: "project_planning",
      read: () => latestHiveProjectPlanningState(),
      fallback: null,
    },
    {
      label: "project_registry",
      read: () => currentProjectRegistry({ limit: 60 }),
    },
    {
      label: "task_state",
      read: () => currentTaskState({ limit: 12 }),
    },
    {
      label: "task_requests",
      read: () => currentTaskRequests({ limit: 8 }),
    },
    {
      label: "network_task_content",
      read: () => getNetworkTaskContentSnapshot({
        completedLimit: 4,
        outstandingLimit: 8,
        stoppedLimit: 4,
        pendingLimit: 4,
      }),
      fallback: {},
    },
    {
      label: "network_task_output_corpus",
      read: () => getNetworkTaskOutputCorpus({ limit: 24 }),
      fallback: () => compactNetworkTaskOutputCorpusForBoardManager([]),
    },
    {
      label: "network_task_candidates",
      read: () => listEligibleNetworkTaskCandidates({ limit: 12 }),
      fallback: [],
    },
    {
      label: "recent_board_manager_runs",
      read: () => recentBoardManagerRuns({ limit: 20 }),
    },
    {
      label: "routing_constraints",
      read: () => buildHiveRoutingConstraintsSnapshot({ limit: 120 }),
      fallback: { ok: false, status: "unavailable", accounts: [] },
    },
    {
      label: "orc_operations",
      read: () => getBoardManagerOrcOperations({ limit: 24 }),
      fallback: {
        schema: "pf.hive.board_manager.orc_operations.v1",
        status: "unavailable",
        enforcement: "none_context_only",
        summary: {},
        agents: [],
        routingCandidates: [],
        reviewQueue: { recent: [] },
        runJournal: { recent: [] },
        operatorInteractions: { recent: [] },
      },
    },
    {
      label: "open_followups",
      read: async () => {
        await expireOpenBoardManagerFollowups();
        await resolveStaleBoardManagerFollowups();
        return listOpenBoardManagerFollowups({ limit: 20 });
      },
      fallback: [],
    },
  ]);

  const generatedAt = new Date().toISOString();
  const evidenceEvaluationRefresh = await ensureRecentEvidenceEvaluationPackets({
    corpus: networkTaskOutputCorpus,
    limit: 8,
  }).catch((error) => ({
    attempted: 0,
    createdOrUpdated: 0,
    error: safeText(error?.message || error, 500),
  }));
  const evidenceEvaluationPackets = await listEvidenceEvaluationPacketsForBoardManager({ limit: 24 })
    .catch(() => []);
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
  const projectLeaderInputs = extractProjectLeaderInputs(hiveContext);
  const capabilityProfiles = await listCapabilityProfilesForBoardManager({
    accountIds: networkTaskCandidates.map((candidate) => candidate.accountId || candidate.account_id).filter(Boolean),
    projectIds: projectRegistry.map((project) => project.id).filter(Boolean),
    limit: 240,
  }).catch(() => []);
  const capabilityInstrumentation = buildBoardManagerCapabilityInstrumentation({
    projectRegistry,
    networkTaskCandidates,
    capabilityProfiles,
  });
  const badgeEligibility = await buildBadgeEligibilityForCandidates(networkTaskCandidates)
    .catch((error) => ({
      schema: "pf.task_node.badge_eligibility.v1",
      catalogVersion: "network_badges_v1",
      enforcement: "executor_required",
      status: "unavailable",
      error: safeText(error?.message || error, 500),
      candidates: [],
    }));
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
    orcOperations,
  });
  const compactNetworkTaskOutputCorpus = compactNetworkTaskOutputCorpusPacketForBoardManager(networkTaskOutputCorpus);
  const compactCorpusSummary = safeObject(compactNetworkTaskOutputCorpus?.summary);
  const packetCore = {
    schema: "pf.hive.board_manager.source.v0",
    scope: safeText(scope, 120) || "global_hive",
    trigger: safeText(trigger, 160) || "manual",
    generatedAt,
    database: databaseStatus(),
    actionRegistry: boardManagerActions,
    freshness,
    boardActionPressure: compactBoardActionPressureForBoardManager(boardActionPressure),
    hiveContext: compactContextDocument(hiveContext),
    hiveSecretarySource: compactSecretarySourceForBoardManager(hiveSecretarySource),
    hiveSecretary: compactHiveSecretaryStateForBoardManager(hiveSecretaryState),
    hiveProjects: compactHiveProjectsForBoardManager(hiveProjects),
    projectPlanning: compactProjectPlanningForBoardManager(projectPlanning),
    projectRegistry: compactProjectRegistryForBoardManager(projectRegistry),
    taskState: compactTaskStateForBoardManager(taskState),
	    taskRequests: compactTaskRequestsForBoardManager(taskRequests),
	    networkTaskContent: compactNetworkTaskContentForBoardManager(networkTaskContent),
	    networkTaskOutputCorpus: compactNetworkTaskOutputCorpus,
	    evidenceEvaluationPackets: compactEvidenceEvaluationPacketsForBoardManager(evidenceEvaluationPackets),
	    evidenceEvaluationRefresh: compactEvidenceEvaluationRefreshForBoardManager(evidenceEvaluationRefresh),
	    operatorStandingPolicy: compactOperatorStandingPolicyForBoardManager(operatorStandingPolicy),
	    generationQualityPolicy,
	    projectLeaderInputs,
	    priorOutputCorpusSummary: {
      projects_covered: safeArray(compactCorpusSummary.projects_covered).slice(0, 8),
      repeated_themes: safeArray(compactCorpusSummary.repeated_themes).slice(0, 4),
      open_actionable_items: safeArray(compactCorpusSummary.open_actionable_items).slice(0, 4),
    },
	    deduplicationWatchlist: safeArray(compactNetworkTaskOutputCorpus?.deduplicationWatchlist).slice(0, 4).map((item) => ({
      theme: safeText(item.theme, 180),
      project_id: safeText(item.project_id || item.projectId, 180),
      prior_task_ids: safeArray(item.prior_task_ids || item.priorTaskIds).slice(0, 4),
      why_not_repeat: safeText(item.why_not_repeat || item.whyNotRepeat, 220),
    })),
	    capabilityInstrumentation: compactCapabilityInstrumentationForBoardManager(capabilityInstrumentation),
	    badgeEligibility,
    orcOperations: compactOrcOperationsForBoardManager(orcOperations),
	    taskWorkTypeVocabulary: boardManagerTaskWorkTypeVocabulary,
	    networkTaskCandidates: compactNetworkTaskCandidatesForBoardManager(networkTaskCandidates),
	    routingConstraints: compactRoutingConstraintsForBoardManager(routingConstraints),
    openFollowups: compactOpenFollowupsForBoardManager(openFollowups),
    recentBoardManagerRuns: compactRecentRuns.slice(0, 3),
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
      networkTaskPolicy: "Board Manager initiates allocation/generation jobs only. The network task generation worker writes concrete task offers through the existing task engine. Network tasks must include required_badge_id, operating_badge_id, and badge_work_type that match badgeEligibility; the executor rejects missing/unsupported badges, disallowed work types, and rewards above the badge cap before queuing rows. Active user-facing badge lanes are KOL, Core Contributor, Expert, Project Leader, and QA Worker.",
      projectLeaderPolicy: "Project Leader is a backend-defined discretionary badge. Hive inputs listed in projectLeaderInputs may define special new projects, including open-source projects. If a user-proposed special/open-source project has no Project Leader source input, ask for discretionary approval instead of creating it.",
      userResponsePolicy: "Hive Context entries are inbound user messages. message_user responses must target a hive_context_entry when possible and are delivered back to that entry's sourceConversationId as a chat assistant message. A message_user action creates an open follow-up row; do not send another Hive message to the same account/project until new user input answers it, it expires, or a materially new blocker appears. For task-action messages, payload.message_precondition must identify the related task or allocation and the live statuses that must still hold when the runtime sends the message; stale preconditions are skipped at execution time.",
    },
  };

  return {
    ...packetCore,
    sourcePacketDigest: digestJson({ ...packetCore, generatedAt: "" }),
  };
}

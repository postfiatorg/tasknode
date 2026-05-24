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
  return Number.isFinite(parsed) ? parsed : fallback;
}

function projectEntries(hiveProjects = {}) {
  const projects = safeObject(hiveProjects.projects);
  return Object.values(projects).filter((project) => project && typeof project === "object");
}

function taskProjectIds(tasks = []) {
  return new Set(safeArray(tasks).map((task) => safeText(task.projectId || task.project_id, 180)).filter(Boolean));
}

function candidateKeys(candidate = {}) {
  const keys = new Set();
  const accountId = safeText(candidate.accountId || candidate.account_id || candidate.candidateAccountId || candidate.candidate_account_id, 180);
  const walletAddress = safeText(candidate.walletAddress || candidate.wallet_address || candidate.candidateWalletAddress || candidate.candidate_wallet_address, 120);
  if (accountId) keys.add(`account:${accountId}`);
  if (walletAddress) keys.add(`wallet:${walletAddress}`);
  return keys;
}

function activeCandidateKeys(tasks = []) {
  const keys = new Set();
  for (const task of safeArray(tasks)) {
    for (const key of candidateKeys(task)) keys.add(key);
  }
  return keys;
}

function availableCandidates(candidates = [], activeKeys = new Set()) {
  return safeArray(candidates).filter((candidate) => {
    for (const key of candidateKeys(candidate)) {
      if (activeKeys.has(key)) return false;
    }
    return true;
  });
}

function activeNetworkTaskCapacityBlockers({
  outstanding = [],
  pendingGeneration = [],
} = {}) {
  const blockerRows = [
    ...safeArray(outstanding).map((task) => ({ task, source: "outstanding_network_task" })),
    ...safeArray(pendingGeneration).map((task) => ({ task, source: "pending_network_task_generation" })),
  ];
  return blockerRows.map(({ task, source }) => ({
    source,
    taskId: safeText(task.taskId || task.task_id || task.generatedTaskId || task.generated_task_id, 180),
    generationJobId: safeText(task.generationJobId || task.generation_job_id, 180),
    allocationId: safeText(task.allocationId || task.allocation_id, 180),
    requestId: safeText(task.requestId || task.request_id, 180),
    projectId: safeText(task.projectId || task.project_id, 180),
    title: safeText(task.title || task.name || task.projectNeedSummary || task.project_need_summary, 240),
    state: safeText(task.state || task.status || task.allocationStatus || task.allocation_status, 80),
    candidateAccountId: safeText(task.candidateAccountId || task.candidate_account_id, 180),
    candidateWalletAddress: safeText(task.candidateWalletAddress || task.candidate_wallet_address, 120),
  })).filter((blocker) => blocker.candidateAccountId || blocker.candidateWalletAddress);
}

function candidateCapacityRows(candidates = [], blockers = []) {
  return safeArray(candidates).map((candidate) => {
    const keys = candidateKeys(candidate);
    const matchingBlockers = safeArray(blockers).filter((blocker) => {
      for (const key of candidateKeys(blocker)) {
        if (keys.has(key)) return true;
      }
      return false;
    });
    return {
      accountId: safeText(candidate.accountId || candidate.account_id, 180),
      walletAddress: safeText(candidate.walletAddress || candidate.wallet_address, 120),
      availableForNetworkTask: matchingBlockers.length === 0,
      capacityBlockers: matchingBlockers.slice(0, 3),
    };
  });
}

function projectLiveCount(project = {}, key = "") {
  const value = project[key];
  if (Array.isArray(value)) return value.length;
  return 0;
}

function projectPlannedCount(project = {}, key = "") {
  return Math.max(0, Math.round(numeric(project[key], 0)));
}

function hasRecentProjectHandling({ projectId = "", recentBoardManagerRuns = [] } = {}) {
  const normalizedProjectId = safeText(projectId, 180);
  if (!normalizedProjectId) return false;
  return safeArray(recentBoardManagerRuns).slice(0, 5).some((run) => {
    const action = safeText(run.selectedAction || run.action, 80);
    const targetId = safeText(run.targetId || run.target_id || run.decision?.target_id, 240);
    const resultTargetId = safeArray(run.actionResults).some((result) => safeText(result.targetId || result.target_id, 240) === normalizedProjectId);
    return ["initiate_network_task", "assign_contributor", "archive_project", "message_user"].includes(action)
      && (targetId === normalizedProjectId || resultTargetId);
  });
}

function projectPressureSignal({
  project = {},
  outstandingProjectIds,
  pendingProjectIds,
  completedProjectIds,
  stoppedProjectIds,
  eligibleCandidateCount = 0,
  candidateCount = 0,
  recentBoardManagerRuns = [],
} = {}) {
  const projectId = safeText(project.id, 180);
  const status = safeText(project.status, 80).toLowerCase() || "unknown";
  if (status !== "active") return null;

  const liveTaskCount = projectLiveCount(project, "tasks");
  const liveContributorCount = projectLiveCount(project, "contributors");
  const plannedTaskCount = projectPlannedCount(project, "taskCount");
  const plannedContributorCount = projectPlannedCount(project, "contributorCount");
  const hasOutstandingNetworkTask = outstandingProjectIds.has(projectId);
  const hasPendingNetworkTaskGeneration = pendingProjectIds.has(projectId);
  const hasCompletedNetworkTask = completedProjectIds.has(projectId);
  const hasStoppedNetworkTask = stoppedProjectIds.has(projectId);
  const recentlyHandled = hasRecentProjectHandling({ projectId, recentBoardManagerRuns });
  const reasons = [];

  if (plannedTaskCount > liveTaskCount) reasons.push("planned task count is not backed by live project task rows");
  if (plannedContributorCount > liveContributorCount) reasons.push("planned contributor count is not backed by live contributor rows");
  if (!liveTaskCount && !hasOutstandingNetworkTask && !hasPendingNetworkTaskGeneration) {
    reasons.push("active project has no live task movement");
  }
  if (!liveContributorCount && eligibleCandidateCount > 0) {
    reasons.push("active project has no assigned contributors despite eligible candidates");
  }
  if (!eligibleCandidateCount && candidateCount > 0 && !hasOutstandingNetworkTask && !hasPendingNetworkTaskGeneration) {
    reasons.push("all candidate capacity is consumed by other outstanding or pending Network Tasks");
  }
  if (hasStoppedNetworkTask && !hasOutstandingNetworkTask && !hasPendingNetworkTaskGeneration) {
    reasons.push("recent network task stopped without a replacement or closure decision");
  }

  if (!reasons.length) return null;

  const allowedNextActions = ["message_user", "refresh_project_document", "archive_project"];
  if (eligibleCandidateCount > 0) {
    allowedNextActions.unshift("initiate_network_task", "assign_contributor");
  }
  const preferredNextAction = eligibleCandidateCount > 0
    ? "initiate_network_task"
    : "message_user";

  return {
    projectId,
    title: safeText(project.title || project.name, 180),
    status,
    severity: recentlyHandled ? "medium" : "high",
    requiresAction: !recentlyHandled,
    pressure: "empty_or_stalled_active_project",
    reasons,
    allowedNextActions: [...new Set(allowedNextActions)],
    preferredNextAction,
    plannedTaskCount,
    liveTaskCount,
    plannedContributorCount,
    liveContributorCount,
    hasOutstandingNetworkTask,
    hasPendingNetworkTaskGeneration,
    hasCompletedNetworkTask,
    hasStoppedNetworkTask,
    recentlyHandled,
  };
}

export function buildBoardManagerActionPressure({
  hiveProjects = {},
  networkTaskContent = {},
  networkTaskCandidates = [],
  taskState = {},
  recentBoardManagerRuns = [],
  freshness = {},
} = {}) {
  const projects = projectEntries(hiveProjects);
  const outstandingProjectIds = taskProjectIds(networkTaskContent.outstanding);
  const pendingProjectIds = taskProjectIds(networkTaskContent.pendingGeneration);
  const completedProjectIds = taskProjectIds(networkTaskContent.completed);
  const stoppedProjectIds = taskProjectIds(networkTaskContent.stopped);
  const activeKeys = activeCandidateKeys([
    ...safeArray(networkTaskContent.outstanding),
    ...safeArray(networkTaskContent.pendingGeneration),
  ]);
  const capacityBlockers = activeNetworkTaskCapacityBlockers({
    outstanding: networkTaskContent.outstanding,
    pendingGeneration: networkTaskContent.pendingGeneration,
  });
  const candidateCount = safeArray(networkTaskCandidates).length;
  const eligibleCandidates = availableCandidates(networkTaskCandidates, activeKeys);
  const eligibleCandidateCount = eligibleCandidates.length;
  const unavailableCandidateCount = Math.max(0, candidateCount - eligibleCandidateCount);
  const staleHiveSecretary = numeric(freshness.hiveSecretaryAgeMs, 0) > 60 * 60 * 1000;
  const activeProjects = projects.filter((project) => safeText(project.status, 80).toLowerCase() === "active");
  const signals = activeProjects
    .map((project) =>
      projectPressureSignal({
        project,
        outstandingProjectIds,
        pendingProjectIds,
        completedProjectIds,
        stoppedProjectIds,
        eligibleCandidateCount,
        candidateCount,
        recentBoardManagerRuns,
      })
    )
    .filter(Boolean);
  const projectsWithoutLiveTasks = activeProjects.filter(
    (project) =>
      projectLiveCount(project, "tasks") === 0 &&
      !outstandingProjectIds.has(safeText(project.id, 180)) &&
      !pendingProjectIds.has(safeText(project.id, 180))
  ).length;
  const projectsWithoutContributors = activeProjects.filter((project) => projectLiveCount(project, "contributors") === 0).length;
  const unresolvedSignals = signals.filter((signal) => signal.requiresAction);
  const motionState = unresolvedSignals.length || staleHiveSecretary ? "action_required" : "moving_or_recently_handled";

  return {
    schema: "pf.hive.board_action_pressure.v1",
    summary: {
      motionState,
      requiresAction: motionState === "action_required",
      activeProjectCount: activeProjects.length,
      projectsWithoutLiveTasks,
      projectsWithoutContributors,
      outstandingNetworkTaskCount: safeArray(networkTaskContent.outstanding).length,
      pendingNetworkTaskGenerationCount: safeArray(networkTaskContent.pendingGeneration).length,
      stoppedNetworkTaskCount: safeArray(networkTaskContent.stopped).length,
      candidateCount,
      eligibleCandidateCount,
      unavailableCandidateCount,
      activeNetworkTaskCapacityBlockerCount: capacityBlockers.length,
      staleHiveSecretary,
    },
    candidateCapacity: {
      policy: {
        personalTasksDoNotAffectNetworkTaskEligibility: true,
        engineeringTasksDoNotAffectNetworkTaskEligibility: true,
        candidateCapacityIsConsumedOnlyByOutstandingOrPendingNetworkTasks: true,
        personalAndEngineeringTasksAreContextOnly: true,
      },
      ignoredForCapacity: {
        taskStateRecentCount: safeArray(taskState.recent).length,
        reason: "Personal and engineering tasks can inform routing judgment, but they do not hard-block Network Task eligibility.",
      },
      eligibleCandidates: eligibleCandidates.slice(0, 8).map((candidate) => ({
        accountId: safeText(candidate.accountId || candidate.account_id, 180),
        walletAddress: safeText(candidate.walletAddress || candidate.wallet_address, 120),
      })),
      candidates: candidateCapacityRows(networkTaskCandidates, capacityBlockers).slice(0, 12),
      activeNetworkTaskCapacityBlockers: capacityBlockers.slice(0, 12),
    },
    signals,
    policy: {
      plannedCountsAreNotLiveWork: true,
      emptyActiveProjectRequiresAction: true,
      stoppedOrRefusedNetworkTaskRequiresFollowup: true,
      documentRefreshIsNotLiveMotion: true,
      zeroEligibleCandidatesRequiresFollowup: true,
      doNothingRequiresHealthyMotionOrRecentHandling: true,
      personalTasksDoNotAffectNetworkTaskEligibility: true,
      candidateCapacityIsConsumedOnlyByOutstandingOrPendingNetworkTasks: true,
      acceptableResolutions: [
        "initiate a network task for an eligible contributor",
        "assign a contributor when the project has live work",
        "message a user for the smallest missing decision input",
        "refresh the project document with a concrete blocker and next action",
        "archive the project when it cannot be managed now",
      ],
    },
  };
}

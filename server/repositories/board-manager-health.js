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

function dateMs(value = null) {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectEntries(hiveProjects = {}) {
  const projects = safeObject(hiveProjects.projects);
  return Object.values(projects).filter((project) => project && typeof project === "object");
}

function taskProjectIds(tasks = []) {
  return new Set(safeArray(tasks).map((task) => safeText(task.projectId || task.project_id, 180)).filter(Boolean));
}

function candidateIdentity(candidate = {}) {
  return {
    accountId: safeText(candidate.accountId || candidate.account_id || candidate.candidateAccountId || candidate.candidate_account_id, 180),
    walletAddress: safeText(candidate.walletAddress || candidate.wallet_address || candidate.candidateWalletAddress || candidate.candidate_wallet_address, 120),
  };
}

function capacityMatchesCandidate(candidate = {}, blocker = {}) {
  const candidateInfo = candidateIdentity(candidate);
  const blockerInfo = candidateIdentity(blocker);
  if (candidateInfo.walletAddress && blockerInfo.walletAddress) {
    return candidateInfo.walletAddress === blockerInfo.walletAddress;
  }
  if (candidateInfo.accountId && blockerInfo.accountId && (!candidateInfo.walletAddress || !blockerInfo.walletAddress)) {
    return candidateInfo.accountId === blockerInfo.accountId;
  }
  return false;
}

function availableCandidates(candidates = [], blockers = []) {
  return safeArray(candidates).filter((candidate) =>
    !safeArray(blockers).some((blocker) => capacityMatchesCandidate(candidate, blocker))
  );
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
    const matchingBlockers = safeArray(blockers).filter((blocker) => capacityMatchesCandidate(candidate, blocker));
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

function hasRecentProjectHandling({ projectId = "", recentBoardManagerRuns = [], sinceMs = 0 } = {}) {
  const normalizedProjectId = safeText(projectId, 180);
  if (!normalizedProjectId) return false;
  return safeArray(recentBoardManagerRuns).slice(0, 12).some((run) => {
    if (sinceMs > 0 && dateMs(run.completedAt || run.completed_at || run.updatedAt || run.updated_at) < sinceMs) {
      return false;
    }
    const action = safeText(run.selectedAction || run.action, 80);
    const targetId = safeText(run.targetId || run.target_id || run.decision?.target_id, 240);
    const resultTargetId = safeArray(run.actionResults).some((result) => safeText(result.targetId || result.target_id, 240) === normalizedProjectId);
    return ["initiate_network_task", "assign_contributor", "archive_project", "message_user"].includes(action)
      && (targetId === normalizedProjectId || resultTargetId);
  });
}

function hasRecentUserFollowup({ recentBoardManagerRuns = [], sinceMs = 0 } = {}) {
  return safeArray(recentBoardManagerRuns).slice(0, 20).some((run) => {
    if (sinceMs > 0 && dateMs(run.completedAt || run.completed_at || run.updatedAt || run.updated_at) < sinceMs) {
      return false;
    }
    const action = safeText(run.selectedAction || run.action, 80);
    const state = safeText(run.status || run.state, 80);
    if (action !== "message_user") return false;
    if (run.dryRun === true) return false;
    return !["failed", "skipped", "blocked"].includes(state);
  });
}

function hasOpenFollowupForProject({ projectId = "", openFollowups = [], sinceMs = 0 } = {}) {
  const normalizedProjectId = safeText(projectId, 180);
  return safeArray(openFollowups).some((followup) => {
    const status = safeText(followup.status, 80);
    const followupProjectId = safeText(followup.projectId || followup.project_id, 180);
    if (status && status !== "open") return false;
    if (sinceMs > 0) {
      const followupMs = dateMs(
        followup.lastSentAt ||
          followup.last_sent_at ||
          followup.answeredAt ||
          followup.answered_at ||
          followup.updatedAt ||
          followup.updated_at ||
          followup.createdAt ||
          followup.created_at
      );
      if (!followupMs || followupMs < sinceMs) return false;
    }
    if (normalizedProjectId) return followupProjectId === normalizedProjectId;
    return !followupProjectId;
  });
}

function latestProjectTaskMs(tasks = [], projectId = "") {
  const normalizedProjectId = safeText(projectId, 180);
  if (!normalizedProjectId) return 0;
  return safeArray(tasks).reduce((latest, task) => {
    const taskProjectId = safeText(task.projectId || task.project_id, 180);
    if (taskProjectId !== normalizedProjectId) return latest;
    return Math.max(
      latest,
      dateMs(
        task.updatedAt ||
          task.updated_at ||
          task.completedAt ||
          task.completed_at ||
          task.lastEventAt ||
          task.last_event_at ||
          task.createdAt ||
          task.created_at
      )
    );
  }, 0);
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
  recentUserFollowup = false,
  openFollowups = [],
  outstandingTasks = [],
  pendingTasks = [],
  completedTasks = [],
  stoppedTasks = [],
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
  const latestStoppedMs = latestProjectTaskMs(stoppedTasks, projectId);
  const latestReplacementMs = latestProjectTaskMs([...safeArray(outstandingTasks), ...safeArray(pendingTasks)], projectId);
  const latestClosureMs = latestProjectTaskMs([...safeArray(completedTasks), ...safeArray(stoppedTasks)], projectId);
  const hasOpenFollowup = hasOpenFollowupForProject({ projectId, openFollowups, sinceMs: latestClosureMs });
  const recentUserFollowupAfterClosure = latestClosureMs > 0
    ? hasRecentUserFollowup({ recentBoardManagerRuns, sinceMs: latestClosureMs })
    : recentUserFollowup;
  const recentlyHandled = hasRecentProjectHandling({ projectId, recentBoardManagerRuns, sinceMs: latestClosureMs })
    || hasOpenFollowup
    || (!eligibleCandidateCount && recentUserFollowupAfterClosure);
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
  if (latestStoppedMs > 0 && latestStoppedMs > latestReplacementMs && eligibleCandidateCount > 0) {
    reasons.push("latest stopped Network Task has no newer replacement task or generation job");
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
    hasOpenFollowup,
    latestClosureAt: latestClosureMs ? new Date(latestClosureMs).toISOString() : null,
    recentlyHandled,
  };
}

export function buildBoardManagerActionPressure({
  hiveProjects = {},
  networkTaskContent = {},
  networkTaskCandidates = [],
  taskState = {},
  recentBoardManagerRuns = [],
  openFollowups = [],
  freshness = {},
} = {}) {
  const projects = projectEntries(hiveProjects);
  const outstandingProjectIds = taskProjectIds(networkTaskContent.outstanding);
  const pendingProjectIds = taskProjectIds(networkTaskContent.pendingGeneration);
  const completedProjectIds = taskProjectIds(networkTaskContent.completed);
  const stoppedProjectIds = taskProjectIds(networkTaskContent.stopped);
  const completedTasks = safeArray(networkTaskContent.completed);
  const stoppedTasks = safeArray(networkTaskContent.stopped);
  const outstandingTasks = safeArray(networkTaskContent.outstanding);
  const pendingTasks = safeArray(networkTaskContent.pendingGeneration);
  const capacityBlockers = activeNetworkTaskCapacityBlockers({
    outstanding: networkTaskContent.outstanding,
    pendingGeneration: networkTaskContent.pendingGeneration,
  });
  const candidateCount = safeArray(networkTaskCandidates).length;
  const eligibleCandidates = availableCandidates(networkTaskCandidates, capacityBlockers);
  const eligibleCandidateCount = eligibleCandidates.length;
  const unavailableCandidateCount = Math.max(0, candidateCount - eligibleCandidateCount);
  const staleHiveSecretary = numeric(freshness.hiveSecretaryAgeMs, 0) > 60 * 60 * 1000;
  const activeProjects = projects.filter((project) => safeText(project.status, 80).toLowerCase() === "active");
  const recentUserFollowup = hasRecentUserFollowup({ recentBoardManagerRuns });
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
        recentUserFollowup,
        openFollowups,
        outstandingTasks,
        pendingTasks,
        completedTasks,
        stoppedTasks,
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
      recentUserFollowup,
      openFollowupCount: safeArray(openFollowups).length,
    },
    candidateCapacity: {
      policy: {
        personalTasksDoNotAffectNetworkTaskEligibility: true,
        engineeringTasksDoNotAffectNetworkTaskEligibility: true,
        candidateCapacityIsConsumedOnlyByOutstandingOrPendingNetworkTasks: true,
        walletBoundNetworkTasksOnlyConsumeMatchingWalletCapacity: true,
        accountOnlyPendingWorkConsumesAccountCapacityUntilWalletIsKnown: true,
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
      openFollowupCountsAsRecentHandling: true,
      recentUserFollowupCountsAsRecentHandling: true,
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

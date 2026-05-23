function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactProjectTask(task = {}) {
  return {
    taskId: safeText(task.taskId || task.task_id, 180),
    requestId: safeText(task.requestId || task.request_id, 180),
    title: safeText(task.title || task.name, 240),
    state: safeText(task.state || task.status, 80),
    rewardPft: Number(task.rewardPft || task.reward_pft || task.rewardActualPft || task.rewardOfferPft || 0),
    updatedAt: task.updatedAt || task.updated_at || null,
  };
}

function compactProductDocument(document = {}) {
  if (!document?.id && !document?.summary && !document?.projectStatus) return null;
  return {
    id: safeText(document.id, 180),
    title: safeText(document.title, 180),
    summary: safeText(document.summary, 900),
    projectStatus: safeText(document.projectStatus || document.project_status, 1200),
    keyPoints: safeArray(document.keyPoints || document.key_points).slice(0, 5).map((item) => safeText(item, 500)).filter(Boolean),
    blockedOrUnclear: safeArray(document.blockedOrUnclear || document.blocked_or_unclear).slice(0, 4).map((item) => safeText(item, 500)).filter(Boolean),
    nextActions: safeArray(document.nextActions || document.next_actions).slice(0, 4).map((item) => safeText(item, 500)).filter(Boolean),
  };
}

export function compactHiveProjectsForBoardManager(document = {}) {
  const projects = safeObject(document.projects);
  const projectIds = safeArray(document.projectIds).length ? document.projectIds : Object.keys(projects);
  return {
    generatedAt: document.generatedAt || null,
    projectIds: projectIds.slice(0, 24),
    stats: safeObject(document.stats),
    projects: Object.fromEntries(projectIds.slice(0, 24).map((id) => {
      const project = safeObject(projects[id]);
      return [id, {
        id: safeText(project.id || id, 180),
        name: safeText(project.name || project.title, 180),
        type: safeText(project.type || project.typeKey, 80),
        summary: safeText(project.summary, 600),
        objective: safeText(project.objective, 800),
        status: safeText(project.status, 80),
        priority: Number(project.priority || 0),
        phase: safeText(project.phase || project.phaseLabel, 120),
        taskCount: Number(project.taskCount || 0),
        contributorCount: Number(project.contributorCount || 0),
        pft: Number(project.pft || project.pftRouted || 0),
        contributors: safeArray(project.contributors).slice(0, 6).map((contributor) => ({
          accountId: safeText(contributor.accountId || contributor.account_id, 180),
          walletAddress: safeText(contributor.walletAddress || contributor.wallet_address, 120),
          role: safeText(contributor.role || contributor.roleLabel || contributor.role_label, 120),
          status: safeText(contributor.status, 80),
        })),
        tasks: safeArray(project.tasks).slice(0, 10).map(compactProjectTask),
        activity: safeArray(project.activity).slice(0, 8).map((event) => ({
          label: safeText(event.label || event.title || event.action, 180),
          state: safeText(event.state || event.status, 80),
          at: event.at || event.updatedAt || event.createdAt || null,
        })),
        productDocument: compactProductDocument(project.productDocument),
      }];
    })),
  };
}

export function compactTaskStateForBoardManager(taskState = {}) {
  return {
    counts: safeArray(taskState.counts).slice(0, 20),
    recent: safeArray(taskState.recent).slice(0, 12).map((task) => ({
      ...task,
      title: safeText(task.title, 180),
    })),
  };
}

export function compactTaskRequestsForBoardManager(requests = []) {
  return safeArray(requests).slice(0, 6).map((request) => ({
    requestId: safeText(request.requestId, 180),
    accountId: safeText(request.accountId, 180),
    subjectWallet: safeText(request.subjectWallet, 120),
    source: safeText(request.source, 80),
    requestText: safeText(request.requestText, 300),
    userDetailText: safeText(request.userDetailText, 500),
    requestedTaskKind: safeText(request.requestedTaskKind, 80),
    status: safeText(request.status, 80),
    generatedTaskId: safeText(request.generatedTaskId, 180),
    lastError: safeText(request.lastError, 300),
    updatedAt: request.updatedAt || null,
  }));
}

export function compactNetworkTaskContentForBoardManager(content = {}) {
  return {
    schema: safeText(content.schema, 120),
    generatedAt: content.generatedAt || null,
    counts: safeObject(content.counts),
    completed: safeArray(content.completed).slice(0, 5),
    outstanding: safeArray(content.outstanding).slice(0, 8),
    stopped: safeArray(content.stopped).slice(0, 6),
    pendingGeneration: safeArray(content.pendingGeneration).slice(0, 6),
    text: safeText(content.text, 3500),
  };
}

export function compactProjectRegistryForBoardManager(projects = []) {
  return safeArray(projects).slice(0, 16).map((project) => ({
    id: safeText(project.id, 180),
    type: safeText(project.type, 80),
    title: safeText(project.title || project.name, 180),
    summary: safeText(project.summary, 500),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    phaseLabel: safeText(project.phaseLabel || project.phase, 120),
    taskCount: Number(project.taskCount || 0),
    contributorCount: Number(project.contributorCount || 0),
    updatedAt: project.updatedAt || null,
  }));
}

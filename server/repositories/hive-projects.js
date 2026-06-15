import { databaseEnabled, query, transaction } from "../db/pool.js";
import { listPublicAccountWalletIdentities } from "../runtime-store.js";
import { publicReducerEvent } from "../task-forensics-format.js";
import { taskRewardOutcome } from "../task-reward-outcome.js";
import { currentVerificationRequest } from "../task-verification-view.js";
import { discoverableMemberProfileIds } from "./directory-leaderboard.js";
import { latestHiveProjectPlanningState, projectHasOperatorArchiveLock } from "./hive-project-planning.js";
import { getCurrentProjectProductDocs } from "./hive-project-product-docs.js";

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

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

const activeTaskStateRank = new Map([
  ["accepted", 10],
  ["verification_requested", 20],
  ["verification_response_submitted", 30],
  ["submitted", 40],
  ["proposed", 50],
]);

function intValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function formatProjectDate(value) {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return safeText(value, 80);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function toIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : safeText(value, 80);
}

function timestampMs(value = "") {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function typeLabel(value = "") {
  return safeText(value, 80)
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function compactWallet(wallet = "") {
  const normalized = safeText(wallet, 120);
  if (normalized.length <= 12) return normalized || "Operator";
  return `${normalized.slice(0, 6)}...${normalized.slice(-5)}`;
}

function walletIdentityKey(wallet = "") {
  return safeText(wallet, 160).toLowerCase();
}

function walletIdentityDisplayName(identity = {}) {
  const publicAlias = safeArray(identity.publicAliases).find((alias) => safeText(alias?.handle, 120));
  return safeText(
    identity.displayName ||
      identity.publicDisplayName ||
      (identity.hiveHandle ? `@${safeText(identity.hiveHandle, 80).replace(/^@+/, "")}` : "") ||
      (publicAlias?.handle ? `@${safeText(publicAlias.handle, 120).replace(/^@+/, "")}` : ""),
    120
  );
}

function walletIdentityMap(walletIdentities = [], publicProfileIds = new Set()) {
  const identities = new Map();
  for (const identity of safeArray(walletIdentities)) {
    const key = walletIdentityKey(identity.walletAddress || identity.wallet_address || identity.wallet);
    const displayName = walletIdentityDisplayName(identity);
    if (!key || !displayName) continue;
    const accountId = safeText(identity.accountId || identity.account_id, 180);
    identities.set(key, {
      accountId,
      displayName,
      hiveHandle: safeText(identity.hiveHandle || identity.hive_handle, 80),
      publicDisplayName: safeText(identity.publicDisplayName || identity.public_display_name, 120),
      publicAliases: safeArray(identity.publicAliases || identity.public_aliases),
      publicTrustBadges: safeArray(identity.publicTrustBadges || identity.public_trust_badges),
      hasPublicProfile: Boolean(accountId && publicProfileIds.has(accountId)),
    });
  }
  return identities;
}

function enrichContributorWithWalletIdentity(contributor = {}, identity = null) {
  if (identity?.displayName) {
    // Keep the operator's Hive codename as the displayed name; expose the public
    // profile displayName as a separate fallback field (the frontend's
    // operatorDisplayName prefers codename, then displayName). Overwriting codename
    // here blanked routing-feed names when displayName was empty/odd.
    contributor.displayName = identity.displayName;
    contributor.hiveHandle = identity.hiveHandle || contributor.hiveHandle || "";
    contributor.publicDisplayName = identity.publicDisplayName || contributor.publicDisplayName || "";
    contributor.publicAliases = identity.publicAliases || contributor.publicAliases || [];
    contributor.publicTrustBadges = identity.publicTrustBadges || contributor.publicTrustBadges || [];
  }
  contributor.accountId = identity?.accountId || contributor.accountId || "";
  contributor.hasPublicProfile = Boolean(identity?.hasPublicProfile);
  return contributor;
}

function enrichTaskWithWalletIdentity(task = {}, identity = null) {
  task.assigneeAccountId = identity?.accountId || task.assigneeAccountId || "";
  task.assigneeHasPublicProfile = Boolean(identity?.hasPublicProfile);
  task.assigneeHandle = identity?.hiveHandle || task.assigneeHandle || "";
  task.assigneeDisplayName = identity?.displayName || task.assigneeDisplayName || "";
  return task;
}

function enrichActivityWithWalletIdentity(entry = {}, identity = null) {
  entry.accountId = identity?.accountId || entry.accountId || "";
  entry.hasPublicProfile = Boolean(identity?.hasPublicProfile);
  entry.hiveHandle = identity?.hiveHandle || entry.hiveHandle || "";
  entry.displayName = identity?.displayName || entry.displayName || "";
  return entry;
}

function applyWalletIdentitiesToProjects(projects = {}, walletIdentities = [], publicProfileIds = new Set()) {
  const identities = walletIdentityMap(walletIdentities, publicProfileIds);
  if (identities.size === 0) return projects;

  for (const project of Object.values(projects)) {
    for (const contributor of safeArray(project.contributors)) {
      enrichContributorWithWalletIdentity(contributor, identities.get(walletIdentityKey(contributor.wallet)));
    }
    for (const task of safeArray(project.tasks)) {
      enrichTaskWithWalletIdentity(task, identities.get(walletIdentityKey(task.assignee)));
    }
    for (const entry of safeArray(project.activity)) {
      enrichActivityWithWalletIdentity(entry, identities.get(walletIdentityKey(entry.wallet)));
    }
  }
  return projects;
}

async function publicWalletIdentityForWallet(wallet = "") {
  const key = walletIdentityKey(wallet);
  if (!key) return null;
  const walletIdentities = listPublicAccountWalletIdentities().filter((identity) =>
    walletIdentityKey(identity.walletAddress || identity.wallet_address || identity.wallet) === key
  );
  const publicProfileIds = await discoverableMemberProfileIds(
    Array.from(new Set(walletIdentities.map((identity) => safeText(identity.accountId || identity.account_id, 180)).filter(Boolean)))
  );
  return walletIdentityMap(walletIdentities, publicProfileIds).get(key) || null;
}

function publicProject(row = {}) {
  const phase = row.phase_label || (row.phase_current && row.phase_total ? `${row.phase_current} of ${row.phase_total}` : "");
  return {
    id: row.id,
    name: safeText(row.title, 180),
    type: typeLabel(row.type),
    typeKey: safeText(row.type, 80),
    summary: safeText(row.summary, 600),
    objective: safeText(row.objective, 800),
    about: safeText(row.about, 1800),
    status: safeText(row.status, 80),
    priority: intValue(row.priority),
    origin: safeText(row.origin, 100),
    proposedBy: safeText(row.proposed_by, 120) || "hive",
    proposed: formatProjectDate(row.proposed_at),
    phase,
    phaseCurrent: intValue(row.phase_current),
    phaseTotal: intValue(row.phase_total),
    pft: 0,
    taskCount: 0,
    contributorCount: 0,
    plannedPftTarget: numeric(row.pft_routed),
    plannedTaskCount: intValue(row.task_count),
    plannedContributorTarget: intValue(row.contributor_count),
    pendingGenerationCount: 0,
    sourceHiveSecretaryReportId: safeText(row.source_hive_secretary_report_id, 180),
    sourceHiveSecretaryReportDigest: safeText(row.source_hive_secretary_report_digest, 180),
    sourceInputs: safeObject(row.source_inputs_json),
    metadata: safeObject(row.metadata_json),
    contributors: [],
    tasks: [],
    activity: [],
  };
}

function publicContributor(row = {}) {
  return {
    wallet: safeText(row.wallet_address, 120),
    accountId: "",
    hasPublicProfile: false,
    codename: safeText(row.codename, 120),
    archetype: safeText(row.archetype, 180),
    badge: intValue(row.badge_variant),
    allotted: Boolean(row.allotted),
    cap: intValue(row.cap),
    load: intValue(row.load),
    status: safeText(row.status, 80) || "active",
    tasks: intValue(row.task_count),
    pft: numeric(row.pft_earned),
    lastActive: safeText(row.last_active_label, 80),
    role: safeText(row.role_label, 80),
    currentTasks: [],
  };
}

function publicTask(row = {}) {
  const projectedReward = row.projected_reward_pft ?? row.reward_pft;
  const state = safeText(row.projected_status || row.state, 80) || "proposed";
  const assigneeNft = safeText(row.assignee_nft_image_cid || row.assignee_nft_image_gateway_url, 500)
    ? {
        title: safeText(row.assignee_nft_title, 160),
        status: safeText(row.assignee_nft_status, 80),
        imageCid: safeText(row.assignee_nft_image_cid, 180),
        imageGatewayUrl: safeText(row.assignee_nft_image_gateway_url, 500),
      }
    : null;
  return {
    id: safeText(row.id, 180),
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    title: safeText(row.projected_title || row.title, 240),
    state,
    assignee: safeText(row.projected_subject_wallet || row.assignee_wallet, 120),
    assigneeAccountId: "",
    assigneeHasPublicProfile: false,
    assigneeHandle: "",
    assigneeDisplayName: "",
    pft: numeric(projectedReward),
    nextAction: taskNextAction(state),
    age: safeText(row.age_label, 80),
    source: safeText(row.source, 100),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.projected_updated_at || row.updated_at),
    assigneeNft,
  };
}

function publicActivity(row = {}) {
  return {
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    wallet: safeText(row.wallet_address, 120),
    taskId: safeText(row.task_id || safeObject(row.metadata_json).taskId || safeObject(row.metadata_json).task_id, 180),
    accountId: "",
    hasPublicProfile: false,
    hiveHandle: "",
    displayName: "",
    action: safeText(row.action, 80),
    task: safeText(row.task_title, 240),
    time: safeText(row.time_label, 80),
    pft: row.pft_amount === null || row.pft_amount === undefined ? null : numeric(row.pft_amount),
    nextAction: taskNextAction(row.action),
    routing: safeText(row.routing_label, 120),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function operatorMap(projects = {}) {
  const operators = {};
  for (const project of Object.values(projects)) {
    for (const contributor of safeArray(project.contributors)) {
      if (!contributor.wallet) continue;
      const operator = {
        codename: contributor.codename || "Operator",
        archetype: contributor.archetype || "",
        badge: contributor.badge || 0,
        allotted: Boolean(contributor.allotted),
        cap: contributor.cap || 0,
        load: contributor.load || 0,
        status: contributor.status || "active",
        tasks: contributor.tasks || 0,
        pft: contributor.pft || 0,
        currentTasks: safeArray(contributor.currentTasks),
        nft: contributor.nft || null,
        accountId: contributor.accountId || "",
        hasPublicProfile: Boolean(contributor.hasPublicProfile),
        hiveHandle: contributor.hiveHandle || "",
        publicDisplayName: contributor.publicDisplayName || "",
        publicAliases: safeArray(contributor.publicAliases),
        publicTrustBadges: safeArray(contributor.publicTrustBadges),
      };
      operators[contributor.wallet] = operators[contributor.wallet]
        ? mergeContributor(operators[contributor.wallet], operator)
        : operator;
    }
  }
  return operators;
}

function taskNextAction(state = "") {
  const normalized = safeText(state, 80).toLowerCase();
  if (normalized === "accepted") return "Complete the task and submit evidence for review.";
  if (normalized === "verification_requested") return "Answer the reviewer follow-up with the missing verification detail.";
  if (normalized === "verification_response_submitted") return "Wait for review or prepare any final clarification.";
  if (normalized === "submitted") return "Wait for review, then respond quickly if verification is requested.";
  if (normalized === "proposed") return "Open the task and accept or refuse it before the deadline.";
  if (normalized === "reward_decided") return "Wait for the terminal reward outcome to settle.";
  if (["rewarded", "paid"].includes(normalized)) return "Reward recorded; no further action is required.";
  if (["refused", "cancelled", "rejected", "expired"].includes(normalized)) return "Task is stopped; wait for a new routed task if more work is needed.";
  return "Open the project task row and inspect the latest state.";
}

function taskStateRank(state = "") {
  return activeTaskStateRank.get(safeText(state, 80).toLowerCase()) || 0;
}

function taskIsNextCandidate(task = {}) {
  return Boolean(task?.taskId && taskStateRank(task.state) > 0);
}

function compareNextTask(left = {}, right = {}) {
  const leftRank = taskStateRank(left.state);
  const rightRank = taskStateRank(right.state);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (numeric(right.rewardPft || right.pft) !== numeric(left.rewardPft || left.pft)) {
    return numeric(right.rewardPft || right.pft) - numeric(left.rewardPft || left.pft);
  }
  return timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
}

function projectNextTask(project = {}) {
  const task = safeArray(project.tasks)
    .filter(taskIsNextCandidate)
    .sort(compareNextTask)[0] || null;
  if (!task) return null;
  return {
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    assignee: task.assignee,
    assigneeAccountId: task.assigneeAccountId || "",
    assigneeHasPublicProfile: Boolean(task.assigneeHasPublicProfile),
    assigneeHandle: task.assigneeHandle || "",
    assigneeDisplayName: task.assigneeDisplayName || "",
    pft: numeric(task.pft),
    nextAction: task.nextAction || taskNextAction(task.state),
    updatedAt: task.updatedAt || task.createdAt || "",
  };
}

function deriveContributorFromTask(project = {}, task = {}) {
  const wallet = safeText(task.assignee, 120);
  if (!wallet) return null;
  const taskState = safeText(task.state, 80).toLowerCase();
  const paidPft = taskState === "rewarded" ? numeric(task.pft) : 0;
  const activeLoad = ["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted"].includes(taskState) ? 1 : 0;
  return {
    wallet,
    accountId: task.assigneeAccountId || "",
    hasPublicProfile: Boolean(task.assigneeHasPublicProfile),
    codename: compactWallet(wallet),
    archetype: "Network task contributor",
    badge: 0,
    allotted: true,
    cap: Math.max(1, activeLoad),
    load: activeLoad,
    status: "active",
    tasks: 1,
    pft: paidPft,
    lastActive: task.age || "recently",
    role: "contributor",
    currentTasks: taskIsNextCandidate(task)
      ? [{
          projectId: project.id,
          projectName: project.name,
          taskId: task.taskId,
          title: task.title,
          state: task.state,
          rewardPft: numeric(task.pft),
          nextAction: taskNextAction(task.state),
          updatedAt: task.updatedAt || task.createdAt || "",
        }]
      : [],
    nft: task.assigneeNft || null,
  };
}

function mergeContributor(left = {}, right = {}) {
  const pft = numeric(left.pft) + numeric(right.pft);
  const tasks = intValue(left.tasks) + intValue(right.tasks);
  const load = intValue(left.load) + intValue(right.load);
  const cap = Math.max(intValue(left.cap), intValue(right.cap), load, 1);
  const currentTasks = [...safeArray(left.currentTasks), ...safeArray(right.currentTasks)]
    .filter((task, index, list) => (
      task?.taskId &&
      list.findIndex((item) => item?.taskId === task.taskId) === index
    ))
    .sort(compareNextTask);
  return {
    ...left,
    codename: left.codename || right.codename,
    archetype: left.archetype || right.archetype,
    badge: intValue(left.badge) || intValue(right.badge),
    allotted: Boolean(left.allotted || right.allotted),
    cap,
    load,
    status: left.status || right.status || "active",
    tasks,
    pft,
    lastActive: left.lastActive || right.lastActive,
    role: left.role || right.role,
    currentTasks,
    nft: left.nft || right.nft || null,
    accountId: left.accountId || right.accountId || "",
    hasPublicProfile: Boolean(left.hasPublicProfile || right.hasPublicProfile),
    hiveHandle: left.hiveHandle || right.hiveHandle || "",
    publicDisplayName: left.publicDisplayName || right.publicDisplayName || "",
    publicAliases: safeArray(left.publicAliases).length ? left.publicAliases : safeArray(right.publicAliases),
    publicTrustBadges: safeArray(left.publicTrustBadges).length ? left.publicTrustBadges : safeArray(right.publicTrustBadges),
  };
}

function actionForTaskState(state = "") {
  const normalized = safeText(state, 80).toLowerCase();
  if (normalized === "verification_response_submitted") return "verification_response_submitted";
  if (normalized === "reward_decided") return "reward_pending";
  if (normalized === "rewarded") return "rewarded";
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "rejected") return "rejected";
  if (normalized === "expired") return "expired";
  if (normalized === "refused") return "refused";
  if (normalized === "verification_requested") return "verification_requested";
  if (normalized === "submitted") return "submitted";
  if (normalized === "accepted") return "accepted";
  return "proposed";
}

function deriveActivityFromTask(project = {}, task = {}) {
  if (!task.taskId) return null;
  const action = actionForTaskState(task.state);
  return {
    id: `project_task_activity_${task.taskId}`,
    projectId: project.id,
    wallet: task.assignee,
    taskId: task.taskId,
    accountId: task.assigneeAccountId || "",
    hasPublicProfile: Boolean(task.assigneeHasPublicProfile),
    hiveHandle: task.assigneeHandle || "",
    displayName: task.assigneeDisplayName || "",
    action,
    task: task.title,
    time: task.age || "",
    pft: action === "rewarded" ? numeric(task.pft) : null,
    nextAction: task.nextAction || taskNextAction(action),
    routing: task.requestId ? `request ${task.requestId}` : "",
    project: project.name,
    derived: true,
    createdAt: task.createdAt || "",
    updatedAt: task.updatedAt || task.createdAt || "",
  };
}

function populateDerivedProjectRollups(projects = {}) {
  for (const project of Object.values(projects)) {
    const byWallet = new Map(safeArray(project.contributors).map((contributor) => [contributor.wallet, contributor]));
    for (const task of safeArray(project.tasks)) {
      const contributor = deriveContributorFromTask(project, task);
      if (contributor) {
        byWallet.set(contributor.wallet, byWallet.has(contributor.wallet)
          ? mergeContributor(byWallet.get(contributor.wallet), contributor)
          : contributor);
      }
      const hasActivity = safeArray(project.activity).some((entry) => entry.task === task.title && entry.action === actionForTaskState(task.state));
      if (!hasActivity) {
        const activity = deriveActivityFromTask(project, task);
        if (activity) project.activity.push(activity);
      }
    }
    project.contributors = Array.from(byWallet.values()).sort((left, right) => {
      if (Boolean(right.allotted) !== Boolean(left.allotted)) return right.allotted ? 1 : -1;
      if (numeric(right.pft) !== numeric(left.pft)) return numeric(right.pft) - numeric(left.pft);
      return safeText(left.wallet).localeCompare(safeText(right.wallet));
    });
    project.tasks = safeArray(project.tasks).sort((left, right) =>
      timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
      safeText(right.id).localeCompare(safeText(left.id))
    );
    project.activity = safeArray(project.activity).sort((left, right) =>
      timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
      safeText(right.id).localeCompare(safeText(left.id))
    );
    project.taskCount = project.tasks.length;
    project.contributorCount = project.contributors.length;
    project.pft = numeric(project.tasks.reduce((sum, task) => sum + numeric(task.pft), 0));
    project.nextTask = projectNextTask(project);
  }
}

function projectHasOperatorPin(project = {}) {
  const metadata = safeObject(project.metadata);
  return Boolean(
    metadata.operator_pinned === true ||
    metadata.operator_pin === true ||
    metadata.board_pinned === true ||
    metadata.pin_source === "operator"
  );
}

function projectHasBoardEvidence(project = {}) {
  return (
    safeArray(project.tasks).length > 0 ||
    safeArray(project.contributors).some((contributor) => safeText(contributor.status, 80) !== "archived") ||
    intValue(project.pendingGenerationCount) > 0 ||
    projectHasOperatorPin(project)
  );
}

function projectVisibleOnActiveBoard(project = {}, { includeEmptyActive = false } = {}) {
  if (projectHasOperatorArchiveLock({ metadata_json: project.metadata })) return false;
  const status = safeText(project.status, 80);
  if (status !== "active") return false;
  if (includeEmptyActive && status === "active") return true;
  if (!projectHasBoardEvidence(project)) return false;
  return true;
}

function visiblePublicProject(project = {}) {
  const { metadata, ...publicFields } = project;
  return publicFields;
}

function documentFromRows({
  projectRows = [],
  contributorRows = [],
  taskRows = [],
  activityRows = [],
  pendingGenerationRows = [],
  productDocs = [],
  latestSecretary = null,
  projectPlanning = null,
  walletIdentities = [],
  publicProfileIds = new Set(),
  includeEmptyActive = false,
} = {}) {
  const projects = Object.fromEntries(projectRows.map((row) => {
    const project = publicProject(row);
    return [project.id, project];
  }));

  for (const row of contributorRows) {
    const project = projects[row.project_id];
    if (project) project.contributors.push(publicContributor(row));
  }
  for (const row of taskRows) {
    const project = projects[row.project_id];
    if (project) project.tasks.push(publicTask(row));
  }
  for (const row of activityRows) {
    const project = projects[row.project_id];
    if (project) project.activity.push(publicActivity(row));
  }
  for (const row of pendingGenerationRows) {
    const project = projects[row.project_id];
    if (project) project.pendingGenerationCount = intValue(row.pending_generation_count);
  }
  for (const doc of safeArray(productDocs)) {
    const project = projects[doc.projectId];
    if (project) project.productDocument = doc;
  }
  applyWalletIdentitiesToProjects(projects, walletIdentities, publicProfileIds);
  populateDerivedProjectRollups(projects);

  const visibleProjects = Object.fromEntries(
    Object.values(projects)
      .filter((project) => projectVisibleOnActiveBoard(project, { includeEmptyActive }))
      .map((project) => [project.id, visiblePublicProject(project)])
  );
  const projectIds = Object.values(visibleProjects)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map((project) => project.id);
  const operators = operatorMap(visibleProjects);
  const routingFeed = Object.values(visibleProjects)
    .flatMap((project) =>
      safeArray(project.activity).map((entry) => ({
        ...entry,
        project: project.name,
      }))
    )
    .sort((left, right) =>
      timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
      safeText(right.id).localeCompare(safeText(left.id))
    )
    .slice(0, 12);
  const activeOperators = Object.values(operators).filter((operator) => operator.status === "active").length;
  const tasksInFlight = Object.values(visibleProjects).reduce((sum, project) => sum + safeArray(project.tasks).length, 0);
  const pftRouted = Object.values(visibleProjects).reduce((sum, project) => sum + numeric(project.pft), 0);

  return {
    generatedAt: new Date().toISOString(),
    projectIds,
    projects: visibleProjects,
    operators,
    routingFeed,
    stats: {
      activeProjects: projectIds.length,
      operatorsOnline: activeOperators,
      tasksInFlight,
      pftRouted,
    },
    secretaryInput: latestSecretary
      ? {
          id: latestSecretary.id,
          completedAt: latestSecretary.completed_at,
          digest: latestSecretary.source_packet_digest,
          title: latestSecretary.output_json?.title || "Hive Secretary Report",
        }
      : null,
    projectPlanning,
  };
}

function publicSummaryText(value = "", max = 900) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function publicSubmissionSummaries(metadata = {}) {
  return safeArray(metadata.submissionSummaries)
    .map((summary, index) => ({
      type: publicSummaryText(summary?.type || summary?.label || `Submission ${index + 1}`, 120),
      summary: publicSummaryText(summary?.summary || summary?.description || "", 900),
    }))
    .filter((summary) => summary.type || summary.summary)
    .slice(0, 6);
}

function publicTimelineRows(rows = []) {
  return safeArray(rows)
    .map((row, index) => publicReducerEvent(row, index))
    .map((event) => ({
      action: safeText(event.schema || event.label, 120),
      label: safeText(event.label, 180),
      time: toIso(event.observedAt),
      txHash: safeText(event.txHash, 240),
      cid: safeText(event.cid, 240),
    }))
    .filter((event) => event.label)
    .slice(0, 40);
}

function latestTimelineEvent(timeline = [], schema = "") {
  const normalized = safeText(schema, 120);
  for (let index = safeArray(timeline).length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (safeText(event.schema, 120) === normalized) return event;
  }
  return null;
}

function publicVerificationSummary(timeline = []) {
  const request = currentVerificationRequest(timeline);
  const response = latestTimelineEvent(timeline, "pf.task.verification_response.v1");
  if (!request && !response) return null;
  return {
    request: request ? publicSummaryText(request.body || request.ask, 900) : "",
    response: response ? "Verification response submitted." : "",
  };
}

function publicRewardOutcome(outcome = null) {
  if (!outcome) {
    return {
      decision: "",
      rewardPft: 0,
      reason: "",
    };
  }
  return {
    decision: publicSummaryText(outcome.decision || outcome.title || outcome.status, 120),
    rewardPft: numeric(outcome.rewardPft),
    reason: publicSummaryText(outcome.reason || outcome.userFeedback || outcome.summary, 900),
  };
}

function publicAssigneeNft(nft = null) {
  return {
    title: safeText(nft?.title, 180),
    status: safeText(nft?.status, 80),
    imageCid: safeText(nft?.imageCid, 180),
    imageGatewayUrl: safeText(nft?.imageGatewayUrl, 500),
  };
}

export const publicHiveTaskDetailFields = [
  "ok",
  "task.id",
  "task.taskId",
  "task.requestId",
  "task.title",
  "task.state",
  "task.assignee",
  "task.assigneeAccountId",
  "task.assigneeHasPublicProfile",
  "task.assigneeHandle",
  "task.assigneeDisplayName",
  "task.pft",
  "task.nextAction",
  "task.age",
  "task.source",
  "task.createdAt",
  "task.updatedAt",
  "task.assigneeNft.title",
  "task.assigneeNft.status",
  "task.assigneeNft.imageCid",
  "task.assigneeNft.imageGatewayUrl",
  "task.kind",
  "task.summary",
  "task.description",
  "task.project.id",
  "task.project.name",
  "task.project.type",
  "review.submissions[].type",
  "review.submissions[].summary",
  "review.verification.request",
  "review.verification.response",
  "review.outcome.decision",
  "review.outcome.rewardPft",
  "review.outcome.reason",
  "timeline[].action",
  "timeline[].label",
  "timeline[].time",
  "timeline[].txHash",
  "timeline[].cid",
];

export function publicHiveTaskDetailFieldsForPayload(value, path = "") {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((item) => publicHiveTaskDetailFieldsForPayload(item, `${path}[]`))));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => key !== "publicFields");
    if (!entries.length) return path ? [path] : [];
    return Array.from(new Set(entries.flatMap(([key, child]) => publicHiveTaskDetailFieldsForPayload(child, path ? `${path}.${key}` : key))));
  }
  return path ? [path] : [];
}

function publicHiveTaskFromProjection(row = {}) {
  const projected = publicTask({
    ...row,
    project_id: row.project_id,
    projected_status: row.status,
    projected_title: row.title,
    projected_subject_wallet: row.subject_wallet,
    projected_reward_pft: row.status === "rewarded" ? row.reward_actual_pft : row.reward_offer_pft,
    projected_updated_at: row.updated_at,
  });
  return {
    ...projected,
    assigneeNft: publicAssigneeNft(projected.assigneeNft),
    kind: projected.source === "task_projections" ? "Network task" : "Network task",
    summary: publicSummaryText(row.description || row.submission_requirement_text || "", 1200),
    description: publicSummaryText(row.description || "", 1600),
    project: {
      id: safeText(row.project_id, 180),
      name: safeText(row.project_title, 180),
      type: typeLabel(row.project_type),
    },
  };
}

export async function getPublicHiveTaskDetail({ taskId = "", queryImpl = query, databaseReady = useDatabase() } = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) {
    return {
      ok: false,
      status: 400,
      error: "hive_task_id_required",
      message: "A taskId query parameter is required.",
    };
  }
  if (!databaseReady) {
    return {
      ok: false,
      status: 503,
      error: "database_not_configured",
      message: "Hive task detail requires the database-backed task projection.",
    };
  }

  const taskResult = await queryImpl(
    `
      SELECT projection.*,
             refs.project_id,
             project.title AS project_title,
             project.type AS project_type
      FROM network_project_task_refs refs
      JOIN network_projects project
        ON project.id = refs.project_id
      JOIN task_projections projection
        ON projection.task_id = refs.task_id
      WHERE refs.task_id = $1
        AND refs.task_id <> ''
      LIMIT 1
    `,
    [normalizedTaskId]
  );
  const row = taskResult.rows[0] || null;
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "hive_task_not_found",
      message: "No public Hive task projection was found for this task.",
    };
  }

  const eventsResult = await queryImpl(
    `
      SELECT *
      FROM task_events
      WHERE task_id = $1
      ORDER BY occurred_at ASC, id ASC
      LIMIT 200
    `,
    [normalizedTaskId]
  );
  const timeline = eventsResult.rows.map((eventRow, index) => publicReducerEvent(eventRow, index));
  const publicTimeline = publicTimelineRows(eventsResult.rows);
  const task = publicHiveTaskFromProjection(row);
  enrichTaskWithWalletIdentity(task, await publicWalletIdentityForWallet(task.assignee));
  const metadata = safeObject(row.metadata_json);
  const submissions = publicSubmissionSummaries(metadata);
  const verification = publicVerificationSummary(timeline) || { request: "", response: "" };
  const outcome = publicRewardOutcome(taskRewardOutcome({
    offeredPft: row.reward_offer_pft,
    task,
    timeline,
  }));

  const response = {
    ok: true,
    task,
    review: {
      submissions,
      verification,
      outcome,
    },
    timeline: publicTimeline.length
      ? publicTimeline
      : [{
          action: task.state,
          label: taskNextAction(task.state),
          time: task.updatedAt || task.createdAt || "",
          txHash: "",
          cid: "",
        }],
  };
  return {
    ...response,
    publicFields: publicHiveTaskDetailFieldsForPayload(response),
  };
}

export async function syncNetworkProjectsWithLatestHiveSecretary() {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured" };
  return transaction(async (client) => {
    const latest = await client.query(
      `
        SELECT id, source_packet_digest, output_json, completed_at
        FROM hive_secretary_reports
        WHERE status = 'completed'
          AND superseded_at IS NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      `
    );
    const report = latest.rows[0] || null;
    if (!report?.id) return { ok: true, updated: 0, reason: "no_hive_secretary_report" };
    const updated = await client.query(
      `
        UPDATE network_projects
        SET source_hive_secretary_report_id = $1,
            source_hive_secretary_report_digest = $2,
            source_inputs_json = jsonb_set(
              COALESCE(source_inputs_json, '{}'::jsonb),
              '{hive_secretary}',
              $3::jsonb,
              true
            ),
            updated_at = now()
        WHERE status = 'active'
          AND origin = 'system_seed'
          AND (
            source_hive_secretary_report_id <> $1
            OR source_hive_secretary_report_digest <> $2
          )
      `,
      [
        report.id,
        safeText(report.source_packet_digest, 180),
        JSON.stringify({
          report_id: report.id,
          source_packet_digest: report.source_packet_digest,
          completed_at: report.completed_at,
          title: report.output_json?.title || "Hive Secretary Report",
        }),
      ]
    );
    return { ok: true, updated: updated.rowCount || 0, reportId: report.id };
  });
}

export async function getHiveProjectsDocument({ includeEmptyActive = false } = {}) {
  if (!useDatabase()) {
    return documentFromRows({ includeEmptyActive });
  }
  const [projectsResult, contributorsResult, tasksResult, activityResult, pendingGenerationResult, secretaryResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM network_projects
        WHERE status IN ('active', 'paused', 'archived')
          AND (
            status = 'active'
            OR metadata_json->>'operator_pinned' = 'true'
            OR metadata_json->>'operator_pin' = 'true'
            OR metadata_json->>'board_pinned' = 'true'
            OR metadata_json->>'pin_source' = 'operator'
            OR EXISTS (
              SELECT 1
              FROM network_project_contributors contributor
              WHERE contributor.project_id = network_projects.id
                AND contributor.status <> 'archived'
            )
            OR EXISTS (
              SELECT 1
              FROM network_project_task_refs refs
              JOIN task_projections projection
                ON projection.task_id = refs.task_id
              WHERE refs.project_id = network_projects.id
                AND refs.task_id <> ''
            )
            OR EXISTS (
              SELECT 1
              FROM network_task_generation_jobs job
              WHERE job.project_id = network_projects.id
                AND job.status IN ('queued', 'running', 'generated')
            )
          )
        ORDER BY priority ASC, title ASC
      `
    ),
    query(
      `
        SELECT *
        FROM network_project_contributors
        WHERE status <> 'archived'
        ORDER BY project_id ASC, sort_order ASC, wallet_address ASC
      `
    ),
    query(
      `
        SELECT refs.*,
               projection.status AS projected_status,
               projection.title AS projected_title,
               projection.subject_wallet AS projected_subject_wallet,
               CASE
                 WHEN projection.status = 'rewarded' THEN projection.reward_actual_pft
                 ELSE projection.reward_offer_pft
               END AS projected_reward_pft,
               projection.updated_at AS projected_updated_at,
               nft.title AS assignee_nft_title,
               nft.status AS assignee_nft_status,
               nft.image_cid AS assignee_nft_image_cid,
               nft.image_gateway_url AS assignee_nft_image_gateway_url
        FROM network_project_task_refs refs
        JOIN task_projections projection
          ON projection.task_id = refs.task_id
        LEFT JOIN LATERAL (
          SELECT id, title, status, image_cid, image_gateway_url, selected, created_at, updated_at
          FROM profile_nfts
          WHERE wallet_address = COALESCE(NULLIF(projection.subject_wallet, ''), refs.assignee_wallet)
            AND wallet_address <> ''
            AND status IN ('minted', 'prepared', 'generated')
            AND (
              COALESCE(image_gateway_url, '') <> ''
              OR COALESCE(image_cid, '') <> ''
            )
          ORDER BY
            selected DESC,
            created_at DESC NULLS LAST,
            updated_at DESC NULLS LAST,
            id DESC
          LIMIT 1
        ) nft ON true
        WHERE refs.task_id <> ''
        ORDER BY refs.project_id ASC, refs.sort_order ASC, refs.id ASC
      `
    ),
    query(
      `
        SELECT *
        FROM network_project_activity
        ORDER BY project_id ASC, sort_order ASC, id ASC
      `
    ),
    query(
      `
        SELECT project_id, count(*)::int AS pending_generation_count
        FROM network_task_generation_jobs
        WHERE status IN ('queued', 'running', 'generated')
        GROUP BY project_id
        ORDER BY project_id ASC
      `
    ),
    query(
      `
        SELECT id, source_packet_digest, output_json, completed_at
        FROM hive_secretary_reports
        WHERE status = 'completed'
          AND superseded_at IS NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      `
    ),
  ]);
  const productDocs = await getCurrentProjectProductDocs({
    projectIds: projectsResult.rows.map((row) => row.id),
  });
  const projectPlanning = await latestHiveProjectPlanningState().catch(() => null);
  const walletIdentities = listPublicAccountWalletIdentities();
  const publicProfileIds = await discoverableMemberProfileIds(
    Array.from(new Set(walletIdentities.map((identity) => safeText(identity.accountId || identity.account_id, 180)).filter(Boolean)))
  );

  return documentFromRows({
    projectRows: projectsResult.rows,
    contributorRows: contributorsResult.rows,
    taskRows: tasksResult.rows,
    activityRows: activityResult.rows,
    pendingGenerationRows: pendingGenerationResult.rows,
    productDocs,
    latestSecretary: secretaryResult.rows[0] || null,
    projectPlanning,
    walletIdentities,
    publicProfileIds,
    includeEmptyActive,
  });
}

export const hiveProjectsDocumentForTests = documentFromRows;

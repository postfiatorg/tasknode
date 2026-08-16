import { projectHasOperatorArchiveLock } from "./hive-project-planning.js";
import { deriveNetworkTaskStatusPacketFromRow } from "./network-task-status.js";

export function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function emptyOperatorDisclosure() {
  return {
    isMachineOperator: false,
    label: "",
    kind: "",
  };
}

export function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

const activeTaskStateRank = new Map([
  ["accepted", 10],
  ["verification_requested", 20],
  ["verification_response_submitted", 30],
  ["submitted", 40],
  ["reward_decided", 45],
  ["proposed", 50],
]);

const terminalTaskStates = new Set([
  "rewarded",
  "paid",
  "refused",
  "cancelled",
  "rejected",
  "expired",
  "failed",
  "completed",
  "rerouted",
]);
const maxProjectActivityRows = 48;

export function intValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

export function formatProjectDate(value) {
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

export function toIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : safeText(value, 80);
}

export function timestampMs(value = "") {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function typeLabel(value = "") {
  return safeText(value, 80)
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function compactWallet(wallet = "") {
  const normalized = safeText(wallet, 120);
  if (normalized.length <= 12) return normalized || "Operator";
  return `${normalized.slice(0, 6)}...${normalized.slice(-5)}`;
}

export function walletIdentityKey(wallet = "") {
  return safeText(wallet, 160).toLowerCase();
}

export function viewerContext({ accountId = "", walletAddress = "" } = {}) {
  return {
    accountId: safeText(accountId, 180),
    walletAddress: walletIdentityKey(walletAddress),
  };
}

export function taskMatchesViewer(task = {}, viewer = {}) {
  const accountId = safeText(viewer.accountId, 180);
  if (accountId && safeText(task.assigneeAccountId, 180) === accountId) return true;
  const walletAddress = safeText(viewer.walletAddress, 180);
  return Boolean(walletAddress && walletIdentityKey(task.assignee) === walletAddress);
}

export function viewerTaskRelation(task = {}, viewer = {}) {
  if (!taskMatchesViewer(task, viewer)) return "";
  const state = safeText(task.state, 80).toLowerCase();
  return state === "proposed" ? "offer" : "active";
}

export function walletIdentityDisplayName(identity = {}) {
  const publicAlias = safeArray(identity.publicAliases).find((alias) => safeText(alias?.handle, 120));
  return safeText(
    identity.displayName ||
      identity.publicDisplayName ||
      (identity.hiveHandle ? `@${safeText(identity.hiveHandle, 80).replace(/^@+/, "")}` : "") ||
      (publicAlias?.handle ? `@${safeText(publicAlias.handle, 120).replace(/^@+/, "")}` : ""),
    120
  );
}

export function walletIdentityMap(walletIdentities = [], publicProfileIds = new Set(), operatorDisclosures = {}) {
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
      nft: identity.nft || publicIdentityNft(identity),
      hasPublicProfile: Boolean(accountId && publicProfileIds.has(accountId)),
      operatorDisclosure: accountId ? operatorDisclosures[accountId] || null : null,
    });
  }
  return identities;
}

export function enrichContributorWithWalletIdentity(contributor = {}, identity = null) {
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
  contributor.nft = contributor.nft || identity?.nft || null;
  contributor.operatorDisclosure = identity?.operatorDisclosure || contributor.operatorDisclosure || null;
  return contributor;
}

export function enrichTaskWithWalletIdentity(task = {}, identity = null) {
  task.assigneeAccountId = identity?.accountId || task.assigneeAccountId || "";
  task.assigneeHasPublicProfile = Boolean(identity?.hasPublicProfile);
  task.assigneeHandle = identity?.hiveHandle || task.assigneeHandle || "";
  task.assigneeDisplayName = identity?.displayName || task.assigneeDisplayName || "";
  task.assigneeNft = task.assigneeNft || identity?.nft || null;
  task.assigneeOperatorDisclosure = identity?.operatorDisclosure || task.assigneeOperatorDisclosure || null;
  return task;
}

export function enrichActivityWithWalletIdentity(entry = {}, identity = null) {
  entry.accountId = identity?.accountId || entry.accountId || "";
  entry.hasPublicProfile = Boolean(identity?.hasPublicProfile);
  entry.hiveHandle = identity?.hiveHandle || entry.hiveHandle || "";
  entry.displayName = identity?.displayName || entry.displayName || "";
  entry.operatorDisclosure = identity?.operatorDisclosure || entry.operatorDisclosure || null;
  return entry;
}

export function applyWalletIdentitiesToProjects(projects = {}, walletIdentities = [], publicProfileIds = new Set(), operatorDisclosures = {}) {
  const identities = walletIdentityMap(walletIdentities, publicProfileIds, operatorDisclosures);
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

export function publicProject(row = {}) {
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
    comments: [],
  };
}

export function publicContributor(row = {}) {
  return {
    wallet: safeText(row.wallet_address, 120),
    accountId: "",
    hasPublicProfile: false,
    operatorDisclosure: null,
    codename: safeText(row.codename, 120),
    displayName: "",
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

export function publicTask(row = {}) {
  const projectedReward = row.projected_reward_pft ?? row.reward_pft;
  const state = safeText(row.projected_status || row.state, 80) || "proposed";
  const rewardProofState = ["rewarded", "paid"].includes(state.toLowerCase());
  const proofTxHash = rewardProofState ? safeText(row.last_event_tx_hash || row.proof_tx_hash || row.tx_hash, 240) : "";
  const proofCid = rewardProofState ? safeText(row.last_event_cid || row.proof_cid || row.cid, 240) : "";
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
    assigneeAccountId: safeText(row.projected_account_id || row.account_id || row.assignee_account_id, 180),
    assigneeHasPublicProfile: false,
    assigneeHandle: "",
    assigneeDisplayName: "",
    assigneeOperatorDisclosure: emptyOperatorDisclosure(),
    pft: numeric(projectedReward),
    nextAction: taskNextAction(state),
    age: safeText(row.age_label, 80),
    source: safeText(row.source, 100),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.projected_updated_at || row.updated_at),
    proofTxHash,
    proofCid,
    assigneeNft,
    statusPacket: deriveNetworkTaskStatusPacketFromRow(row),
  };
}

export function publicActivity(row = {}) {
  const metadata = safeObject(row.metadata_json);
  return {
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    wallet: safeText(row.wallet_address, 120),
    taskId: safeText(row.task_id || metadata.taskId || metadata.task_id, 180),
    accountId: "",
    hasPublicProfile: false,
    hiveHandle: "",
    displayName: "",
    operatorDisclosure: null,
    action: safeText(row.action, 80),
    task: safeText(row.task_title, 240),
    time: safeText(row.time_label, 80),
    pft: row.pft_amount === null || row.pft_amount === undefined ? null : numeric(row.pft_amount),
    nextAction: taskNextAction(row.action),
    routing: safeText(row.routing_label, 120),
    proofTxHash: safeText(metadata.proofTxHash || metadata.rewardTxHash || metadata.txHash || metadata.sourceTxHash || metadata.source_tx_hash, 240),
    proofCid: safeText(metadata.proofCid || metadata.rewardCid || metadata.cid || metadata.sourceCid || metadata.source_cid, 240),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function operatorMap(projects = {}) {
  const operators = {};
  for (const project of Object.values(projects)) {
    for (const contributor of safeArray(project.contributors)) {
      if (!contributor.wallet) continue;
      const operator = {
        codename: contributor.codename || "Operator",
        displayName: contributor.displayName || "",
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
        operatorDisclosure: contributor.operatorDisclosure || null,
      };
      operators[contributor.wallet] = operators[contributor.wallet]
        ? mergeContributor(operators[contributor.wallet], operator)
        : operator;
    }
  }
  return operators;
}

export function taskNextAction(state = "") {
  const normalized = safeText(state, 80).toLowerCase();
  if (normalized === "accepted") return "Complete the task and submit evidence for review.";
  if (normalized === "verification_requested") return "Answer the reviewer follow-up with the missing verification detail.";
  if (normalized === "verification_response_submitted") return "Wait for review or prepare any final clarification.";
  if (normalized === "submitted") return "Wait for review, then respond quickly if verification is requested.";
  if (normalized === "proposed") return "Open the task and accept or refuse it before the deadline.";
  if (normalized === "reward_decided") return "Wait for the terminal reward outcome to settle.";
  if (["rewarded", "paid"].includes(normalized)) return "Reward paid. View proof, copy the tx, or request another task.";
  if (["refused", "cancelled", "rejected", "expired"].includes(normalized)) return "Task is stopped; wait for a new routed task if more work is needed.";
  return "Open the project task row and inspect the latest state.";
}

export function taskStateRank(state = "") {
  return activeTaskStateRank.get(safeText(state, 80).toLowerCase()) || 0;
}

export function taskIsInFlight(task = {}) {
  return taskStateRank(task.state) > 0;
}

export function taskIsTerminal(task = {}) {
  return terminalTaskStates.has(safeText(task.state, 80).toLowerCase());
}

export function taskIsNextCandidate(task = {}) {
  return Boolean(task?.taskId && taskStateRank(task.state) > 0);
}

export function compareNextTask(left = {}, right = {}, viewer = {}) {
  const leftRelation = viewerTaskRelation(left, viewer);
  const rightRelation = viewerTaskRelation(right, viewer);
  const leftViewerRank = leftRelation === "active" ? 0 : leftRelation === "offer" ? 1 : 2;
  const rightViewerRank = rightRelation === "active" ? 0 : rightRelation === "offer" ? 1 : 2;
  if (leftViewerRank !== rightViewerRank) return leftViewerRank - rightViewerRank;
  const leftRank = taskStateRank(left.state);
  const rightRank = taskStateRank(right.state);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (numeric(right.rewardPft || right.pft) !== numeric(left.rewardPft || left.pft)) {
    return numeric(right.rewardPft || right.pft) - numeric(left.rewardPft || left.pft);
  }
  return timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
}

export function projectNextTask(project = {}, viewer = {}) {
  const task = safeArray(project.tasks)
    .filter(taskIsNextCandidate)
    .sort((left, right) => compareNextTask(left, right, viewer))[0] || null;
  if (!task) return null;
  const viewerRelation = viewerTaskRelation(task, viewer);
  return {
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    viewerScoped: Boolean(viewerRelation),
    viewerRelation,
    viewerActive: viewerRelation === "active",
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

export function deriveContributorFromTask(project = {}, task = {}) {
  const wallet = safeText(task.assignee, 120);
  if (!wallet) return null;
  const taskState = safeText(task.state, 80).toLowerCase();
  const paidPft = taskState === "rewarded" ? numeric(task.pft) : 0;
  const activeLoad = taskIsInFlight(task) ? 1 : 0;
  const identityLabel = task.assigneeDisplayName || (task.assigneeHandle ? `@${safeText(task.assigneeHandle, 80).replace(/^@+/, "")}` : "");
  return {
    wallet,
    accountId: task.assigneeAccountId || "",
    hasPublicProfile: Boolean(task.assigneeHasPublicProfile),
    codename: identityLabel || compactWallet(wallet),
    displayName: task.assigneeDisplayName || "",
    hiveHandle: task.assigneeHandle || "",
    publicDisplayName: task.assigneeDisplayName || "",
    archetype: "Network task contributor",
    badge: 0,
    allotted: true,
    cap: Math.max(1, activeLoad),
    load: activeLoad,
    status: activeLoad > 0 ? "active" : "settled",
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

export function mergeContributor(left = {}, right = {}) {
  const pft = numeric(left.pft) + numeric(right.pft);
  const tasks = intValue(left.tasks) + intValue(right.tasks);
  const load = intValue(left.load) + intValue(right.load);
  const cap = Math.max(intValue(left.cap), intValue(right.cap), load, 1);
  const status = load > 0 || left.status === "active" || right.status === "active"
    ? "active"
    : (left.status || right.status || "settled");
  const currentTasks = [...safeArray(left.currentTasks), ...safeArray(right.currentTasks)]
    .filter((task, index, list) => (
      task?.taskId &&
      list.findIndex((item) => item?.taskId === task.taskId) === index
    ))
    .sort(compareNextTask);
  return {
    ...left,
    codename: left.codename || right.codename,
    displayName: left.displayName || right.displayName || "",
    archetype: left.archetype || right.archetype,
    badge: intValue(left.badge) || intValue(right.badge),
    allotted: Boolean(left.allotted || right.allotted),
    cap,
    load,
    status,
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
    operatorDisclosure: left.operatorDisclosure || right.operatorDisclosure || null,
  };
}

export function actionForTaskState(state = "") {
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

export function deriveActivityFromTask(project = {}, task = {}) {
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
    proofTxHash: action === "rewarded" ? task.proofTxHash || "" : "",
    proofCid: action === "rewarded" ? task.proofCid || "" : "",
    project: project.name,
    derived: true,
    createdAt: task.createdAt || "",
    updatedAt: task.updatedAt || task.createdAt || "",
  };
}

export function populateDerivedProjectRollups(projects = {}, viewer = {}) {
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
    project.activity = safeArray(project.activity)
      .sort((left, right) =>
        timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
        safeText(right.id).localeCompare(safeText(left.id))
      )
      .slice(0, maxProjectActivityRows);
    project.taskCount = project.tasks.length;
    project.tasksInFlight = project.tasks.filter(taskIsInFlight).length;
    project.terminalTaskCount = project.tasks.filter(taskIsTerminal).length;
    project.contributorCount = project.contributors.length;
    project.pft = numeric(project.tasks.reduce((sum, task) => sum + numeric(task.pft), 0));
    project.nextTask = projectNextTask(project, viewer);
  }
}

export function projectHasOperatorPin(project = {}) {
  const metadata = safeObject(project.metadata);
  return Boolean(
    metadata.operator_pinned === true ||
    metadata.operator_pin === true ||
    metadata.board_pinned === true ||
    metadata.pin_source === "operator"
  );
}

export function projectHasBoardEvidence(project = {}) {
  return (
    safeArray(project.tasks).length > 0 ||
    safeArray(project.contributors).some((contributor) => safeText(contributor.status, 80) !== "archived") ||
    intValue(project.pendingGenerationCount) > 0 ||
    projectHasOperatorPin(project)
  );
}

export function projectVisibleOnActiveBoard(project = {}, { includeEmptyActive = false } = {}) {
  if (projectHasOperatorArchiveLock({ metadata_json: project.metadata })) return false;
  const status = safeText(project.status, 80);
  if (status !== "active") return false;
  if (includeEmptyActive && status === "active") return true;
  if (!projectHasBoardEvidence(project)) return false;
  return true;
}

export function visiblePublicProject(project = {}) {
  return Object.fromEntries(Object.entries(project).filter(([key]) => key !== "metadata"));
}

export function projectArchivedForIndex(project = {}) {
  const status = safeText(project.status, 80).toLowerCase();
  return status === "archived" || projectHasOperatorArchiveLock({ metadata_json: project.metadata });
}

export function archivedBoardIndexEntry(project = {}) {
  const metadata = safeObject(project.metadata);
  const archivedAt = safeText(
    metadata.archived_at ||
      metadata.archive_at ||
      metadata.archive_lock_applied_at ||
      metadata.operator_archived_at ||
      "",
    80
  );
  const archivedReason = safeText(
    metadata.archived_reason ||
      metadata.archive_reason ||
      metadata.archive_lock_reason ||
      metadata.operator_archive_reason ||
      "",
    500
  );
  const latestActivity = safeArray(project.activity)[0] || {};
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    typeKey: project.typeKey,
    summary: project.summary,
    status: "archived",
    priority: intValue(project.priority),
    pft: numeric(project.pft),
    taskCount: intValue(project.taskCount),
    tasksInFlight: intValue(project.tasksInFlight),
    terminalTaskCount: intValue(project.terminalTaskCount),
    contributorCount: intValue(project.contributorCount),
    pendingGenerationCount: intValue(project.pendingGenerationCount),
    archivedAt,
    archivedReason,
    operatorArchiveLock: projectHasOperatorArchiveLock({ metadata_json: metadata }),
    lastActivityAt: latestActivity.updatedAt || latestActivity.createdAt || "",
  };
}

export function documentFromRows({
  projectRows = [],
  contributorRows = [],
  taskRows = [],
  activityRows = [],
  pendingGenerationRows = [],
  projectCommentsByProject = {},
  productDocs = [],
  boardSecretaryMemos = [],
  latestSecretary = null,
  projectPlanning = null,
  walletIdentities = [],
  publicProfileIds = new Set(),
  operatorDisclosures = {},
  includeEmptyActive = false,
  viewerAccountId = "",
  viewerWalletAddress = "",
} = {}) {
  const viewer = viewerContext({ accountId: viewerAccountId, walletAddress: viewerWalletAddress });
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
  for (const memo of safeArray(boardSecretaryMemos)) {
    const project = projects[memo.projectId];
    if (project) project.secretaryMemo = memo;
  }
  for (const [projectId, comments] of Object.entries(safeObject(projectCommentsByProject))) {
    const project = projects[projectId];
    if (project) project.comments = safeArray(comments);
  }
  applyWalletIdentitiesToProjects(projects, walletIdentities, publicProfileIds, operatorDisclosures);
  populateDerivedProjectRollups(projects, viewer);

  const visibleProjects = Object.fromEntries(
    Object.values(projects)
      .filter((project) => projectVisibleOnActiveBoard(project, { includeEmptyActive }))
      .map((project) => [project.id, visiblePublicProject(project)])
  );
  const projectIds = Object.values(visibleProjects)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map((project) => project.id);
  const archivedBoards = Object.values(projects)
    .filter(projectArchivedForIndex)
    .map(archivedBoardIndexEntry)
    .sort((a, b) =>
      timestampMs(b.archivedAt || b.lastActivityAt) - timestampMs(a.archivedAt || a.lastActivityAt) ||
      a.priority - b.priority ||
      a.name.localeCompare(b.name)
    )
    .slice(0, 80);
  const archivedProjects = Object.fromEntries(archivedBoards.map((project) => [project.id, project]));
  const archivedProjectIds = archivedBoards.map((project) => project.id);
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
  const taskRowCount = Object.values(visibleProjects).reduce((sum, project) => sum + safeArray(project.tasks).length, 0);
  const tasksInFlight = Object.values(visibleProjects).reduce((sum, project) => sum + intValue(project.tasksInFlight), 0);
  const terminalTaskRows = Object.values(visibleProjects).reduce((sum, project) => sum + intValue(project.terminalTaskCount), 0);
  const pftRouted = Object.values(visibleProjects).reduce((sum, project) => sum + numeric(project.pft), 0);

  return {
    generatedAt: new Date().toISOString(),
    projectIds,
    archivedProjectIds,
    projects: visibleProjects,
    archivedProjects,
    operators,
    routingFeed,
    stats: {
      activeProjects: projectIds.length,
      archivedProjects: archivedProjectIds.length,
      operatorsOnline: activeOperators,
      tasksInFlight,
      taskRows: taskRowCount,
      terminalTaskRows,
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


export function publicIdentityNft(row = {}) {
  const imageCid = safeText(row.hero_nft_image_cid || row.image_cid, 180);
  const imageGatewayUrl = safeText(row.hero_nft_image_gateway_url || row.image_gateway_url, 500);
  if (!imageCid && !imageGatewayUrl) return null;
  return {
    title: safeText(row.hero_nft_title || row.title, 180),
    status: safeText(row.hero_nft_status || row.status, 80),
    imageCid,
    imageGatewayUrl,
  };
}

export function hiveWalletsFromRows({
  contributorRows = [],
  taskRows = [],
  activityRows = [],
} = {}) {
  const wallets = new Set();
  for (const row of safeArray(contributorRows)) {
    const wallet = safeText(row.wallet_address, 160);
    if (wallet) wallets.add(wallet);
  }
  for (const row of safeArray(taskRows)) {
    for (const value of [row.projected_subject_wallet, row.subject_wallet, row.assignee_wallet]) {
      const wallet = safeText(value, 160);
      if (wallet) wallets.add(wallet);
    }
  }
  for (const row of safeArray(activityRows)) {
    const wallet = safeText(row.wallet_address, 160);
    if (wallet) wallets.add(wallet);
  }
  return [...wallets];
}

export function hiveWalletAccountsFromRows({ taskRows = [] } = {}) {
  const pairs = [];
  const seen = new Set();
  for (const row of safeArray(taskRows)) {
    const wallet = safeText(row.projected_subject_wallet || row.subject_wallet || row.assignee_wallet, 160);
    const accountId = safeText(row.projected_account_id || row.account_id || row.assignee_account_id, 180);
    const key = `${wallet.toLowerCase()}:${accountId}`;
    if (!wallet || !accountId || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ walletAddress: wallet, accountId });
  }
  return pairs;
}

export function mergeWalletIdentity(left = {}, right = {}) {
  const walletAddress = safeText(left.walletAddress || left.wallet_address || right.walletAddress || right.wallet_address, 160);
  return {
    ...left,
    ...right,
    accountId: safeText(left.accountId || left.account_id || right.accountId || right.account_id, 180),
    walletAddress,
    displayName: safeText(left.displayName || left.display_name || right.displayName || right.display_name, 120),
    hiveHandle: safeText(left.hiveHandle || left.hive_handle || right.hiveHandle || right.hive_handle, 80),
    publicDisplayName: safeText(left.publicDisplayName || left.public_display_name || right.publicDisplayName || right.public_display_name, 120),
    publicAliases: safeArray(left.publicAliases || left.public_aliases).length
      ? safeArray(left.publicAliases || left.public_aliases)
      : safeArray(right.publicAliases || right.public_aliases),
    publicTrustBadges: safeArray(left.publicTrustBadges || left.public_trust_badges).length
      ? safeArray(left.publicTrustBadges || left.public_trust_badges)
      : safeArray(right.publicTrustBadges || right.public_trust_badges),
    nft: left.nft || right.nft || publicIdentityNft(left) || publicIdentityNft(right),
  };
}

export function mergeWalletIdentityLists(...lists) {
  const byWallet = new Map();
  for (const identity of lists.flatMap((list) => safeArray(list))) {
    const wallet = safeText(identity.walletAddress || identity.wallet_address || identity.wallet, 160);
    const key = walletIdentityKey(wallet);
    if (!key) continue;
    const normalized = { ...identity, walletAddress: wallet };
    byWallet.set(key, byWallet.has(key) ? mergeWalletIdentity(byWallet.get(key), normalized) : normalized);
  }
  return [...byWallet.values()];
}

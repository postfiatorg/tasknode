// Pure view-model for the Network Task Eligibility panel.
//
// `server/repositories/tasks.js::listTaskState` already attaches the full
// `getNetworkTaskEligibility` payload as `tasks.networkTasks`, so this module
// only derives display state. It must never trigger reads or observability
// writes of its own; the panel renders whatever the existing task poll
// already fetched.

function cleanText(value) {
  return String(value || "").trim();
}

export function shortWalletAddress(address) {
  const text = cleanText(address);
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

// Plain-language eligibility labels from
// docs/wiki/plans/task-node-production-scope.md (P0-5). Only server statuses
// that exist in getNetworkTaskEligibility/listTaskState are mapped here;
// `validation task needed` and `operator hold` have no server status yet and
// must not be invented client-side. `no suitable task right now` is the
// eligible-but-not-routed explanation, not a separate status.
const PLAIN_STATUS = {
  available_for_routing: {
    label: "Eligible",
    tone: "ok",
    explanation: "If no Network Task arrives, there is no suitable task right now — Hive Board Manager routes work when an active project needs it.",
  },
  at_capacity: {
    label: "Capacity blocked",
    tone: "blocked",
    explanation: "An active Network Task is already consuming this account's Network Task capacity.",
  },
  profile_required: {
    label: "Needs more task history",
    tone: "action",
    explanation: "Your Network Diagnostic Report has not been generated yet; it is queued automatically after your second positively rewarded task, or immediately when you open Memory.",
  },
  badge_required: {
    label: "Capacity blocked",
    tone: "blocked",
    explanation: "Network Task routing needs a verified operating badge. Open Profile to qualify for KOL, Core Contributor, QA Worker, Expert, or Project Leader.",
  },
  profile_pending: {
    label: "Needs more task history",
    tone: "pending",
    explanation: "Your Network Diagnostic Report is queued or processing; routing resumes evaluation when it completes.",
  },
  profile_failed: {
    label: "Needs more task history",
    tone: "action",
    explanation: "The last Network Diagnostic Report job failed, so Board Manager has no routing profile for this account.",
  },
  wallet_sync_pending: {
    label: "Wallet sync in progress",
    tone: "pending",
    explanation: "Task Node has not finished indexing the linked wallet as an active user wallet yet.",
  },
  setup_required: {
    label: "Wallet link needed",
    tone: "action",
    explanation: "Network Tasks are wallet-bound, so routing needs a linked PFT wallet first.",
  },
  sign_in_required: {
    label: "Sign in required",
    tone: "action",
    explanation: "Network Task routing is account-scoped, so eligibility can only be evaluated for a signed-in account.",
  },
  unavailable: {
    label: "Eligibility unavailable",
    tone: "unavailable",
    explanation: "Task Node could not inspect Network Task routing state right now.",
  },
};

export function plainEligibilityStatus(status = "") {
  const key = cleanText(status);
  const mapped = PLAIN_STATUS[key];
  if (mapped) return { status: key, ...mapped };
  return {
    status: key || "unknown",
    ...PLAIN_STATUS.unavailable,
    explanation: "Task Node returned an eligibility state this app version does not recognize.",
  };
}

const GATE_FAILING_STATUSES = new Set(["pending", "action_required", "blocked"]);

export function eligibilityGateView(gate = {}) {
  const status = cleanText(gate.status);
  return {
    id: cleanText(gate.id),
    label: cleanText(gate.label) || "Eligibility gate",
    status,
    passed: status === "complete",
    waiting: status === "waiting",
    failing: GATE_FAILING_STATUSES.has(status),
    detail: cleanText(gate.detail),
    action: cleanText(gate.action),
  };
}

export function firstFailingGate(gates = []) {
  return (Array.isArray(gates) ? gates : [])
    .map(eligibilityGateView)
    .find((gate) => gate.failing) || null;
}

const BLOCKER_KIND_LABELS = {
  allocation: "Allocation",
  generation_job: "Generation job",
  proposed_task: "Proposed task",
};

export function capacityBlockerView(blocker = {}) {
  const walletAddress = cleanText(blocker.walletAddress);
  return {
    key: cleanText(blocker.allocationId || blocker.taskId || blocker.generationJobId) || "blocker",
    title: cleanText(blocker.title) || cleanText(blocker.taskId) || "Network Task",
    taskId: cleanText(blocker.taskId),
    state: cleanText(blocker.state || blocker.allocationStatus) || "active",
    kind: cleanText(blocker.kind),
    kindLabel: BLOCKER_KIND_LABELS[cleanText(blocker.kind)] || "Network Task",
    accountScoped: !walletAddress,
    // "" walletAddress means the blocker is account-scoped (candidate wallet
    // not assigned yet); anything else is wallet-bound.
    scopeLabel: walletAddress ? shortWalletAddress(walletAddress) : "account-wide",
  };
}

const BADGE_LABELS = {
  kol: "KOL",
  core_contributor: "Core Contributor",
  expert: "Expert",
  project_leader: "Project Leader",
  qa_worker: "QA Worker",
};

export function badgeEligibilityView(badgeEligibility = {}) {
  const badgeIds = (Array.isArray(badgeEligibility?.verifiedBadgeIds) ? badgeEligibility.verifiedBadgeIds : [])
    .map(cleanText)
    .filter(Boolean);
  const defaultBadge = cleanText(badgeEligibility?.defaultBadge) || badgeIds[0] || "";
  const defaultLabel = BADGE_LABELS[defaultBadge] || defaultBadge;
  return {
    present: Boolean(badgeEligibility && typeof badgeEligibility === "object"),
    status: cleanText(badgeEligibility?.status || (badgeIds.length ? "available" : "unknown")),
    badgeIds,
    defaultBadge,
    defaultLabel,
    hasNonAnonOperatingBadge: badgeEligibility?.hasNonAnonOperatingBadge === true || badgeIds.length > 0,
    allowedWorkTypes: (Array.isArray(badgeEligibility?.allowedWorkTypes) ? badgeEligibility.allowedWorkTypes : [])
      .map(cleanText)
      .filter(Boolean),
    summary: cleanText(badgeEligibility?.summary),
    error: cleanText(badgeEligibility?.error),
    laneLabel: defaultLabel
      ? defaultLabel
      : "",
  };
}

export function networkTaskEligibilityView(networkTasks = null) {
  if (!networkTasks || typeof networkTasks !== "object") {
    return {
      ready: false,
      loading: true,
      eligible: false,
      status: "loading",
      plainLabel: "Checking eligibility",
      tone: "pending",
      explanation: "Network Task eligibility has not loaded yet.",
      walletLabel: "",
      walletAddress: "",
      nextAction: "",
      gates: [],
      blockers: [],
      badge: badgeEligibilityView(null),
      expandedByDefault: false,
      error: "",
    };
  }

  const plain = plainEligibilityStatus(networkTasks.status);
  const gates = (Array.isArray(networkTasks.gates) ? networkTasks.gates : []).map(eligibilityGateView);
  const failingGate = gates.find((gate) => gate.failing) || null;
  const blockers = (Array.isArray(networkTasks?.capacity?.blockers) ? networkTasks.capacity.blockers : [])
    .map(capacityBlockerView);
  const badge = badgeEligibilityView(networkTasks.badgeEligibility);
  const eligible = plain.status === "available_for_routing";
  const unavailable = plain.tone === "unavailable";
  const walletAddress = cleanText(networkTasks.walletAddress);
  return {
    ready: true,
    loading: false,
    eligible,
    status: plain.status,
    plainLabel: plain.label,
    tone: plain.tone,
    explanation: plain.explanation,
    walletLabel: walletAddress ? shortWalletAddress(walletAddress) : "No wallet linked",
    walletAddress,
    // Prefer the failing gate's action copy from the server, then the
    // server's overall nextAction.
    nextAction: failingGate?.action || cleanText(networkTasks.nextAction),
    gates,
    blockers,
    badge,
    expandedByDefault: !eligible && !unavailable,
    error: cleanText(networkTasks.error),
  };
}

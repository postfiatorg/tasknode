import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  badgeEligibilityView,
  activeCapacityBlockerTaskIds,
  capacityBlockerView,
  eligibilityGateView,
  firstActiveCapacityBlockerTaskId,
  firstFailingGate,
  networkTaskEligibilityView,
  plainEligibilityStatus,
  shortWalletAddress,
} from "../src/features/tasks/network-task-eligibility-state.js";

// 1. Every server eligibility status maps to the right plain-language label.
// Statuses come from server/repositories/network-tasks.js::getNetworkTaskEligibility
// plus the listTaskState error fallback; plain labels come from
// docs/wiki/plans/task-node-production-scope.md (P0-5).
const expectedLabels = {
  available_for_routing: "Eligible",
  at_capacity: "Capacity blocked",
  profile_required: "Needs more task history",
  badge_required: "Capacity blocked",
  profile_pending: "Needs more task history",
  profile_failed: "Needs more task history",
  wallet_sync_pending: "Wallet sync in progress",
  setup_required: "Wallet link needed",
  sign_in_required: "Sign in required",
  unavailable: "Eligibility unavailable",
};
for (const [status, label] of Object.entries(expectedLabels)) {
  assert.equal(plainEligibilityStatus(status).label, label, `status ${status} label`);
}
assert.equal(plainEligibilityStatus("available_for_routing").tone, "ok");
assert.equal(plainEligibilityStatus("at_capacity").tone, "blocked");
assert.equal(plainEligibilityStatus("badge_required").tone, "blocked");
assert.equal(plainEligibilityStatus("unavailable").tone, "unavailable");
// Unknown statuses fall back to an honest unavailable label, never a guess.
assert.equal(plainEligibilityStatus("operator_hold_someday").label, "Eligibility unavailable");
assert.match(plainEligibilityStatus("operator_hold_someday").explanation, /does not recognize/);
// Eligible explanation carries the "no suitable task right now" language.
assert.match(plainEligibilityStatus("available_for_routing").explanation, /no suitable task right now/);

// 2. Wallet shortening matches the app-wide prefix style.
assert.equal(shortWalletAddress("rPo8abcd1234efgh5678ijkx"), "rPo8abcd...78ijkx");
assert.equal(shortWalletAddress("rShortAddr"), "rShortAddr");
assert.equal(shortWalletAddress(""), "");
assert.equal(shortWalletAddress("rNetCapCurrent1765432100000"), "rNetCapC...100000");

// 3. Blocker rendering data: wallet prefix vs account-wide, title fallback.
const walletBlocker = capacityBlockerView({
  kind: "allocation",
  taskId: "task_abc",
  title: "Audit the capacity panel",
  state: "accepted",
  allocationStatus: "accepted",
  rewardOfferPft: "12000.000000",
  acceptBy: "2026-06-28T12:30:00.000Z",
  walletAddress: "rNetCapCurrent1765432100000",
  allocationId: "alloc_1",
});
assert.equal(walletBlocker.scopeLabel, "rNetCapC...100000");
assert.equal(walletBlocker.accountScoped, false);
assert.equal(walletBlocker.kindLabel, "Allocation");
assert.equal(walletBlocker.title, "Audit the capacity panel");
assert.equal(walletBlocker.state, "accepted");
assert.equal(walletBlocker.rewardLabel, "12,000 PFT");
assert.equal(walletBlocker.acceptBy, "2026-06-28T12:30:00.000Z");
assert.equal(walletBlocker.dueLabel, "Accept by");
assert.match(walletBlocker.dueDisplay, /Jun 28/);
assert.match(walletBlocker.acceptByDisplay, /Jun 28/);

const accountBlocker = capacityBlockerView({
  kind: "generation_job",
  taskId: "",
  title: "",
  state: "queued",
  walletAddress: "",
  generationJobId: "job_9",
});
assert.equal(accountBlocker.scopeLabel, "account-wide");
assert.equal(accountBlocker.accountScoped, true);
assert.equal(accountBlocker.kindLabel, "Generation job");
assert.equal(accountBlocker.title, "Network Task");

const titleFallbackBlocker = capacityBlockerView({
  kind: "proposed_task",
  taskId: "task_no_title",
  title: "",
  state: "proposed",
  walletAddress: "rWalletWithProposedTask001",
});
assert.equal(titleFallbackBlocker.title, "task_no_title");
assert.equal(titleFallbackBlocker.kindLabel, "Proposed task");

// 4. Gate views and first-failing-gate selection.
const gates = [
  { id: "wallet", label: "Linked PFT wallet", status: "complete", detail: "linked", action: "" },
  { id: "wallet_sync", label: "Wallet indexed by Task Node", status: "complete", detail: "synced", action: "" },
  { id: "routing_profile", label: "Network Diagnostic Report", status: "action_required", detail: "missing", action: "Open Memory and refresh the Network Diagnostic Report" },
  { id: "capacity", label: "Network Task capacity", status: "complete", detail: "free", action: "" },
  { id: "board_routing", label: "Hive Board Manager routing", status: "blocked", detail: "waits on gates", action: "" },
];
const failing = firstFailingGate(gates);
assert.equal(failing.id, "routing_profile");
assert.equal(failing.action, "Open Memory and refresh the Network Diagnostic Report");
assert.equal(eligibilityGateView(gates[0]).passed, true);
assert.equal(eligibilityGateView({ status: "waiting" }).waiting, true);
assert.equal(eligibilityGateView({ status: "waiting" }).failing, false);
assert.equal(eligibilityGateView({ status: "pending" }).failing, true);

const missingBadge = badgeEligibilityView({
  status: "missing",
  verifiedBadgeIds: [],
  defaultBadge: "",
  allowedWorkTypes: [],
  summary: "No verified Network Task operating badge was found.",
});
assert.equal(missingBadge.laneLabel, "");
assert.equal(missingBadge.hasNonAnonOperatingBadge, false);

const coreBadge = badgeEligibilityView({
  status: "available",
  verifiedBadgeIds: ["core_contributor"],
  defaultBadge: "core_contributor",
  allowedWorkTypes: ["code_task"],
  summary: "Verified Network Task lanes: Core Contributor.",
});
assert.equal(coreBadge.laneLabel, "Core Contributor");
assert.equal(coreBadge.hasNonAnonOperatingBadge, true);

// 5. Full view-model: not eligible expands by default and surfaces the
// failing gate's server action copy as the next action.
const blockedView = networkTaskEligibilityView({
  status: "profile_required",
  walletAddress: "rNetCapCurrent1765432100000",
  nextAction: "Open Memory and refresh the Network Diagnostic Report.",
  gates,
  capacity: { available: true, blockers: [] },
});
assert.equal(blockedView.eligible, false);
assert.equal(blockedView.expandedByDefault, true);
assert.equal(blockedView.plainLabel, "Needs more task history");
assert.equal(blockedView.walletLabel, "rNetCapC...100000");
assert.equal(blockedView.nextAction, "Open Memory and refresh the Network Diagnostic Report");

// 6. Eligible view stays compact.
const eligibleView = networkTaskEligibilityView({
  status: "available_for_routing",
  walletAddress: "rNetCapCurrent1765432100000",
  nextAction: "No manual request is needed.",
  gates: gates.map((gate) => ({ ...gate, status: gate.id === "board_routing" ? "waiting" : "complete", action: "" })),
  capacity: { available: true, blockers: [] },
  badgeEligibility: {
    status: "available",
    verifiedBadgeIds: ["core_contributor"],
    defaultBadge: "core_contributor",
    summary: "Verified Network Task lanes: Core Contributor.",
  },
});
assert.equal(eligibleView.eligible, true);
assert.equal(eligibleView.expandedByDefault, false);
assert.equal(eligibleView.plainLabel, "Eligible");
assert.equal(eligibleView.badge.laneLabel, "Core Contributor");
assert.match(eligibleView.explanation, /no suitable task right now/);

// 7. Capacity-blocked view carries blocker rows.
const capacityView = networkTaskEligibilityView({
  status: "at_capacity",
  walletAddress: "rNetCapCurrent1765432100000",
  nextAction: "Finish or close the active Network Task before another Network Task can be routed.",
  gates: [],
  capacity: {
    available: false,
    blockers: [
      { kind: "allocation", taskId: "task_busy", title: "Busy task", state: "accepted", walletAddress: "rNetCapCurrent1765432100000" },
      { kind: "generation_job", taskId: "", title: "", state: "queued", walletAddress: "" },
    ],
  },
});
assert.equal(capacityView.plainLabel, "Capacity blocked");
assert.equal(capacityView.blockers.length, 2);
assert.equal(capacityView.blockers[0].scopeLabel, "rNetCapC...100000");
assert.equal(capacityView.blockers[1].scopeLabel, "account-wide");
assert.deepEqual(activeCapacityBlockerTaskIds({
  status: "at_capacity",
  capacity: {
    available: false,
    blockers: [
      { kind: "allocation", taskId: "task_busy", title: "Busy task", state: "accepted", walletAddress: "rNetCapCurrent1765432100000" },
      { kind: "generation_job", taskId: "", title: "", state: "queued", walletAddress: "" },
      { kind: "proposed_task", taskId: "task_busy", title: "Busy task", state: "proposed", walletAddress: "rNetCapCurrent1765432100000" },
    ],
  },
}), ["task_busy"]);
assert.equal(firstActiveCapacityBlockerTaskId({
  status: "at_capacity",
  capacity: { available: false, blockers: [{ kind: "allocation", taskId: "task_busy" }] },
}), "task_busy");
assert.deepEqual(activeCapacityBlockerTaskIds({
  status: "available_for_routing",
  capacity: { available: true, blockers: [{ kind: "allocation", taskId: "task_ready" }] },
}), []);

// 8. Unavailable and missing data stay honest, with the server error visible
// and no default expansion of a checklist that cannot be trusted.
const unavailableView = networkTaskEligibilityView({
  status: "unavailable",
  label: "Network task routing unavailable",
  summary: "Task Node could not inspect Network Task routing state.",
  nextAction: "Try again after task state reloads.",
  error: "database timeout",
  gates: [],
});
assert.equal(unavailableView.plainLabel, "Eligibility unavailable");
assert.equal(unavailableView.tone, "unavailable");
assert.equal(unavailableView.error, "database timeout");
assert.equal(unavailableView.expandedByDefault, false);

const loadingView = networkTaskEligibilityView(null);
assert.equal(loadingView.loading, true);
assert.equal(loadingView.eligible, false);
assert.equal(loadingView.plainLabel, "Checking eligibility");
assert.equal(loadingView.gates.length, 0);

const signedOutView = networkTaskEligibilityView({
  status: "sign_in_required",
  walletAddress: "",
  nextAction: "Sign in with GitHub, email, Telegram, or X.",
  gates: [{ id: "account", label: "Signed-in account", status: "action_required", detail: "Network Task routing is account-scoped.", action: "Sign in" }],
});
assert.equal(signedOutView.plainLabel, "Sign in required");
assert.equal(signedOutView.walletLabel, "No wallet linked");
assert.equal(signedOutView.nextAction, "Sign in");


// 9. Panel source keeps capacity blocker identity/status + drops dual open-task navigation CTAs/props.
{
  const panelSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/features/tasks/NetworkTaskEligibilityPanel.jsx"), "utf8");
  assert.match(panelSource, /Capacity blockers/);
  assert.match(panelSource, /function BlockerRow/);
  // Concatenate so this smoke file itself is not a false-positive for removed-literal inventory greps.
  const banned = [
    "Continue" + " active task",
    "Open" + " active Network task",
    "onOpen" + "ActiveTask",
  ];
  for (const phrase of banned) {
    assert.equal(panelSource.includes(phrase), false, `panel still contains ${phrase}`);
  }
  assert.match(panelSource, /export function NetworkTaskEligibilityPanel\(\{\s*networkTasks = null\s*\}\)/);
  const mainSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/main.jsx"), "utf8");
  for (const phrase of banned) {
    assert.equal(mainSource.includes(phrase), false, `main still contains ${phrase}`);
  }
}

console.log("network-task-eligibility-panel-smoke ok");

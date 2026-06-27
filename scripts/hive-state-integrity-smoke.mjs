import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";

import {
  evaluateBoardManagerMessagePrecondition,
  guardBoardManagerMessageUserFreshness,
} from "../server/board-manager-actions.js";
import {
  extractReservationRatePft,
  formatHiveAccountLiveStateForPrompt,
} from "../server/repositories/hive-account-live-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    envFile: ".env.tasknodeofficial-dev",
    seedFile: process.env.TASKNODE_HIVE_STATE_SMOKE_SEED_FILE || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--env-file") args.envFile = argv[++index] || "";
    else if (entry === "--seed-file") args.seedFile = argv[++index] || "";
  }
  return args;
}

function loadEnvFile(relativeOrAbsolutePath) {
  if (!relativeOrAbsolutePath) return false;
  const envPath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(repoRoot, relativeOrAbsolutePath);
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

function readSeedFile(seedFile = "") {
  if (!seedFile) return [];
  const seedPath = path.isAbsolute(seedFile) ? seedFile : path.resolve(repoRoot, seedFile);
  if (!fs.existsSync(seedPath)) return [];
  return fs.readFileSync(seedPath, "utf8")
    .split(/\s|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectLocalSeeds({ seedFile = "" } = {}) {
  const names = [
    "TASKNODE_DAILY_AIRDROP_SEED",
    "TASKNODE_REWARD_SEED",
    "TASKNODE_ALLOCATION_SEED",
    "TASKNODE_AUTHORITY_SEED",
    "TASKNODE_SERVICE_SEED",
    "TASKNODE_ENCRYPTION_SEED",
    "TASKNODE_PFT_FAUCET_SEED",
    "FAUCET_SEED",
    "REWARD_WALLET_SEEDS",
  ];
  const values = [];
  for (const name of names) {
    const raw = process.env[name] || "";
    raw.split(",").map((item) => item.trim()).filter(Boolean).forEach((seed) => {
      values.push({ source: name, seed });
    });
  }
  readSeedFile(seedFile).forEach((seed) => values.push({ source: "seed_file", seed }));
  if (!values.length) {
    values.push({ source: "generated_fixture_seed", seed: Wallet.generate().seed });
  }
  return values;
}

function validateSeeds(seedInputs = []) {
  const valid = [];
  const invalid = [];
  for (const input of seedInputs) {
    try {
      const wallet = Wallet.fromSeed(input.seed);
      valid.push({
        source: input.source,
        addressPreview: `${wallet.classicAddress.slice(0, 6)}...${wallet.classicAddress.slice(-5)}`,
      });
    } catch (error) {
      invalid.push({ source: input.source, error: error?.message || String(error) });
    }
  }
  return { valid, invalid };
}

const args = parseArgs(process.argv.slice(2));
const envLoaded = loadEnvFile(args.envFile);

assert.equal(extractReservationRatePft("I repeatedly told you my reservation rate is 25k PFT."), 25_000);
assert.equal(extractReservationRatePft("I will not do Network Tasks below 30,000 PFT."), 30_000);

const refusedGuard = guardBoardManagerMessageUserFreshness({
  decision: {
    reason: "Nudge candidate to accept proposed Network Task",
    payload: {
      summary: "Please accept or decline Audit Contributor Reward Visibility Gaps.",
      next_steps: ["accept or decline"],
    },
  },
  messageText: "You have a proposed Network Task waiting: Audit Contributor Reward Visibility Gaps. Please accept or decline.",
  accountLiveState: {
    ok: true,
    digest: "digest_refused",
    networkTasks: [
      {
        taskId: "task_refused",
        allocationId: "netalloc_refused",
        title: "Audit Contributor Reward Visibility Gaps",
        taskStatus: "refused",
        allocationStatus: "refused",
        terminal: true,
        waitingForUser: false,
      },
    ],
    openFollowups: [],
    routingConstraints: {},
  },
});
assert.equal(refusedGuard.ok, false);
assert.equal(refusedGuard.reason, "board_manager_message_precondition_failed");
assert.equal(refusedGuard.precondition.reason, "board_manager_message_user_missing_structured_precondition");

const missingPreconditionGuard = guardBoardManagerMessageUserFreshness({
  decision: {
    reason: "Nudge candidate to accept proposed Network Task",
    payload: {
      summary: "Please accept or decline the proposed Network Task.",
      next_steps: ["accept or decline"],
    },
  },
  messageText: "Please accept or decline the proposed Network Task.",
  accountLiveState: {
    ok: true,
    digest: "digest_missing_precondition",
    networkTasks: [
      {
        taskId: "task_proposed",
        allocationId: "netalloc_proposed",
        title: "Review proposed task",
        taskStatus: "proposed",
        allocationStatus: "proposed",
        terminal: false,
        waitingForUser: true,
      },
    ],
    openFollowups: [],
    routingConstraints: {},
  },
});
assert.equal(missingPreconditionGuard.ok, false);
assert.equal(missingPreconditionGuard.reason, "board_manager_message_precondition_failed");
assert.equal(
  missingPreconditionGuard.precondition.reason,
  "board_manager_message_user_missing_structured_precondition"
);

const staleStructuredPreconditionGuard = guardBoardManagerMessageUserFreshness({
  decision: {
    reason: "Nudge candidate to accept proposed Network Task",
    payload: {
      summary: "Please accept or decline Audit Contributor Reward Visibility Gaps.",
      next_steps: ["accept or decline"],
      message_precondition: {
        intent: "task_acceptance_nudge",
        related_task_id: "task_refused",
        related_allocation_id: "netalloc_refused",
        expected_task_status: ["proposed"],
        expected_allocation_status: ["proposed"],
        expected_followup_status: "none_open",
        expected_min_reward_pft: 0,
        allow_terminal_task: false,
      },
    },
  },
  messageText: "Please accept or decline Audit Contributor Reward Visibility Gaps.",
  accountLiveState: {
    ok: true,
    digest: "digest_refused_structured",
    networkTasks: [
      {
        taskId: "task_refused",
        allocationId: "netalloc_refused",
        title: "Audit Contributor Reward Visibility Gaps",
        taskStatus: "refused",
        allocationStatus: "refused",
        terminal: true,
        waitingForUser: false,
      },
    ],
    openFollowups: [],
    routingConstraints: {},
  },
});
assert.equal(staleStructuredPreconditionGuard.ok, false);
assert.equal(staleStructuredPreconditionGuard.reason, "board_manager_message_precondition_failed");
assert.equal(
  staleStructuredPreconditionGuard.precondition.reason,
  "board_manager_message_precondition_terminal_task"
);

const satisfiedPreconditionGuard = guardBoardManagerMessageUserFreshness({
  decision: {
    reason: "Nudge candidate to accept proposed Network Task",
    payload: {
      summary: "Please accept or decline the proposed Network Task.",
      next_steps: ["accept or decline"],
      message_precondition: {
        intent: "task_acceptance_nudge",
        related_task_id: "task_live_proposed",
        related_allocation_id: "netalloc_live_proposed",
        expected_task_status: ["proposed"],
        expected_allocation_status: ["proposed"],
        expected_followup_status: "none_open",
        expected_min_reward_pft: 25_000,
        allow_terminal_task: false,
      },
    },
  },
  messageText: "Please accept or decline the proposed Network Task.",
  accountLiveState: {
    ok: true,
    digest: "digest_live_proposed",
    networkTasks: [
      {
        taskId: "task_live_proposed",
        allocationId: "netalloc_live_proposed",
        title: "Review proposed task",
        taskStatus: "proposed",
        allocationStatus: "proposed",
        rewardMaxPft: 30_000,
        terminal: false,
        waitingForUser: true,
      },
    ],
    openFollowups: [],
    routingConstraints: {},
  },
});
assert.equal(satisfiedPreconditionGuard.ok, true);
assert.equal(satisfiedPreconditionGuard.reason, "account_live_state_allows_message");

const openFollowupPrecondition = evaluateBoardManagerMessagePrecondition({
  decision: {
    payload: {
      message_precondition: {
        intent: "project_followup",
        project_id: "project_smoke",
        expected_followup_status: "none_open",
      },
    },
  },
  messageText: "Can you clarify the project priority?",
  accountLiveState: {
    ok: true,
    digest: "digest_open_followup",
    networkTasks: [],
    openFollowups: [
      {
        id: "followup_smoke",
        projectId: "project_smoke",
        status: "open",
      },
    ],
    routingConstraints: {},
  },
});
assert.equal(openFollowupPrecondition.ok, false);
assert.equal(openFollowupPrecondition.reason, "board_manager_message_precondition_open_followup");

const belowReservationGuard = guardBoardManagerMessageUserFreshness({
  decision: {
    reason: "Nudge candidate to accept proposed Network Task",
    payload: {
      summary: "Please accept or decline the proposed Network Task.",
      next_steps: ["accept or decline"],
      message_precondition: {
        intent: "task_acceptance_nudge",
        related_task_id: "task_15k",
        related_allocation_id: "netalloc_15k",
        expected_task_status: ["proposed"],
        expected_allocation_status: ["proposed"],
        expected_followup_status: "none_open",
        expected_min_reward_pft: 0,
        allow_terminal_task: false,
      },
    },
  },
  messageText: "Please accept or decline the proposed Network Task.",
  accountLiveState: {
    ok: true,
    digest: "digest_below_min",
    networkTasks: [
      {
        taskId: "task_15k",
        allocationId: "netalloc_15k",
        title: "Audit reward visibility",
        taskStatus: "proposed",
        allocationStatus: "proposed",
        rewardMaxPft: 15_000,
        terminal: false,
        waitingForUser: true,
      },
    ],
    openFollowups: [],
    routingConstraints: {
      reservationRate: { minPft: 25_000, sourceEntryId: "hivectx_rate" },
    },
  },
});
assert.equal(belowReservationGuard.ok, false);
assert.equal(belowReservationGuard.reason, "board_manager_message_user_below_reservation_rate");

const satisfiedReservationGuard = guardBoardManagerMessageUserFreshness({
  decision: {
    reason: "Route task that satisfies candidate minimum",
    payload: {
      summary: "This proposed Network Task is 30,000 PFT and satisfies your minimum.",
      next_steps: ["review the offer"],
      message_precondition: {
        intent: "task_acceptance_nudge",
        related_task_id: "task_30k",
        related_allocation_id: "netalloc_30k",
        expected_task_status: ["proposed"],
        expected_allocation_status: ["proposed"],
        expected_followup_status: "none_open",
        expected_min_reward_pft: 25_000,
        allow_terminal_task: false,
      },
    },
  },
  messageText: "This proposed Network Task is 30,000 PFT and satisfies your minimum.",
  accountLiveState: {
    ok: true,
    digest: "digest_30k",
    networkTasks: [
      {
        taskId: "task_30k",
        allocationId: "netalloc_30k",
        title: "Audit Task Node determinism",
        taskStatus: "proposed",
        allocationStatus: "proposed",
        rewardMaxPft: 30_000,
        terminal: false,
        waitingForUser: true,
      },
    ],
    openFollowups: [],
    routingConstraints: {
      reservationRate: { minPft: 25_000, sourceEntryId: "hivectx_rate" },
    },
  },
});
assert.equal(satisfiedReservationGuard.ok, true);

const promptText = formatHiveAccountLiveStateForPrompt({
  ok: true,
  status: "ready",
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  snapshotAt: "2026-05-31T00:00:00.000Z",
  networkTasks: [
    {
      taskId: "task_smoke",
      allocationId: "netalloc_smoke",
      title: "Smoke task",
      taskStatus: "proposed",
      allocationStatus: "proposed",
      rewardOfferPft: 12000,
      rewardMaxPft: 30_000,
      acceptBy: "2026-06-28T12:30:00.000Z",
      deadlineAt: "2026-06-29T12:30:00.000Z",
      waitingForUser: true,
      terminal: false,
    },
  ],
  openFollowups: [],
  recentBoardMessages: [],
  routingConstraints: {
    reservationRate: { minPft: 25_000, sourceEntryId: "hivectx_rate" },
  },
});
assert.match(promptText, /ACCOUNT LIVE STATE - AUTHORITATIVE/);
assert.match(promptText, /user-stated minimum Network Task reward is 25000 PFT/);
assert.match(promptText, /Smoke task/);
assert.match(promptText, /reward_offer_pft=12000/);
assert.match(promptText, /accept_by=2026-06-28T12:30:00\.000Z/);
assert.match(promptText, /deadline_at=2026-06-29T12:30:00\.000Z/);
assert.match(promptText, /network_task_eligibility: unavailable in this snapshot/);

const eligibilityPromptText = formatHiveAccountLiveStateForPrompt({
  ok: true,
  status: "ready",
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  snapshotAt: "2026-05-31T00:00:00.000Z",
  networkTasks: [],
  openFollowups: [],
  recentBoardMessages: [],
  routingConstraints: {},
  networkTaskEligibility: {
    status: "profile_required",
    label: "Network profile required",
    nextAction: "Open Memory and refresh the Network Diagnostic Report.",
    walletLinked: true,
    walletSynced: true,
    diagnosticReportStatus: "missing",
    capacityAvailable: true,
    blockedGates: ["routing_profile=action_required"],
    positiveRewardedTaskCount: 1,
    autoReportRewardedTaskThreshold: 2,
  },
});
assert.match(eligibilityPromptText, /network_task_eligibility: status=profile_required/);
assert.match(eligibilityPromptText, /wallet_linked=yes \| wallet_synced=yes \| diagnostic_report=missing \| capacity_available=yes/);
assert.match(eligibilityPromptText, /rewarded_tasks=1\/2 toward automatic Network Diagnostic Report generation/);
assert.match(eligibilityPromptText, /blocked gates: routing_profile=action_required \| next_action=Open Memory and refresh the Network Diagnostic Report\./);
assert.match(eligibilityPromptText, /Answer Network Task eligibility questions from the network_task_eligibility lines above/);

const routableEligibilityPromptText = formatHiveAccountLiveStateForPrompt({
  ok: true,
  status: "ready",
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  snapshotAt: "2026-05-31T00:00:00.000Z",
  networkTasks: [],
  openFollowups: [],
  recentBoardMessages: [],
  routingConstraints: {},
  networkTaskEligibility: {
    status: "available_for_routing",
    label: "Eligible for Board Manager routing",
    nextAction: "No manual request is needed.",
    walletLinked: true,
    walletSynced: true,
    diagnosticReportStatus: "completed",
    capacityAvailable: true,
    blockedGates: [],
    positiveRewardedTaskCount: 4,
    autoReportRewardedTaskThreshold: 2,
  },
});
assert.match(routableEligibilityPromptText, /network_task_eligibility: status=available_for_routing/);
assert.match(routableEligibilityPromptText, /blocked gates: none; the account is routable and waits on Board Manager project need\./);

const seedValidation = validateSeeds(collectLocalSeeds({ seedFile: args.seedFile }));
assert.ok(seedValidation.valid.length > 0, "expected at least one local seed in env file or seed file");
assert.equal(seedValidation.invalid.length, 0, "all configured local smoke seeds must parse");

console.log(JSON.stringify({
  ok: true,
  envLoaded,
  validSeedSources: seedValidation.valid.map((item) => item.source),
  validSeedAddressPreviews: seedValidation.valid.map((item) => item.addressPreview),
  refusedGuard: refusedGuard.reason,
  belowReservationGuard: belowReservationGuard.reason,
  satisfiedReservationGuard: satisfiedReservationGuard.reason,
}, null, 2));

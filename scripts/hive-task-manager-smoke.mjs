#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  applyTaskManagerGuardrails,
  normalizeTaskManagerOutput,
  translateTaskManagerSelectionToBoardDecision,
} from "../server/repositories/hive-task-manager.js";
import { fetchHiveTaskManagerSelection } from "../server/hive-task-manager-provider.js";

process.env.TASKNODE_HIVE_TASK_MANAGER_PROVIDER_MOCK = "true";

const sourcePacket = {
  schema: "pf.hive.task_manager.source.v1",
  activeBoards: [
    {
      projectId: "routing-board",
      title: "Routing Eligibility and Badge Projection",
      type: "protocol_development",
      status: "active",
      summary: "Fix routing eligibility so badge-qualified operators can receive useful work.",
    },
  ],
  eligibleSelectionPool: [
    {
      accountId: "acct_good",
      walletAddress: "rGoodWallet",
      identity: { hiveHandle: "goodalexander", displayName: "@goodalexander" },
      verifiedBadges: ["core_contributor"],
      defaultBadge: "core_contributor",
      allowedWorkTypes: ["code_task", "operator_coordination_task"],
      rewardCaps: { code_task: 20000, operator_coordination_task: 5000 },
      badgeDetails: [{ badgeId: "core_contributor", maxPayoutPft: 20000 }],
    },
  ],
  guardrails: {
    dedupIndex: [],
  },
};

const providerResult = await fetchHiveTaskManagerSelection({ sourcePacket });
assert.equal(providerResult.selection.action, "create_task", "mock provider selects a task when an eligible pair exists");

const valid = normalizeTaskManagerOutput({
  explanation: "Route one concrete routing fix.",
  action: "create_task",
  board_selection: {
    project_id: "routing-board",
    title: "Routing Eligibility and Badge Projection",
    why_this_board: "It is active and blocked on routing quality.",
  },
  operator_selection: {
    account_id: "acct_good",
    wallet_address: "rGoodWallet",
    required_badge_id: "core_contributor",
    operating_badge_id: "core_contributor",
    task_work_type: "code_task",
    badge_work_type: "code_task",
    why_this_operator: "The operator is an idle Core Contributor.",
  },
  task_intent: {
    title: "Fix the routing eligibility badge display",
    project_need_summary: "Patch the routing eligibility surface so operators can see why they are or are not eligible for Network Tasks.",
    routing_reason: "The board needs a concrete code fix and the operator has the Core Contributor badge.",
    dedup_basis: "No matching outstanding or rewarded routing-display task exists.",
    action_output: "Submit a PR or commit plus before/after evidence.",
    delivery_surface: "task_node",
    recipient_or_reviewer: "@goodalexander",
    escalation_stage: "normal",
    reward_min_pft: 1000,
    reward_max_pft: 20000,
  },
  constraints_checked: {
    contributor_badge: true,
    operator_idle: true,
    refusal_history: true,
    rewarded_history: true,
    not_duplicative: true,
    cold_start_problem: false,
  },
  confidence: 0.77,
});

const validGuardrail = applyTaskManagerGuardrails({ selection: valid, sourcePacket });
assert.equal(validGuardrail.ok, true, JSON.stringify(validGuardrail));
const translated = translateTaskManagerSelectionToBoardDecision({ selection: valid, sourcePacket });
assert.equal(translated.action, "initiate_network_task", "Task Manager selection translates into network task enqueue decision");
assert.equal(translated.payload.network_task.candidate_account_id, "acct_good", "translated decision preserves selected account");
assert.equal(translated.payload.network_task.required_badge_id, "core_contributor", "translated decision preserves badge");

const badBadge = normalizeTaskManagerOutput({
  ...valid,
  operator_selection: {
    account_id: "acct_good",
    wallet_address: "rGoodWallet",
    required_badge_id: "qa_worker",
    operating_badge_id: "qa_worker",
    task_work_type: "qa_bug_reproduction",
    badge_work_type: "qa_bug_reproduction",
    why_this_operator: "Invalid fixture.",
  },
});
const badBadgeGuardrail = applyTaskManagerGuardrails({ selection: badBadge, sourcePacket });
assert.equal(badBadgeGuardrail.ok, false, "guardrail blocks operators without the selected badge");
assert.ok(badBadgeGuardrail.reasons.includes("selected_operator_missing_required_badge"));

const duplicateSource = {
  ...sourcePacket,
  guardrails: {
    dedupIndex: [
      {
        source: "task_projection",
        taskId: "task_existing",
        accountId: "acct_good",
        walletAddress: "rGoodWallet",
        status: "proposed",
        title: "Fix the routing eligibility badge display",
        summaryKey: "fix routing eligibility badge display operators eligible network tasks",
        active: true,
      },
    ],
  },
};
const duplicateGuardrail = applyTaskManagerGuardrails({ selection: valid, sourcePacket: duplicateSource });
assert.equal(duplicateGuardrail.ok, false, "guardrail blocks duplicate task intent");
assert.ok(duplicateGuardrail.reasons.includes("structural_dedup_match"));

console.log("hive-task-manager-smoke ok");

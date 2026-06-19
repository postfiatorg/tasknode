import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const { compactBoardManagerOrcOperationsForSourcePacket } = await import("../server/repositories/orc-operations.js");
const {
  buildBoardManagerSecretaryDecisionPacket,
  normalizeBoardManagerSecretaryPacket,
} = await import("../server/board-manager-secretary-packets.js");

const orcOperations = compactBoardManagerOrcOperationsForSourcePacket({
  generatedAt: "2026-06-19T00:00:00.000Z",
  tableStatus: {
    orcAgents: true,
    orcRunJournal: true,
    orcTaskReviewStates: true,
    orcOperatorInteractions: true,
  },
  agents: [
    {
      id: "orc_grashnuk",
      handle: "grashnuk",
      agent_id: "agent_grashnuk",
      account_id: "acct_orc_grashnuk",
      wallet_address: "rGrashnukWallet",
      status: "active",
      active: true,
      capacity_limit: 1,
      tmux_target: "grashnuk:0.0",
      metadata_json: {
        sessionPath: "/home/pfrpc/repos/tasknode_agent_sessions.json",
      },
    },
  ],
  taskStats: [
    {
      id: "orc_grashnuk",
      handle: "grashnuk",
      agent_id: "agent_grashnuk",
      account_id: "acct_orc_grashnuk",
      wallet_address: "rGrashnukWallet",
      outstanding_network_task_count: 0,
      outstanding_personal_task_count: 1,
      pending_generation_count: 0,
      rewarded_task_count: 3,
      reward_actual_pft: 45000,
      active_task_ids: ["task_personal_orc_context"],
    },
  ],
  reviewCounts: [
    {
      handle: "grashnuk",
      wallet_address: "rGrashnukWallet",
      reviewed_count: 5,
      action_required_count: 1,
      by_disposition: { reviewed_follow_up: 1, reviewed_no_action: 4 },
    },
  ],
  recentReviews: [
    {
      task_id: "task_reviewed_by_orc",
      disposition: "reviewed_follow_up",
      action_required: true,
      confidence: "high",
      summary: "Evidence needs an operator handoff.",
      recommended_action: "Route a concise follow-up task.",
      reviewer_handle: "grashnuk",
      reviewer_wallet: "rGrashnukWallet",
      source_task_ids: ["task_reviewed_by_orc"],
      source_cids: ["cid_review"],
      source_tx_hashes: ["tx_review"],
    },
  ],
  runJournal: [
    {
      orc_handle: "grashnuk",
      agent_id: "agent_grashnuk",
      command: "review-task",
      phase: "complete",
      status: "ok",
      task_id: "task_reviewed_by_orc",
      cid: "cid_review",
      tx_hash: "tx_review",
      created_at: "2026-06-19T00:01:00.000Z",
    },
  ],
  operatorInteractions: [
    {
      id: "orcint_1",
      orc_handle: "grashnuk",
      interaction_type: "directive",
      directive: "Review duplicate reward evidence.",
      status: "recorded",
      created_at: "2026-06-19T00:02:00.000Z",
    },
  ],
});

assert.equal(orcOperations.schema, "pf.hive.board_manager.orc_operations.v1");
assert.equal(orcOperations.enforcement, "none_context_only");
assert.equal(orcOperations.summary.activeAgentCount, 1);
assert.equal(orcOperations.summary.availableForRoutingCount, 1);
assert.equal(orcOperations.agents[0].handle, "grashnuk");
assert.equal(orcOperations.agents[0].accountId, "acct_orc_grashnuk");
assert.equal(orcOperations.agents[0].walletAddress, "rGrashnukWallet");
assert.equal(orcOperations.agents[0].reviews.actionRequiredCount, 1);
assert.equal(orcOperations.routingCandidates[0].availableForNetworkTask, true);
assert.equal(JSON.stringify(orcOperations).includes("sessionPath"), false);
assert.equal(JSON.stringify(orcOperations).includes("tasknode_agent_sessions"), false);
assert.equal(JSON.stringify(orcOperations).includes("grashnuk:0.0"), false);

const normalized = normalizeBoardManagerSecretaryPacket({
  motion_state: "needs_attention",
  orc_operations_summary: orcOperations,
});
assert.equal(normalized.orc_operations_summary.active_agent_count, 1);
assert.equal(normalized.orc_operations_summary.agents[0].handle, "grashnuk");
assert.equal(normalized.orc_operations_summary.recent_reviews[0].task_id, "task_reviewed_by_orc");

const decisionPacket = buildBoardManagerSecretaryDecisionPacket({
  sourcePacket: {
    schema: "pf.hive.board_manager.source.v0",
    scope: "global_hive",
    sourcePacketDigest: "source_digest_orc",
    boardActionPressure: { summary: { requiresAction: true } },
    orcOperations,
    networkTaskCandidates: [],
  },
  secretaryPacket: {
    id: "secretary_orc",
    sourceDigest: "source_digest_orc",
    packetDigest: "packet_digest_orc",
    packetJson: normalized,
  },
});
assert.equal(decisionPacket.orcOperationsSummary.active_agent_count, 1);
assert.ok(decisionPacket.actionTargetRegistry.contributorCandidates.some((candidate) => (
  candidate.accountId === "acct_orc_grashnuk" &&
  candidate.walletAddress === "rGrashnukWallet"
)));

console.log("board-manager-orc-accounting-smoke ok");

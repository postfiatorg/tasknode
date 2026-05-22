import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  boardManagerActions,
  buildBoardManagerSourcePacket,
  formatBoardManagerCodexPrompt,
  normalizeBoardManagerDecision,
} = await import("../server/repositories/board-manager.js");
const { loadPrompt } = await import("../server/prompt-registry.js");

assert.ok(boardManagerActions.includes("do_nothing"));
assert.ok(boardManagerActions.includes("archive_project"));
assert.ok(boardManagerActions.includes("initiate_network_task"));

const packet = await buildBoardManagerSourcePacket({
  trigger: "board_manager_smoke",
  scope: "global_hive",
});

assert.equal(packet.schema, "pf.hive.board_manager.source.v0");
assert.equal(packet.scope, "global_hive");
assert.equal(packet.trigger, "board_manager_smoke");
assert.equal(packet.executionPolicy.dryRunDefault, true);
assert.ok(packet.executionPolicy.implementedActionHooks.includes("message_user"));
assert.ok(packet.executionPolicy.implementedActionHooks.includes("create_project"));
assert.ok(packet.sourcePacketDigest.length >= 40);
assert.deepEqual(packet.actionRegistry, boardManagerActions);

const prompt = formatBoardManagerCodexPrompt({
  prompt: loadPrompt("hive/board_manager_v1.md"),
  sourcePacket: packet,
});
assert.match(prompt, /BOARD MANAGER SOURCE PACKET/);
assert.match(prompt, /Do not mutate database state/);
assert.match(prompt, /pf\.hive\.board_manager\.source\.v0/);

const decision = normalizeBoardManagerDecision({
  action: "refresh_hive_secretary",
  target_type: "hive_secretary_report",
  target_id: "latest",
  reason: "The report is stale relative to validated Hive Inputs.",
  confidence: 0.72,
  payload: {
    summary: "Refresh the Hive Secretary report because validated inputs changed.",
    next_steps: ["Run the secretary refresh action when mutation execution is enabled."],
  },
});
assert.equal(decision.action, "refresh_hive_secretary");
assert.equal(decision.confidence, 0.72);
assert.equal(decision.payload.summary, "Refresh the Hive Secretary report because validated inputs changed.");
assert.deepEqual(decision.payload.next_steps, ["Run the secretary refresh action when mutation execution is enabled."]);
assert.equal(decision.payload.project.title, "");
assert.equal(decision.payload.contributor.wallet_address, "");

assert.throws(
  () => normalizeBoardManagerDecision({ action: "delete_everything", reason: "bad", payload: {} }),
  /board_manager_invalid_action/
);

console.log("board manager v0 smoke ok");

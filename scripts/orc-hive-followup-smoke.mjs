import assert from "node:assert/strict";
import {
  buildMessageUserDecision,
  parseArgs,
  sendOrcHiveFollowup,
} from "./orc-hive-followup.mjs";
import {
  guardBoardManagerMessageUserFreshness,
} from "../server/board-manager-actions.js";
import { normalizeBoardManagerDecision } from "../server/repositories/board-manager.js";

const args = parseArgs([
  "--task-id",
  "task_test",
  "--message",
  "No action is needed.",
  "--account-id",
  "acct_test",
  "--json",
]);
assert.equal(args.taskId, "task_test");
assert.equal(args.accountId, "acct_test");
assert.equal(args.followupRequired, false);
assert.equal(args.execute, false);

const dryRun = await sendOrcHiveFollowup({
  taskId: "task_test",
  message: "Following up on this rewarded Network Task. No action is needed.",
  accountId: "acct_test",
  deps: {
    databaseEnabledImpl: () => false,
    queryImpl: () => {
      throw new Error("dry-run with explicit account should not query");
    },
  },
});
assert.equal(dryRun.ok, true);
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.executed, false);
assert.equal(dryRun.accountId, "acct_test");
assert.equal(dryRun.followupRequired, false);
assert.equal(dryRun.secretPrinted, false);

let executeCalls = 0;
const delivered = await sendOrcHiveFollowup({
  taskId: "task_test",
  message: "Following up on this rewarded Network Task. No action is needed.",
  execute: true,
  deps: {
    databaseEnabledImpl: () => true,
    queryImpl: async (_sql, params) => ({
      rows: [{
        task_id: params[0],
        account_id: "acct_owner",
        subject_wallet: "rOwner",
        status: "rewarded",
        title: "Rewarded task",
        task_kind: "network",
        reward_actual_pft: "12.5",
        updated_at: "2026-06-20T00:00:00Z",
      }],
    }),
    executeBoardManagerDecisionImpl: async ({ decision, sourcePacket, dryRun: actionDryRun }) => {
      executeCalls += 1;
      assert.equal(actionDryRun, false);
      assert.equal(decision.action, "message_user");
      assert.equal(decision.target_type, "account");
      assert.equal(decision.target_id, "acct_owner");
      assert.equal(decision.payload.followup_required, false);
      assert.equal(sourcePacket.actionTargetRegistry.accounts[0].accountId, "acct_owner");
      return {
        ok: true,
        result: {
          executed: true,
          messageId: "boardmsg_test",
          chatMessageId: "msg_boardmsg_test_assistant",
          followupId: "",
          accountId: "acct_owner",
          conversationId: "account_acct_owner_hive",
          messagePreview: "Following up",
        },
      };
    },
  },
});
assert.equal(executeCalls, 1);
assert.equal(delivered.ok, true);
assert.equal(delivered.executed, true);
assert.equal(delivered.boardManagerMessageId, "boardmsg_test");
assert.equal(delivered.chatMessageId, "msg_boardmsg_test_assistant");
assert.equal(delivered.followupId, "");

const skipped = await sendOrcHiveFollowup({
  taskId: "task_test",
  message: "Following up on this rewarded Network Task. No action is needed.",
  execute: true,
  accountId: "acct_owner",
  deps: {
    databaseEnabledImpl: () => true,
    queryImpl: async () => ({ rows: [] }),
    executeBoardManagerDecisionImpl: async () => ({
      ok: true,
      result: {
        executed: false,
        skipped: true,
        reason: "board_manager_message_user_open_followup",
      },
    }),
  },
});
assert.equal(skipped.ok, false);
assert.equal(skipped.executed, false);
assert.equal(skipped.skipped, true);
assert.equal(skipped.error, "board_manager_message_user_open_followup");

const { sourcePacket: _sourcePacket, ...rawDecision } = buildMessageUserDecision({
  taskId: "task_rewarded",
  target: {
    accountId: "acct_owner",
    conversationId: "account_acct_owner_hive",
    displayName: "Owner",
  },
  message: "Following up on your rewarded Network Task. No action is needed.",
  followupRequired: false,
  reason: "Informational reward follow-up",
});
const normalizedDecision = normalizeBoardManagerDecision(rawDecision);
assert.equal(normalizedDecision.payload.followup_required, false);
const informationalGuard = guardBoardManagerMessageUserFreshness({
  decision: normalizedDecision,
  messageText: normalizedDecision.payload.message_text,
  accountLiveState: { ok: false, status: "not_loaded" },
});
assert.equal(informationalGuard.ok, true);
assert.equal(informationalGuard.reason, "informational_message_no_followup");

const strictActionGuard = guardBoardManagerMessageUserFreshness({
  decision: normalizeBoardManagerDecision({
    ...rawDecision,
    payload: {
      ...rawDecision.payload,
      message_text: "Please accept this Network Task now.",
      followup_required: false,
    },
  }),
  messageText: "Please accept this Network Task now.",
  accountLiveState: { ok: true, networkTasks: [], openFollowups: [] },
});
assert.equal(strictActionGuard.ok, false);
assert.equal(strictActionGuard.reason, "board_manager_message_precondition_failed");

console.log("orc-hive-followup-smoke ok");

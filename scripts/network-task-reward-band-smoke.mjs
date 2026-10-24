// A board manager's reward band is never rewritten silently: a contributor band
// below the floor is rejected with the floor named, any clamp is recorded on the
// allocation and returned by the command, and operator referrals keep 0-1 PFT.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { enqueueNetworkTaskGenerationFromBoardDecision as enqueue } from "../server/repositories/network-task-enqueue.js";
import { normalizeBoardManagerDecision } from "../server/repositories/board-manager.js";
import { normalizeNetworkTaskRewardBand } from "../server/repositories/network-tasks-utils.js";
import { advertisedRewardBand } from "../server/network-task-generation-worker.js";
import { executeBoardAgentCommand } from "../server/board-agent-routes.js";
process.env.TASKNODE_BOARD_SOURCES_OFFLINE = "true";
assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith("_test"), "Use a disposable *_test database");

const id = "reward_band_" + randomUUID(), wallet = "rRewardBandFixture", board = "board_pf_terminal";
// Decisions pass through the same contract normalization as production.
const decision = (min, max, extra = {}) => normalizeBoardManagerDecision({ action: "initiate_network_task", target_type: "network_project", target_id: board, reason: "reward band smoke", confidence: 1,
  payload: { network_task: { candidate_account_id: id, candidate_wallet_address: wallet, task_class: "network", task_work_type: "code_task",
    required_badge_id: "core_contributor", operating_badge_id: "core_contributor", badge_work_type: "code_task",
    project_need_summary: `Reward band fixture ${min}-${max} ${randomUUID()}`, reward_min_pft: min, reward_max_pft: max, allow_over_capacity: true, ...extra } } });
const allocation = async (allocationId) => (await query("SELECT reward_min_pft, reward_max_pft, metadata_json FROM network_task_allocations WHERE id=$1", [allocationId])).rows[0];

try {
  await migrateDatabase();
  await query("INSERT INTO network_projects(id,title,status) VALUES($1,'Reward band fixture','active') ON CONFLICT DO NOTHING", [board]);
  await query("INSERT INTO pftl_sync_wallets(wallet_address,account_id,role,status) VALUES($1,$2,'user','active')", [wallet, id]);
  await query("INSERT INTO account_network_badges(id,account_id,badge_id,status,selected_default) VALUES($1,$1,'core_contributor','verified',true)", [id]);
  await query("INSERT INTO board_reward_budgets(board_id) VALUES($1) ON CONFLICT DO NOTHING", [board]);
  const token = randomUUID();
  await query("INSERT INTO board_agent_credentials(id,token_hash,actor,board_ids,expires_at) VALUES($1,$2,$1,$3::jsonb,now()+interval '1 hour')", [id, createHash("sha256").update(token).digest("hex"), JSON.stringify([board])]);
  const create = (min, max, key) => executeBoardAgentCommand({ token, payload: { requestKey: `${id}_${key}`, argv: ["task", "create", board, "--account", id, "--wallet", wallet,
    "--need", `Reward band command ${key}`, "--required-badge", "core_contributor", "--work-type", "code_task", ...(min === null ? [] : ["--reward-min", String(min)]), "--reward-max", String(max)] } });

  // 1. A 10-50 contributor band is rejected, naming the 100 PFT floor, by the command and by the engine.
  await assert.rejects(create(10, 50, "sub_floor"), (error) => error.status === 422 && error.message.includes("100 PFT"));
  await assert.rejects(enqueue({ decision: decision(10, 50), sourcePacket: {} }), (error) => error.status === 422 && error.message.includes("100 PFT"));
  console.log("PASS 10-50 band rejected: network_task_reward_below_floor names the 100 PFT minimum");

  // 2. A clamped band (0-400, min raised to the floor) is recorded on the allocation and returned by the command.
  const dryRun = await create(null, 400, "clamped");
  assert.deepEqual([dryRun.result.rewardMin, dryRun.result.rewardMax], [100, 400]);
  assert.deepEqual(dryRun.result.rewardBandClampedFrom, { min: 0, max: 400 });
  const clamped = await enqueue({ decision: decision(0, 400), sourcePacket: {} });
  assert.deepEqual(clamped.rewardBandPft, [100, 400]);
  assert.deepEqual(clamped.rewardBandClampedFrom, { min: 0, max: 400 });
  const clampedRow = await allocation(clamped.allocationId);
  assert.deepEqual([Number(clampedRow.reward_min_pft), Number(clampedRow.reward_max_pft)], [100, 400]);
  assert.deepEqual(clampedRow.metadata_json.reward_band_clamped_from, { min: 0, max: 400 });
  console.log("PASS 0-400 band clamped to 100-400 and reward_band_clamped_from {min:0,max:400} saved on the allocation and in the command result");

  // 3. An operator referral keeps 0-1 through the contract, the allocation, and the advertised offer.
  const referral = await enqueue({ decision: decision(0, 1, { operator_duty: true }), sourcePacket: {} });
  assert.deepEqual(referral.rewardBandPft, [0, 1]);
  assert.equal(referral.rewardBandClampedFrom, undefined);
  const referralRow = await allocation(referral.allocationId);
  assert.deepEqual([Number(referralRow.reward_min_pft), Number(referralRow.reward_max_pft)], [0, 1]);
  assert.deepEqual(advertisedRewardBand({ min: referralRow.reward_min_pft, max: referralRow.reward_max_pft, perTaskCap: 5000 }), { min: 0, max: 1 });
  console.log("PASS operator 0-1 referral publishes as 0-1, not 100");

  // The advertised band only ever lowers to the board cap, and says so.
  assert.deepEqual(advertisedRewardBand({ min: 100, max: 800, perTaskCap: 500 }), { min: 100, max: 500, clampedFrom: { min: 100, max: 800 } });
  assert.deepEqual(normalizeNetworkTaskRewardBand({ min: 100, max: 300 }), { min: 100, max: 300 });
  console.log("PASS per-task cap lowers the advertised band with clampedFrom; in-policy bands are untouched");
} finally {
  await query("DELETE FROM board_agent_commands WHERE credential_id=$1", [id]);
  await query("DELETE FROM board_agent_credentials WHERE id=$1", [id]);
  for (const table of ["network_task_intents", "network_task_generation_jobs", "network_task_allocations"]) {
    await query(`DELETE FROM ${table} WHERE candidate_account_id=$1`, [id]);
  }
  await query("DELETE FROM board_manager_runs WHERE source_packet_json->'candidate'->>'account_id'=$1", [id]).catch(() => {});
  await query("DELETE FROM bm_audit_log WHERE actor=$1", [id]);
  await query("DELETE FROM account_network_badges WHERE account_id=$1", [id]);
  await query("DELETE FROM pftl_sync_wallets WHERE account_id=$1", [id]);
  await query("DELETE FROM user_observability_events WHERE account_id=$1", [id]);
  await closePool();
}

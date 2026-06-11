import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  buildDailyAirdropTaskRewardPacket,
  normalizeDailyAirdropOutput,
  runDailyAirdropScore,
} from "../server/profile-daily-airdrop.js";
import {
  createDailyAirdropRun,
  failDailyAirdropRun,
} from "../server/repositories/profile-daily-airdrop.js";
import { registerPftlSyncWallet } from "../server/repositories/pftl-cache.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_packet_${suffix}`;
const walletAddress = Wallet.generate().classicAddress;
const taskId = `task_airdrop_packet_${suffix}`;
const mismatchAccountId = `acct_airdrop_mismatch_${suffix}`;
const mismatchWallet = Wallet.generate().classicAddress;
const mismatchTaskId = `task_airdrop_mismatch_${suffix}`;

async function cleanup() {
  await query("DELETE FROM profile_daily_airdrop_runs WHERE account_id = ANY($1::text[])", [
    [accountId, mismatchAccountId],
  ]);
  await query("DELETE FROM task_events WHERE account_id = ANY($1::text[])", [[accountId, mismatchAccountId]]);
  await query("DELETE FROM task_projections WHERE account_id = ANY($1::text[])", [[accountId, mismatchAccountId]]);
  await query("DELETE FROM pftl_sync_wallets WHERE account_id = ANY($1::text[])", [[accountId, mismatchAccountId]]);
}

async function insertRewardedTask({
  account = accountId,
  wallet = walletAddress,
  task = taskId,
  reward = 7.5,
} = {}) {
  await query(
    `INSERT INTO task_projections (
       task_id,
       account_id,
       subject_wallet,
       status,
       title,
       task_kind,
       reward_offer_pft,
       reward_actual_pft,
       last_event_tx_hash,
       last_event_cid,
       last_event_at,
       updated_at
     )
     VALUES ($1, $2, $3, 'rewarded', 'Airdrop packet smoke task', 'personal', $4, $4,
             $5, $6, now() - interval '1 hour', now() - interval '1 hour')`,
    [task, account, wallet, reward, `REWARD_TX_${task}`, `QmReward${task}`]
  );
  await query(
    `INSERT INTO task_events (
       id,
       task_id,
       account_id,
       wallet_address,
       event_type,
       source_tx_hash,
       source_cid,
       payload_json,
       occurred_at
     )
     VALUES ($1, $2, $3, $4, 'pf.reward.v1', $5, $6, $7::jsonb, now() - interval '1 hour')`,
    [
      `event_${task}`,
      task,
      account,
      wallet,
      `REWARD_TX_${task}`,
      `QmReward${task}`,
      JSON.stringify({
        reward_pft: reward,
        score: {
          decision: "reward",
          reward_pft: reward,
          completion: 95,
          evidence_quality: 90,
          reason: "Smoke reward.",
        },
      }),
    ]
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("profile daily airdrop packet smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    await registerPftlSyncWallet({
      walletAddress,
      accountId,
      role: "user",
      priority: 10,
      status: "active",
      metadata: { reason: "airdrop_packet_smoke" },
    });
    await insertRewardedTask();

    const packet = await buildDailyAirdropTaskRewardPacket({
      accountId,
      now: new Date(),
      lookbackDays: 7,
    });
    assert.equal(packet.identity_cloud.source, "pftl_sync_wallets");
    assert.equal(packet.identity_cloud.active_wallet_address, walletAddress);
    assert.equal(packet.identity_cloud.eligible_wallet_count, 1);
    assert.equal(packet.reward_totals.rewarded_task_count, 1);
    assert.equal(packet.reward_totals.total_reward_paid_pft, 7.5);
    assert.equal(packet.rewarded_tasks[0].task_id, taskId);
    assert.equal(packet.daily_airdrop_policy.max_reward_fraction, 0.5);
    assert.equal(
      packet.daily_airdrop_policy.deterministic_cap_rule,
      "min(max_daily_pft, floor(max_reward_fraction * total_reward_paid_pft))"
    );

    // Deterministic amount cap: the model can never pay more than
    // max_reward_fraction * the packet's 7-day rewarded PFT, even if it tries.
    const cappedOutput = normalizeDailyAirdropOutput(
      { daily_airdrop_pft: 5000, retention_value_score: 99, eligibility_status: "eligible" },
      packet,
      { maxDailyPft: 10000, maxRewardFraction: 0.5 }
    );
    assert.equal(cappedOutput.daily_airdrop_pft, 3, "5000 PFT proposal clamps to floor(0.5 * 7.5) = 3");
    assert.equal(cappedOutput.deterministic_cap.cap_bound, true);
    assert.equal(cappedOutput.deterministic_cap.model_daily_airdrop_pft, 5000);
    assert.equal(cappedOutput.deterministic_cap.reward_fraction_cap_pft, 3);
    assert.equal(cappedOutput.deterministic_cap.total_reward_paid_pft, 7.5);
    assert.equal(cappedOutput.deterministic_cap.max_reward_fraction, 0.5);

    const underCapOutput = normalizeDailyAirdropOutput(
      { daily_airdrop_pft: 2, retention_value_score: 40, eligibility_status: "eligible" },
      packet,
      { maxDailyPft: 10000, maxRewardFraction: 0.5 }
    );
    assert.equal(underCapOutput.daily_airdrop_pft, 2, "a proposal under the cap is unchanged");
    assert.equal(underCapOutput.deterministic_cap.cap_bound, false);

    const zeroBaseOutput = normalizeDailyAirdropOutput(
      { daily_airdrop_pft: 100, retention_value_score: 80, eligibility_status: "eligible" },
      { reward_totals: { rewarded_task_count: 1, total_reward_paid_pft: 0 } },
      { maxDailyPft: 10000, maxRewardFraction: 0.5 }
    );
    assert.equal(zeroBaseOutput.daily_airdrop_pft, 0, "a zero rewarded-PFT base caps the payout to zero");

    await insertRewardedTask({
      account: mismatchAccountId,
      wallet: mismatchWallet,
      task: mismatchTaskId,
      reward: 5,
    });
    await assert.rejects(
      () => runDailyAirdropScore({
        accountId: mismatchAccountId,
        expectedCandidate: {
          accountId: mismatchAccountId,
          rewardedTaskCount: 1,
          rewardActualPft: 5,
        },
      }),
      /daily_airdrop_packet_candidate_mismatch/
    );
    const runs = await query("SELECT COUNT(*)::int AS count FROM profile_daily_airdrop_runs WHERE account_id = $1", [
      mismatchAccountId,
    ]);
    assert.equal(runs.rows[0].count, 0);

    const retryRunDate = "2026-01-15";
    const failedRun = await createDailyAirdropRun({
      id: `airdrop_packet_retry_failed_${suffix}`,
      accountId,
      runDate: retryRunDate,
      runMode: "production",
      scenarioId: "packet_smoke_first_attempt",
      isCanonical: true,
      status: "running",
      inputHash: "sha256:first",
      inputSnapshot: { attempt: "first" },
      provider: "openrouter",
      model: "smoke-model",
      promptVersion: "smoke-v1",
      promptDigest: "digest-first",
    });
    await failDailyAirdropRun({
      id: failedRun.id,
      errorMessage: "daily_airdrop_model_output_not_json",
    });
    const retriedRun = await createDailyAirdropRun({
      id: `airdrop_packet_retry_second_${suffix}`,
      accountId,
      runDate: retryRunDate,
      runMode: "production",
      scenarioId: "packet_smoke_second_attempt",
      isCanonical: true,
      status: "running",
      inputHash: "sha256:second",
      inputSnapshot: { attempt: "second" },
      provider: "openrouter",
      model: "smoke-model",
      promptVersion: "smoke-v1",
      promptDigest: "digest-second",
    });
    assert.equal(retriedRun.id, failedRun.id);
    assert.equal(retriedRun.status, "running");
    assert.equal(retriedRun.scenario_id, "packet_smoke_second_attempt");
    assert.equal(retriedRun.input_hash, "sha256:second");
    assert.equal(retriedRun.error_message, null);
    assert.equal(retriedRun.completed_at, null);

    await createDailyAirdropRun({
      id: `airdrop_packet_completed_${suffix}`,
      accountId: mismatchAccountId,
      runDate: retryRunDate,
      runMode: "production",
      scenarioId: "packet_smoke_completed",
      isCanonical: true,
      status: "completed",
      inputHash: "sha256:completed",
      inputSnapshot: { attempt: "completed" },
      provider: "openrouter",
      model: "smoke-model",
      promptVersion: "smoke-v1",
      promptDigest: "digest-completed",
    });
    await assert.rejects(
      () => createDailyAirdropRun({
        id: `airdrop_packet_completed_retry_${suffix}`,
        accountId: mismatchAccountId,
        runDate: retryRunDate,
        runMode: "production",
        scenarioId: "packet_smoke_completed_retry",
        isCanonical: true,
        status: "running",
        inputHash: "sha256:completed-retry",
        inputSnapshot: { attempt: "completed-retry" },
        provider: "openrouter",
        model: "smoke-model",
        promptVersion: "smoke-v1",
        promptDigest: "digest-completed-retry",
      }),
      /daily_airdrop_production_run_already_exists/
    );

    console.log("profile daily airdrop packet smoke ok");
  } finally {
    await cleanup().catch(() => null);
    await closePool().catch(() => null);
  }
}

main().catch(async (error) => {
  await cleanup().catch(() => null);
  await closePool().catch(() => null);
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});

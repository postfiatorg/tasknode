import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const { closePool, databaseEnabled, query } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const { importTaskReplayReceipt } = await import("../server/repositories/tasks.js");
const { executeBoardManagerDecision } = await import("../server/board-manager-actions.js");
const {
  buildBoardManagerSourcePacket,
  startBoardManagerRun,
} = await import("../server/repositories/board-manager.js");

const NS = "board_manager_cancel_network_task_smoke";

// normalizePayload merges emptyBoardManagerPayload defaults, so only the
// cancel_target needs to be supplied.
function cancelDecision(runId, sourcePacket, taskId, reason, referenced = []) {
  return executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: {
      action: "cancel_network_task",
      target_type: "network_task",
      target_id: taskId,
      reason,
      confidence: 1,
      payload: {
        cancel_target: { task_id: taskId, reason, referenced_task_ids: referenced },
      },
    },
  });
}

async function seedProject(projectId) {
  await query(
    `INSERT INTO network_projects (id, type, title, summary, objective, about, status, origin, proposed_by)
     VALUES ($1, 'network_validation', 'Cancel smoke project', 'Cancel smoke', 'Verify Board Manager cancel boundary.', 'Cancel smoke fixture.', 'active', 'smoke', 'hive')
     ON CONFLICT (id) DO NOTHING`,
    [projectId]
  );
}

async function seedProjection({ taskId, accountId, wallet, status, taskKind = "network", rewardActualPft = 0 }) {
  await query(
    `INSERT INTO task_projections (task_id, account_id, subject_wallet, status, title, task_kind, source, reward_actual_pft)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (task_id) DO UPDATE SET
       status = EXCLUDED.status,
       task_kind = EXCLUDED.task_kind,
       reward_actual_pft = EXCLUDED.reward_actual_pft,
       subject_wallet = EXCLUDED.subject_wallet,
       account_id = EXCLUDED.account_id`,
    [taskId, accountId, wallet, status, `Cancel smoke ${taskId}`, taskKind, NS, rewardActualPft]
  );
}

async function seedRef({ taskId, projectId, source, state, wallet, rewardPft = 12000 }) {
  await query(
    `INSERT INTO network_project_task_refs (id, project_id, task_id, request_id, title, state, assignee_wallet, reward_pft, source, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       state = EXCLUDED.state,
       source = EXCLUDED.source,
       assignee_wallet = EXCLUDED.assignee_wallet,
       reward_pft = EXCLUDED.reward_pft`,
    [`ref_${taskId}`, projectId, taskId, `req_${taskId}`, `Cancel smoke ${taskId}`, state, wallet, rewardPft, source]
  );
}

async function seedAllocation({ taskId, projectId, accountId, wallet, allocationStatus = "proposed" }) {
  await query(
    `INSERT INTO network_task_allocations (id, idempotency_key, project_id, task_class, allocation_status, generated_task_id, candidate_account_id, candidate_wallet_address, project_need_summary)
     VALUES ($1, $1, $2, 'network', $3, $4, $5, $6, 'Cancel smoke need')
     ON CONFLICT (id) DO UPDATE SET
       allocation_status = EXCLUDED.allocation_status,
       generated_task_id = EXCLUDED.generated_task_id`,
    [`alloc_${taskId}`, projectId, allocationStatus, taskId, accountId, wallet]
  );
}

async function projection(taskId) {
  const r = await query(
    "SELECT status, reward_actual_pft, metadata_json->>'agent_cancelled' AS agent_cancelled FROM task_projections WHERE task_id = $1",
    [taskId]
  );
  return r.rows[0] || {};
}

async function refRow(taskId) {
  const r = await query("SELECT state, source FROM network_project_task_refs WHERE task_id = $1", [taskId]);
  return r.rows[0] || null;
}

async function allocRow(taskId) {
  const r = await query("SELECT allocation_status FROM network_task_allocations WHERE generated_task_id = $1", [taskId]);
  return r.rows[0] || null;
}

// Drive the REAL reducer upsert (importTaskReplayReceipt) with a rewarded
// receipt for an already-cancelled task, to prove the persist-time guard holds.
async function replayReward({ taskId, accountId, wallet, rewardPft = "15000" }) {
  const suffix = taskId.slice(-12);
  const offerCid = `QmCancelReplayOffer${suffix}`;
  const rewardCid = `QmCancelReplayReward${suffix}`;
  const offerTx = `CANCEL_REPLAY_OFFER_TX_${suffix}`;
  const rewardTx = `CANCEL_REPLAY_REWARD_TX_${suffix}`;
  await importTaskReplayReceipt(
    {
      run_id: `cancel_smoke_replay_${taskId}`,
      task_id: taskId,
      fixture: { account_id: accountId, request_id: `req_replay_${suffix}` },
      wallets: [
        { role: "user", address: wallet },
        { role: "task_authority", address: `rCancelReplayAuth${suffix}` },
        { role: "allocation_reward", address: `rCancelReplayAlloc${suffix}` },
      ],
      cids: { offer: offerCid, reward: rewardCid, request_bundle: `QmCancelReplayBundle${suffix}` },
      txs: { reward: { tx_hash: rewardTx } },
      generated_task: {
        title: `Cancel smoke replay ${taskId}`,
        description: "Replay a reward pointer after cancel.",
        task_kind: "network",
        reward_offer: { amount_estimate_pft: rewardPft },
        submission_requirement: { type: "text", criteria: "Smoke." },
        verification_policy: { mode: "manual_review" },
      },
      hydrated_events: [
        {
          schema: "pf.task.offer.v1",
          task_id: taskId,
          tx_hash: offerTx,
          cid: offerCid,
          payload: {
            schema: "pf.task.offer.v1",
            task_id: taskId,
            event_id: `evt_replay_offer_${suffix}`,
            title: `Cancel smoke replay ${taskId}`,
            task_kind: "network",
            reward_offer: { amount_estimate_pft: rewardPft },
          },
        },
        {
          schema: "pf.reward.v1",
          task_id: taskId,
          tx_hash: rewardTx,
          cid: rewardCid,
          payload: {
            schema: "pf.reward.v1",
            task_id: taskId,
            event_id: `evt_replay_reward_${suffix}`,
            reward_pft: rewardPft,
          },
        },
      ],
      projection: {
        [taskId]: {
          status: "rewarded",
          title: `Cancel smoke replay ${taskId}`,
          task_kind: "network",
          reward_offer_pft: rewardPft,
          reward_actual_pft: rewardPft,
          request_bundle_cid: `QmCancelReplayBundle${suffix}`,
          events: [{}, {}],
        },
      },
    },
    { source: NS, sourceRef: `replay-reward-${taskId}` }
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("board manager cancel network task smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();

  const sourcePacket = await buildBoardManagerSourcePacket({ trigger: NS, scope: "global_hive" });
  const run = await startBoardManagerRun({
    scope: "global_hive",
    managerId: NS,
    trigger: NS,
    sourcePacket,
    dryRun: false,
    model: "smoke",
    reasoningEffort: "none",
  });
  const runId = run.run.id;
  const sp = { sourcePacketDigest: "cancel_smoke_digest" };
  const projectId = `cancel_smoke_project_${randomUUID().slice(0, 8)}`;
  await seedProject(projectId);
  let cancelsExecuted = 0;

  // 1. proposed network task -> refused + mirror sync (refs + allocation).
  {
    const taskId = `task_cancel_proposed_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelProp${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "proposed" });
    await seedRef({ taskId, projectId, source: "network_task_generation", state: "proposed", wallet });
    await seedAllocation({ taskId, projectId, accountId, wallet, allocationStatus: "proposed" });
    const res = await cancelDecision(runId, sp, taskId, "runaway duplicate of prior doc tasks", ["task_prior_doc_1"]);
    assert.equal(res.result?.executed, true, "proposed cancel should execute");
    assert.equal(res.result?.status, "refused");
    const p = await projection(taskId);
    assert.equal(p.status, "refused");
    assert.equal(p.agent_cancelled, "true");
    assert.equal((await refRow(taskId)).state, "refused", "mirror sync: refs.state should be terminal");
    const alloc = await allocRow(taskId);
    assert.ok(alloc && alloc.allocation_status !== "proposed", `mirror sync: allocation should be terminal (got ${alloc?.allocation_status})`);
    cancelsExecuted += 1;
    console.log(`cancel proposed + mirror sync ok: ${taskId}`);
  }

  // 2. accepted network task -> cancelled.
  {
    const taskId = `task_cancel_accepted_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelAcc${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "accepted" });
    await seedRef({ taskId, projectId, source: "network_task_generation", state: "accepted", wallet });
    const res = await cancelDecision(runId, sp, taskId, "stale, superseded by an action task");
    assert.equal(res.result?.executed, true);
    assert.equal(res.result?.status, "cancelled");
    assert.equal((await projection(taskId)).status, "cancelled");
    cancelsExecuted += 1;
    console.log(`cancel accepted ok: ${taskId}`);
  }

  // 3. provenance guard: ref source != network_task_generation -> not_network.
  {
    const taskId = `task_cancel_badsource_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelBad${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "proposed" });
    await seedRef({ taskId, projectId, source: "manual_project_link", state: "proposed", wallet });
    const res = await cancelDecision(runId, sp, taskId, "should be refused: not Board-Manager-issued");
    assert.equal(res.result?.executed, false);
    assert.equal(res.result?.skipped, true);
    assert.equal(res.result?.reason, "board_manager_cancel_task_not_network");
    assert.equal((await projection(taskId)).status, "proposed");
    console.log(`provenance guard ok: ${taskId}`);
  }

  // 4. personal task (no network_task_generation ref) -> not_network.
  {
    const taskId = `task_cancel_personal_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelPers${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "proposed", taskKind: "personal" });
    const res = await cancelDecision(runId, sp, taskId, "should be refused: personal task");
    assert.equal(res.result?.reason, "board_manager_cancel_task_not_network");
    assert.equal((await projection(taskId)).status, "proposed");
    console.log(`personal-task refusal ok: ${taskId}`);
  }

  // 5a. rewarded task -> not_cancellable_state; payout untouched.
  {
    const taskId = `task_cancel_paid_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelPaid${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "rewarded", rewardActualPft: 15000 });
    await seedRef({ taskId, projectId, source: "network_task_generation", state: "rewarded", wallet, rewardPft: 15000 });
    const res = await cancelDecision(runId, sp, taskId, "should be refused: already paid");
    assert.equal(res.result?.reason, "board_manager_cancel_task_not_cancellable_state");
    const p = await projection(taskId);
    assert.equal(p.status, "rewarded");
    assert.equal(Number(p.reward_actual_pft), 15000);
    console.log(`paid-task refusal ok: ${taskId}`);
  }

  // 5b. inconsistent accepted-but-paid -> already_rewarded (defense-in-depth).
  {
    const taskId = `task_cancel_inconsistent_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelIncon${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "accepted", rewardActualPft: 15000 });
    await seedRef({ taskId, projectId, source: "network_task_generation", state: "accepted", wallet });
    const res = await cancelDecision(runId, sp, taskId, "should be refused: reward present");
    assert.equal(res.result?.reason, "board_manager_cancel_task_already_rewarded");
    console.log(`paid defense-in-depth refusal ok: ${taskId}`);
  }

  // 6. submitted task -> not_cancellable_state.
  {
    const taskId = `task_cancel_submitted_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelSub${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "submitted" });
    await seedRef({ taskId, projectId, source: "network_task_generation", state: "submitted", wallet });
    const res = await cancelDecision(runId, sp, taskId, "should be refused: past acceptance");
    assert.equal(res.result?.reason, "board_manager_cancel_task_not_cancellable_state");
    console.log(`submitted-state refusal ok: ${taskId}`);
  }

  // 7. reducer replay guard: a stale reward pointer must not revive or reward.
  {
    const taskId = `task_cancel_replay_${randomUUID().slice(0, 8)}`;
    const wallet = `rCancelReplay${taskId.slice(-12)}`;
    const accountId = `acct_${taskId.slice(-12)}`;
    await seedProjection({ taskId, accountId, wallet, status: "proposed" });
    await seedRef({ taskId, projectId, source: "network_task_generation", state: "proposed", wallet });
    const res = await cancelDecision(runId, sp, taskId, "replay guard seed");
    assert.equal(res.result?.executed, true);
    assert.equal((await projection(taskId)).status, "refused");
    // A delayed reward replay arrives for the same task via the real reducer upsert.
    await replayReward({ taskId, accountId, wallet, rewardPft: "15000" });
    const p = await projection(taskId);
    assert.equal(p.status, "refused", "guard: reward replay must not revive status");
    assert.notEqual(Number(p.reward_actual_pft || 0), 15000, "guard: reward replay must not set reward_actual_pft");
    assert.equal(p.agent_cancelled, "true");
    console.log(`reducer replay guard ok: ${taskId}`);
  }

  console.log(JSON.stringify({ ok: true, runId, cancelsExecuted }));
}

try {
  await main();
} finally {
  await closePool();
}

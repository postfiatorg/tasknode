import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  listNetworkTaskCapacityBlockers,
  listNetworkTaskCandidateCapacityChecks,
} from "../server/repositories/network-task-capacity.js";
import {
  listNetworkTaskAllocationDivergences,
  syncNetworkTaskAllocationMirrors,
} from "../server/repositories/network-task-allocation-sync.js";
import {
  enqueueNetworkTaskGenerationFromBoardDecision,
  getNetworkTaskEligibility,
} from "../server/repositories/network-tasks.js";
import { buildBoardManagerActionPressure } from "../server/repositories/board-manager-health.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const projectId = `netcap_project_${suffix}`;

const accounts = {
  stale: `acct_netcap_stale_${suffix}`,
  crossClass: `acct_netcap_cross_${suffix}`,
  terminal: `acct_netcap_terminal_${suffix}`,
  syncRefused: `acct_netcap_sync_refused_${suffix}`,
  syncCancelled: `acct_netcap_sync_cancelled_${suffix}`,
  syncRewarded: `acct_netcap_sync_rewarded_${suffix}`,
  syncFallback: `acct_netcap_sync_fallback_${suffix}`,
  wallets: `acct_netcap_wallets_${suffix}`,
};
const wallets = {
  stale: `rNetCapStale${suffix}`,
  crossClass: `rNetCapCross${suffix}`,
  terminal: `rNetCapTerminal${suffix}`,
  syncRefused: `rNetCapSyncRefused${suffix}`,
  syncCancelled: `rNetCapSyncCancelled${suffix}`,
  syncRewarded: `rNetCapSyncRewarded${suffix}`,
  syncFallback: `rNetCapSyncFallback${suffix}`,
  current: `rNetCapCurrent${suffix}`,
  old: `rNetCapOld${suffix}`,
};

async function cleanup() {
  const accountIds = Object.values(accounts);
  const walletAddresses = Object.values(wallets);
  await query("DELETE FROM network_task_intents WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_task_generation_jobs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_task_allocations WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_project_task_refs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_project_product_docs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
  await query("DELETE FROM task_projections WHERE account_id = ANY($1::text[])", [accountIds]);
  await query("DELETE FROM network_task_profiles WHERE account_id = ANY($1::text[])", [accountIds]);
  await query("DELETE FROM account_network_badges WHERE account_id = ANY($1::text[])", [accountIds]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = ANY($1::text[])", [walletAddresses]);
  await query("DELETE FROM user_observability_events WHERE account_id = ANY($1::text[])", [accountIds]);
}

async function seedCandidate({ accountId, walletAddress }) {
  await query(
    `
      INSERT INTO pftl_sync_wallets (wallet_address, account_id, role, status, priority, last_hot_sync_at)
      VALUES ($1, $2, 'user', 'active', 100, now())
      ON CONFLICT (wallet_address) DO UPDATE SET account_id = EXCLUDED.account_id, status = 'active'
    `,
    [walletAddress, accountId]
  );
  await query(
    `
      INSERT INTO network_task_profiles (id, account_id, status, output_text, completed_at)
      VALUES ($1, $2, 'completed', 'Network capacity smoke routing profile.', now())
    `,
    [`netprofile_${accountId}`, accountId]
  );
  await query(
    `
      INSERT INTO account_network_badges (
        id,
        account_id,
        badge_id,
        status,
        selected_default,
        verified_by_operator,
        evidence_json,
        validated_metrics_json
      )
      VALUES ($1, $2, 'core_contributor', 'verified', true, 'network_task_capacity_smoke', $3::jsonb, $4::jsonb)
      ON CONFLICT (account_id, badge_id) DO UPDATE SET
        status = EXCLUDED.status,
        selected_default = EXCLUDED.selected_default,
        verified_by_operator = EXCLUDED.verified_by_operator,
        evidence_json = EXCLUDED.evidence_json,
        validated_metrics_json = EXCLUDED.validated_metrics_json,
        revoked_at = NULL,
        updated_at = now()
    `,
    [
      `acctbadge_${accountId}_core`,
      accountId,
      JSON.stringify({ proofMethod: "smoke_core_contributor_fixture" }),
      JSON.stringify({ proofMethod: "smoke_core_contributor_fixture" }),
    ]
  );
}

async function seedAllocation({
  allocationId,
  accountId,
  walletAddress,
  allocationStatus = "accepted",
  taskClass = "network",
  taskId = "",
  requestId = "",
  createdHoursAgo = 0,
}) {
  await query(
    `
      INSERT INTO network_task_allocations (
        id, idempotency_key, project_id, task_class, allocation_status,
        task_request_id, generated_task_id, candidate_account_id, candidate_wallet_address,
        project_need_summary, created_at
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, 'Capacity smoke need', now() - ($9::integer * interval '1 hour'))
    `,
    [allocationId, projectId, taskClass, allocationStatus, requestId, taskId, accountId, walletAddress, createdHoursAgo]
  );
}

async function seedProjection({
  taskId,
  requestId = "",
  accountId,
  walletAddress,
  status,
  title,
  rewardOfferPft = 0,
  acceptBy = null,
  deadlineAt = null,
}) {
  await query(
    `
      INSERT INTO task_projections (
        task_id, account_id, subject_wallet, request_id, status, title, task_kind, source,
        reward_offer_pft, accept_by, deadline_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'network', 'network_capacity_smoke', $7, $8, $9)
    `,
    [taskId, accountId, walletAddress, requestId, status, title, rewardOfferPft, acceptBy, deadlineAt]
  );
}

async function setProjectionStatus(taskId, status) {
  const result = await query(
    `
      UPDATE task_projections
      SET status = $2, updated_at = now()
      WHERE task_id = $1
      RETURNING task_id, request_id, status, updated_at
    `,
    [taskId, status]
  );
  assert.equal(result.rowCount, 1, `projection ${taskId} should exist before status update`);
  return result.rows[0];
}

async function allocationMirror(allocationId) {
  const result = await query(
    `
      SELECT id, allocation_status, generated_task_id, task_request_id
      FROM network_task_allocations
      WHERE id = $1
    `,
    [allocationId]
  );
  return result.rows[0] || null;
}

function boardDecision({ accountId, walletAddress, taskClass = "network", need = "Capacity smoke routing need" }) {
  return {
    action: "initiate_network_task",
    target_type: "project",
    target_id: projectId,
    reason: need,
    confidence: 0.9,
    payload: {
      summary: need,
      network_task: {
        task_work_type: "code_task",
        required_badge_id: "core_contributor",
        operating_badge_id: "core_contributor",
        badge_work_type: "code_task",
        badge_reason: "Capacity smoke uses the Core Contributor lane.",
        badge_reward_cap_pft: 30000,
        badge_evidence_requirements: ["PR or commit URL."],
        discord_evidence_required: true,
        candidate_account_id: accountId,
        candidate_wallet_address: walletAddress,
        task_class: taskClass,
        project_need_summary: need,
        allocation_reason_summary: need,
        reward_min_pft: 100,
        reward_max_pft: 100,
      },
    },
  };
}

async function executorVerdict({ accountId, walletAddress, taskClass = "network", need }) {
  try {
    const result = await enqueueNetworkTaskGenerationFromBoardDecision({
      runId: `netcap_run_${suffix}`,
      decision: boardDecision({ accountId, walletAddress, taskClass, need }),
      sourcePacket: {},
    });
    return { blocked: false, result };
  } catch (error) {
    if (error?.message === "network_task_candidate_at_capacity") return { blocked: true };
    throw error;
  }
}

async function pressureVerdict({ accountId, walletAddress }) {
  const candidates = [{ accountId, walletAddress }];
  const candidateCapacityChecks = await listNetworkTaskCandidateCapacityChecks(candidates);
  const pressure = buildBoardManagerActionPressure({
    hiveProjects: {
      projects: {
        [projectId]: { id: projectId, title: "Capacity smoke", status: "active", tasks: [], contributors: [] },
      },
    },
    networkTaskContent: { completed: [], outstanding: [], stopped: [], pendingGeneration: [] },
    networkTaskCandidates: candidates,
    candidateCapacityChecks,
    taskState: { recent: [] },
    recentBoardManagerRuns: [],
    openFollowups: [],
  });
  const row = pressure.candidateCapacity.candidates[0];
  assert.ok(row, "pressure candidateCapacity row missing");
  return { blocked: row.availableForNetworkTask === false, row, pressure };
}

async function eligibilityVerdict({ accountId, walletAddress }) {
  const eligibility = await getNetworkTaskEligibility({ accountId, walletAddress, recordCapacityEvent: false });
  return { blocked: eligibility.capacity.available === false, eligibility };
}

async function assertConsistentVerdicts({ accountId, walletAddress, taskClass = "network", need, expectBlocked }) {
  // The executor check runs last: on success it creates a real allocation,
  // which would flip the read-only eligibility/pressure verdicts afterwards.
  const eligibility = await eligibilityVerdict({ accountId, walletAddress });
  const pressure = await pressureVerdict({ accountId, walletAddress });
  const executor = await executorVerdict({ accountId, walletAddress, taskClass, need });
  assert.equal(eligibility.blocked, expectBlocked, `eligibility verdict mismatch for ${accountId}`);
  assert.equal(executor.blocked, expectBlocked, `executor verdict mismatch for ${accountId}`);
  assert.equal(pressure.blocked, expectBlocked, `pressure verdict mismatch for ${accountId}`);
  return { eligibility, executor, pressure };
}

async function main() {
  if (!databaseEnabled()) {
    console.log("network task capacity smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();
  await cleanup();
  try {
    await query(
      `
        INSERT INTO network_projects (id, type, title, summary, objective, about, status, origin, proposed_by)
        VALUES ($1, 'network_validation', 'Network capacity smoke', 'Capacity smoke',
                'Verify the shared Network Task capacity predicate.',
                'Fixture project for capacity smoke.', 'active', 'smoke', 'hive')
      `,
      [projectId]
    );
    for (const key of ["stale", "crossClass", "terminal", "syncRefused", "syncCancelled", "syncRewarded", "syncFallback"]) {
      await seedCandidate({ accountId: accounts[key], walletAddress: wallets[key] });
    }
    await seedCandidate({ accountId: accounts.wallets, walletAddress: wallets.current });

    // Case A: accepted allocation created 25h ago still blocks ALL THREE paths.
    const staleTaskId = `task_netcap_stale_${suffix}`;
    await seedAllocation({
      allocationId: `netalloc_netcap_stale_${suffix}`,
      accountId: accounts.stale,
      walletAddress: wallets.stale,
      allocationStatus: "accepted",
      taskId: staleTaskId,
      createdHoursAgo: 25,
    });
    await seedProjection({
      taskId: staleTaskId,
      accountId: accounts.stale,
      walletAddress: wallets.stale,
      status: "accepted",
      title: "Stale accepted network task",
      rewardOfferPft: 12000,
      acceptBy: "2026-06-28T12:30:00.000Z",
      deadlineAt: "2026-06-29T12:30:00.000Z",
    });
    const stale = await assertConsistentVerdicts({
      accountId: accounts.stale,
      walletAddress: wallets.stale,
      need: "stale blocker case",
      expectBlocked: true,
    });
    assert.equal(stale.eligibility.eligibility.status, "at_capacity");
    const staleBlocker = stale.eligibility.eligibility.capacity.blockers
      .find((blocker) => blocker.taskId === staleTaskId);
    assert.ok(staleBlocker, "25h-old accepted allocation missing from eligibility blockers");
    assert.equal(staleBlocker.kind, "allocation");
    assert.equal(staleBlocker.walletAddress, wallets.stale);
    assert.ok(staleBlocker.title, "blocker title missing");
    assert.ok(staleBlocker.createdAt, "blocker createdAt missing");
    assert.equal(staleBlocker.rewardOfferPft, 12000);
    assert.equal(staleBlocker.acceptBy, "2026-06-28T12:30:00.000Z");
    assert.equal(staleBlocker.deadlineAt, "2026-06-29T12:30:00.000Z");
    assert.equal(stale.pressure.row.capacityBlockers[0].taskId, staleTaskId);
    assert.equal(stale.pressure.pressure.summary.eligibleCandidateCount, 0);

    // Case B: an active allocation of a DIFFERENT task_class blocks too.
    await seedAllocation({
      allocationId: `netalloc_netcap_cross_${suffix}`,
      accountId: accounts.crossClass,
      walletAddress: wallets.crossClass,
      allocationStatus: "accepted",
      taskClass: "alpha",
    });
    const cross = await assertConsistentVerdicts({
      accountId: accounts.crossClass,
      walletAddress: wallets.crossClass,
      taskClass: "network",
      need: "cross class blocker case",
      expectBlocked: true,
    });
    assert.equal(cross.eligibility.eligibility.capacity.blockers[0].taskClass, "alpha");
    const sameClassOnly = await listNetworkTaskCapacityBlockers({
      accountId: accounts.crossClass,
      walletAddress: wallets.crossClass,
      sameClassOnly: true,
      taskClass: "network",
    });
    assert.equal(sameClassOnly.length, 0, "sameClassOnly option should scope blockers to the requested class");

    // Case C: allocation whose task projection is terminal does NOT block.
    const terminalTaskId = `task_netcap_terminal_${suffix}`;
    await seedAllocation({
      allocationId: `netalloc_netcap_terminal_${suffix}`,
      accountId: accounts.terminal,
      walletAddress: wallets.terminal,
      allocationStatus: "accepted",
      taskId: terminalTaskId,
      createdHoursAgo: 2,
    });
    await seedProjection({
      taskId: terminalTaskId,
      accountId: accounts.terminal,
      walletAddress: wallets.terminal,
      status: "refused",
      title: "Refused network task",
    });
    const terminal = await assertConsistentVerdicts({
      accountId: accounts.terminal,
      walletAddress: wallets.terminal,
      need: "terminal projection case",
      expectBlocked: false,
    });
    assert.equal(terminal.eligibility.eligibility.status, "available_for_routing");
    assert.equal(terminal.executor.result.executed, true, "executor should allocate when only terminal blockers exist");

    // Case C2: terminal transitions repair allocation mirrors immediately,
    // including request_id fallback when generated_task_id is empty.
    const refusedTaskId = `task_netcap_refused_sync_${suffix}`;
    const refusedAllocationId = `netalloc_netcap_refused_sync_${suffix}`;
    await seedAllocation({
      allocationId: refusedAllocationId,
      accountId: accounts.syncRefused,
      walletAddress: wallets.syncRefused,
      allocationStatus: "proposed",
      taskId: refusedTaskId,
    });
    await seedProjection({
      taskId: refusedTaskId,
      accountId: accounts.syncRefused,
      walletAddress: wallets.syncRefused,
      status: "proposed",
      title: "Proposed task that will be refused",
    });
    assert.equal((await listNetworkTaskAllocationDivergences({ taskId: refusedTaskId })).length, 0);
    const refusedProjection = await setProjectionStatus(refusedTaskId, "refused");
    const refusedDivergence = await listNetworkTaskAllocationDivergences({ taskId: refusedTaskId });
    assert.equal(refusedDivergence.length, 1);
    assert.equal(refusedDivergence[0].allocation_id, refusedAllocationId);
    assert.equal(refusedDivergence[0].allocation_status, "proposed");
    assert.equal(refusedDivergence[0].canonical_task_status, "refused");
    const refusedSync = await syncNetworkTaskAllocationMirrors({ projection: refusedProjection });
    assert.equal(refusedSync.allocationsUpdated, 1);
    assert.equal((await allocationMirror(refusedAllocationId)).allocation_status, "refused");
    assert.equal((await listNetworkTaskAllocationDivergences({ taskId: refusedTaskId })).length, 0);
    assert.equal(
      (await listNetworkTaskCapacityBlockers({ accountId: accounts.syncRefused, walletAddress: wallets.syncRefused }))
        .some((blocker) => blocker.taskId === refusedTaskId),
      false,
      "refused mirror should not block capacity"
    );

    const cancelledTaskId = `task_netcap_cancelled_sync_${suffix}`;
    const cancelledAllocationId = `netalloc_netcap_cancelled_sync_${suffix}`;
    await seedAllocation({
      allocationId: cancelledAllocationId,
      accountId: accounts.syncCancelled,
      walletAddress: wallets.syncCancelled,
      allocationStatus: "accepted",
      taskId: cancelledTaskId,
    });
    await seedProjection({
      taskId: cancelledTaskId,
      accountId: accounts.syncCancelled,
      walletAddress: wallets.syncCancelled,
      status: "accepted",
      title: "Accepted task that will be cancelled",
    });
    assert.equal((await listNetworkTaskAllocationDivergences({ taskId: cancelledTaskId })).length, 0);
    const cancelledProjection = await setProjectionStatus(cancelledTaskId, "cancelled");
    const cancelledDivergence = await listNetworkTaskAllocationDivergences({ taskId: cancelledTaskId });
    assert.equal(cancelledDivergence.length, 1);
    assert.equal(cancelledDivergence[0].allocation_status, "accepted");
    assert.equal(cancelledDivergence[0].canonical_task_status, "cancelled");
    const cancelledSync = await syncNetworkTaskAllocationMirrors({ projection: cancelledProjection });
    assert.equal(cancelledSync.allocationsUpdated, 1);
    assert.equal((await allocationMirror(cancelledAllocationId)).allocation_status, "cancelled");
    assert.equal((await listNetworkTaskAllocationDivergences({ taskId: cancelledTaskId })).length, 0);
    assert.equal(
      (await listNetworkTaskCapacityBlockers({ accountId: accounts.syncCancelled, walletAddress: wallets.syncCancelled }))
        .some((blocker) => blocker.taskId === cancelledTaskId),
      false,
      "cancelled mirror should not block capacity"
    );

    const rewardedTaskId = `task_netcap_rewarded_sync_${suffix}`;
    const rewardedAllocationId = `netalloc_netcap_rewarded_sync_${suffix}`;
    await seedAllocation({
      allocationId: rewardedAllocationId,
      accountId: accounts.syncRewarded,
      walletAddress: wallets.syncRewarded,
      allocationStatus: "proposed",
      taskId: rewardedTaskId,
    });
    await seedProjection({
      taskId: rewardedTaskId,
      accountId: accounts.syncRewarded,
      walletAddress: wallets.syncRewarded,
      status: "proposed",
      title: "Proposed task that will be rewarded",
    });
    assert.equal((await listNetworkTaskAllocationDivergences({ taskId: rewardedTaskId })).length, 0);
    const rewardedProjection = await setProjectionStatus(rewardedTaskId, "rewarded");
    const rewardedDivergence = await listNetworkTaskAllocationDivergences({ taskId: rewardedTaskId });
    assert.equal(rewardedDivergence.length, 1);
    assert.equal(rewardedDivergence[0].allocation_status, "proposed");
    assert.equal(rewardedDivergence[0].canonical_task_status, "rewarded");
    const rewardedSync = await syncNetworkTaskAllocationMirrors({ projection: rewardedProjection });
    assert.equal(rewardedSync.allocationsUpdated, 1);
    assert.equal((await allocationMirror(rewardedAllocationId)).allocation_status, "rewarded");
    assert.equal((await listNetworkTaskAllocationDivergences({ taskId: rewardedTaskId })).length, 0);

    const requestFallbackTaskId = `task_netcap_request_fallback_${suffix}`;
    const requestFallbackId = `req_netcap_request_fallback_${suffix}`;
    const requestFallbackAllocationId = `netalloc_netcap_request_fallback_${suffix}`;
    await seedAllocation({
      allocationId: requestFallbackAllocationId,
      accountId: accounts.syncFallback,
      walletAddress: wallets.syncFallback,
      allocationStatus: "proposed",
      requestId: requestFallbackId,
    });
    await seedProjection({
      taskId: requestFallbackTaskId,
      requestId: requestFallbackId,
      accountId: accounts.syncFallback,
      walletAddress: wallets.syncFallback,
      status: "proposed",
      title: "Request-linked proposed task",
    });
    const requestFallbackProjection = await setProjectionStatus(requestFallbackTaskId, "refused");
    const requestFallbackSync = await syncNetworkTaskAllocationMirrors({ projection: requestFallbackProjection });
    assert.equal(requestFallbackSync.allocationsUpdated, 1, "empty generated_task_id should use request fallback");
    assert.equal((await allocationMirror(requestFallbackAllocationId)).allocation_status, "refused");

    // Case D: old-wallet allocation (wallet no longer linked) does NOT block
    // the current wallet; an account-scoped allocation DOES.
    await seedAllocation({
      allocationId: `netalloc_netcap_oldwallet_${suffix}`,
      accountId: accounts.wallets,
      walletAddress: wallets.old,
      allocationStatus: "accepted",
      createdHoursAgo: 3,
    });
    const afterOldWallet = await eligibilityVerdict({ accountId: accounts.wallets, walletAddress: wallets.current });
    assert.equal(afterOldWallet.blocked, false, "delinked old-wallet allocation must not block the current wallet");
    const oldWalletPressure = await pressureVerdict({ accountId: accounts.wallets, walletAddress: wallets.current });
    assert.equal(oldWalletPressure.blocked, false);

    await seedAllocation({
      allocationId: `netalloc_netcap_accountscope_${suffix}`,
      accountId: accounts.wallets,
      walletAddress: "",
      allocationStatus: "queued",
      createdHoursAgo: 1,
    });
    const accountScoped = await assertConsistentVerdicts({
      accountId: accounts.wallets,
      walletAddress: wallets.current,
      need: "account scoped blocker case",
      expectBlocked: true,
    });
    const accountBlockers = accountScoped.eligibility.eligibility.capacity.blockers;
    assert.equal(accountBlockers.length, 1, "only the account-scoped allocation should block the current wallet");
    assert.equal(accountBlockers[0].walletAddress, "", "account-scoped blocker should report an empty wallet");
    assert.equal(accountBlockers[0].kind, "allocation");

    console.log("network task capacity smoke ok");
  } finally {
    await cleanup();
  }
}

try {
  await main();
} finally {
  await closePool();
}

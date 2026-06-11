import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  listNetworkTaskCapacityBlockers,
  listNetworkTaskCandidateCapacityChecks,
} from "../server/repositories/network-task-capacity.js";
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
  wallets: `acct_netcap_wallets_${suffix}`,
};
const wallets = {
  stale: `rNetCapStale${suffix}`,
  crossClass: `rNetCapCross${suffix}`,
  terminal: `rNetCapTerminal${suffix}`,
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
}

async function seedAllocation({
  allocationId,
  accountId,
  walletAddress,
  allocationStatus = "accepted",
  taskClass = "network",
  taskId = "",
  createdHoursAgo = 0,
}) {
  await query(
    `
      INSERT INTO network_task_allocations (
        id, idempotency_key, project_id, task_class, allocation_status,
        generated_task_id, candidate_account_id, candidate_wallet_address,
        project_need_summary, created_at
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, 'Capacity smoke need', now() - ($8::integer * interval '1 hour'))
    `,
    [allocationId, projectId, taskClass, allocationStatus, taskId, accountId, walletAddress, createdHoursAgo]
  );
}

async function seedProjection({ taskId, accountId, walletAddress, status, title }) {
  await query(
    `
      INSERT INTO task_projections (task_id, account_id, subject_wallet, status, title, task_kind, source)
      VALUES ($1, $2, $3, $4, $5, 'network', 'network_capacity_smoke')
    `,
    [taskId, accountId, walletAddress, status, title]
  );
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
        candidate_account_id: accountId,
        candidate_wallet_address: walletAddress,
        task_class: taskClass,
        project_need_summary: need,
        allocation_reason_summary: need,
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
    for (const key of ["stale", "crossClass", "terminal"]) {
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

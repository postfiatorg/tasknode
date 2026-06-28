#!/usr/bin/env node

import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
process.env.TASKNODE_TASK_ACCOUNTING_HARVESTER_PROVIDER_MOCK = "true";
process.env.TASKNODE_TASK_ACCOUNTING_HARVESTER_BATCH_LIMIT = "10";

const { closePool, databaseEnabled, query } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const { runTaskAccountingHarvesterOnce } = await import("../server/task-accounting-harvester-worker.js");
const {
  accountCanResolveCheckedOutTaskAccountingHarvest,
  accountHasTaskAccountingCheckoutAccess,
  checkoutTaskAccountingHarvest,
  getLatestTaskAccountingHarvestReport,
  getTaskAccountingCheckoutAccess,
  listTaskAccountingHarvests,
  listTaskAccountingHarvestCheckouts,
  resolveTaskAccountingHarvest,
  taskAccountingHarvestOrderSql,
} = await import("../server/repositories/task-accounting-harvester.js");

const suffix = `${Date.now()}`;
const actionableTaskId = `task_accounting_action_${suffix}`;
const noActionTaskId = `task_accounting_done_${suffix}`;
const notBugTaskId = `task_accounting_not_bug_${suffix}`;
const smokeTaskIds = [actionableTaskId, noActionTaskId, notBugTaskId];
const accountId = `acct_task_accounting_${suffix}`;
const wallet = `rTaskAccounting${suffix}`.slice(0, 120);
const orcAccountId = `acct_task_accounting_orc_${suffix}`;
const orcWallet = `rTaskAccountingOrc${suffix}`.slice(0, 120);
const orcAgentId = `orc_task_accounting_${suffix}`;

async function cleanup() {
  await query("DELETE FROM task_accounting_harvest_reports WHERE source_task_ids_json ?| $1::text[]", [smokeTaskIds]);
  await query("DELETE FROM task_accounting_harvests WHERE task_id = ANY($1::text[])", [smokeTaskIds]);
  await query("DELETE FROM account_network_badges WHERE account_id = $1 AND badge_id = 'core_contributor'", [accountId]);
  await query("DELETE FROM orc_agents WHERE id = $1", [orcAgentId]);
  await query("DELETE FROM task_events WHERE task_id = ANY($1::text[])", [smokeTaskIds]);
  await query("DELETE FROM task_projections WHERE task_id = ANY($1::text[])", [smokeTaskIds]);
}

async function grantCoreContributorBadge() {
  await query(
    `
      INSERT INTO account_network_badges (
        id,
        account_id,
        badge_id,
        status,
        verified_by_operator,
        evidence_url_or_ref
      )
      VALUES ($1, $2, 'core_contributor', 'verified', 'task_accounting_harvester_smoke', 'smoke')
      ON CONFLICT (account_id, badge_id) DO UPDATE SET
        status = EXCLUDED.status,
        revoked_at = NULL,
        expires_at = NULL,
        verified_by_operator = EXCLUDED.verified_by_operator,
        evidence_url_or_ref = EXCLUDED.evidence_url_or_ref,
        updated_at = now()
    `,
    [`badge_${accountId}_core`, accountId]
  );
}

async function grantActiveOrcAgent() {
  await query(
    `
      INSERT INTO orc_agents (
        id,
        handle,
        agent_id,
        account_id,
        wallet_address,
        role,
        status,
        active,
        runtime_kind,
        metadata_json
      )
      VALUES ($1, 'task_accounting_orc_smoke', 'task_accounting_orc_smoke', $2, $3, 'operator', 'active', true, 'codex', $4::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        wallet_address = EXCLUDED.wallet_address,
        status = EXCLUDED.status,
        active = EXCLUDED.active,
        updated_at = now()
    `,
    [orcAgentId, orcAccountId, orcWallet, JSON.stringify({ smoke: true })]
  );
}

async function insertRewardedTask({ taskId, title, description, requirement, reward }) {
  const occurredAt = taskId === actionableTaskId
    ? new Date("2000-01-01T00:00:00.000Z")
    : new Date("2000-01-02T00:00:00.000Z");
  await query(
    `
      INSERT INTO task_projections (
        task_id, account_id, subject_wallet, request_id, status, title, description,
        task_kind, reward_offer_pft, reward_actual_pft, submission_requirement_text,
        event_count, last_event_tx_hash, last_event_cid, last_event_at, source, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'rewarded', $5, $6, 'Network', $7, $7, $8,
        1, $9, $10, $11, 'task_accounting_harvester_smoke', $11
      )
    `,
    [
      taskId,
      accountId,
      wallet,
      `req_${taskId}`,
      title,
      description,
      reward,
      requirement,
      `tx_${taskId}`,
      `cid_${taskId}`,
      occurredAt,
    ]
  );
  await query(
    `
      INSERT INTO task_events (
        id, task_id, account_id, wallet_address, event_type,
        source_tx_hash, source_cid, payload_json, occurred_at, created_at
      )
      VALUES ($1, $2, $3, $4, 'pf.reward.v1', $5, $6, $7::jsonb, $8, $8)
    `,
    [
      `evt_${taskId}`,
      taskId,
      accountId,
      wallet,
      `tx_${taskId}`,
      `cid_${taskId}`,
      JSON.stringify({ schema: "pf.reward.v1", task_id: taskId, reward_pft: reward }),
      occurredAt,
    ]
  );
}

async function main() {
  assert.match(
    taskAccountingHarvestOrderSql({ resolvedFilter: "true" }),
    /harvest\.resolved_at DESC NULLS LAST/,
    "resolved harvest history sorts by resolution timestamp"
  );
  assert.doesNotMatch(
    taskAccountingHarvestOrderSql({ resolvedFilter: "true" }),
    /harvest\.requires_action DESC/,
    "resolved harvest history does not use unresolved queue priority ordering"
  );
  assert.match(
    taskAccountingHarvestOrderSql({ resolvedFilter: "false" }),
    /harvest\.requires_action DESC/,
    "unresolved harvest queue keeps action-priority ordering"
  );

  if (!databaseEnabled()) {
    console.log("task-accounting-harvester-smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();
  await cleanup();
  try {
    const baselineHarvestReport = await getLatestTaskAccountingHarvestReport({ generate: true });
    const baselineResolvedCount = Number(baselineHarvestReport.summary?.resolved || baselineHarvestReport.report?.resolvedCount || 0);
    const nextReportIn = 3 - (baselineResolvedCount % 3 || 0);
    await insertRewardedTask({
      taskId: actionableTaskId,
      title: "Reward routing bug report",
      description: "The task identified a bug where reward accounting totals could display stale values after payment.",
      requirement: "Submit the reproduction details and recommended owner for follow-up.",
      reward: 30000,
    });
    await insertRewardedTask({
      taskId: noActionTaskId,
      title: "Standalone contributor completion",
      description: "The task output was a self-contained completion packet with no separate follow-up signal.",
      requirement: "Submit the completed packet.",
      reward: 100,
    });
    await insertRewardedTask({
      taskId: notBugTaskId,
      title: "Expected task state display",
      description: "The task reported behavior that later review found was intended behavior for closed rows.",
      requirement: "Submit the observed task state and whether it should change.",
      reward: 50,
    });

    const run = await runTaskAccountingHarvesterOnce();
    assert.equal(run.ok, true, JSON.stringify(run.errors || []));
    assert.ok(run.queued >= 3, "rewarded Network tasks were queued");
    const processedSmokeTaskIds = run.processed.map((row) => row.taskId).filter((taskId) => smokeTaskIds.includes(taskId));
    assert.deepEqual(
      processedSmokeTaskIds.sort(),
      [...smokeTaskIds].sort(),
      "three smoke harvest rows processed"
    );

    const listed = await listTaskAccountingHarvests({ limit: 20 });
    const rows = listed.harvests.filter((row) => smokeTaskIds.includes(row.taskId));
    assert.equal(rows.length, 3, "all harvest rows are listable");
    const actionable = rows.find((row) => row.taskId === actionableTaskId);
    const noAction = rows.find((row) => row.taskId === noActionTaskId);
    assert.equal(actionable.classification, "requires_action");
    assert.equal(actionable.requiresAction, true);
    assert.ok(actionable.suggestedAction, "actionable row stores suggested action");
    assert.match(
      actionable.suggestedAction,
      /Investigate|Implement|Update|Add|Run/,
      "actionable bug-like rows request investigation/fix work instead of QA paperwork"
    );
    assert.equal(noAction.classification, "no_action");
    assert.equal(noAction.requiresAction, false);
    assert.equal(listed.summary.harvested >= 2, true, "summary includes harvested count");

    assert.equal(
      await accountHasTaskAccountingCheckoutAccess({ accountId }),
      false,
      "checkout access requires a Core Contributor badge"
    );
    await grantActiveOrcAgent();
    const orcAccess = await getTaskAccountingCheckoutAccess({
      accountId: orcAccountId,
      walletAddress: orcWallet,
    });
    assert.equal(orcAccess.canCheckout, true, "active Orc agent grants checkout access");
    assert.equal(orcAccess.hasActiveOrcAgent, true, "active Orc agent flag is exposed");
    assert.equal(
      await accountHasTaskAccountingCheckoutAccess({ accountId: orcAccountId, walletAddress: orcWallet }),
      true,
      "active Orc agent is accepted by the legacy boolean helper"
    );
    await grantCoreContributorBadge();
    assert.equal(
      await accountHasTaskAccountingCheckoutAccess({ accountId }),
      true,
      "verified Core Contributor badge grants checkout access"
    );
    const checkout = await checkoutTaskAccountingHarvest({
      taskId: actionableTaskId,
      accountId,
      walletAddress: wallet,
      metadata: { smoke: true },
    });
    assert.equal(checkout.ok, true);
    assert.equal(checkout.harvest.checkedOut, true);
    assert.equal(checkout.harvest.checkout.walletAddress, wallet);
    assert.equal(
      await accountCanResolveCheckedOutTaskAccountingHarvest({ taskId: actionableTaskId, accountId, walletAddress: wallet }),
      true,
      "eligible checkout owner can resolve their checked-out harvest"
    );
    const checkoutLog = await listTaskAccountingHarvestCheckouts({ limit: 20 });
    const checkoutEvent = checkoutLog.events.find((event) => event.taskId === actionableTaskId);
    assert.ok(checkoutEvent, "checkout log includes the checked-out harvest");
    assert.equal(checkoutEvent.walletAddress, wallet);
    assert.equal(checkoutEvent.current, true);

    const invalidResolved = await resolveTaskAccountingHarvest({
      taskId: actionableTaskId,
      resolvedByAccountId: accountId,
      outcome: "fixed",
      note: "Resolved by creating a tracker-ready QA packet for the reported issue.",
    });
    assert.equal(invalidResolved.ok, false, "paperwork-only artifacts cannot close harvest rows");
    assert.equal(invalidResolved.error, "task_accounting_harvest_resolution_not_a_fix");

    const resolutionNote = "Fixed by smoke test: changed reward accounting display behavior and verified it with TASKNODE-SMOKE-1 regression coverage.";
    const resolved = await resolveTaskAccountingHarvest({
      taskId: actionableTaskId,
      resolvedByAccountId: accountId,
      outcome: "fixed",
      note: resolutionNote,
    });
    const resolutionResults = [resolved];
    assert.equal(resolved.ok, true);
    assert.equal(resolved.harvest.resolved, true);
    assert.equal(resolved.harvest.resolutionOutcome, "fixed");
    assert.equal(resolved.harvest.resolutionNote, resolutionNote);
    assert.equal(resolved.harvest.checkedOut, false, "resolved harvest releases checkout ownership");
    assert.equal(resolved.harvest.checkout.checkedOut, false, "resolved harvest checkout object is inactive");
    assert.equal(
      await accountCanResolveCheckedOutTaskAccountingHarvest({ taskId: actionableTaskId, accountId, walletAddress: wallet }),
      false,
      "resolved checkout owner no longer has active checkout resolver rights"
    );
    const activeCheckoutLog = await listTaskAccountingHarvestCheckouts({ limit: 20 });
    assert.equal(
      activeCheckoutLog.events.some((event) => event.taskId === actionableTaskId),
      false,
      "default checkout log hides resolved checkout events"
    );
    const fullCheckoutLog = await listTaskAccountingHarvestCheckouts({ includeResolved: true, limit: 20 });
    const resolvedCheckoutEvent = fullCheckoutLog.events.find((event) => event.taskId === actionableTaskId);
    assert.ok(resolvedCheckoutEvent, "includeResolved checkout log can audit the old checkout event");
    assert.equal(resolvedCheckoutEvent.current, false, "resolved checkout event is not current");
    assert.equal(resolvedCheckoutEvent.resolved, true, "resolved checkout event is marked resolved");

    const noActionResolution = await resolveTaskAccountingHarvest({
      taskId: noActionTaskId,
      resolvedByAccountId: accountId,
      outcome: "fixed",
      note: "Fixed by smoke test: verified standalone completion rows can be resolved and sorted by resolved_at in TASKNODE-SMOKE-2 regression coverage.",
    });
    resolutionResults.push(noActionResolution);
    assert.equal(noActionResolution.ok, true);

    const notBugResolution = await resolveTaskAccountingHarvest({
      taskId: notBugTaskId,
      resolvedByAccountId: accountId,
      outcome: "not_a_bug",
      note: "Closed as not a bug by smoke test: the observed closed-row state is intended behavior and does not require a product change.",
    });
    resolutionResults.push(notBugResolution);
    assert.equal(notBugResolution.ok, true);
    const boundaryResolution = resolutionResults[nextReportIn - 1];
    assert.equal(boundaryResolution.harvestReportGenerated, true, "Harvest Report generates at the next three-resolution boundary");
    assert.ok(boundaryResolution.harvestReport?.bodyMarkdown, "generated Harvest Report has markdown");
    assert.match(boundaryResolution.harvestReport.bodyMarkdown, /## Overall BLUF/);
    assert.match(boundaryResolution.harvestReport.bodyMarkdown, /## Key Issues Resolved/);
    assert.match(boundaryResolution.harvestReport.bodyMarkdown, /## Solutions And Deployment/);
    assert.match(boundaryResolution.harvestReport.bodyMarkdown, /## Productive Takeaways/);
    assert.match(boundaryResolution.harvestReport.bodyMarkdown, /## Initiators And What They Need To Know/);
    assert.ok(
      boundaryResolution.harvestReport.sourceTaskIds.includes(smokeTaskIds[nextReportIn - 1]),
      "Harvest Report source task IDs include the smoke row that crossed the boundary"
    );
    await query(
      `
        UPDATE task_accounting_harvests
        SET resolved_at = CASE
          WHEN task_id = $1 THEN now() - interval '2 hours'
          WHEN task_id = $2 THEN now() - interval '1 hour'
          WHEN task_id = $3 THEN now()
          ELSE resolved_at
        END
        WHERE task_id = ANY(ARRAY[$1, $2, $3]::text[])
      `,
      [actionableTaskId, noActionTaskId, notBugTaskId]
    );

    const unresolvedList = await listTaskAccountingHarvests({ limit: 20 });
    assert.equal(
      unresolvedList.harvests.some((row) => row.taskId === actionableTaskId),
      false,
      "default harvest list hides resolved rows"
    );
    const resolvedList = await listTaskAccountingHarvests({ resolved: "true", limit: 20 });
    const resolvedRow = resolvedList.harvests.find((row) => row.taskId === actionableTaskId);
    assert.ok(resolvedRow, "resolved=true lists resolved rows");
    assert.equal(resolvedRow.resolutionNote, resolutionNote);
    assert.deepEqual(
      resolvedList.harvests
        .filter((row) => smokeTaskIds.includes(row.taskId))
        .map((row) => row.taskId),
      [notBugTaskId, noActionTaskId, actionableTaskId],
      "resolved history is sorted by resolved_at descending"
    );

    console.log("task-accounting-harvester-smoke ok");
  } finally {
    await cleanup();
    await closePool();
  }
}

main().catch(async (error) => {
  await closePool().catch(() => null);
  console.error(error);
  process.exitCode = 1;
});

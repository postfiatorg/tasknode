import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import {
  listTaskProjectionCounts, listTaskProjectionRewards, listTaskProjectionTasks, listTaskState,
} from "../server/repositories/tasks.js";
import { taskIsTerminal, taskStatusTab } from "../shared/task-lifecycle.js";
import { reconcileTaskVisibleState } from "../src/features/tasks/task-visible-state.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
process.env.TASKNODE_DATABASE_ENABLED = "true";
await migrateDatabase();
const cases = JSON.parse(readFileSync(new URL("./fixtures/task-active-history-window.json", import.meta.url)));
const suffix = randomUUID().slice(0, 8);
const failures = [];
const reports = [];
function order(rows) {
  return [...rows].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
function counts(rows) {
  const result = { outstanding: 0, verification: 0, refused: 0, rewarded: 0 };
  for (const row of rows) result[taskStatusTab(row.status)] += 1;
  return result;
}
const ids = (tasks) => tasks.map((task) => task.taskId).sort();

try {
  for (const [index, fixture] of cases.entries()) {
    const owner = `acct_history_${suffix}_${index}`;
    const wallet = `rHistoryFixture${suffix}${index}`;
    const prefix = `task_history_${suffix}_${index}_`;
    const start = Date.parse("2026-01-01T00:00:00Z");
    const rows = [];
    for (let i = 0; i < fixture.history; i += 1) {
      rows.push({ id: `${prefix}h${String(i).padStart(4, "0")}`, owner, wallet,
        status: fixture.mixedTerminal && i % 2 ? "refused" : "rewarded",
        time: start + 10000 + i * 1000 });
    }
    for (const [i, status] of fixture.live.entries()) {
      rows.push({ id: `${prefix}l${String(i).padStart(4, "0")}`, owner, wallet, status,
        time: fixture.liveRecent ? start + 1000000 + i * 1000 : start + i * 1000 });
    }
    if (fixture.newReward) rows.push({ id: `${prefix}new`, owner, wallet, status: "rewarded", time: start + 2000000 });
    if (fixture.foreignAccount) rows.push({ id: `${prefix}foreign_account`, owner: `${owner}_other`, wallet, status: "accepted", time: start + 3000000 });
    if (fixture.foreignWallet) rows.push({ id: `${prefix}foreign_wallet`, owner, wallet: `${wallet}Other`, status: "verification_requested", time: start + 3000000 });
    if (fixture.tieDates) for (const row of rows) row.time = start;
    // Every row is synthetic; there are no legacy entries for these wallets.
    await query(`INSERT INTO task_projections
      (task_id, account_id, subject_wallet, status, title, reward_offer_pft, reward_actual_pft, source, updated_at)
      SELECT item->>'id', item->>'owner', item->>'wallet', item->>'status', 'Synthetic history regression', 1, 1,
        'direct_write', (item->>'time')::timestamptz
      FROM jsonb_array_elements($1::jsonb) item`,
    [JSON.stringify(rows.map((row) => ({ ...row, time: new Date(row.time).toISOString() })))]);
    const accountId = fixture.walletOnly ? "" : owner;
    const input = { accountId, walletAddress: wallet };
    const scoped = order(rows.filter((row) => row.wallet === wallet && (!accountId || row.owner === accountId)));
    const expected = (limit) => {
      const recent = scoped.slice(0, limit);
      const present = new Set(recent.map((row) => row.id));
      return order([...recent, ...scoped.filter((row) => !present.has(row.id) && !taskIsTerminal(row.status))]);
    };
    const state = await listTaskState(input);
    const counted = await listTaskProjectionCounts(input);
    const listed = await listTaskProjectionTasks({ ...input, limit: fixture.listLimit || 200 });
    const verifierList = await listTaskProjectionTasks({ ...input, tab: "verification", limit: fixture.listLimit || 200 });
    const rewards = await listTaskProjectionRewards({ ...input, limit: 50 });
    const visible = reconcileTaskVisibleState({ ...input, linkedWalletAddress: wallet, tasks: state, nowMs: start + 4000000 });
    const expectedRows = expected(200);
    const expectedList = expected(fixture.listLimit || 200);
    const recentRewards = scoped.slice(0, 200).filter((row) => taskStatusTab(row.status) === "rewarded").slice(0, 50);
    const failed = [];
    const check = (name, actual, wanted) => {
      try { assert.deepEqual(actual, wanted); } catch { failed.push(name); }
    };
    for (const tab of ["outstanding", "verification", "refused", "rewarded"]) {
      check(`browser-${tab}`, ids(state[tab]), expectedRows.filter((row) => taskStatusTab(row.status) === tab).map((row) => row.id).sort());
    }
    check("terminal-counts", counted.counts, counts(expectedRows));
    check("visible-counts", visible.counts, counts(expectedRows));
    check("projection-count", state.sync.projectionCount, expectedRows.length);
    check("legacy-empty", state.sync.legacyHistoryCount, 0);
    check("CLI-outstanding", ids(listed.tasks), expectedList.filter((row) => taskStatusTab(row.status) === "outstanding").map((row) => row.id).sort());
    check("CLI-verification", ids(verifierList.tasks), expectedList.filter((row) => taskStatusTab(row.status) === "verification").map((row) => row.id).sort());
    check("CLI-loaded-counts", listed.counts, counts(expectedList));
    check("reward-list-unchanged", ids(rewards.rewards), recentRewards.map((row) => row.id).sort());
    check("deterministic-order", [...state.outstanding, ...state.verification, ...state.refused, ...state.rewarded].length,
      new Set([...state.outstanding, ...state.verification, ...state.refused, ...state.rewarded].map((task) => task.taskId)).size);
    const report = { case: fixture.id, pass: failed.length === 0, failed, actualCounts: counted.counts,
      expectedCounts: counts(expectedRows), actualLoaded: state.sync.projectionCount, expectedLoaded: expectedRows.length,
      newestRewardVisible: fixture.newReward ? state.rewarded.some((task) => task.taskId === `${prefix}new`) : null };
    reports.push(report);
    console.log(JSON.stringify(report));
    if (failed.length) failures.push(fixture.id);
    await query("DELETE FROM task_projections WHERE task_id LIKE $1", [`${prefix}%`]);
  }
  console.log(JSON.stringify({ schema: "task-active-history-regression.v1", cases: reports.length, passed: reports.length - failures.length, failures }));
  assert.equal(failures.length, 0, "active projections must remain visible beyond the bounded history window");
} finally {
  await query("DELETE FROM task_projections WHERE task_id LIKE $1", [`task_history_${suffix}_%`]);
  await closePool();
}

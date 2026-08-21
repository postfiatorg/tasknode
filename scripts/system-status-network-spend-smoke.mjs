import assert from "node:assert/strict";

import {
  networkTaskSpendWindowDays,
  readNetworkTaskSpendByDay,
} from "../server/system-status.js";
import { canonicalRewardedTaskProjectionSql } from "../server/repositories/task-projection-integrity.js";

assert.equal(networkTaskSpendWindowDays(), 30);
assert.equal(networkTaskSpendWindowDays(0), 1);
assert.equal(networkTaskSpendWindowDays(999), 90);
assert.equal(networkTaskSpendWindowDays("not-a-number"), 30);

const calls = [];
const document = await readNetworkTaskSpendByDay({
  tables: new Map([["task_projections", true]]),
  days: 999,
  databaseReady: true,
  queryImpl: async (sql, params = []) => {
    calls.push({ sql, params });
    assert.deepEqual(params, [90]);
    assert.match(sql, /FROM task_projections p/);
    assert.match(sql, /p\.status = 'rewarded'/);
    assert.match(sql, /task_kind/);
    assert.match(sql, /'network'/);
    assert.match(sql, /GROUP BY reward_day/);
    assert.match(sql, /ORDER BY reward_day DESC/);
    assert.match(sql, /last_event_at/);
    assert.match(sql, /updated_at/);
    const canonical = canonicalRewardedTaskProjectionSql("p").replace(/\s+/g, " ").trim();
    const compactSql = sql.replace(/\s+/g, " ").trim();
    assert.ok(
      compactSql.includes(canonical),
      "network spend query must reuse canonical rewarded task projection predicate"
    );
    return {
      rows: [
        { date: "2026-06-19", total_pft: "12.5", task_count: 2 },
        { date: "2026-06-18", total_pft: "7", task_count: 1 },
      ],
    };
  },
});

assert.equal(calls.length, 1);
assert.equal(document.ok, true);
assert.equal(document.enabled, true);
assert.equal(document.windowDays, 90);
assert.deepEqual(document.rows, [
  { date: "2026-06-19", totalPft: 12.5, taskCount: 2 },
  { date: "2026-06-18", totalPft: 7, taskCount: 1 },
]);
assert.deepEqual(document.totals, { totalPft: 19.5, taskCount: 3 });

const unavailable = await readNetworkTaskSpendByDay({
  tables: new Map(),
  databaseReady: false,
});
assert.equal(unavailable.enabled, false);
assert.deepEqual(unavailable.rows, []);
assert.deepEqual(unavailable.totals, { totalPft: 0, taskCount: 0 });

console.log("system status network spend smoke ok");

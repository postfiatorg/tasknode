import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const { readAgentActivity } = await import("../server/system-status.js");

const disabled = await readAgentActivity({ databaseReady: false });
assert.equal(disabled.ok, true);
assert.equal(disabled.enabled, false);
assert.equal(disabled.reason, "database_disabled");
assert.deepEqual(disabled.agents, []);

const missing = await readAgentActivity({
  databaseReady: true,
  tables: new Map([["task_projections", true]]),
  queryImpl: async () => {
    throw new Error("query should not run when orc_agents is missing");
  },
});
assert.equal(missing.enabled, false);
assert.equal(missing.reason, "orc_agents_missing");

const calls = [];
const document = await readAgentActivity({
  databaseReady: true,
  tables: new Map([
    ["orc_agents", true],
    ["orc_work_journal", true],
    ["task_projections", true],
  ]),
  limit: 99,
  queryImpl: async (sql, params = []) => {
    calls.push({ sql, params });
    assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(sql), false);
    assert.deepEqual(params, [48]);
    if (/count\(p\.task_id\) FILTER/.test(sql)) {
      assert.match(sql, /FROM orc_agents/);
      assert.match(sql, /LEFT JOIN task_projections/);
      assert.match(sql, /LIMIT \$1/);
      return {
        rows: [
          {
            id: "orc_agent_grashnuk",
            handle: "grashnuk",
            agent_id: "agent_grashnuk",
            account_id: "acct_grashnuk",
            wallet_address: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
            role: "operator",
            status: "active",
            active: true,
            updated_at: "2026-06-19T20:00:00.000Z",
            rewarded_task_count: 2,
            reward_actual_pft: "42.5",
          },
          {
            id: "orc_agent_burzghash",
            handle: "burzghash",
            agent_id: "agent_burzghash",
            account_id: "acct_burzghash",
            wallet_address: "rh8jpDYBeYyVKPzxaAFzMfxSSdRaCaenSt",
            role: "operator",
            status: "idle",
            active: true,
            updated_at: "2026-06-19T19:00:00.000Z",
            rewarded_task_count: 0,
            reward_actual_pft: "0",
          },
        ],
      };
    }
    if (/row_number\(\) OVER/.test(sql) && /JOIN task_projections/.test(sql)) {
      assert.match(sql, /status IN/);
      assert.match(sql, /rank <= CASE WHEN status = 'rewarded' THEN 3 ELSE 5 END/);
      return {
        rows: [
          {
            agent_id: "orc_agent_grashnuk",
            task_id: "task_current",
            title: "Patch a Hive task popout regression",
            status: "accepted",
            task_kind: "network",
            reward_offer_pft: "15000",
            reward_actual_pft: "0",
            updated_at: "2026-06-19T20:10:00.000Z",
          },
          {
            agent_id: "orc_agent_grashnuk",
            task_id: "task_rewarded",
            title: "Write a compact review packet",
            status: "rewarded",
            task_kind: "network",
            reward_offer_pft: "35000",
            reward_actual_pft: "35000",
            updated_at: "2026-06-19T18:10:00.000Z",
          },
        ],
      };
    }
    if (/orc_work_journal journal/.test(sql)) {
      assert.match(sql, /rank <= 5/);
      assert.match(sql, /lower\(journal\.operator_handle\) = lower\(agents\.wallet_address\)/);
      assert.match(sql, /lower\(journal\.operator_handle\) = lower\(agents\.account_id\)/);
      return {
        rows: [
          {
            agent_id: "orc_agent_grashnuk",
            task_action: "task_submission",
            status: "recorded",
            outcome_status: "submitted",
            blocker: "",
            source_task_id: "task_current",
            followup_task_id: "",
            tx_hash: "ABC123",
            event_cid: "QmCid",
            created_at: "2026-06-19T20:12:00.000Z",
          },
          {
            agent_id: "orc_agent_grashnuk",
            task_action: "hive_signal",
            status: "recorded",
            outcome_status: "sent",
            blocker: "",
            source_task_id: "task_signal",
            followup_task_id: "",
            tx_hash: "",
            event_cid: "",
            created_at: "2026-06-19T20:13:00.000Z",
          },
        ],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});

assert.equal(calls.length, 3);
assert.equal(document.ok, true);
assert.equal(document.enabled, true);
assert.deepEqual(document.summary, {
  agentCount: 2,
  activeAgentCount: 2,
  currentTaskCount: 1,
  recentActionCount: 2,
  rewardedTaskCount: 2,
  rewardActualPft: 42.5,
});

const grashnuk = document.agents.find((agent) => agent.handle === "grashnuk");
assert.equal(grashnuk.currentTask.taskId, "task_current");
assert.equal(grashnuk.currentTask.status, "accepted");
assert.equal(grashnuk.recentActions[0].action, "task_submission");
assert.equal(grashnuk.recentActions[0].outcomeStatus, "submitted");
assert.equal(grashnuk.recentActions[1].action, "hive_signal");
assert.equal(grashnuk.recentActions[1].outcomeStatus, "sent");
assert.equal(grashnuk.rewards.taskCount, 2);
assert.equal(grashnuk.rewards.totalPft, 42.5);
assert.equal(grashnuk.rewards.recent[0].taskId, "task_rewarded");

const burzghash = document.agents.find((agent) => agent.handle === "burzghash");
assert.equal(burzghash.currentTask, null);
assert.deepEqual(burzghash.recentActions, []);

console.log("system status agent activity smoke ok");

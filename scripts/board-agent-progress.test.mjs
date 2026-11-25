import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

// Regression coverage for the 2026-09-20 verification stall: a task must not
// sit unresolved because the manager repeats a rejected command, the supervisor
// keeps closing answered rounds, or an idle worker waits out a stale timer.
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_DATABASE_DISABLED = "false";
process.env.TASKNODE_POSTGRES_DISABLED = "false";
const { recordAgentDecision, wakeDecisionWorker, workerForDecisionKind } = await import("../server/repositories/bm-decisions.js");
const { parseRecurringBlockers } = await import("../server/board-agent-runtime-status.js");
const { remoteBoardCommand } = await import("../scripts/bm/remote.mjs");
const { trackRecurringBlockers, recurringBlockers, escalationDirective, recurringSummary, RECURRING_BLOCKER_ROUNDS, busyBlockedDecision, BUSY_ALERT_MS, BUSY_INTERRUPT_MS } = await import("../ops/bm-runtime/supervisor.mjs");
const { recentlyBlockedWanted, wantedStillBlocked, WANTED_BLOCKED_COOLDOWN_HOURS, DUTY_OUTCOMES } = await import("../server/board-agent-rounds.js");
const { wantedDuties, reservedPreferredSlots } = await import("../server/board-task-policy.js");
const { evaluateAllocationHealth, readAllocationHealth, allocationHealthLines } = await import("../server/allocation-health.js");
const { closePool } = await import("../server/db/pool.js");

const taskId = "task_progress_fixture";

test("a new pending decision clears the idle matching worker's backoff and nothing else", async (t) => {
  const calls = [];
  t.mock.method(pg.Pool.prototype, "query", async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("UPDATE bm_agent_decisions")) return { rows: [] };
    if (sql.includes("INSERT INTO bm_agent_decisions")) return { rows: [{ id: params[0], kind: params[1], status: params[12] }] };
    if (sql.includes("UPDATE task_projections")) return { rows: [{ task_id: params[0] }] };
    throw new Error("Unexpected fixture query: " + sql);
  });
  const row = await recordAgentDecision({ kind: "verification_request", taskId, boardId: "board_tasknode_fixes", verificationAsk: "Show the merged PR." });
  assert.equal(row.status, "pending");
  const wake = calls.find((call) => call.sql.includes("UPDATE task_projections"));
  assert.ok(wake, "recording a pending decision wakes the worker");
  assert.deepEqual(wake.params[1], ["workers", "verification_request"]);
  assert.deepEqual(Object.keys(JSON.parse(wake.params[2])).sort(), ["retry_after", "woken_at", "woken_by"]);
  assert.equal(JSON.parse(wake.params[2]).retry_after, "");
  for (const guard of ["'processing', '') <> 'true'", "'published', '') <> 'true'", "'retry_after', '') <> ''"]) assert.ok(wake.sql.includes(guard), guard);
  assert.ok(calls.indexOf(wake) > calls.findIndex((call) => call.sql.includes("INSERT INTO bm_agent_decisions")));

  calls.length = 0;
  await recordAgentDecision({ kind: "review", taskId, decision: "reward", rewardPft: 100, status: "refused" });
  assert.ok(!calls.some((call) => call.sql.includes("UPDATE task_projections")), "a refused decision wakes nothing");
  calls.length = 0;
  const reviewWake = await wakeDecisionWorker({ taskId, kind: "review" });
  assert.deepEqual(reviewWake, { workerName: "reward_scoring", woken: true });
  assert.equal(await wakeDecisionWorker({ taskId, kind: "unknown_kind" }), null);
  assert.equal(workerForDecisionKind("review"), "reward_scoring");
  assert.equal(workerForDecisionKind("verification_request"), "verification_request");
});

test("the CLI refuses to resend a rejected command until the task status changes", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://localhost:5174";
  const tokenFile = path.join(root, "credential.json");
  writeFileSync(tokenFile, JSON.stringify({ id: "credential_fixture", alias: "pfterminal", origin, token: "x".repeat(40) }));
  const stateDir = path.join(root, "state");
  writeFileSync(path.join(root, "pending.json"), "{}");
  const requests = [];
  let status = "submitted";
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.argv[0] === "task" && body.argv[1] === "detail") return { ok: true, status: 200, json: async () => ({ ok: true, result: { task: { task_id: taskId, status } } }) };
    if (body.argv[0] === "review" && status !== "verification_response_submitted") {
      return { ok: false, status: 409, json: async () => ({ ok: false, error: "lifecycle_violation: task is in '" + status + "'.", message: "lifecycle_violation: task is in '" + status + "'. Next action: bm verify request " + taskId + " --ask \"...\"", lifecycle: { taskId, taskStatus: status, command: "review", priorRejections: 0 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { decision: { id: "bmdec_fixture" } } }) };
  };
  const argv = ["review", taskId, "--decision", "reward", "--pft", "100"];
  const run = () => remoteBoardCommand(argv, { tokenFile, origin, stateDir, fetchImpl });
  await assert.rejects(run, (error) => error.status === 409 && error.message.includes("lifecycle_violation"));
  assert.equal(requests.length, 1);
  const commandFiles = () => {
    const directory = path.join(stateDir, "commands");
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, "one saved command file per fingerprint");
    return readFileSync(path.join(directory, files[0]), "utf8");
  };
  assert.equal(JSON.parse(commandFiles()).rejected.taskStatus, "submitted");
  // Second attempt, status unchanged: one read-only status check, no mutation sent.
  await assert.rejects(run, (error) => error.message.startsWith("lifecycle_violation_repeated") && error.message.includes("still 'submitted'") && error.message.includes("bm verify request " + taskId));
  assert.deepEqual(requests.slice(1).map((item) => item.argv), [["task", "detail", taskId]]);
  assert.equal(JSON.parse(commandFiles()).rejected.count, 2);
  // The task advanced: the same command is sent again and succeeds.
  status = "verification_response_submitted";
  const result = await run();
  assert.equal(result.decision.id, "bmdec_fixture");
  assert.deepEqual(requests.slice(2).map((item) => item.argv), [["task", "detail", taskId], argv]);
  assert.equal(requests.at(-1).requestKey, requests[0].requestKey, "the saved request key is reused");
  assert.equal(JSON.parse(commandFiles()).rejected, undefined);
});

test("the supervisor detects a duty blocked across consecutive processed rounds", () => {
  const duty = { id: "d1", type: "verification_due", board_id: "board_pf_terminal", task_id: taskId };
  const other = { id: "d2", type: "wanted_open", board_id: "board_pf_terminal", wanted_id: "wanted_a" };
  const routine = [
    { id: "d3", type: "wanted_open", board_id: "board_capital_markets", wanted_id: "wanted_b" },
    { id: "d4", type: "stale_accepted", board_id: "board_pf_terminal", task_id: "task_stale", staleness: { lastActivityAt: "2026-09-06T17:59:00.000Z", cancellationEligible: false } },
    { id: "d5", type: "wanted_rewrite", board_id: "board_pf_terminal", wanted_id: "wanted_c" },
  ];
  const blocked = (roundId, reason) => ({ id: roundId, state: "complete", duties_json: [duty, other, ...routine], results_json: {
    d1: { outcome: "blocked", reason, recordedAt: "2026-09-20T01:03:00.512Z" },
    d2: { outcome: "completed", reason: "Assigned one task." },
    d3: { outcome: "blocked", reason: "Gated on an operator merge." },
    d4: { outcome: "deferred", reason: "Not yet cancellation eligible." },
    d5: { outcome: "deferred", reason: "Nothing changed." },
  } });
  const first = trackRecurringBlockers({}, blocked("round_a", "10 failed reward-review attempts; task still submitted"));
  assert.deepEqual(Object.keys(first), ["verification_due|board_pf_terminal|" + taskId], "routine routing/staleness deferrals are not stalls");
  assert.equal(recurringBlockers(first).length, 0, "one blocked round is a normal report");
  const second = trackRecurringBlockers(first, blocked("round_b", "14 failed attempts; task still submitted"));
  const recurring = recurringBlockers(second);
  assert.equal(RECURRING_BLOCKER_ROUNDS, 2);
  assert.equal(recurring.length, 1);
  assert.equal(recurring[0].rounds, 2);
  assert.equal(recurring[0].firstRoundId, "round_a");
  assert.equal(recurring[0].lastRoundId, "round_b");
  assert.equal(recurring[0].task_id, taskId);
  // A changed hashed duty id (staleness timestamps) still tracks the same task.
  const third = trackRecurringBlockers(second, { ...blocked("round_c", "17 failed attempts"), duties_json: [{ ...duty, id: "d1_rehashed" }, other], results_json: { d1_rehashed: { outcome: "deferred", reason: "17 failed attempts" }, d2: { outcome: "completed", reason: "ok" } } });
  assert.equal(recurringBlockers(third)[0].rounds, 3);
  assert.equal(recurringBlockers(third)[0].lastOutcome, "deferred");
  const directive = escalationDirective(recurringBlockers(third));
  assert.ok(directive.includes("ESCALATION"));
  assert.ok(directive.includes("verification_due " + taskId));
  assert.ok(directive.includes("3 consecutive rounds"));
  assert.ok(directive.includes("do not reissue it"));
  assert.equal(escalationDirective([]), "");
  const summary = recurringSummary(recurringBlockers(third));
  assert.deepEqual(parseRecurringBlockers(summary), [{ type: "verification_due", board_id: "board_pf_terminal", task_id: taskId, rounds: 3, unserved: 0, reason_code: "" }]);
  assert.equal(recurringSummary([]), "");
  assert.deepEqual(parseRecurringBlockers(""), []);
  assert.throws(() => parseRecurringBlockers("not json"), { message: "board_agent_runtime_state_invalid" });
  assert.throws(() => parseRecurringBlockers(JSON.stringify([{ type: "x", board_id: "b", rounds: 0 }])), { message: "board_agent_runtime_state_invalid" });
  // Completion or disappearance clears the streak; a later block starts over.
  const escalation = trackRecurringBlockers(second, { id: "round_c2", state: "complete", duties_json: [{ id: "h1", type: "hive_chat_escalation", board_id: "board_pf_terminal", escalation_id: "esc_1" }], results_json: { h1: { outcome: "deferred", reason: "Will answer later." } } });
  assert.equal(Object.keys(escalation).length, 1, "an unanswered Hive escalation is a progress duty");
  const cleared = trackRecurringBlockers(third, { id: "round_d", state: "complete", duties_json: [duty, other], results_json: { d1: { outcome: "completed", reason: "Reviewed and rewarded." }, d2: { outcome: "completed", reason: "ok" } } });
  assert.deepEqual(cleared, {});
  const absent = trackRecurringBlockers(third, { id: "round_e", state: "complete", duties_json: [other], results_json: { d2: { outcome: "completed", reason: "ok" } } });
  assert.deepEqual(absent, {});
  assert.equal(trackRecurringBlockers(cleared, blocked("round_f", "new blocker"))["verification_due|board_pf_terminal|" + taskId].rounds, 1);
});

test("a blocked Wanted item is not re-asked during the cooldown unless the item changed", () => {
  const duty = { id: "w1", type: "wanted_open", board_id: "board_capital_markets", wanted_id: "wanted_alpha", item_updated_at: "2026-11-25T10:00:00.000Z" };
  const blocked = { id: "round_1", state: "complete", duties_json: [duty], results_json: { w1: { outcome: "blocked", reason: "Source post is behind a login.", recordedAt: "2026-11-25T11:00:00.000Z" } } };
  const map = recentlyBlockedWanted([blocked]);
  assert.deepEqual([...map.keys()], ["wanted_alpha"]);
  assert.equal(wantedStillBlocked(duty, map), true);
  assert.equal(wantedStillBlocked({ ...duty, item_updated_at: "2026-11-25T12:00:00.000Z" }, map), false, "a changed item is asked again at once");
  assert.deepEqual([...recentlyBlockedWanted([{ ...blocked, results_json: {} }]).keys()], []);
  assert.deepEqual([...recentlyBlockedWanted([{ ...blocked, results_json: { w1: { outcome: "completed", reason: "Created the task." } } }]).keys()], []);
  assert.equal(WANTED_BLOCKED_COOLDOWN_HOURS, 12);
  assert.deepEqual(DUTY_OUTCOMES, ["completed", "blocked", "deferred"]);
});

test("slots are kept for an account's preferred items", async () => {
  const founder = { account_id: "acct_founder", engine_verdict: "eligible", free_slots: 2, public_handle: "goodalexander", delivery_wallet: "rF" };
  const alice = { account_id: "acct_a", engine_verdict: "eligible", free_slots: 1, public_handle: "alice", delivery_wallet: "rA" };
  const items = [
    { id: "gov_1", state: "open", title: "Gov 1", why: "x", sourceUrl: "https://e.com/1", preferredAccountId: "acct_founder" },
    { id: "gov_2", state: "open", title: "Gov 2", why: "x", sourceUrl: "https://e.com/2", preferredAccountId: "acct_founder" },
    { id: "ordinary", state: "open", title: "Ordinary", why: "x", sourceUrl: "https://e.com/3" },
  ];
  const reserved = reservedPreferredSlots(items);
  assert.deepEqual(reserved, { acct_founder: 2 });
  const duties = await wantedDuties({ id: "board_postfiat_l1v2" }, [founder, alice], { listItems: async () => items, reserved });
  const byItem = Object.fromEntries(duties.map((duty) => [duty.wanted_id, duty.candidate_ids]));
  assert.deepEqual(byItem.gov_1, ["acct_founder", "acct_a"]);
  assert.deepEqual(byItem.ordinary, ["acct_a"], "the founder's two free slots are kept for his two preferred items");
  const roomy = await wantedDuties({ id: "board_postfiat_l1v2" }, [{ ...founder, free_slots: 3 }], { listItems: async () => items, reserved });
  assert.deepEqual(roomy.find((duty) => duty.wanted_id === "ordinary").candidate_ids, ["acct_founder"], "a spare slot beyond the reservation can take ordinary work");
});

test("work comes from the Wanted list: open items become duties, the preferred owner first", async () => {
  const alice = { account_id: "acct_a", engine_verdict: "eligible", free_slots: 1, public_handle: "alice", delivery_wallet: "rA" };
  const founder = { account_id: "acct_founder", engine_verdict: "eligible", free_slots: 4, public_handle: "goodalexander", delivery_wallet: "rF" };
  const items = [
    { id: "wanted_open", state: "open", title: "Fix the RPC flood", why: "Validators fall over.", sourceUrl: "https://github.com/x/y/issues/1", workType: "code_task", rewardPft: 800, preferredAccountId: "acct_founder" },
    { id: "wanted_taken", state: "in_progress", title: "Taken", why: "x", sourceUrl: "https://e.com" },
    { id: "wanted_done", state: "done", title: "Done", why: "x", sourceUrl: "https://e.com" },
    { id: "wanted_refused", state: "rewrite", refusals: 2, title: "Refused twice", why: "x", sourceUrl: "https://e.com" },
  ];
  const listItems = async () => items;
  const duties = await wantedDuties({ id: "board_postfiat_l1v2" }, [alice, founder], { listItems });
  assert.deepEqual(duties.map((duty) => [duty.type, duty.wanted_id]), [["wanted_open", "wanted_open"], ["wanted_rewrite", "wanted_refused"]]);
  const open = duties[0];
  assert.deepEqual(open.candidate_ids, ["acct_founder", "acct_a"], "the preferred owner is offered first");
  assert.ok(open.detail.includes("--wanted wanted_open"));
  assert.ok(open.detail.includes("Deferring is not allowed"));
  assert.ok(open.detail.includes("https://github.com/x/y/issues/1"));
  // Nobody free: no duty. Closed board: no duty.
  assert.deepEqual(await wantedDuties({ id: "board_postfiat_l1v2" }, [{ ...alice, free_slots: 0 }], { listItems: async () => [items[0]] }), []);
  assert.deepEqual(await wantedDuties({ id: "board_ai_l1_governance" }, [alice], { listItems }), []);
});

test("allocation health alarms on unanswered submissions, never on idle contributors", async (t) => {
  assert.equal(evaluateAllocationHealth({ idle_badge_verified_no_live_task: 12, executed_creates_24h: 0, executed_creates_7d: 0 }).status, "ok", "idle contributors and zero new tasks are a normal state");
  assert.equal(evaluateAllocationHealth({ idle_badge_verified_no_live_task: 12, executed_creates_24h: 3, executed_creates_7d: 9, distinct_accounts_offered_7d: 5 }).status, "ok");
  const queryImpl = async (sql) => {
    if (sql.includes("FROM account_network_badges")) return { rows: [{ idle: 35 }] };
    if (sql.includes("FROM bm_audit_log")) return { rows: [{ board_id: "board_tasknode_fixes", creates_24h: 1, creates_7d: 3, last_create_at: new Date("2026-09-21T01:41:58.183Z") }, { board_id: "board_pf_terminal", creates_24h: 0, creates_7d: 1, last_create_at: new Date("2026-09-06T19:04:33.860Z") }] };
    if (sql.includes("count(DISTINCT p.account_id)")) return { rows: [{ board_id: "board_tasknode_fixes", accounts_offered_7d: 1 }] };
    if (sql.includes("GROUP BY a.project_id, p.status")) return { rows: [{ board_id: "board_pf_terminal", status: "proposed", count: 1 }] };
    if (sql.includes("FROM network_task_generation_jobs")) return { rows: [{ board_id: "board_tasknode_fixes", family: "contract", count: 1 }] };
    if (sql.includes("count(DISTINCT account_id)")) return { rows: [{ accounts: 3 }] };
    if (sql.includes("WHERE d.status='pending'")) return { rows: [{ board_id: "board_pf_terminal", task_id: "task_stuck", kind: "review", decision: "reject", since: "2026-09-29T06:18:36.900Z", wait_ms: 5 * 3_600_000, last_error: "merged_pr_required:no_pull_request_url" }] };
    if (sql.includes("submitted','verification_response_submitted")) return { rows: [{ board_id: "board_pf_terminal", task_id: "task_waiting", status: "submitted", since: "2026-09-21T20:32:24.264Z", wait_ms: 4 * 60 * 60_000 }] };
    throw new Error("unexpected " + sql);
  };
  const health = await readAllocationHealth({ boardIds: ["board_pf_terminal", "board_tasknode_fixes"], queryImpl });
  assert.equal(health.aggregate.idle_badge_verified_no_live_task, 35);
  assert.equal(health.aggregate.executed_creates_24h, 1);
  assert.equal(health.aggregate.distinct_accounts_offered_7d, 3);
  assert.equal(health.aggregate.last_create_at, "2026-09-21T01:41:58.183Z", "latest by time, not by string order of Date objects");
  assert.equal(health.aggregate.submissions_awaiting_manager, 1);
  assert.equal(health.evaluation.status, "critical", "a four-hour unreviewed submission is critical even when routing is healthy");
  assert.ok(health.evaluation.label.includes("awaiting a manager verification request"));
  assert.equal(health.boards.find((b) => b.board_id === "board_pf_terminal").submissions_awaiting_manager[0].task_id, "task_waiting");
  assert.equal(evaluateAllocationHealth({ idle_badge_verified_no_live_task: 12, executed_creates_24h: 3, executed_creates_7d: 9, submissions_awaiting_manager: 1, oldest_submission_wait_ms: 50 * 60_000 }).status, "warning");
  assert.equal(evaluateAllocationHealth({ idle_badge_verified_no_live_task: 12, executed_creates_24h: 3, executed_creates_7d: 9, submissions_awaiting_manager: 0, oldest_submission_wait_ms: 0 }).status, "ok");
  assert.equal(health.boards.find((b) => b.board_id === "board_tasknode_fixes").failures_7d.contract, 1);
  const lines = allocationHealthLines(health, "board_pf_terminal");
  assert.ok(lines[0].startsWith("Allocation: 35 idle badge-verified; 1 created 24h / 4 7d"));
  assert.ok(lines.some((line) => line.startsWith("Review backlog: 1 submission(s)")));
  assert.ok(lines.some((line) => line.includes("task_waiting submitted 240min")));
  // A recorded decision that never publishes must stay visible.
  assert.equal(health.aggregate.decisions_stuck_publishing, 1);
  assert.ok(lines.some((line) => line.startsWith("Stuck publications: 1")));
  assert.ok(lines.some((line) => line.includes("task_stuck review/reject 5h merged_pr_required")));
  t.diagnostic(lines.join(" | "));
});

test("a terminal that stays busy while an undelivered round waits is alerted and then interrupted", () => {
  const t0 = Date.parse("2026-09-21T10:16:56.596Z");
  const round = { id: "round_4b40943b", state: "pending" };
  const busyStatus = (at) => ({ version: 1, pid: 1, threadId: "t", ready: false, updatedAt: new Date(at).toISOString() });
  const pending = { id: round.id, attempts: 0 };
  const first = busyBlockedDecision({ round, status: busyStatus(t0), pending, busy: {}, now: t0 });
  assert.equal(first.state, "tracking");
  const busy = { roundId: round.id, since: first.since };
  assert.equal(busyBlockedDecision({ round, status: busyStatus(t0 + 10 * 60_000), pending, busy, now: t0 + 10 * 60_000 }).state, "tracking");
  const alert = busyBlockedDecision({ round, status: busyStatus(t0 + BUSY_ALERT_MS), pending, busy, now: t0 + BUSY_ALERT_MS });
  assert.equal(alert.state, "alert");
  assert.equal(busyBlockedDecision({ round, status: busyStatus(t0 + BUSY_ALERT_MS + 60_000), pending, busy: { ...busy, alerted: true }, now: t0 + BUSY_ALERT_MS + 60_000 }).state, "tracking", "alert fires once");
  const interrupt = busyBlockedDecision({ round, status: busyStatus(t0 + BUSY_INTERRUPT_MS), pending, busy: { ...busy, alerted: true }, now: t0 + BUSY_INTERRUPT_MS });
  assert.equal(interrupt.state, "interrupt");
  const interruptedAt = new Date(t0 + BUSY_INTERRUPT_MS).toISOString();
  assert.equal(busyBlockedDecision({ round, status: busyStatus(t0 + BUSY_INTERRUPT_MS + 5 * 60_000), pending, busy: { ...busy, alerted: true, interruptedAt }, now: t0 + BUSY_INTERRUPT_MS + 5 * 60_000 }).state, "tracking", "no repeat within an hour");
  assert.equal(busyBlockedDecision({ round, status: busyStatus(t0 + BUSY_INTERRUPT_MS + 61 * 60_000), pending, busy: { ...busy, alerted: true, interruptedAt }, now: t0 + BUSY_INTERRUPT_MS + 61 * 60_000 }).state, "interrupt");
  // Never interrupt a terminal that is working a delivered round, an idle terminal, or a stale heartbeat.
  assert.equal(busyBlockedDecision({ round, status: busyStatus(t0 + BUSY_INTERRUPT_MS), pending: { ...pending, attempts: 1, lastDeliveredAt: new Date(t0).toISOString() }, busy, now: t0 + BUSY_INTERRUPT_MS }).state, "clear");
  assert.equal(busyBlockedDecision({ round, status: { ...busyStatus(t0), ready: true }, pending, busy, now: t0 + BUSY_INTERRUPT_MS }).state, "clear");
  assert.equal(busyBlockedDecision({ round, status: busyStatus(t0), pending, busy, now: t0 + BUSY_INTERRUPT_MS }).state, "clear", "stale heartbeat is the relaunch path, not an interrupt");
  assert.equal(busyBlockedDecision({ round: { ...round, state: "complete" }, status: busyStatus(t0), pending, busy, now: t0 }).state, "clear");
});

after(async () => { mock.restoreAll(); await closePool(); });

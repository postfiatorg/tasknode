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
const { trackRecurringBlockers, recurringBlockers, escalationDirective, recurringSummary, RECURRING_BLOCKER_ROUNDS } = await import("../ops/bm-runtime/supervisor.mjs");
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
  const other = { id: "d2", type: "routing_due", board_id: "board_pf_terminal" };
  const routine = [
    { id: "d3", type: "routing_due", board_id: "board_capital_markets" },
    { id: "d4", type: "stale_accepted", board_id: "board_pf_terminal", task_id: "task_stale", staleness: { lastActivityAt: "2026-09-06T17:59:00.000Z", cancellationEligible: false } },
    { id: "d5", type: "board_info_stale", board_id: "board_pf_terminal" },
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
  assert.deepEqual(parseRecurringBlockers(summary), [{ type: "verification_due", board_id: "board_pf_terminal", task_id: taskId, rounds: 3 }]);
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

after(async () => { mock.restoreAll(); await closePool(); });

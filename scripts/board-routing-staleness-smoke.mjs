import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { query, getPool, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { boardTaskStaleness, routingDuty } from "../server/board-task-policy.js";
import { computeBoardDuties } from "./bm/lib.mjs";
import { executeBoardManagerDecision } from "../server/board-manager-actions.js";
import { executeBoardAgentCommand } from "../server/board-agent-routes.js";
import { dutyId, openAgentRound, recordDutyResult } from "../server/board-agent-rounds.js";

assert.ok(new URL(process.env.DATABASE_URL).pathname.includes("routing_"), "Use the isolated routing fixture database");
const prefix = `routing_fixture_${randomUUID()}`;
const board = "board_pf_terminal", otherBoard = "board_capital_markets";
const account = `${prefix}_account`, token = randomUUID();
const now = Date.now(), day = 86400000;
const ago = (days) => new Date(now - days * day).toISOString();
const candidate = { account_id: account, public_handle: "fixture-contributor", badges: ["core_contributor"], free_slots: 1, engine_verdict: "eligible", delivery_wallet: "rFixture" };

async function task(name, status, days, { project = board, kind = "network", submission = false, reward = 0, activityDays = days } = {}) {
  const id = `${prefix}_${name}`;
  await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,status,title,task_kind,created_at,last_event_at,reward_actual_pft,submission_requirement_text)
    VALUES($1,$2,'rFixture',$3,$1,$4,$5,$6,$7,'Provide independently inspectable test evidence')`, [id, account, status, kind, ago(days), ago(activityDays), reward]);
  await query(`INSERT INTO network_task_allocations(id,idempotency_key,project_id,task_class,allocation_status,generated_task_id,candidate_account_id,candidate_wallet_address)
    VALUES($1,$1,$2,'network',$3,$4,$5,'rFixture')`, [`alloc_${id}`, project, status, id, account]);
  if (kind === "network") await query(`INSERT INTO network_project_task_refs(id,project_id,task_id,source,state) VALUES($1,$2,$3,'network_task_generation',$4)`, [`ref_${id}`, project, id, status]);
  if (submission) await event(id, "pf.task.submission.v1", { evidence_items: [{ artifact_type: "text", value: "Submitted work must survive stale cancellation." }] }, ago(activityDays));
  return id;
}
async function event(id, type, payload, occurredAt = ago(0)) {
  const key = randomUUID();
  await query(`INSERT INTO task_events(id,task_id,account_id,wallet_address,event_type,source_tx_hash,source_cid,payload_json,occurred_at)
    VALUES($1,$2,$3,'rFixture',$4,$1,$1,$5::jsonb,$6)`, [key, id, account, type, JSON.stringify(payload), occurredAt]);
}
const cancel = (taskId, dryRun = false) => executeBoardManagerDecision({ dryRun, decision: {
  action: "cancel_network_task", target_type: "network_task", target_id: taskId, reason: "Existing stale-task policy applies after checking recent activity.",
  payload: { cancel_target: { task_id: taskId, stale_only: true } },
} });
const statusOf = async (id) => (await query("SELECT status FROM task_projections WHERE task_id=$1", [id])).rows[0].status;
const scoped = (argv) => executeBoardAgentCommand({ token, payload: { requestKey: randomUUID(), argv } });

try {
  await migrateDatabase();
  for (const count of [0, 3, 5, 20]) assert.ok(routingDuty({ id: board }, [candidate], count), `full board with ${count} tasks must still expose idle contributors`);
  assert.equal(routingDuty({ id: board }, [{ ...candidate, free_slots: 0 }], 0), null);
  assert.equal(routingDuty({ id: board, routing_constraints: { assignable_handles: ["another-contributor"] } }, [candidate], 0), null);
  assert.ok(routingDuty({ id: board, routing_constraints: { assignable_handles: ["FIXTURE-CONTRIBUTOR"] } }, [candidate], 10));
  assert.notEqual(dutyId(routingDuty({ id: board }, [candidate], 5)), dutyId(routingDuty({ id: board }, [{ ...candidate, account_id: "different" }], 5)), "new contributors must bypass old-round cooldown");
  assert.equal(boardTaskStaleness({ status: "accepted", created_at: ago(30), last_event_at: ago(2), updated_at: ago(0) }, now).followUp, false);
  assert.equal(boardTaskStaleness({ status: "accepted", created_at: ago(30), last_event_at: ago(15), updated_at: ago(0) }, now).cancellationEligible, true, "projection refresh is not contributor activity");
  assert.equal(boardTaskStaleness({ status: "accepted", created_at: ago(30), last_event_at: ago(15), last_contact_at: ago(1) }, now).cancellationEligible, false);
  assert.equal(boardTaskStaleness({ status: "accepted", created_at: ago(30), has_submission: true }, now).cancellationEligible, false);
  for (const [status, threshold] of [["proposed", 7], ["accepted", 14]]) {
    assert.equal(boardTaskStaleness({ status, created_at: ago(threshold - 0.01) }, now).cancellationEligible, false);
    assert.equal(boardTaskStaleness({ status, created_at: ago(threshold) }, now).cancellationEligible, true);
  }
  const oldAccepted = await task("old_accepted", "accepted", 30);
  const oldProposed = await task("old_proposed", "proposed", 10);
  const followup = await task("followup", "accepted", 8);
  const recent = await task("recent_activity", "accepted", 30, { activityDays: 1 });
  const submitted = await task("submitted", "submitted", 30, { submission: true });
  const evidenceGuard = await task("evidence_guard", "accepted", 30, { submission: true });
  const verification = await task("verification", "verification_requested", 4, { submission: true });
  const rewarded = await task("rewarded", "rewarded", 30, { reward: 10 });
  const personal = await task("personal", "accepted", 30, { kind: "personal" });
  const contact = await task("recent_contact", "accepted", 30);
  await event(contact, "pf.task.update.v1", { note: "New progress recorded before projection refresh." });
  const snapshot = await computeBoardDuties([board], { idleContributors: async () => [candidate], now });
  assert.ok(snapshot.duties.some((d) => d.type === "routing_due"));
  assert.ok(snapshot.duties.some((d) => d.type === "stale_accepted" && d.task_id === oldAccepted && d.staleness.cancellationEligible));
  assert.ok(snapshot.duties.some((d) => d.type === "stale_accepted" && d.task_id === followup && !d.staleness.cancellationEligible));
  assert.ok(snapshot.duties.some((d) => d.type === "stale_verification" && d.task_id === verification));
  assert.equal(snapshot.duties.some((d) => d.task_id === recent), false);
  assert.equal((await cancel(oldAccepted, true)).result.eligible, true);
  assert.equal(await statusOf(oldAccepted), "accepted", "dry-run preserves state");
  for (const id of [recent, followup, submitted, evidenceGuard, verification, rewarded, personal, contact]) assert.equal((await cancel(id)).result.executed, false, id);
  assert.equal((await cancel(oldAccepted)).result.status, "cancelled");
  assert.equal((await cancel(oldProposed)).result.status, "refused");
  assert.equal((await cancel(oldAccepted)).result.executed, false, "repeated cancellation does not act twice");

  const race = await task("activity_race", "accepted", 30);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT task_id FROM task_projections WHERE task_id=$1 FOR UPDATE", [race]);
    const pending = cancel(race);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const state = await query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
      if (state.rows.some((row) => row.query.includes("last_event_at IS NOT DISTINCT FROM"))) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(blocked, "cancellation should wait behind the contributor update");
    await client.query("UPDATE task_projections SET last_event_at=now() WHERE task_id=$1", [race]);
    await client.query("COMMIT");
    assert.equal((await pending).result.executed, false, "concurrent activity fences stale cancellation");
    assert.equal(await statusOf(race), "accepted");
  } finally { await client.query("ROLLBACK"); client.release(); }

  await query("INSERT INTO board_agent_credentials(id,token_hash,actor,board_ids,expires_at) VALUES($1,$2,$1,$3::jsonb,now()+interval '1 hour')", [prefix, createHash("sha256").update(token).digest("hex"), JSON.stringify([board])]);
  for (const missing of ["account", "wallet", "need"]) {
    const values = { account, wallet: "rFixture", need: "A concrete scoped contribution" };
    values[missing] = "";
    await assert.rejects(scoped(["task", "create", board, ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]), "--execute"]), {
      status: 400, message: `board_agent_required_flag:${missing}`,
    });
  }
  const originalDuty = routingDuty({ id: board }, [candidate], 5);
  const opened = await executeBoardAgentCommand({ token, payload: { requestKey: randomUUID(), argv: ["round-open"] } }, {
    dispatch: () => openAgentRound([board], { computeDuties: async () => ({ duties: [originalDuty] }) }),
  });
  await assert.rejects(executeBoardAgentCommand({ token, payload: { requestKey: randomUUID(), argv: ["duty-result"] } }, {
    dispatch: () => recordDutyResult({ roundId: opened.result.id, dutyId: dutyId(originalDuty), outcome: "completed", reason: "The candidate pool changed but no task was actually routed" }, {
      computeDuties: async () => ({ duties: [routingDuty({ id: board }, [candidate, { ...candidate, account_id: `${account}_new` }], 5)] }),
    }),
  }), { status: 409 }, "changing candidate pools must not bypass actual routing proof");
  const scopedStale = await task("scoped_stale", "accepted", 30);
  const dryCancel = await scoped(["task", "cancel", scopedStale, "--stale-only", "--reason", "Stale accepted task with no recent contact or submission"]);
  assert.equal(dryCancel.result.phase, "dry_run");
  assert.equal(dryCancel.result.actionResult.result.eligible, true);
  assert.equal(await statusOf(scopedStale), "accepted");
  const source = (await query("SELECT source_packet_json FROM board_manager_runs WHERE id=$1", [dryCancel.result.runId])).rows[0].source_packet_json;
  assert.equal(source.scope, board);
  assert.equal(source.taskDetail.task.task_id, scopedStale);
  assert.equal(source.taskDetail.staleness.cancellationEligible, true);
  assert.equal(source.hiveContext, undefined, "targeted cancellation must not fetch unrelated global planning context");
  const executedCancel = await scoped(["task", "cancel", scopedStale, "--stale-only", "--reason", "Stale accepted task with no recent contact or submission", "--execute"]);
  assert.equal(executedCancel.result.phase, "cancelled");
  assert.equal(executedCancel.result.actionResult.result.executed, true);
  assert.equal(await statusOf(scopedStale), "cancelled");
  const review = await task("review_missing", "verification_response_submitted", 1);
  const missingSubmission = await task("missing_submission", "submitted", 1);
  await assert.rejects(scoped(["verify", "request", missingSubmission, "--ask", "Please resubmit because the API cannot read evidence"]), { status: 409 });
  await assert.rejects(scoped(["review", review, "--decision", "reject", "--reason", "Evidence reader failed"]), { status: 409 });
  assert.equal(Number((await query("SELECT count(*) AS n FROM bm_agent_decisions WHERE task_id=$1", [review])).rows[0].n), 0);
  await event(review, "pf.task.submission.v1", { evidence_items: [{ artifact_type: "url", value: "https://example.org/proof" }] });
  await event(review, "pf.task.verification_response.v1", { response_text: "Verification results with evidence." });
  const detail = (await scoped(["task", "detail", review])).result;
  assert.equal(detail.evidence_state.review_ready, true);
  assert.equal(detail.submission.payload_json.evidence_items[0].value, "https://example.org/proof");
  assert.equal(detail.verification_response.payload_json.response_text, "Verification results with evidence.");
  const denied = await task("cross_board", "submitted", 1, { project: otherBoard, submission: true });
  await assert.rejects(scoped(["task", "detail", denied]), { status: 403 });
  console.log(JSON.stringify({ ok: true, fullBoardRouting: true, boardRestrictionsPreserved: true, staleAcceptedAndVerificationDuties: true, protectedStatesAndActivity: 8, concurrentActivityFenced: true, scopedEvidenceRead: true, missingEvidenceBlocksRejection: true }));
} finally { await closePool(); }

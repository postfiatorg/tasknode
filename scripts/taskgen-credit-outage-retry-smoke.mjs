import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";

// Replays the 2026-11-06 incident against a disposable database: the gateway
// balance hits $0, task generation answers 402, then credits return. Inference
// and the credits endpoint are mocked through global fetch; nothing leaves the
// process.
const store = await mkdtemp(join(tmpdir(), "taskgen-credit-outage-"));
Object.assign(process.env, {
  TASKNODE_STORE_PATH: join(store, "runtime.json"),
  TASKNODE_AUTHORITY_SEED: Wallet.generate().seed,
  TASKNODE_OFFCHAIN_TASK_LIFECYCLE: "true",
  TASKNODE_OFFCHAIN_TASK_LIFECYCLE_DUAL_WRITE: "false",
  TASKNODE_PROCESS_ROLE: "web",
  TASKNODE_NETWORK_TASK_GENERATION_V2_ENABLED: "false",
  TASKNODE_HIVE_TASK_GENERATION_V2_ENABLED: "false",
  VERCEL_KIMI_API_KEY: "vck_fixture_kimi",
  VERCEL_AI_GATEWAY_API_KEY: "vck_fixture_gateway",
  VERCEL_AI_GATEWAY_BASE_URL: "https://gateway.invalid/v1",
  // Re-check the balance on every tick so the trace stays short.
  TASKNODE_TASKGEN_CREDIT_RECHECK_MS: "0",
  TASKNODE_TASKGEN_CREDIT_SWEEP_INTERVAL_MS: "0",
  TASKNODE_GATEWAY_CREDIT_CACHE_TTL_MS: "0",
});
delete process.env.TASKNODE_TASKGEN_PROVIDER_MOCK;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.INFERENCE_AMBIENT_BACKUP_ENABLED;

const { closePool, databaseEnabled, query } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const { getOwnedTaskRequest } = await import("../server/repositories/task-requests.js");
const { terminalTaskRequestAction } = await import("../server/task-request.js");
const { processTaskGenerationQueueOnce } = await import("../server/task-generation-worker.js");
const { processNetworkTaskGenerationQueueOnce } = await import("../server/network-task-generation-worker.js");
const { resetTaskGenerationCreditOutage } = await import("../server/inference-credits.js");
const { usageLedger } = await import("../server/repositories/chat-billing-read.js");

assert.ok(databaseEnabled(), "Use an isolated fixture database");
const url = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.ok(url.pathname.endsWith("_test"), "Use a disposable *_test database");

const COST_PER_CALL_USD = 0.0125;
const gateway = { balance: "0.00", chatCalls: 0, creditCalls: 0, rejected402: 0 };
const trace = [];
const log = (step, detail) => { trace.push({ step, ...detail }); console.log(`[trace] ${step} ${JSON.stringify(detail)}`); };
const quietLogger = { warn: (event, detail = {}) => console.log(`[worker] ${event} ${JSON.stringify(detail)}`), info: () => {} };

function completion(content, model) {
  return Response.json({
    id: `gen_fixture_${randomUUID()}`,
    model,
    choices: [{ message: { content: JSON.stringify(content), provider_metadata: { gateway: { cost: String(COST_PER_CALL_USD) } } }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250, prompt_tokens_details: { cached_tokens: 100 } },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const target = String(input);
  if (target === "https://gateway.invalid/v1/credits") {
    gateway.creditCalls += 1;
    return Response.json({ balance: gateway.balance, total_used: "1204.10" });
  }
  if (target === "https://gateway.invalid/v1/chat/completions") {
    gateway.chatCalls += 1;
    if (Number(gateway.balance) <= 0) {
      gateway.rejected402 += 1;
      return Response.json({ error: { type: "insufficient_funds", message: "Insufficient funds. Please add credits." } }, { status: 402 });
    }
    const body = JSON.parse(init.body);
    const schema = body.response_format?.json_schema?.name;
    if (schema === "taskgen_readiness") {
      const steps = JSON.parse(body.messages[1].content).steps;
      return completion({ actionable_task: true, actionable_submission: true, consistent_scope: true,
        step_reviews: steps.map((_step, index) => ({ step_index: index + 1, actionable: true, reason: "Concrete contributor action." })) }, body.model);
    }
    if (schema === "task_intent_assessment") {
      return completion({ relationship: "independent", priorTaskIds: [], reason: "Distinct output from every prior task.", newOutput: "A merged fix with a regression test.", actionable: true, scopeClear: true }, body.model);
    }
    if (schema === "taskgen_output") {
      return completion({
        schema: "pf.taskgen.output.v1",
        title: "Document the dashboard keyboard shortcuts",
        description: "Write a short reference of every keyboard shortcut in the local task dashboard.",
        task_kind: "personal",
        steps: ["List every shortcut the dashboard binds.", "Write the reference page and link it from the README."],
        submission_requirement: { type: "text", criteria: "Submit the reference page text and the README link." },
        verification_policy: { followup_required: false, mode: "standard_followup", verification_type: "text" },
        reward_offer: { amount_estimate_pft: "100" },
        deadline: { accept_by: null, deadline_at: null },
      }, body.model);
    }
    throw new Error(`unexpected inference schema ${schema}`);
  }
  throw new Error(`unexpected fetch ${target}`);
};

const accountId = `credit_outage_${randomUUID()}`;
const wallet = Wallet.generate().classicAddress;
const board = `board_credit_outage_${randomUUID().slice(0, 8)}`;
const allocationId = `alloc_credit_outage_${randomUUID()}`;
const jobId = `netjob_credit_outage_${randomUUID()}`;

try {
  await migrateDatabase();
  resetTaskGenerationCreditOutage();
  await query("INSERT INTO account_linked_wallets(account_id,wallet_address) VALUES($1,$2)", [accountId, wallet]);

  // --- Phase 1: credits exhausted ---------------------------------------
  const first = await terminalTaskRequestAction({ idempotencyKey: "credit-outage-a", userDetailText: "Help me document my dashboard", source: "pfterminal" }, "POST", { accountId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const requestA = first.body.requestId;

  const tick1 = await processTaskGenerationQueueOnce({ logger: quietLogger });
  assert.equal(tick1.claimed, 1);
  assert.equal(tick1.results[0].creditOutage, true, JSON.stringify(tick1));
  const rawA = (await query("SELECT status,last_error,worker_attempt_count,worker_retry_after > now() AS deferred,metadata_json FROM task_requests WHERE request_id=$1", [requestA])).rows[0];
  assert.equal(rawA.status, "queued", "a 402 parks the request instead of failing it");
  assert.equal(rawA.last_error, "inference_http_402", "raw code kept internally");
  assert.equal(rawA.metadata_json.creditOutage.parks, 1);
  assert.equal(rawA.metadata_json.manualRetryAttemptBase, rawA.worker_attempt_count, "credit wait does not consume the retry budget");
  const publicA = await getOwnedTaskRequest({ accountId, requestId: requestA });
  assert.equal(publicA.lastError, "task generation is temporarily unavailable");
  assert.equal(JSON.stringify(publicA).includes("inference_http_402"), false, "user view never shows the raw code");
  log("1_request_failed_402_parked", { requestId: requestA, dbStatus: rawA.status, dbLastError: rawA.last_error, userStatus: publicA.status, userLastError: publicA.lastError, gateway402s: gateway.rejected402 });

  // Network generation job: its intent assessment hits the same 402.
  await query("INSERT INTO network_projects(id,title,status) VALUES($1,'Credit outage fixture','active') ON CONFLICT DO NOTHING", [board]);
  await query(`INSERT INTO network_task_allocations(id,project_id,task_class,allocation_status,candidate_account_id,candidate_wallet_address,project_need_summary,reward_min_pft,reward_max_pft)
    VALUES($1,$2,'network','queued',$3,$4,'Ship a regression test for the credit outage worker.',100,200)`, [allocationId, board, accountId, wallet]);
  await query(`INSERT INTO network_task_generation_jobs(id,allocation_id,project_id,task_class,candidate_account_id,candidate_wallet_address,reward_min_pft,reward_max_pft,status,source_payload_digest,source_payload_json)
    VALUES($1,$2,$3,'network',$4,$5,100,200,'queued','sha256:fixture',$6::jsonb)`, [jobId, allocationId, board, accountId, wallet,
    JSON.stringify({ need: "Ship a regression test for the credit outage worker.", project: { title: "Credit outage fixture" }, networkTask: { projectNeedSummary: "Ship a regression test for the credit outage worker." } })]);
  // The breaker is per process and the request above already opened it, which
  // would keep this job unclaimed. Reset it to replay a worker process that has
  // not seen a 402 yet.
  resetTaskGenerationCreditOutage();
  const netTick1 = await processNetworkTaskGenerationQueueOnce({ logger: quietLogger });
  assert.equal(netTick1.results[0]?.creditOutage, true, JSON.stringify(netTick1));
  const rawJob = (await query("SELECT status,last_error,next_attempt_at > now() AS deferred,generated_task_payload FROM network_task_generation_jobs WHERE id=$1", [jobId])).rows[0];
  const allocation = (await query("SELECT allocation_status FROM network_task_allocations WHERE id=$1", [allocationId])).rows[0];
  assert.equal(rawJob.status, "queued");
  assert.equal(rawJob.deferred, true);
  assert.ok(rawJob.last_error.includes("inference_http_402"));
  assert.equal(allocation.allocation_status, "queued", "the allocation is not failed by a credit outage");
  log("2_network_job_failed_402_parked", { jobId, jobStatus: rawJob.status, lastError: rawJob.last_error, allocationStatus: allocation.allocation_status });

  // While credits stay at $0 nothing is sent to the provider, even when the
  // request's own retry time has passed.
  await query("UPDATE task_requests SET worker_retry_after=now()-interval '1 second' WHERE request_id=$1", [requestA]);
  await query("UPDATE network_task_generation_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [jobId]);
  const chatCallsBefore = gateway.chatCalls;
  const tick2 = await processTaskGenerationQueueOnce({ logger: quietLogger });
  const netTick2 = await processNetworkTaskGenerationQueueOnce({ logger: quietLogger });
  assert.equal(tick2.claimed, 0);
  assert.equal(netTick2.claimed, 0);
  assert.equal(tick2.creditOutage.reason, "gateway_credits_exhausted");
  assert.equal(gateway.chatCalls, chatCallsBefore, "no inference while the balance is $0");
  log("3_gate_closed_while_balance_zero", { claimed: tick2.claimed, networkClaimed: netTick2.claimed, reason: tick2.creditOutage.reason, inferenceCallsDuringOutage: gateway.chatCalls - chatCallsBefore });

  // A request that already failed with the raw 402 (the incident's 28 rows).
  const second = await terminalTaskRequestAction({ idempotencyKey: "credit-outage-b", userDetailText: "Help me write dashboard release notes", source: "pfterminal" }, "POST", { accountId });
  const requestB = second.body.requestId;
  await query(`UPDATE task_requests SET status='failed',last_error='inference_http_402',worker_attempt_count=1,worker_completed_at=now(),
    metadata_json=metadata_json || '{"workerError":"inference_http_402"}'::jsonb WHERE request_id=$1`, [requestB]);
  const publicB = await getOwnedTaskRequest({ accountId, requestId: requestB });
  assert.equal(publicB.statusLabel, "Needs attention");
  assert.equal(publicB.lastError, "task generation is temporarily unavailable");
  log("4_incident_style_failed_request", { requestId: requestB, dbStatus: "failed", dbLastError: "inference_http_402", userLastError: publicB.lastError });

  // --- Phase 2: credits return -------------------------------------------
  gateway.balance = "50.00";
  const tick3 = await processTaskGenerationQueueOnce({ logger: quietLogger });
  assert.equal(tick3.claimed, 1);
  assert.equal(tick3.results[0].ok, true, JSON.stringify(tick3));
  assert.equal(tick3.results[0].requestId, requestA);
  const readyA = await getOwnedTaskRequest({ accountId, requestId: requestA });
  assert.equal(readyA.status, "proposed");
  assert.ok(readyA.generatedTaskId);
  assert.equal(readyA.lastError, "");
  log("5_credits_returned_request_retried_to_success", { requestId: requestA, status: readyA.status, generatedTaskId: readyA.generatedTaskId });

  const netTick3 = await processNetworkTaskGenerationQueueOnce({ logger: quietLogger });
  assert.equal(netTick3.results[0]?.ok, true, JSON.stringify(netTick3));
  const doneJob = (await query("SELECT status,request_id FROM network_task_generation_jobs WHERE id=$1", [jobId])).rows[0];
  assert.equal(doneJob.status, "generated");
  assert.ok(doneJob.request_id);
  log("6_network_job_retried_to_success", { jobId, jobStatus: doneJob.status, taskRequestId: doneJob.request_id });

  const tick4 = await processTaskGenerationQueueOnce({ logger: quietLogger });
  assert.equal(tick4.results[0]?.requestId, requestB, JSON.stringify(tick4));
  assert.equal(tick4.results[0]?.ok, true, JSON.stringify(tick4));
  const readyB = await getOwnedTaskRequest({ accountId, requestId: requestB });
  assert.equal(readyB.status, "proposed");
  assert.ok(readyB.metadata.creditOutageRequeuedAt);
  log("7_incident_failed_request_requeued_to_success", { requestId: requestB, status: readyB.status, generatedTaskId: readyB.generatedTaskId });

  // --- Billing attribution -----------------------------------------------
  const ledger = (await query(`SELECT kind,source,amount_usd,provider_cost_usd,cost_source,provider,model,input_tokens,output_tokens,total_tokens,metadata_json
    FROM billing_ledger_entries WHERE account_id=$1 ORDER BY created_at,(metadata_json->>'sequence')::integer`, [accountId])).rows;
  const taskgen = ledger.filter((row) => row.kind === "taskgen_inference");
  // Request A: generator + readiness reviewer. Network job: intent assessment.
  // Request B: generator + readiness reviewer. 402 rejections cost nothing.
  assert.equal(taskgen.length, 5, JSON.stringify(ledger));
  assert.equal(ledger.length, taskgen.length, "no chat_debit or other entries");
  assert.ok(taskgen.every((row) => Number(row.amount_usd) === 0 && row.metadata_json.billingImpact === "none"));
  assert.ok(taskgen.every((row) => Number(row.provider_cost_usd) === COST_PER_CALL_USD && row.cost_source === "gateway_reported" && row.provider === "vercel"));
  assert.ok(taskgen.every((row) => row.input_tokens === 1000 && row.output_tokens === 250 && row.total_tokens === 1250));
  assert.deepEqual(taskgen.map((row) => row.source), ["task_generation", "task_generation", "network_task_generation", "task_generation", "task_generation"]);
  assert.deepEqual(taskgen.map((row) => row.model), ["moonshotai/kimi-k3.1-pro", "zai/glm-5.3-flash", "zai/glm-5.3", "moonshotai/kimi-k3.1-pro", "zai/glm-5.3-flash"]);
  const account = (await query("SELECT current_spend_usd,current_credit_usd,ledger_entry_count FROM billing_accounts WHERE account_id=$1", [accountId])).rows[0];
  assert.equal(Number(account.current_spend_usd), 0, "user balance is not debited");
  assert.equal(Number(account.ledger_entry_count), taskgen.length);
  const userLedger = await usageLedger({ accountId });
  assert.equal(userLedger.entries.length, 0, "zero-amount attribution rows stay out of the user's billing ledger");
  assert.equal(userLedger.currentSpendUsd, 0);
  const attributed = Number(taskgen.reduce((sum, row) => sum + Number(row.provider_cost_usd), 0).toFixed(6));
  log("8_billing_attribution", {
    accountId: "credit_outage_<fixture>",
    entries: taskgen.map((row) => ({ kind: row.kind, source: row.source, model: row.model, amountUsd: Number(row.amount_usd), providerCostUsd: Number(row.provider_cost_usd), inputTokens: row.input_tokens, outputTokens: row.output_tokens, outcome: row.metadata_json.outcome })),
    attributedProviderCostUsd: attributed,
    accountSpendUsd: Number(account.current_spend_usd),
  });
  assert.equal(attributed, 0.0625);

  console.log(JSON.stringify({ ok: true, gateway402Responses: gateway.rejected402, creditChecks: gateway.creditCalls, steps: trace.map((item) => item.step) }));
} finally {
  const requests = (await query("SELECT request_id FROM task_requests WHERE account_id=$1", [accountId])).rows.map((row) => row.request_id);
  await query("DELETE FROM task_events WHERE account_id=$1", [accountId]);
  await query("DELETE FROM task_projections WHERE account_id=$1", [accountId]);
  await query("DELETE FROM taskgen_replay_cache WHERE request_id=ANY($1::text[])", [requests]);
  await query("DELETE FROM network_task_generation_jobs WHERE id=$1", [jobId]);
  await query("DELETE FROM network_task_allocations WHERE id=$1", [allocationId]);
  await query("DELETE FROM network_projects WHERE id=$1", [board]);
  await query("DELETE FROM task_requests WHERE account_id=$1", [accountId]);
  await query("DELETE FROM billing_ledger_entries WHERE account_id=$1", [accountId]);
  await query("DELETE FROM billing_accounts WHERE account_id=$1", [accountId]);
  await query("DELETE FROM account_linked_wallets WHERE account_id=$1", [accountId]);
  await closePool();
  await rm(store, { recursive: true, force: true });
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Context Rewrite live smoke.");
}
if (!process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER) {
  throw new Error("OPENROUTER_API_KEY is required for Context Rewrite live smoke.");
}

process.env.TASKNODE_DATABASE_ENABLED ||= "true";
process.env.TASKNODE_JOBS_EMBEDDING_PROVIDER ||= "openai";
process.env.CONTEXT_REWRITE_PROVIDER_MOCK = "false";
process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL ||= "3";

const [
  { migrateDatabase },
  { closePool, query },
  { appendUsageCredit, recordBillableModelRun },
  { saveContextDocument },
  { createContextRewriteJob, getContextRewriteAssistantMessage, getContextRewriteArtifact, getContextRewriteJob },
  { runContextRewriteWorkerOnce },
  {
    contextRewriteScorePromptSha256,
    contextRewriteScorePromptVersion,
    renderContextRewriteScorePrompt,
  },
  {
    contextRewriteModels,
    runContextRewriteScoreCall,
  },
  { aggregateContextRewriteScores, normalizeContextRewriteScore },
  { assembleContextRewriteSourcePacket },
] = await Promise.all([
  import("../server/db/migrate.js"),
  import("../server/db/pool.js"),
  import("../server/repositories/chat-billing.js"),
  import("../server/repositories/context.js"),
  import("../server/repositories/context-rewrite.js"),
  import("../server/context-rewrite-worker.js"),
  import("../server/context-rewrite-prompts.js"),
  import("../server/context-rewrite-provider.js"),
  import("../server/context-rewrite-scoring.js"),
  import("../server/context-rewrite-source-packet.js"),
]);

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function localContextScore(markdown = "") {
  const text = String(markdown || "");
  const checks = [
    /^#\s+/m,
    /##\s+Operating Urgency/i,
    /##\s+Values/i,
    /##\s+Strategy/i,
    /##\s+Milestone Map/i,
    /##\s+Decision Rules/i,
    /focus/i,
    /craft|taste/i,
    /task history|rewarded tasks|completed/i,
    /best practice|research|evidence/i,
    !/see a lawyer|consult a therapist/i.test(text),
    text.length > 10000,
  ];
  return checks.reduce((sum, value) => sum + (value ? 1 : 0), 0);
}

async function scalar(sql, params = [], column = "value") {
  const result = await query(sql, params);
  return result.rows[0]?.[column];
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function usageCost(usage = {}) {
  return numeric(Number(usage.costUsd || 0) + Number(usage.toolCostUsd || 0));
}

async function runScoreHarnessForPacket({
  sourcePacket,
  accountId,
  conversationId,
  requestMessageId,
  responseMessageId,
  jobId,
  label,
} = {}) {
  const models = contextRewriteModels();
  const perModel = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL || 3), 1), 3);
  const tasks = [];
  for (let index = 1; index <= perModel; index += 1) {
    tasks.push({ modelFamily: "glm", model: models.glm, runIndex: index });
    tasks.push({ modelFamily: "deepseek", model: models.deepseek, runIndex: index });
  }

  const settled = await Promise.allSettled(tasks.map(async (task) => {
    const prompt = renderContextRewriteScorePrompt({
      runIndex: task.runIndex,
      modelFamily: task.modelFamily,
    });
    const result = await runContextRewriteScoreCall({
      modelFamily: task.modelFamily,
      model: task.model,
      systemPrompt: prompt,
      sourcePacket,
      runIndex: task.runIndex,
      decorrelation: `${label} ${task.modelFamily} scorer run ${task.runIndex}`,
    });
    const parsedScore = normalizeContextRewriteScore(result.parsed);
    await recordBillableModelRun({
      accountId,
      conversationId,
      requestMessageId,
      responseMessageId,
      provider: result.provider,
      model: result.model,
      mode: "Context Rewrite",
      responseId: result.responseId,
      usage: result.usage,
      source: "context_rewrite_model_run",
      note: `Context Rewrite ${label} score`,
      metadata: {
        contextRewriteJobId: jobId,
        stage: `${label}:score:${task.modelFamily}:${task.runIndex}`,
        promptVersion: contextRewriteScorePromptVersion,
        promptSha256: contextRewriteScorePromptSha256,
        modelFamily: task.modelFamily,
        runIndex: task.runIndex,
      },
    });
    return {
      label,
      modelFamily: task.modelFamily,
      runIndex: task.runIndex,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      usage: result.usage,
      costUsd: usageCost(result.usage),
      score: parsedScore,
    };
  }));
  const failures = settled.filter((item) => item.status === "rejected");
  if (failures.length > 0) {
    throw failures[0].reason || new Error("context_rewrite_rewritten_scoring_failed");
  }
  const runs = settled.map((item) => item.value);

  return {
    label,
    aggregate: aggregateContextRewriteScores(runs.map((run) => run.score)),
    runs,
  };
}

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_context_rewrite_live_${suffix}`;
const conversationId = `chat_context_rewrite_live_${suffix}`;
const sampleInputPath = process.env.CONTEXT_REWRITE_SAMPLE_INPUT || "/home/pfrpc/repos/sample_context.md";
const sampleOutputPath = process.env.CONTEXT_REWRITE_SAMPLE_OUTPUT || "";
const sampleInstruction = process.env.CONTEXT_REWRITE_SAMPLE_INSTRUCTION ||
  "Rewrite the full context into a well-thought-through Task Node context document. Use the entire source document as input; do not abbreviate it into a short brief. Preserve concrete source facts, remove repetition rather than substance, make strategy and milestone maps flow from values, and apply relevant Jobs-style focus.";
const runDir = join(
  "/home/pfrpc/repos/rapit_iterator/runs",
  `tasknode-context-rewrite-live-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

try {
  await migrateDatabase();

  const jobsSourceCount = Number(
    await scalar("SELECT count(*)::integer AS value FROM jobs_corpus_sources", [], "value")
  );
  assert.ok(jobsSourceCount > 0, "expected at least one Jobs corpus source for pgvector retrieval");

  const sample = await readFile(sampleInputPath, "utf8");
  const beforeHeuristic = localContextScore(sample);
  const beforeSha256 = sha256(sample);

  await saveContextDocument({
    accountId,
    title: "Sample Context",
    body: sample,
    source: "context_rewrite_live_smoke",
  });
  await appendUsageCredit({
    accountId,
    amountUsd: 20,
    source: "context_rewrite_live_smoke",
    note: "Context Rewrite live smoke credit",
    uniqueKey: `context_rewrite_live_smoke:${accountId}`,
  });

  const created = await createContextRewriteJob({
    accountId,
    conversationId,
    instructionText: sampleInstruction,
    estimateCostUsd: 0.35,
  });

  const worker = await runContextRewriteWorkerOnce({
    limit: 1,
    workerId: `context_rewrite_live_${suffix}`,
  });
  assert.equal(worker.ok, true);
  assert.equal(worker.processed, 1);
  assert.equal(worker.failed, 0);

  const publicJob = await getContextRewriteJob({ accountId, jobId: created.job.id });
  assert.equal(publicJob.status, "completed");
  assert.match(publicJob.artifact.markdown, /##\s+.*Strategy/i);
  assert.match(publicJob.artifact.markdown, /##\s+.*Milestone/i);
  assert.ok(publicJob.artifact.markdown.length >= 10_000, "expected substantial rewritten Markdown artifact");
  assert.ok(!Object.hasOwn(publicJob, "aggregateScore"));

  const artifact = await getContextRewriteArtifact({ accountId, jobId: created.job.id });
  assert.ok(artifact.filename.endsWith(".md"));
  assert.equal(artifact.markdown, publicJob.artifact.markdown);
  assert.notEqual(sha256(artifact.markdown), beforeSha256);

  const assistant = await getContextRewriteAssistantMessage({
    accountId,
    messageId: created.job.assistantMessageId,
  });
  assert.equal(assistant.metadata.contextRewrite.status, "completed");
  assert.equal(assistant.metadata.contextRewrite.markdown, artifact.markdown);
  assert.ok(!Object.hasOwn(assistant.metadata.contextRewrite, "aggregateScore"));

  const scoreRunCount = Number(
    await scalar("SELECT count(*)::integer AS value FROM context_rewrite_score_runs WHERE job_id = $1", [created.job.id])
  );
  const searchRunCount = Number(
    await scalar("SELECT count(*)::integer AS value FROM context_rewrite_search_results WHERE job_id = $1", [created.job.id])
  );
  const modelRunSummary = await query(
    `
      SELECT
        count(*)::integer AS count,
        coalesce(sum(input_tokens), 0)::integer AS input_tokens,
        coalesce(sum(output_tokens), 0)::integer AS output_tokens,
        coalesce(sum(total_tokens), 0)::integer AS total_tokens,
        coalesce(sum(total_cost_usd), 0)::numeric AS total_cost_usd,
        coalesce(sum(web_search_calls), 0)::integer AS web_search_calls
      FROM chat_model_runs
      WHERE account_id = $1
        AND metadata_json->>'contextRewriteJobId' = $2
    `,
    [accountId, created.job.id]
  );
  const ledgerSummary = await query(
    `
      SELECT
        count(*)::integer AS count,
        coalesce(sum(amount_usd), 0)::numeric AS debit_usd
      FROM billing_ledger_entries
      WHERE account_id = $1
        AND source = 'context_rewrite_model_run'
        AND metadata_json->>'contextRewriteJobId' = $2
    `,
    [accountId, created.job.id]
  );
  const jobCost = await query(
    `
      SELECT actual_cost_usd::numeric AS actual_cost_usd,
             jsonb_array_length(coalesce(jobs_retrieval_json->'chunks', '[]'::jsonb))::integer AS jobs_chunks
      FROM context_rewrite_jobs
      WHERE id = $1 AND account_id = $2
    `,
    [created.job.id, accountId]
  );

  const modelRuns = modelRunSummary.rows[0] || {};
  const ledger = ledgerSummary.rows[0] || {};
  const persistedJob = jobCost.rows[0] || {};
  assert.equal(scoreRunCount, Number(process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL || 3) * 2);
  assert.equal(searchRunCount, 2);
  assert.equal(Number(modelRuns.count || 0), scoreRunCount + searchRunCount + 2);
  assert.ok(Number(modelRuns.total_tokens || 0) > 0, "expected live token usage");
  assert.ok(Number(modelRuns.total_cost_usd || 0) > 0, "expected live provider cost");
  assert.ok(Number(ledger.count || 0) > 0, "expected billing ledger debit rows");
  assert.ok(Number(ledger.debit_usd || 0) > 0, "expected positive billing ledger debit");
  assert.ok(Number(persistedJob.jobs_chunks || 0) > 0, "expected Jobs pgvector chunks on the job");

  const afterHeuristic = localContextScore(artifact.markdown);
  assert.ok(
    afterHeuristic >= beforeHeuristic,
    `expected local rewrite heuristic not to regress: before=${beforeHeuristic} after=${afterHeuristic}`
  );

  const initialScoreRow = await query(
    "SELECT aggregate_score_json FROM context_rewrite_jobs WHERE id = $1 AND account_id = $2",
    [created.job.id, accountId]
  );
  const initialAggregateScore = initialScoreRow.rows[0]?.aggregate_score_json || null;
  assert.ok(initialAggregateScore?.score_total !== undefined, "expected initial aggregate score");

  await saveContextDocument({
    accountId,
    title: artifact.metadata?.title || "Rewritten Sample Context",
    body: artifact.markdown,
    source: "context_rewrite_live_smoke_rewritten_score",
  });
  const rewrittenSource = await assembleContextRewriteSourcePacket({
    accountId,
    conversationId,
    instructionText:
      "Score the rewritten context document with the Context Rewrite scoring frame. Evaluate it as the final context document, not as a draft.",
  });
  const rewrittenScore = await runScoreHarnessForPacket({
    sourcePacket: rewrittenSource.packet,
    accountId,
    conversationId,
    requestMessageId: created.job.instructionMessageId,
    responseMessageId: created.job.assistantMessageId,
    jobId: created.job.id,
    label: "rewritten",
  });
  const scoreDelta = numeric(
    Number(rewrittenScore.aggregate.score_total || 0) - Number(initialAggregateScore.score_total || 0)
  );
  const scoreBumped = scoreDelta > 0;

  await mkdir(runDir, { recursive: true });
  const artifactPath = join(runDir, artifact.filename || "context-rewrite.md");
  const summaryPath = join(runDir, "live_verification_summary.json");
  const initialScorePath = join(runDir, "initial_score.json");
  const rewrittenScorePath = join(runDir, "rewritten_score.json");
  await writeFile(artifactPath, artifact.markdown, "utf8");
  if (sampleOutputPath) {
    await writeFile(sampleOutputPath, artifact.markdown, "utf8");
  }
  await writeFile(initialScorePath, `${JSON.stringify(initialAggregateScore, null, 2)}\n`, "utf8");
  await writeFile(rewrittenScorePath, `${JSON.stringify(rewrittenScore.aggregate, null, 2)}\n`, "utf8");

  const totalModelRunSummary = await query(
    `
      SELECT
        count(*)::integer AS count,
        coalesce(sum(input_tokens), 0)::integer AS input_tokens,
        coalesce(sum(output_tokens), 0)::integer AS output_tokens,
        coalesce(sum(total_tokens), 0)::integer AS total_tokens,
        coalesce(sum(total_cost_usd), 0)::numeric AS total_cost_usd,
        coalesce(sum(web_search_calls), 0)::integer AS web_search_calls
      FROM chat_model_runs
      WHERE account_id = $1
        AND metadata_json->>'contextRewriteJobId' = $2
    `,
    [accountId, created.job.id]
  );
  const totalLedgerSummary = await query(
    `
      SELECT
        count(*)::integer AS count,
        coalesce(sum(amount_usd), 0)::numeric AS debit_usd
      FROM billing_ledger_entries
      WHERE account_id = $1
        AND source = 'context_rewrite_model_run'
        AND metadata_json->>'contextRewriteJobId' = $2
    `,
    [accountId, created.job.id]
  );
  const totalModelRuns = totalModelRunSummary.rows[0] || {};
  const totalLedger = totalLedgerSummary.rows[0] || {};
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        ok: true,
        accountId,
        conversationId,
        jobId: created.job.id,
        assistantMessageId: created.job.assistantMessageId,
        sampleInputPath,
        sampleOutputPath: sampleOutputPath || null,
        sampleInstruction,
        artifactPath,
        summaryPath,
        initialScorePath,
        rewrittenScorePath,
        initialScoreTotal: Number(initialAggregateScore.score_total || 0),
        rewrittenScoreTotal: Number(rewrittenScore.aggregate.score_total || 0),
        scoreDelta,
        scoreBumped,
        initialScoreBand: initialAggregateScore.band || "",
        rewrittenScoreBand: rewrittenScore.aggregate.band || "",
        scoreRunCount,
        searchRunCount,
        pipelineModelRunCount: Number(modelRuns.count || 0),
        rewrittenScoreRunCount: rewrittenScore.runs.length,
        modelRunCount: Number(totalModelRuns.count || 0),
        inputTokens: Number(totalModelRuns.input_tokens || 0),
        outputTokens: Number(totalModelRuns.output_tokens || 0),
        totalTokens: Number(totalModelRuns.total_tokens || 0),
        webSearchCalls: Number(totalModelRuns.web_search_calls || 0),
        totalModelCostUsd: Number(totalModelRuns.total_cost_usd || 0),
        ledgerDebitRows: Number(totalLedger.count || 0),
        ledgerDebitUsd: Number(totalLedger.debit_usd || 0),
        pipelineModelCostUsd: Number(modelRuns.total_cost_usd || 0),
        pipelineLedgerDebitRows: Number(ledger.count || 0),
        pipelineLedgerDebitUsd: Number(ledger.debit_usd || 0),
        jobActualCostUsd: Number(persistedJob.actual_cost_usd || 0),
        jobsRetrievalChunks: Number(persistedJob.jobs_chunks || 0),
        artifactBytes: Buffer.byteLength(artifact.markdown, "utf8"),
        sampleOutputBytes: sampleOutputPath ? Buffer.byteLength(artifact.markdown, "utf8") : 0,
        beforeSha256,
        afterSha256: sha256(artifact.markdown),
        sampleOutputSha256: sampleOutputPath ? sha256(artifact.markdown) : "",
        publicJobHidesAggregateScore: !Object.hasOwn(publicJob, "aggregateScore"),
        assistantHidesAggregateScore: !Object.hasOwn(assistant.metadata.contextRewrite, "aggregateScore"),
        localHeuristicBefore: beforeHeuristic,
        localHeuristicAfter: afterHeuristic,
        localHeuristicDidNotRegress: afterHeuristic >= beforeHeuristic,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        jobId: created.job.id,
        accountId,
        sampleInputPath,
        sampleOutputPath: sampleOutputPath || null,
        sampleInstruction,
        artifactPath,
        summaryPath,
        initialScorePath,
        rewrittenScorePath,
        initialScoreTotal: Number(initialAggregateScore.score_total || 0),
        rewrittenScoreTotal: Number(rewrittenScore.aggregate.score_total || 0),
        scoreDelta,
        scoreBumped,
        scoreRunCount,
        searchRunCount,
        pipelineModelRunCount: Number(modelRuns.count || 0),
        rewrittenScoreRunCount: rewrittenScore.runs.length,
        modelRunCount: Number(totalModelRuns.count || 0),
        totalTokens: Number(totalModelRuns.total_tokens || 0),
        totalModelCostUsd: Number(totalModelRuns.total_cost_usd || 0),
        ledgerDebitRows: Number(totalLedger.count || 0),
        ledgerDebitUsd: Number(totalLedger.debit_usd || 0),
        jobsRetrievalChunks: Number(persistedJob.jobs_chunks || 0),
        artifactBytes: Buffer.byteLength(artifact.markdown, "utf8"),
        sampleOutputBytes: sampleOutputPath ? Buffer.byteLength(artifact.markdown, "utf8") : 0,
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}

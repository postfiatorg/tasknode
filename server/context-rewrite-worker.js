import { createHash } from "node:crypto";
import { databaseEnabled } from "./db/pool.js";
import { recordBillableModelRun } from "./repositories/chat-billing.js";
import {
  addContextRewriteActualCost,
  claimContextRewriteJobs,
  completeContextRewriteJob,
  failContextRewriteJob,
  isContextRewriteTerminalError,
  recordContextRewriteScoreRun,
  recordContextRewriteSearchResult,
  updateContextRewriteStage,
} from "./repositories/context-rewrite.js";
import { assembleContextRewriteSourcePacket } from "./context-rewrite-source-packet.js";
import {
  contextRewriteFinalPromptSha256,
  contextRewriteFinalPromptText,
  contextRewritePolishPromptSha256,
  contextRewritePolishPromptText,
  contextRewritePolishPromptVersion,
  contextRewriteScorePromptSha256,
  contextRewriteScorePromptVersion,
  renderContextRewriteScorePrompt,
} from "./context-rewrite-prompts.js";
import {
  contextRewriteModels,
  contextRewriteProviderConfigured,
  runContextRewriteFinalCall,
  runContextRewritePolishCall,
  runContextRewriteScoreCall,
  runContextRewriteSearchCall,
} from "./context-rewrite-provider.js";
import {
  aggregateContextRewriteScores,
  normalizeContextRewriteScore,
} from "./context-rewrite-scoring.js";
import { selectContextRewriteResearchQueries } from "./context-rewrite-search.js";

let timer = null;
let running = false;

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function workerEnabled() {
  return (
    process.env.TASKNODE_CONTEXT_REWRITE_WORKER_ENABLED !== "false" &&
    process.env.CONTEXT_REWRITE_WORKER_ENABLED !== "false" &&
    databaseEnabled() &&
    contextRewriteProviderConfigured()
  );
}

function scoreRunsPerModel() {
  const parsed = Number(process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL || 3);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : 3, 1), 3);
}

function scoreQuorumCount(totalRuns = 0) {
  const configured = Number(process.env.CONTEXT_REWRITE_SCORE_MIN_SUCCESS || 0);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(Math.trunc(configured), 1), totalRuns);
  }
  return Math.min(totalRuns, Math.max(2, Math.ceil(totalRuns * (2 / 3))));
}

function usageCost(usage = {}) {
  return numeric(Number(usage.costUsd || 0) + Number(usage.toolCostUsd || 0));
}

function minimumFinalMarkdownChars(sourcePacket = {}) {
  const sourceLength = String(sourcePacket?.current_context?.body || "").trim().length;
  if (sourceLength <= 0) return 4000;
  return Math.min(12000, Math.max(6000, Math.floor(sourceLength * 0.6)));
}

function validateFinalMarkdown({ markdown = "", sourcePacket = {} } = {}) {
  const text = String(markdown || "").trim();
  const minimumChars = minimumFinalMarkdownChars(sourcePacket);
  if (text.length < minimumChars) {
    const error = new Error("context_rewrite_final_markdown_too_short");
    error.actualChars = text.length;
    error.minimumChars = minimumChars;
    throw error;
  }
  const requiredHeadingPatterns = [
    /##\s+.*values/i,
    /##\s+.*strategy/i,
    /##\s+.*milestone/i,
    /##\s+.*decision/i,
  ];
  const missing = requiredHeadingPatterns.filter((pattern) => !pattern.test(text)).length;
  if (missing > 1) {
    const error = new Error("context_rewrite_final_markdown_missing_required_sections");
    error.missingSectionCount = missing;
    throw error;
  }
}

async function billProviderCall({ job, stage, result, usage, metadata = {} } = {}) {
  const billable = await recordBillableModelRun({
    accountId: job.accountId,
    conversationId: job.conversationId,
    requestMessageId: job.instructionMessageId,
    responseMessageId: job.assistantMessageId,
    provider: result?.provider || "",
    model: result?.model || "",
    mode: "Context Rewrite",
    responseId: result?.responseId || "",
    usage,
    source: "context_rewrite_model_run",
    note: `Context Rewrite ${stage}`,
    metadata: {
      contextRewriteJobId: job.id,
      stage,
      ...metadata,
    },
  });
  const costUsd = usageCost(usage);
  if (costUsd > 0) await addContextRewriteActualCost({ jobId: job.id, costUsd });
  return billable;
}

async function runOneScore({ job, sourcePacket, modelFamily, model, runIndex }) {
  const prompt = renderContextRewriteScorePrompt({ runIndex, modelFamily });
  const result = await runContextRewriteScoreCall({
    modelFamily,
    model,
    systemPrompt: prompt,
    sourcePacket,
    runIndex,
    decorrelation: `${modelFamily} scorer run ${runIndex}`,
  });
  const parsedScore = normalizeContextRewriteScore(result.parsed);
  await billProviderCall({
    job,
    stage: `score:${modelFamily}:${runIndex}`,
    result,
    usage: result.usage,
    metadata: {
      promptVersion: contextRewriteScorePromptVersion,
      promptSha256: contextRewriteScorePromptSha256,
      modelFamily,
      runIndex,
    },
  });
  await recordContextRewriteScoreRun({
    job,
    modelFamily,
    runIndex,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    promptDigest: contextRewriteScorePromptSha256,
    parsedScore,
    rawText: result.text,
    usage: result.usage,
    costUsd: usageCost(result.usage),
    status: "completed",
  });
  return parsedScore;
}

async function runScoring({ job, sourcePacket }) {
  const models = contextRewriteModels();
  const perModel = scoreRunsPerModel();
  const tasks = [];
  for (let index = 1; index <= perModel; index += 1) {
    tasks.push({ modelFamily: "glm", model: models.glm, runIndex: index });
    tasks.push({ modelFamily: "deepseek", model: models.deepseek, runIndex: index });
  }

  const settled = await Promise.allSettled(
    tasks.map((task) => runOneScore({ job, sourcePacket, ...task }))
  );
  const failures = settled.filter((item) => item.status === "rejected");
  if (failures.length > 0) {
    await Promise.allSettled(
      failures.map((failure, index) => {
        const task = tasks[settled.indexOf(failure)] || {};
        return recordContextRewriteScoreRun({
          job,
          modelFamily: task.modelFamily || "unknown",
          runIndex: task.runIndex || index + 1,
          provider: "openrouter",
          model: task.model || "",
          promptDigest: contextRewriteScorePromptSha256,
          parsedScore: {},
          rawText: "",
          usage: {},
          costUsd: 0,
          status: "failed",
          error: failure.reason?.message || String(failure.reason || "score_failed"),
        });
      })
    );
  }
  const successes = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  const quorum = scoreQuorumCount(tasks.length);
  if (successes.length < quorum) {
    const error = new Error("context_rewrite_score_quorum_not_met");
    error.successCount = successes.length;
    error.requiredCount = quorum;
    error.failureCount = failures.length;
    throw error;
  }
  return successes;
}

async function runOneResearch({ job, model, queryInfo, index }) {
  try {
    const result = await runContextRewriteSearchCall({
      model,
      query: queryInfo.query,
      index,
    });
    await billProviderCall({
      job,
      stage: `research:${index + 1}`,
      result,
      usage: result.usage,
      metadata: {
        query: queryInfo.query,
        queryIndex: index,
      },
    });
    const resultJson = {
      query: queryInfo.query,
      rationale: queryInfo.rationale,
      parsed: result.parsed,
      annotations: result.annotations,
    };
    await recordContextRewriteSearchResult({
      job,
      queryIndex: index,
      queryText: queryInfo.query,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      resultJson,
      usage: result.usage,
      costUsd: usageCost(result.usage),
      status: "completed",
    });
    return resultJson;
  } catch (error) {
    await recordContextRewriteSearchResult({
      job,
      queryIndex: index,
      queryText: queryInfo.query,
      provider: "openrouter",
      model,
      resultJson: {
        query: queryInfo.query,
        rationale: queryInfo.rationale,
      },
      usage: {},
      costUsd: 0,
      status: "failed",
      error: error?.message || String(error || "research_failed"),
    });
    throw error;
  }
}

async function runResearch({ job, aggregateScore }) {
  const models = contextRewriteModels();
  const queries = selectContextRewriteResearchQueries(aggregateScore);
  const settled = await Promise.allSettled(
    queries.map((queryInfo, index) =>
      runOneResearch({
        job,
        model: models.research,
        queryInfo,
        index,
      })
    )
  );
  const failures = settled.filter((item) => item.status === "rejected");
  if (failures.length > 0) {
    console.warn(`context rewrite research degraded with ${failures.length} failed query call(s)`);
  }
  return settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
}

function finalMetadata({ result, parsed, researchResults, draftResult = null, draftParsed = null } = {}) {
  const metadata = parsed?.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
  return {
    ...metadata,
    title: parsed?.title || metadata.title || "Context Rewrite",
    summary: metadata.summary || "",
    provider: result.provider,
    model: result.model,
    responseId: result.responseId || "",
    usage: result.usage,
    promptSha256: contextRewritePolishPromptSha256,
    promptVersion: contextRewritePolishPromptVersion,
    polishPromptSha256: contextRewritePolishPromptSha256,
    draftPromptSha256: contextRewriteFinalPromptSha256,
    draftPromptVersion: "context_rewrite_final_v1",
    draftModel: draftResult?.model || "",
    draftResponseId: draftResult?.responseId || "",
    draftTitle: draftParsed?.title || "",
    researchResultCount: researchResults.length,
  };
}

function draftMetadata({ result, parsed, researchResults } = {}) {
  const metadata = parsed?.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
  return {
    ...metadata,
    title: parsed?.title || metadata.title || "Context Rewrite",
    summary: metadata.summary || "",
    provider: result?.provider || "",
    model: result?.model || "",
    responseId: result?.responseId || "",
    usage: result?.usage || {},
    promptSha256: contextRewriteFinalPromptSha256,
    promptVersion: "context_rewrite_final_v1",
    researchResultCount: researchResults.length,
  };
}

export async function processContextRewriteJob(job) {
  await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "source_packet",
    progress: { stage: "source_packet", message: "Assembling context, memory, tasks, chat, profile, and Jobs retrieval." },
  });
  const source = await assembleContextRewriteSourcePacket({
    accountId: job.accountId,
    conversationId: job.conversationId,
    instructionText: job.instructionText || "",
  });
  job = await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "scoring",
    progress: { stage: "scoring", message: "Running Context Rewrite scoring harness." },
    sourcePacketDigest: source.digest,
    baseContextRevision: source.contextDocument?.revision || 0,
    baseBodySha256: sha256(source.contextDocument?.body || ""),
    jobsRetrieval: source.jobsRetrieval,
  });

  const scores = await runScoring({ job, sourcePacket: source.packet });
  const aggregateScore = aggregateContextRewriteScores(scores);
  job = await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "research",
    progress: { stage: "research", message: "Running two privacy-safe web research queries." },
    aggregateScore,
  });

  const researchResults = await runResearch({ job, aggregateScore });
  job = await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "final_rewrite",
    progress: { stage: "final_rewrite", message: "Writing the final Markdown artifact." },
  });

  const models = contextRewriteModels();
  const result = await runContextRewriteFinalCall({
    model: models.final,
    systemPrompt: contextRewriteFinalPromptText(),
    sourcePacket: source.packet,
    aggregateScore,
    researchResults,
    jobsRetrieval: source.jobsRetrieval,
  });
  await billProviderCall({
    job,
    stage: "final_rewrite",
    result,
    usage: result.usage,
    metadata: {
      promptSha256: contextRewriteFinalPromptSha256,
    },
  });

  const parsed = result.parsed || {};
  const markdown = String(parsed.markdown || "").trim();
  if (!markdown) throw new Error("context_rewrite_final_markdown_empty");
  validateFinalMarkdown({ markdown, sourcePacket: source.packet });

  job = await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "polish_rewrite",
    progress: { stage: "polish_rewrite", message: "Polishing the Markdown artifact for readability, flow, formatting, and action." },
  });

  const polishResult = await runContextRewritePolishCall({
    model: models.polish,
    systemPrompt: contextRewritePolishPromptText(),
    sourcePacket: source.packet,
    aggregateScore,
    researchResults,
    jobsRetrieval: source.jobsRetrieval,
    draftMarkdown: markdown,
    draftMetadata: draftMetadata({ result, parsed, researchResults }),
  });
  await billProviderCall({
    job,
    stage: "polish_rewrite",
    result: polishResult,
    usage: polishResult.usage,
    metadata: {
      promptSha256: contextRewritePolishPromptSha256,
      promptVersion: contextRewritePolishPromptVersion,
      draftResponseId: result.responseId,
    },
  });

  const polishParsed = polishResult.parsed || {};
  const polishedMarkdown = String(polishParsed.markdown || "").trim();
  if (!polishedMarkdown) throw new Error("context_rewrite_polish_markdown_empty");
  validateFinalMarkdown({ markdown: polishedMarkdown, sourcePacket: source.packet });

  return completeContextRewriteJob({
    job,
    markdown: polishedMarkdown,
    metadata: finalMetadata({ result: polishResult, parsed: polishParsed, researchResults, draftResult: result, draftParsed: parsed }),
    aggregateScore,
    sourcePacketDigest: source.digest,
  });
}

export async function runContextRewriteWorkerOnce({ limit = 1, workerId = "" } = {}) {
  if (!workerEnabled()) {
    return { ok: true, skipped: true, reason: "context_rewrite_worker_not_configured" };
  }
  if (running) return { ok: true, skipped: true, reason: "context_rewrite_worker_busy" };

  running = true;
  let claimed = 0;
  let processed = 0;
  let failed = 0;
  let cancelled = 0;
  try {
    const jobs = await claimContextRewriteJobs({ limit, workerId });
    claimed = jobs.length;
    for (const job of jobs) {
      try {
        await processContextRewriteJob(job);
        processed += 1;
      } catch (error) {
        if (isContextRewriteTerminalError(error)) {
          cancelled += error.contextRewriteStatus === "cancelled" ? 1 : 0;
          continue;
        }
        const failure = await failContextRewriteJob({ job, error, stage: job.currentStage || "failed" }).catch(() => null);
        if (failure?.skipped) {
          if (failure?.job?.status === "cancelled") cancelled += 1;
          continue;
        }
        failed += 1;
      }
    }
    return { ok: true, claimed, processed, failed, cancelled };
  } finally {
    running = false;
  }
}

export function startContextRewriteWorker() {
  if (timer || !workerEnabled()) return;
  const intervalMs = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_WORKER_INTERVAL_MS) || 15_000, 2_000), 300_000);
  timer = setInterval(() => {
    runContextRewriteWorkerOnce({ limit: Number(process.env.CONTEXT_REWRITE_WORKER_LIMIT || 1) || 1 })
      .catch((error) => {
        console.warn(`context rewrite worker failed: ${error?.message || error}`);
      });
  }, intervalMs);
  timer.unref?.();
}

export function stopContextRewriteWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

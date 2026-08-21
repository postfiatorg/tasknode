import { createHash } from "node:crypto";
import { databaseEnabled } from "./db/pool.js";
import { recordBillableModelRun } from "./repositories/chat-billing.js";
import {
  addContextRewriteActualCost,
  assertContextRewriteBudgetAvailable,
  claimContextRewriteJobs,
  completeContextRewriteJob,
  contextRewriteWatchdogSnapshot,
  createContextRewriteProviderCall,
  failContextRewriteJob,
  finishContextRewriteProviderCall,
  getCompletedContextRewriteProviderCall,
  heartbeatContextRewriteProviderCall,
  isContextRewriteTerminalError,
  listCompletedContextRewriteScoreRuns,
  listCompletedContextRewriteSearchResults,
  markTimedOutContextRewriteProviderCalls,
  recordContextRewriteScoreRun,
  recordContextRewriteSearchResult,
  saveContextRewriteDraftCheckpoint,
  updateContextRewriteStage,
} from "./repositories/context-rewrite.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
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
  contextRewriteStageTimeoutMs,
} from "./context-rewrite-provider.js";
import {
  aggregateContextRewriteScores,
  normalizeContextRewriteScore,
} from "./context-rewrite-scoring.js";
import { selectContextRewriteResearchQueries } from "./context-rewrite-search.js";

let timer = null;
let watchdogTimer = null;
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestDigest(value = {}) {
  return sha256(stableJson(value));
}

function heartbeatIntervalMs() {
  const parsed = Number(process.env.CONTEXT_REWRITE_HEARTBEAT_INTERVAL_MS || 30_000);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : 30_000, 5_000), 60_000);
}

function completedProviderResultFromCall(row = null) {
  if (!row || row.status !== "completed") return null;
  return {
    provider: row.provider || "ambient",
    model: row.model || "",
    responseId: row.response_id || "",
    parsed: row.result_json && typeof row.result_json === "object" ? row.result_json : {},
    text: row.raw_text_excerpt || JSON.stringify(row.result_json || {}),
    annotations: Array.isArray(row.annotations_json) ? row.annotations_json : [],
    usage: row.usage_json && typeof row.usage_json === "object" ? row.usage_json : {},
    providerCallId: row.id,
  };
}

async function runAuditedProviderCall({
  job,
  stage,
  callIndex = 0,
  model = "",
  request = {},
  metadata = {},
  execute,
} = {}) {
  await assertContextRewriteBudgetAvailable({ job, stage });
  const timeoutMs = contextRewriteStageTimeoutMs(stage);
  const providerCall = await createContextRewriteProviderCall({
    job,
    stage,
    callIndex,
    provider: "ambient",
    model,
    requestDigest: requestDigest({ stage, callIndex, model, request }),
    timeoutMs,
    metadata,
  });
  const providerCallId = providerCall?.id || "";
  const intervalMs = heartbeatIntervalMs();
  const heartbeat = providerCallId
    ? setInterval(() => {
      heartbeatContextRewriteProviderCall({ job, providerCallId }).catch(() => null);
    }, intervalMs)
    : null;
  heartbeat?.unref?.();
  try {
    if (providerCallId) {
      await heartbeatContextRewriteProviderCall({ job, providerCallId }).catch(() => null);
    }
    const result = await execute();
    const costUsd = usageCost(result?.usage || {});
    await finishContextRewriteProviderCall({
      providerCallId,
      status: "completed",
      result,
      usage: result?.usage || {},
      costUsd,
    });
    return { ...result, providerCallId };
  } catch (error) {
    const status = error?.message === "context_rewrite_provider_timeout" ? "timed_out" : "failed";
    await finishContextRewriteProviderCall({
      providerCallId,
      status,
      usage: {},
      costUsd: 0,
      error: error?.message || String(error || "provider_call_failed"),
    }).catch(() => null);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
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
  const costUsd = usageCost(usage);
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
      contextRewriteProviderCallId: result?.providerCallId || "",
      stage,
      ...metadata,
    },
    uniqueKey: result?.providerCallId
      ? `context_rewrite:${job.id}:${stage}:${result.providerCallId}`
      : result?.responseId
        ? `context_rewrite:${job.id}:${stage}:${result.responseId}`
        : "",
  });
  if (costUsd > 0 && billable?.ledgerEntry) await addContextRewriteActualCost({ jobId: job.id, costUsd });
  return billable;
}

async function runOneScore({ job, sourcePacket, modelFamily, model, runIndex }) {
  const stage = `score:${modelFamily}:${runIndex}`;
  const prompt = renderContextRewriteScorePrompt({ runIndex, modelFamily });
  const request = {
    sourceDigest: requestDigest(sourcePacket),
    modelFamily,
    runIndex,
    promptSha256: contextRewriteScorePromptSha256,
  };
  const result = await runAuditedProviderCall({
    job,
    stage,
    callIndex: runIndex,
    model,
    request,
    metadata: {
      modelFamily,
      runIndex,
      promptSha256: contextRewriteScorePromptSha256,
      promptVersion: contextRewriteScorePromptVersion,
    },
    execute: () => runContextRewriteScoreCall({
      modelFamily,
      model,
      systemPrompt: prompt,
      sourcePacket,
      runIndex,
      decorrelation: `${modelFamily} scorer run ${runIndex}`,
    }),
  });
  const parsedScore = normalizeContextRewriteScore(result.parsed);
  await billProviderCall({
    job,
    stage,
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
    attemptId: job.currentAttemptId,
    providerCallId: result.providerCallId,
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
  const completedRows = await listCompletedContextRewriteScoreRuns({ jobId: job.id });
  const completedByKey = new Map();
  for (const row of completedRows) {
    const key = `${row.model_family}:${row.run_index}`;
    if (!completedByKey.has(key)) completedByKey.set(key, normalizeContextRewriteScore(row.parsed_score_json || {}));
  }
  const missingTasks = [];
  for (const task of tasks) {
    const key = `${task.modelFamily}:${task.runIndex}`;
    if (!completedByKey.has(key)) {
      const providerCall = await getCompletedContextRewriteProviderCall({
        jobId: job.id,
        stage: `score:${task.modelFamily}:${task.runIndex}`,
        callIndex: task.runIndex,
      });
      const providerResult = completedProviderResultFromCall(providerCall);
      if (providerResult) {
        const parsedScore = normalizeContextRewriteScore(providerResult.parsed);
        await billProviderCall({
          job,
          stage: `score:${task.modelFamily}:${task.runIndex}`,
          result: providerResult,
          usage: providerResult.usage,
          metadata: {
            promptVersion: contextRewriteScorePromptVersion,
            promptSha256: contextRewriteScorePromptSha256,
            modelFamily: task.modelFamily,
            runIndex: task.runIndex,
            recoveredProviderCall: true,
          },
        });
        await recordContextRewriteScoreRun({
          job,
          modelFamily: task.modelFamily,
          runIndex: task.runIndex,
          attemptId: providerCall.attempt_id || job.currentAttemptId,
          providerCallId: providerCall.id,
          provider: providerResult.provider,
          model: providerResult.model || task.model,
          responseId: providerResult.responseId,
          promptDigest: contextRewriteScorePromptSha256,
          parsedScore,
          rawText: providerResult.text,
          usage: providerResult.usage,
          costUsd: usageCost(providerResult.usage),
          status: "completed",
        });
        completedByKey.set(key, parsedScore);
      } else {
        missingTasks.push(task);
      }
    }
  }

  const settled = await Promise.allSettled(
    missingTasks.map((task) => runOneScore({ job, sourcePacket, ...task }))
  );
  const failures = settled.filter((item) => item.status === "rejected");
  if (failures.length > 0) {
    await Promise.allSettled(
      failures.map((failure, index) => {
        const task = missingTasks[settled.indexOf(failure)] || {};
        return recordContextRewriteScoreRun({
          job,
          modelFamily: task.modelFamily || "unknown",
          runIndex: task.runIndex || index + 1,
          provider: "ambient",
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
  const successes = [
    ...completedByKey.values(),
    ...settled.filter((item) => item.status === "fulfilled").map((item) => item.value),
  ];
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
  const stage = `research:${index + 1}`;
  try {
    const result = await runAuditedProviderCall({
      job,
      stage,
      callIndex: index,
      model,
      request: {
        query: queryInfo.query,
        index,
      },
      metadata: {
        query: queryInfo.query,
        queryIndex: index,
      },
      execute: () => runContextRewriteSearchCall({
        model,
        query: queryInfo.query,
        index,
      }),
    });
    await billProviderCall({
      job,
      stage,
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
      attemptId: job.currentAttemptId,
      providerCallId: result.providerCallId,
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
      attemptId: job.currentAttemptId,
      provider: "ambient",
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
  const completedRows = await listCompletedContextRewriteSearchResults({ jobId: job.id });
  const completedByIndex = new Map();
  for (const row of completedRows) {
    const index = Number(row.query_index || 0);
    if (!completedByIndex.has(index)) completedByIndex.set(index, row.result_json || {});
  }
  const missing = [];
  for (const [index, queryInfo] of queries.entries()) {
    if (!completedByIndex.has(index)) {
      const providerCall = await getCompletedContextRewriteProviderCall({
        jobId: job.id,
        stage: `research:${index + 1}`,
        callIndex: index,
      });
      const providerResult = completedProviderResultFromCall(providerCall);
      if (providerResult) {
        const resultJson = {
          query: queryInfo.query,
          rationale: queryInfo.rationale,
          parsed: providerResult.parsed,
          annotations: providerResult.annotations,
        };
        await billProviderCall({
          job,
          stage: `research:${index + 1}`,
          result: providerResult,
          usage: providerResult.usage,
          metadata: {
            query: queryInfo.query,
            queryIndex: index,
            recoveredProviderCall: true,
          },
        });
        await recordContextRewriteSearchResult({
          job,
          queryIndex: index,
          queryText: queryInfo.query,
          attemptId: providerCall.attempt_id || job.currentAttemptId,
          providerCallId: providerCall.id,
          provider: providerResult.provider,
          model: providerResult.model || models.research,
          responseId: providerResult.responseId,
          resultJson,
          usage: providerResult.usage,
          costUsd: usageCost(providerResult.usage),
          status: "completed",
        });
        completedByIndex.set(index, resultJson);
      } else {
        missing.push({ queryInfo, index });
      }
    }
  }
  const settled = await Promise.allSettled(
    missing.map(({ queryInfo, index }) =>
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
  return [
    ...[...completedByIndex.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]),
    ...settled.filter((item) => item.status === "fulfilled").map((item) => item.value),
  ];
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

function frozenSourceFromJob(job = {}) {
  const packet = job.sourcePacket && typeof job.sourcePacket === "object" ? job.sourcePacket : {};
  if (!packet.schema) return null;
  return {
    packet,
    digest: job.sourcePacketDigest || requestDigest(packet),
    contextDocument: {
      revision: job.baseContextRevision || packet.current_context?.revision || 0,
      body: packet.current_context?.body || "",
    },
    jobsRetrieval: job.jobsRetrieval || packet.jobs_retrieval || {},
  };
}

function aggregateScoreFromJob(job = {}) {
  const score = job.aggregateScore && typeof job.aggregateScore === "object" ? job.aggregateScore : {};
  return score.schema || score.score_total || score.dimensions ? score : null;
}

async function loadOrCreateSourcePacket(job) {
  const frozen = frozenSourceFromJob(job);
  if (frozen) return { source: frozen, job };
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
  const updatedJob = await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "scoring",
    progress: { stage: "scoring", message: "Running Context Rewrite scoring harness." },
    sourcePacket: source.packet,
    sourcePacketDigest: source.digest,
    baseContextRevision: source.contextDocument?.revision || 0,
    baseBodySha256: sha256(source.contextDocument?.body || ""),
    jobsRetrieval: source.jobsRetrieval,
  });
  return { source, job: updatedJob };
}

export async function processContextRewriteJob(job) {
  const loaded = await loadOrCreateSourcePacket(job);
  const source = loaded.source;
  job = loaded.job;

  let aggregateScore = aggregateScoreFromJob(job);
  if (!aggregateScore) {
    if (job.currentStage !== "scoring") {
      job = await updateContextRewriteStage({
        job,
        jobId: job.id,
        stage: "scoring",
        progress: { stage: "scoring", message: "Running Context Rewrite scoring harness." },
      });
    }
    const scores = await runScoring({ job, sourcePacket: source.packet });
    aggregateScore = aggregateContextRewriteScores(scores);
    job = await updateContextRewriteStage({
      job,
      jobId: job.id,
      stage: "research",
      progress: { stage: "research", message: "Running two privacy-safe web research queries." },
      aggregateScore,
    });
  }

  if (job.currentStage !== "research" && job.currentStage !== "final_rewrite" && !job.draftMarkdown) {
    job = await updateContextRewriteStage({
      job,
      jobId: job.id,
      stage: "research",
      progress: { stage: "research", message: "Running two privacy-safe web research queries." },
      aggregateScore,
    });
  }

  const researchResults = await runResearch({ job, aggregateScore });
  let markdown = String(job.draftMarkdown || "").trim();
  let parsed = {};
  let result = null;
  const models = contextRewriteModels();

  if (!markdown) {
    job = await updateContextRewriteStage({
      job,
      jobId: job.id,
      stage: "final_rewrite",
      progress: { stage: "final_rewrite", message: "Writing the final Markdown artifact." },
    });
    const completedFinalCall = await getCompletedContextRewriteProviderCall({
      jobId: job.id,
      stage: "final_rewrite",
      callIndex: 1,
    });
    result = completedProviderResultFromCall(completedFinalCall);
    if (!result) {
      result = await runAuditedProviderCall({
        job,
        stage: "final_rewrite",
        callIndex: 1,
        model: models.final,
        request: {
          sourceDigest: source.digest,
          aggregateScoreDigest: requestDigest(aggregateScore),
          researchDigest: requestDigest(researchResults),
          jobsDigest: requestDigest(source.jobsRetrieval),
          promptSha256: contextRewriteFinalPromptSha256,
        },
        metadata: {
          promptSha256: contextRewriteFinalPromptSha256,
          promptVersion: "context_rewrite_final_v1",
        },
        execute: () => runContextRewriteFinalCall({
          model: models.final,
          systemPrompt: contextRewriteFinalPromptText(),
          sourcePacket: source.packet,
          aggregateScore,
          researchResults,
          jobsRetrieval: source.jobsRetrieval,
        }),
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
    } else {
      await billProviderCall({
        job,
        stage: "final_rewrite",
        result,
        usage: result.usage,
        metadata: {
          promptSha256: contextRewriteFinalPromptSha256,
          recoveredProviderCall: true,
        },
      });
    }
    parsed = result.parsed || {};
    markdown = String(parsed.markdown || "").trim();
    if (!markdown) throw new Error("context_rewrite_final_markdown_empty");
    validateFinalMarkdown({ markdown, sourcePacket: source.packet });
    job = await saveContextRewriteDraftCheckpoint({
      job,
      markdown,
      metadata: draftMetadata({ result, parsed, researchResults }),
    });
  } else {
    parsed = job.draftMetadata || {};
    result = {
      provider: parsed.provider || "",
      model: parsed.model || models.final,
      responseId: parsed.responseId || "",
      usage: parsed.usage || {},
      parsed,
    };
  }

  job = await updateContextRewriteStage({
    job,
    jobId: job.id,
    stage: "polish_rewrite",
    progress: { stage: "polish_rewrite", message: "Polishing the Markdown artifact for readability, flow, formatting, and action." },
  });

  const completedPolishCall = await getCompletedContextRewriteProviderCall({
    jobId: job.id,
    stage: "polish_rewrite",
    callIndex: 1,
  });
  let polishResult = completedProviderResultFromCall(completedPolishCall);
  if (!polishResult) {
    polishResult = await runAuditedProviderCall({
      job,
      stage: "polish_rewrite",
      callIndex: 1,
      model: models.polish,
      request: {
        sourceDigest: source.digest,
        draftDigest: sha256(markdown),
        aggregateScoreDigest: requestDigest(aggregateScore),
        researchDigest: requestDigest(researchResults),
        jobsDigest: requestDigest(source.jobsRetrieval),
        promptSha256: contextRewritePolishPromptSha256,
      },
      metadata: {
        promptSha256: contextRewritePolishPromptSha256,
        promptVersion: contextRewritePolishPromptVersion,
        draftResponseId: result.responseId,
      },
      execute: () => runContextRewritePolishCall({
        model: models.polish,
        systemPrompt: contextRewritePolishPromptText(),
        sourcePacket: source.packet,
        aggregateScore,
        researchResults,
        jobsRetrieval: source.jobsRetrieval,
        draftMarkdown: markdown,
        draftMetadata: draftMetadata({ result, parsed, researchResults }),
      }),
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
  } else {
    await billProviderCall({
      job,
      stage: "polish_rewrite",
      result: polishResult,
      usage: polishResult.usage,
      metadata: {
        promptSha256: contextRewritePolishPromptSha256,
        promptVersion: contextRewritePolishPromptVersion,
        draftResponseId: result.responseId,
        recoveredProviderCall: true,
      },
    });
  }

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

export async function runContextRewriteWatchdogOnce() {
  if (!workerEnabled()) {
    return { ok: true, skipped: true, reason: "context_rewrite_worker_not_configured" };
  }
  const marked = await markTimedOutContextRewriteProviderCalls().catch(() => ({ marked: 0 }));
  const snapshot = await contextRewriteWatchdogSnapshot({ limit: 25 });
  if (snapshot.staleJobs.length > 0 || Number(marked.marked || 0) > 0) {
    console.warn(
      `context rewrite watchdog: staleJobs=${snapshot.staleJobs.length} markedProviderCalls=${Number(marked.marked || 0)}`
    );
  }
  await Promise.allSettled(
    snapshot.staleJobs.map((job) =>
      recordUserObservabilityEvent({
        eventType: "user.context_rewrite.stalled",
        accountId: job.accountId,
        conversationId: job.conversationId,
        sourceSurface: "context_rewrite_worker",
        sourceRoute: "server/context-rewrite-worker.js",
        resultStatus: "stalled",
        reasonCode: "context_rewrite_running_stale",
        metrics: {
          retryCount: job.retryCount,
          elapsedSinceLockMs: job.elapsedSinceLockMs,
        },
        metadata: {
          contextRewriteJobId: job.id,
          currentStage: job.currentStage,
          lockedAt: job.lockedAt,
          lockedBy: job.lockedBy,
        },
        privacyClass: "internal",
      })
    )
  );
  return { ok: true, markedProviderCalls: Number(marked.marked || 0), ...snapshot };
}

export function startContextRewriteWorker() {
  if (timer || !workerEnabled()) return;
  const intervalMs = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_WORKER_INTERVAL_MS) || 15_000, 2_000), 300_000);
  const watchdogIntervalMs = Math.min(
    Math.max(Number(process.env.CONTEXT_REWRITE_WATCHDOG_INTERVAL_MS) || 60_000, 15_000),
    600_000
  );
  timer = setInterval(() => {
    runContextRewriteWorkerOnce({ limit: Number(process.env.CONTEXT_REWRITE_WORKER_LIMIT || 1) || 1 })
      .catch((error) => {
        console.warn(`context rewrite worker failed: ${error?.message || error}`);
      });
  }, intervalMs);
  timer.unref?.();
  watchdogTimer = setInterval(() => {
    runContextRewriteWatchdogOnce().catch((error) => {
      console.warn(`context rewrite watchdog failed: ${error?.message || error}`);
    });
  }, watchdogIntervalMs);
  watchdogTimer.unref?.();
}

export function stopContextRewriteWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

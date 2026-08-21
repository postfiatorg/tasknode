#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Context Rewrite sample smoke.");
}
process.env.TASKNODE_DATABASE_ENABLED ||= "true";
process.env.TASKNODE_JOBS_EMBEDDING_PROVIDER = "deterministic";
process.env.CONTEXT_REWRITE_PROVIDER_MOCK = "true";
process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL = "1";

const [
  { migrateDatabase },
  { closePool, query },
  { appendUsageCredit },
  { saveContextDocument },
  { ingestJobsCorpus },
  {
    cancelContextRewriteJob,
    claimContextRewriteJobs,
    completeContextRewriteJob,
    createContextRewriteProviderCall,
    createContextRewriteJob,
    failContextRewriteJob,
    finishContextRewriteProviderCall,
    getContextRewriteAssistantMessage,
    getContextRewriteArtifact,
    getContextRewriteJob,
    recordContextRewriteScoreRun,
    recordContextRewriteSearchResult,
    updateContextRewriteStage,
  },
  { assembleContextRewriteSourcePacket },
  { contextRewriteModels, runContextRewriteScoreCall },
  { aggregateContextRewriteScores, normalizeContextRewriteScore },
  { selectContextRewriteResearchQueries },
  { runContextRewriteWorkerOnce },
] = await Promise.all([
  import("../server/db/migrate.js"),
  import("../server/db/pool.js"),
  import("../server/repositories/chat-billing.js"),
  import("../server/repositories/context.js"),
  import("../server/jobs-corpus.js"),
  import("../server/repositories/context-rewrite.js"),
  import("../server/context-rewrite-source-packet.js"),
  import("../server/context-rewrite-provider.js"),
  import("../server/context-rewrite-scoring.js"),
  import("../server/context-rewrite-search.js"),
  import("../server/context-rewrite-worker.js"),
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

const jobsRaw = [
  "# Focus",
  "Great product work is not saying yes to every idea. Focus means cutting the merely good so the essential product can become obvious.",
  "",
  "# Craft",
  "The back of the fence matters. The invisible implementation should be clean because sloppy internals eventually become visible user pain.",
  "",
  "# Launch",
  "A usable product loop matters more than a sprawling roadmap. Ship the smallest complete loop, learn from real users, and then refine.",
  "",
  "# Taste",
  "Taste is the act of refusing clutter. A product should make the important thing feel inevitable.",
].join("\n");
const jobsRawSha = sha256(jobsRaw);
const suffix = randomUUID().slice(0, 8);
const accountId = `acct_context_rewrite_smoke_${suffix}`;
const conversationId = `chat_context_rewrite_smoke_${suffix}`;

try {
  await migrateDatabase();
  await query("DELETE FROM jobs_corpus_sources WHERE raw_sha256 = $1", [jobsRawSha]);
  await ingestJobsCorpus({
    raw: jobsRaw,
    sourceUrl: "smoke://context-rewrite-jobs",
    sourceLabel: "Context Rewrite Jobs smoke",
    provider: "deterministic",
    force: true,
  });

  const sample = await readFile("/home/pfrpc/repos/sample_context.md", "utf8");
  const beforeScore = localContextScore(sample);
  await saveContextDocument({
    accountId,
    title: "Sample Context",
    body: sample,
    source: "context_rewrite_sample_smoke",
  });
  await appendUsageCredit({
    accountId,
    amountUsd: 5,
    source: "context_rewrite_sample_smoke",
    note: "Context Rewrite sample smoke credit",
    uniqueKey: `context_rewrite_sample_smoke:${accountId}`,
  });

  const created = await createContextRewriteJob({
    accountId,
    conversationId,
    instructionText: "Rewrite the full context into a sharper Task Node operating brief. Preserve concrete strategy, reduce sprawl, and apply Jobs-style focus.",
    estimateCostUsd: 0.35,
  });
  assert.equal(created.job.status, "queued");
  assert.equal(created.job.aggregateScore, undefined);
  assert.equal(created.job.artifact, undefined);

  const worker = await runContextRewriteWorkerOnce({ limit: 1, workerId: `context_rewrite_smoke_${suffix}` });
  assert.equal(worker.ok, true);
  assert.equal(worker.processed, 1);
  assert.equal(worker.failed, 0);

  const publicJob = await getContextRewriteJob({ accountId, jobId: created.job.id });
  assert.equal(publicJob.status, "completed");
  assert.ok(publicJob.artifact.markdown.includes("## Strategy"));
  assert.ok(publicJob.artifact.markdown.includes("## Milestone Map"));
  assert.equal(publicJob.progress.schema, "context_rewrite.progress.v1");
  assert.equal(publicJob.progress.stage, "completed");
  assert.ok(Array.isArray(publicJob.progress.trace));
  assert.ok(publicJob.progress.trace.some((step) => step.key === "research" && step.status === "completed"));
  assert.ok(publicJob.progress.trace.some((step) => step.key === "polish_rewrite" && step.status === "completed"));
  assert.ok(!Object.hasOwn(publicJob, "aggregateScore"));

  const artifact = await getContextRewriteArtifact({ accountId, jobId: created.job.id });
  assert.ok(artifact.filename.endsWith(".md"));
  assert.equal(artifact.markdown, publicJob.artifact.markdown);

  const assistant = await getContextRewriteAssistantMessage({
    accountId,
    messageId: created.job.assistantMessageId,
  });
  assert.equal(assistant.metadata.contextRewrite.status, "completed");
  assert.equal(assistant.metadata.contextRewrite.markdown, artifact.markdown);
  assert.equal(assistant.metadata.contextRewrite.progress.schema, "context_rewrite.progress.v1");
  assert.ok(Array.isArray(assistant.metadata.contextRewrite.trace));
  assert.ok(!Object.hasOwn(assistant.metadata.contextRewrite, "aggregateScore"));

  const internal = await query(
    "SELECT aggregate_score_json FROM context_rewrite_jobs WHERE id = $1 AND account_id = $2",
    [created.job.id, accountId]
  );
  const dimensions = internal.rows[0]?.aggregate_score_json?.dimensions || {};
  assert.equal(Object.keys(dimensions).length, 15);

  const scoreRunCount = await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_score_runs WHERE job_id = $1",
    [created.job.id]
  );
  assert.equal(Number(scoreRunCount.rows[0]?.count || 0), 2);

  const afterScore = localContextScore(artifact.markdown);
  assert.ok(afterScore >= beforeScore, `expected local quality score not to regress: before=${beforeScore} after=${afterScore}`);

  const providerCallCount = await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_provider_calls WHERE job_id = $1",
    [created.job.id]
  );
  assert.ok(Number(providerCallCount.rows[0]?.count || 0) >= 6, "provider call audit rows must be recorded");
  const currentArtifactCount = await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_artifacts WHERE job_id = $1 AND artifact_type = 'final_markdown' AND is_current = true",
    [created.job.id]
  );
  assert.equal(Number(currentArtifactCount.rows[0]?.count || 0), 1);

  const auditCreated = await createContextRewriteJob({
    accountId,
    conversationId,
    instructionText: "Provider call audit regression job.",
    estimateCostUsd: 0.35,
  });
  const auditClaimed = (await claimContextRewriteJobs({
    limit: 1,
    workerId: `context_rewrite_audit_smoke_${suffix}`,
  })).find((job) => job.id === auditCreated.job.id);
  const auditCall = await createContextRewriteProviderCall({
    job: auditClaimed,
    stage: "audit_probe",
    callIndex: 1,
    provider: "mock",
    model: "mock-audit",
    requestDigest: sha256("audit_probe"),
    timeoutMs: 60_000,
    metadata: { smoke: true },
  });
  assert.equal(auditCall.status, "running");
  await finishContextRewriteProviderCall({
    providerCallId: auditCall.id,
    status: "failed",
    error: "audit_probe_complete",
  });
  await cancelContextRewriteJob({ accountId, jobId: auditCreated.job.id });

  const resumeCreated = await createContextRewriteJob({
    accountId,
    conversationId,
    instructionText: "Resume from frozen source and completed scoring/research without duplicate paid stages.",
    estimateCostUsd: 0.35,
  });
  const resumeClaimed = (await claimContextRewriteJobs({
    limit: 1,
    workerId: `context_rewrite_resume_seed_${suffix}`,
  })).find((job) => job.id === resumeCreated.job.id);
  assert.equal(resumeClaimed.status, "running");
  const resumeSource = await assembleContextRewriteSourcePacket({
    accountId,
    conversationId,
    instructionText: resumeCreated.user.body,
  });
  let resumeJob = await updateContextRewriteStage({
    job: resumeClaimed,
    stage: "scoring",
    progress: { stage: "scoring", message: "Seed frozen source for stale resume smoke." },
    sourcePacket: resumeSource.packet,
    sourcePacketDigest: resumeSource.digest,
    baseContextRevision: resumeSource.contextDocument?.revision || 0,
    baseBodySha256: sha256(resumeSource.contextDocument?.body || ""),
    jobsRetrieval: resumeSource.jobsRetrieval,
  });
  const models = contextRewriteModels();
  const seededScores = [];
  for (const task of [
    { modelFamily: "glm", model: models.glm, runIndex: 1 },
    { modelFamily: "deepseek", model: models.deepseek, runIndex: 1 },
  ]) {
    const scoreResult = await runContextRewriteScoreCall({
      modelFamily: task.modelFamily,
      model: task.model,
      sourcePacket: resumeSource.packet,
      runIndex: task.runIndex,
    });
    const parsedScore = normalizeContextRewriteScore(scoreResult.parsed);
    seededScores.push(parsedScore);
    await recordContextRewriteScoreRun({
      job: resumeJob,
      modelFamily: task.modelFamily,
      runIndex: task.runIndex,
      attemptId: resumeJob.currentAttemptId,
      provider: scoreResult.provider,
      model: scoreResult.model,
      responseId: scoreResult.responseId,
      parsedScore,
      rawText: scoreResult.text,
      usage: scoreResult.usage,
      costUsd: 0,
      status: "completed",
    });
  }
  const resumeAggregate = aggregateContextRewriteScores(seededScores);
  resumeJob = await updateContextRewriteStage({
    job: resumeJob,
    stage: "research",
    progress: { stage: "research", message: "Seed completed research for stale resume smoke." },
    aggregateScore: resumeAggregate,
  });
  const resumeQueries = selectContextRewriteResearchQueries(resumeAggregate);
  await Promise.all(resumeQueries.map((queryInfo, index) => recordContextRewriteSearchResult({
    job: resumeJob,
    queryIndex: index,
    queryText: queryInfo.query,
    attemptId: resumeJob.currentAttemptId,
    provider: "mock",
    model: "mock-search",
    responseId: `mock_resume_search_${index}`,
    resultJson: {
      query: queryInfo.query,
      rationale: queryInfo.rationale,
      parsed: {
        schema: "context_rewrite.search_result.v1",
        query: queryInfo.query,
        summary: "Seeded research checkpoint.",
        sources: [],
      },
      annotations: [],
    },
    usage: {},
    costUsd: 0,
    status: "completed",
  })));
  resumeJob = await updateContextRewriteStage({
    job: resumeJob,
    stage: "final_rewrite",
    progress: { stage: "final_rewrite", message: "Seed stale final stage for resume smoke." },
  });
  await query(
    "UPDATE context_rewrite_jobs SET locked_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE id = $1",
    [resumeJob.id]
  );
  const stalePublicJob = await getContextRewriteJob({ accountId, jobId: resumeJob.id });
  assert.equal(stalePublicJob.stalled, true);
  assert.match(stalePublicJob.statusMessage, /Stalled/);
  const beforeResumeScoreRows = Number((await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_score_runs WHERE job_id = $1",
    [resumeJob.id]
  )).rows[0]?.count || 0);
  const beforeResumeSearchRows = Number((await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_search_results WHERE job_id = $1",
    [resumeJob.id]
  )).rows[0]?.count || 0);
  const resumeWorker = await runContextRewriteWorkerOnce({
    limit: 1,
    workerId: `context_rewrite_resume_worker_${suffix}`,
  });
  assert.equal(resumeWorker.ok, true);
  assert.equal(resumeWorker.processed, 1);
  const resumed = await getContextRewriteJob({ accountId, jobId: resumeJob.id });
  assert.equal(resumed.status, "completed");
  const afterResumeScoreRows = Number((await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_score_runs WHERE job_id = $1",
    [resumeJob.id]
  )).rows[0]?.count || 0);
  const afterResumeSearchRows = Number((await query(
    "SELECT count(*)::integer AS count FROM context_rewrite_search_results WHERE job_id = $1",
    [resumeJob.id]
  )).rows[0]?.count || 0);
  assert.equal(afterResumeScoreRows, beforeResumeScoreRows);
  assert.equal(afterResumeSearchRows, beforeResumeSearchRows);

  const cancelCreated = await createContextRewriteJob({
    accountId,
    conversationId,
    instructionText: "Cancel safety regression job.",
    estimateCostUsd: 0.35,
  });
  const claimedCancelJobs = await claimContextRewriteJobs({
    limit: 1,
    workerId: `context_rewrite_cancel_smoke_${suffix}`,
  });
  const claimedCancelJob = claimedCancelJobs.find((job) => job.id === cancelCreated.job.id);
  assert.equal(claimedCancelJob.status, "running");
  assert.ok(claimedCancelJob.lockedBy);

  const cancelled = await cancelContextRewriteJob({
    accountId,
    jobId: cancelCreated.job.id,
  });
  assert.equal(cancelled.status, "cancelled");

  await assert.rejects(
    updateContextRewriteStage({
      job: claimedCancelJob,
      stage: "research",
      progress: { stage: "research", message: "This update must not revive a cancelled job." },
    }),
    /context_rewrite_cancelled/
  );
  await assert.rejects(
    completeContextRewriteJob({
      job: claimedCancelJob,
      markdown: "# Cancelled artifact must not publish",
      metadata: { title: "Cancelled" },
      aggregateScore: {},
    }),
    /context_rewrite_cancelled/
  );
  const failedCancelled = await failContextRewriteJob({
    job: claimedCancelJob,
    error: new Error("late_worker_error"),
    stage: "research",
  });
  assert.equal(failedCancelled.skipped, true);
  assert.equal(failedCancelled.job.status, "cancelled");
  const cancelledArtifact = await getContextRewriteArtifact({
    accountId,
    jobId: cancelCreated.job.id,
  });
  assert.equal(cancelledArtifact, null);

  console.log("context rewrite sample smoke ok");
} finally {
  await query("DELETE FROM context_rewrite_jobs WHERE account_id = $1", [accountId]).catch(() => null);
  await query("DELETE FROM chat_messages WHERE account_id = $1", [accountId]).catch(() => null);
  await query("DELETE FROM chat_conversations WHERE account_id = $1", [accountId]).catch(() => null);
  await query("DELETE FROM billing_ledger_entries WHERE account_id = $1", [accountId]).catch(() => null);
  await query("DELETE FROM billing_accounts WHERE account_id = $1", [accountId]).catch(() => null);
  await query("DELETE FROM context_documents WHERE account_id = $1", [accountId]).catch(() => null);
  await query("DELETE FROM jobs_corpus_sources WHERE raw_sha256 = $1", [jobsRawSha]).catch(() => null);
  await closePool();
}

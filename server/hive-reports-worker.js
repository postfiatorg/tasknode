import { randomUUID } from "node:crypto";
import { databaseEnabled } from "./db/pool.js";
import {
  buildHiveReportSourcePacket,
  hiveReportDue,
  hiveReportMetadataFromSource,
  hiveReportTypes,
  hiveReportTypeIds,
  saveHiveReport,
} from "./repositories/hive-reports.js";
import {
  generateHiveReportMarkdown,
  hiveReportsProviderConfigured,
  verifyDevelopmentReportRepos,
  verifyKolReportLinks,
} from "./hive-report-provider.js";

let timer = null;
let running = false;
let scheduled = null;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function workerIntervalMs() {
  return Math.min(
    Math.max(Number(process.env.TASKNODE_HIVE_REPORTS_WORKER_INTERVAL_MS || 60_000), 5_000),
    24 * 60 * 60 * 1000
  );
}

function hiveReportsWorkerEnabled() {
  return (
    process.env.TASKNODE_HIVE_REPORTS_WORKER_ENABLED !== "false" &&
    databaseEnabled() &&
    hiveReportsProviderConfigured()
  );
}

function verificationSummary(value = "", max = 6000) {
  return safeText(value, max) || "# Verification\n\nNo verification output was produced.";
}

function usageMetadata(...items) {
  return safeArray(items).reduce((acc, item) => {
    const usage = safeObject(item?.usage);
    acc.inputTokens += Number(usage.inputTokens || 0);
    acc.outputTokens += Number(usage.outputTokens || 0);
    acc.totalTokens += Number(usage.totalTokens || 0);
    acc.reasoningTokens += Number(usage.reasoningTokens || 0);
    acc.costUsd += Number(usage.costUsd || 0);
    acc.latencyMs += Number(usage.latencyMs || 0);
    return acc;
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  });
}

async function runVerifier({ type = "", initialMarkdown = "", sourcePacket = {}, fetchImpl = fetch } = {}) {
  if (type === "kol") {
    return {
      agent: "kol_link_verifier",
      resultSummary: await verifyKolReportLinks({ markdown: initialMarkdown, sourcePacket, fetchImpl }),
    };
  }
  if (type === "development") {
    return {
      agent: "dev_repo_verifier",
      resultSummary: await verifyDevelopmentReportRepos({ markdown: initialMarkdown, sourcePacket, fetchImpl }),
    };
  }
  return null;
}

export async function generateHiveReport({ type = "", now = new Date(), fetchImpl = fetch } = {}) {
  const sourceRunId = `hivereport_run_${randomUUID()}`;
  const sourcePacket = await buildHiveReportSourcePacket({ type, now });
  const initial = await generateHiveReportMarkdown({
    type,
    sourcePacket,
    phase: "initial",
    fetchImpl,
  });
  const verifications = [
    {
      id: `hiverepv_${randomUUID()}`,
      phase: "initial",
      agent: "hive_report_builder",
      resultSummary: [
        "# Initial Report Phase",
        "",
        `Generated initial ${hiveReportTypes[type]?.label || type} report with ${initial.model}.`,
      ].join("\n"),
      verifiedAt: now,
      metadata: {
        provider: initial.provider,
        model: initial.model,
        responseId: initial.responseId,
        usage: initial.usage,
      },
    },
  ];
  let final = initial;
  let verifier = await runVerifier({
    type,
    initialMarkdown: initial.bodyMarkdown,
    sourcePacket,
    fetchImpl,
  });
  if (verifier) {
    verifications.push({
      id: `hiverepv_${randomUUID()}`,
      phase: "agent_verify",
      agent: verifier.agent,
      resultSummary: verificationSummary(verifier.resultSummary),
      verifiedAt: now,
      metadata: {
        verifier: verifier.agent,
      },
    });
    final = await generateHiveReportMarkdown({
      type,
      sourcePacket,
      phase: "final",
      initialMarkdown: initial.bodyMarkdown,
      verifierSummary: verifier.resultSummary,
      fetchImpl,
    });
  }
  verifications.push({
    id: `hiverepv_${randomUUID()}`,
    phase: "final",
    agent: "hive_report_builder",
    resultSummary: [
      "# Final Report Phase",
      "",
      `Stored final ${hiveReportTypes[type]?.label || type} markdown report.`,
    ].join("\n"),
    verifiedAt: now,
    metadata: {
      provider: final.provider,
      model: final.model,
      responseId: final.responseId,
      usage: final.usage,
    },
  });
  const metadata = {
    ...hiveReportMetadataFromSource(sourcePacket),
    sourceRunId,
    provider: final.provider,
    initialModel: initial.model,
    finalModel: final.model,
    verifierAgent: verifier?.agent || "",
    promptDigests: {
      initial: initial.promptDigest,
      final: final.promptDigest,
    },
    usage: usageMetadata(initial, final),
  };
  return saveHiveReport({
    type,
    generatedAt: now,
    bodyMarkdown: final.bodyMarkdown,
    sourceRunId,
    model: final.model,
    metadata,
    verifications,
  });
}

export async function runHiveReportsWorkerOnce({
  types = hiveReportTypeIds,
  force = false,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured", generated: [], errors: [] };
  }
  if (!hiveReportsProviderConfigured()) {
    return { ok: false, skipped: true, reason: "hive_report_provider_not_configured", generated: [], errors: [] };
  }
  const normalizedTypes = safeArray(types).length
    ? safeArray(types).map((type) => safeText(type, 80)).filter((type) => hiveReportTypes[type])
    : hiveReportTypeIds;
  const generated = [];
  const skipped = [];
  const errors = [];
  for (const type of normalizedTypes) {
    try {
      const due = force ? { due: true, forced: true } : await hiveReportDue({ type, now });
      if (!due.due) {
        skipped.push({ type, reason: "not_due", latestGeneratedAt: due.latest?.generatedAt || null, ageMs: due.ageMs });
        continue;
      }
      const result = await generateHiveReport({ type, now, fetchImpl });
      generated.push({
        type,
        reportId: result.report?.id || "",
        generatedAt: result.report?.generatedAt || "",
        model: result.report?.model || "",
        verificationCount: result.report?.verificationCount || 0,
      });
    } catch (error) {
      errors.push({
        type,
        error: error?.message || String(error),
      });
    }
  }
  return {
    ok: errors.length === 0,
    generated,
    skipped,
    errors,
  };
}

export function scheduleHiveReportsQueue({ delayMs = 0 } = {}) {
  if (!hiveReportsWorkerEnabled()) return false;
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    processHiveReportsQueue().catch((error) => {
      console.warn("[hive-reports-worker] queue failed", error?.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return true;
}

async function processHiveReportsQueue() {
  if (running || !hiveReportsWorkerEnabled()) return;
  running = true;
  try {
    const result = await runHiveReportsWorkerOnce();
    if (result.errors?.length) {
      console.warn("[hive-reports-worker] report generation errors", result.errors);
    }
  } finally {
    running = false;
  }
}

export function startHiveReportsWorker() {
  if (!hiveReportsWorkerEnabled()) return false;
  if (timer) return true;
  timer = setInterval(() => {
    processHiveReportsQueue().catch((error) => {
      console.warn("[hive-reports-worker] interval failed", error?.message || error);
    });
  }, workerIntervalMs());
  timer.unref?.();
  scheduleHiveReportsQueue({ delayMs: Math.min(2000, workerIntervalMs()) });
  return true;
}

import { deepResearchAvailable, startCorbanuDeepResearch, fetchCorbanuDeepResearch, fetchCorbanuDeepResearchResult } from "./corbanu-deep-research.js";
import { getResearchJob } from "./repositories/research-gateway.js";
import { submitResearchJob, refreshResearchJob } from "./research-gateway.js";
import { researchLedgerAmount } from "./research-billing.js";

export async function chatResearchAccess({ accountId, env = process.env } = {}) {
  return env.CHAT_RESEARCH_PROVIDER === "corbanu"
    ? { provider: "corbanu", available: deepResearchAvailable({ accountId, env }), atCost: false }
    : { provider: "goodalexander", available: Boolean(accountId && env.GA_RESEARCH_URL && env.GA_RESEARCH_HMAC_SECRET), atCost: true };
}

export async function startChatResearch({ accountId, localJob, question, title, requestId }, {
  ga = submitResearchJob, corbanu = startCorbanuDeepResearch,
} = {}) {
  if (localJob.provider === "goodalexander") {
    const row = await ga({ accountId }, { question, max_cost_usd: localJob.maxCostUsd }, `chat:${localJob.id}`);
    return { id: row.id, status: row.status, stage: row.status };
  }
  return (await corbanu({ accountId, question, title, requestId })).body;
}

export async function fetchChatResearch({ accountId, job }, {
  getGa = getResearchJob, refreshGa = refreshResearchJob,
  fetchCorbanu = fetchCorbanuDeepResearch, resultCorbanu = fetchCorbanuDeepResearchResult,
} = {}) {
  if (job.provider === "goodalexander") {
    const row = await refreshGa(await getGa(accountId, job.gatewayJobId));
    const result = row.result_json || {};
    return {
      status: row.status, stage: row.status,
      usage: { ...(result.usage || {}), ...(row.cost_usd === null ? {} : { total_cost_usd: Number(row.cost_usd) }),
        ...(row.billed_at ? { billed_cost_usd: researchLedgerAmount(Number(row.cost_usd)) } : {}) },
      result: { ...result, title: "GoodAlexander research", source_manifest: JSON.stringify(result.sources || [], null, 2) },
      error: row.last_error || "",
    };
  }
  const remote = (await fetchCorbanu({ accountId, gatewayJobId: job.gatewayJobId })).body;
  const artifact = remote.status === "completed"
    ? await resultCorbanu({ accountId, gatewayJobId: job.gatewayJobId }) : null;
  return { ...remote, result: artifact?.body?.result || {}, error: remote.error?.detail || "" };
}

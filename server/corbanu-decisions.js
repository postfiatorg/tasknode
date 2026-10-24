import { randomUUID } from "node:crypto";
import { callCorbanu, deepResearchAvailable } from "./corbanu-deep-research.js";

export const decisionsAvailable = deepResearchAvailable;

export const DECISION_MODES = Object.freeze({
  budget: { totalCalls: 10, votes: "three", rewrite: "Kimi K3" },
  // GPT-6 Sol does the bulk work; Claude Opus 5.5 casts three of six votes,
  // reviews once and writes the final report. Charged to the user at cost.
  premium: { totalCalls: 15, votes: "six", rewrite: "Claude Opus 5.5", requiredCreditUsd: 10 },
});

export function startCorbanuDecision({ accountId, requestId, input, mode = "budget", env = process.env, fetchImpl = fetch }) {
  return callCorbanu({ accountId, requestId, path: "/internal/v1/decisions", method: "POST",
    body: { input, mode, format: "markdown" }, env, fetchImpl });
}

// Corbanu sponsors the call; this is the actual provider cost to pass on.
export function decisionCostUsd(remote = {}) {
  const models = Number(remote.billing?.model_cost_microusd || 0) / 1e6;
  const research = (remote.billing?.research_usage || []).reduce((sum, usage) => sum + Number(usage?.totalCostUsd || 0), 0);
  return Number((models + research).toFixed(6));
}

export function fetchCorbanuDecision({ accountId, gatewayJobId, artifact = "", env = process.env, fetchImpl = fetch }) {
  if (!["", "result", "pdf", "packet"].includes(artifact)) throw new Error("invalid_decision_artifact");
  const suffix = artifact ? `/${artifact}` : "";
  return callCorbanu({ accountId, requestId: `decision_read_${randomUUID()}`,
    path: `/internal/v1/decisions/${encodeURIComponent(gatewayJobId)}${suffix}`, method: "GET",
    responseType: artifact === "pdf" ? "pdf" : "json", env, fetchImpl });
}

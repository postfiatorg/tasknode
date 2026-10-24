import { requestJson } from "../../api";

export const DECISION_MODE = "decision";
export const DECISION_PLACEHOLDER = "What are you deciding?";

export const DECISION_TIERS = Object.freeze({
  budget: { label: "Budget", note: "Free · 1 research report · 3 votes", totalCalls: 10,
    steps: ["Define five options", "Research the options", "Collect three Flash votes", "Review the draft", "Kimi K3 final rewrite"] },
  premium: { label: "Premium", note: "About $7, charged at cost · 3 research reports · 6 votes", totalCalls: 15,
    steps: ["Define five options", "Research the options", "Collect six Sol and Opus votes", "Review the draft", "Claude Opus 5.5 final rewrite"] },
});
export const decisionTier = mode => DECISION_TIERS[mode] || DECISION_TIERS.budget;

export async function createDecisionJob({ input, conversationId, requestId, includeContext, mode = "budget" }) {
  const options = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, conversationId, requestId, includeContext, mode }) };
  // The same saved identity makes one transport retry safe, even if accepted.
  try { return await requestJson("/api/decisions/jobs", options); }
  catch { return requestJson("/api/decisions/jobs", options); }
}
export const fetchDecisionJob = id => requestJson(`/api/decisions/jobs/${encodeURIComponent(id)}`);
export const decisionIsTerminal = status => ["completed", "failed"].includes(status);

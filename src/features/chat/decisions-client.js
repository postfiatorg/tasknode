import { requestJson } from "../../api";

export const DECISION_MODE = "decision";
export const DECISION_PLACEHOLDER = "What decision are you considering? Add the facts and tradeoffs that matter.";

export const DECISION_TIERS = Object.freeze({
  budget: { label: "Budget", note: "Free", steps: ["Define five options", "Research the options", "Collect three Flash votes", "Review the draft", "Kimi K3 final rewrite"],
    summary: "One research report · Three DeepSeek Flash votes · Kimi K3 final rewrite", votes: "Three runs of DeepSeek V4.1 Flash", totalCalls: 10 },
  premium: { label: "Premium", note: "~$7 at cost", steps: ["Define five options", "Research the options", "Collect six Sol and Opus votes", "Review the draft", "Claude Opus 5.5 final rewrite"],
    summary: "Three research reports · Three GPT-6 Sol and three Claude Opus 5.5 votes · Opus final rewrite", votes: "GPT-6 Sol and Claude Opus 5.5, three runs each", totalCalls: 15 },
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

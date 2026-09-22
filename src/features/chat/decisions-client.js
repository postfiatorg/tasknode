import { requestJson } from "../../api";

export const DECISION_MODE = "decision";
export const DECISION_PLACEHOLDER = "What decision are you considering? Add the facts and tradeoffs that matter.";

export async function createDecisionJob({ input, conversationId, requestId, includeContext }) {
  const options = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, conversationId, requestId, includeContext }) };
  // The same saved identity makes one transport retry safe, even if accepted.
  try { return await requestJson("/api/decisions/jobs", options); }
  catch { return requestJson("/api/decisions/jobs", options); }
}
export const fetchDecisionJob = id => requestJson(`/api/decisions/jobs/${encodeURIComponent(id)}`);
export const decisionIsTerminal = status => ["completed", "failed"].includes(status);

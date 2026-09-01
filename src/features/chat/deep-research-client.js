import { requestJson } from "../../api";

export const DEEP_RESEARCH_MODE = "deep_research";
export const DEEP_RESEARCH_PLACEHOLDER = "What should I research deeply?";

export function createDeepResearchJob({ question, conversationId, requestId, title = "" }) {
  return requestJson("/api/deep-research/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, conversationId, requestId, title }),
  });
}

export function fetchDeepResearchJob(jobId) {
  return requestJson(`/api/deep-research/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelDeepResearchJob(jobId) {
  return requestJson(`/api/deep-research/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function deepResearchIsTerminal(status = "") {
  return ["completed", "failed", "cancelled"].includes(String(status || "").trim());
}

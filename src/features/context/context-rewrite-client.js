import { requestJson } from "../../api";

export const CONTEXT_REWRITE_MODE = "context_rewrite";
export const CONTEXT_REWRITE_PLACEHOLDER = "Describe what the full context rewrite should preserve, change, or optimize for";

export async function createContextRewriteJob({ message, conversationId }) {
  return requestJson("/api/context/rewrite/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      conversationId,
    }),
  });
}

export async function fetchContextRewriteJob(jobId) {
  return requestJson(`/api/context/rewrite/jobs/${encodeURIComponent(jobId)}`);
}

export function contextRewriteIsTerminal(status = "") {
  return ["completed", "failed", "cancelled"].includes(String(status || "").trim());
}

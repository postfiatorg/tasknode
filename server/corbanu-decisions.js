import { randomUUID } from "node:crypto";
import { callCorbanu, deepResearchAvailable } from "./corbanu-deep-research.js";

export const decisionsAvailable = deepResearchAvailable;

export function startCorbanuDecision({ accountId, requestId, input, env = process.env, fetchImpl = fetch }) {
  return callCorbanu({ accountId, requestId, path: "/internal/v1/decisions", method: "POST",
    body: { input, mode: "budget", format: "markdown" }, env, fetchImpl });
}

export function fetchCorbanuDecision({ accountId, gatewayJobId, artifact = "", env = process.env, fetchImpl = fetch }) {
  if (!["", "result", "pdf", "packet"].includes(artifact)) throw new Error("invalid_decision_artifact");
  const suffix = artifact ? `/${artifact}` : "";
  return callCorbanu({ accountId, requestId: `decision_read_${randomUUID()}`,
    path: `/internal/v1/decisions/${encodeURIComponent(gatewayJobId)}${suffix}`, method: "GET",
    responseType: artifact === "pdf" ? "pdf" : "json", env, fetchImpl });
}

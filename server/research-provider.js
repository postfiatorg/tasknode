import { createHash, createHmac } from "node:crypto";
import { validatorError } from "./validator-identity.js";

export function researchHmacHeaders({ method, path, accountId, body = "", timestamp = Math.floor(Date.now() / 1000), secret }) {
  if (!secret) throw validatorError("research_not_configured", 503);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  const message = [method.toUpperCase(), path, String(timestamp), accountId, digest].join("\n");
  return { "content-type": "application/json", "X-GA-Account": accountId,
    "X-GA-Timestamp": String(timestamp), "X-GA-Signature": createHmac("sha256", secret).update(message, "utf8").digest("hex") };
}

export async function callResearchService({ method = "GET", path, accountId, payload, fetchImpl = fetch, env = process.env }) {
  const configured = env.GA_RESEARCH_URL;
  if (!configured || !env.GA_RESEARCH_HMAC_SECRET) throw validatorError("research_not_configured", 503);
  const base = new URL(configured);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) throw validatorError("research_https_required", 503);
  if (!path.startsWith("/v1/research") || path.includes("?") || path.includes("#")) throw validatorError("research_path_invalid");
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const prefix = configured.endsWith("/") ? configured.slice(0, -1) : configured;
  const response = await fetchImpl(`${prefix}${path}`, {
    method, headers: researchHmacHeaders({ method, path, accountId, body, secret: env.GA_RESEARCH_HMAC_SECRET }),
    ...(body ? { body } : {}), signal: AbortSignal.timeout(20000), redirect: "error",
  });
  if (!response.ok) throw validatorError("research_service_request_failed", response.status >= 500 ? 503 : response.status);
  return response.json();
}

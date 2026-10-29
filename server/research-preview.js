import { createHash } from "node:crypto";
import { callResearchService } from "./research-provider.js";
import { researchMode } from "../shared/research-agent.js";

export async function previewResearch({ accountId, question, mode }, call = callResearchService) {
  if (typeof question !== "string" || !question.trim() || question.length > 16000) {
    throw Object.assign(new Error("research_question_invalid"), { status: 400 });
  }
  const selected = researchMode(mode);
  const preview = await call({ method: "POST", path: "/v1/research/preview", accountId,
    payload: { question, mode: selected } });
  if (!preview || !["fast", "agent"].includes(preview.mode) ||
      (selected !== "auto" && preview.mode !== selected) ||
      preview.default_max_cost_usd !== (preview.mode === "agent" ? 3 : 1.5) ||
      preview.max_cost_usd !== 10 || preview.min_cost_usd !== 0.05 || preview.preview_cost_usd !== 0 ||
      preview.question_sha256 !== createHash("sha256").update(question).digest("hex") ||
      typeof preview.route_token !== "string" || !preview.route_token || preview.route_token.length > 8192 ||
      typeof preview.reason !== "string" || preview.reason.length > 2000 ||
      !Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) <= Date.now()) {
    throw Object.assign(new Error("research_preview_invalid"), { status: 502 });
  }
  return { route_token: preview.route_token, mode: preview.mode, reason: preview.reason,
    default_max_cost_usd: preview.default_max_cost_usd, min_cost_usd: preview.min_cost_usd,
    max_cost_usd: preview.max_cost_usd, expires_at: preview.expires_at,
    question_sha256: preview.question_sha256, preview_cost_usd: 0 };
}

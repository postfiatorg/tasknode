import { researchDefaultBudget } from "./research-agent.js";
export const CHAT_RESEARCH_DEFAULT_MAX_USD = 1.5;
export const CHAT_RESEARCH_DESCRIPTION = "GoodAlexander research, billed at cost. Fast research usually takes about 3 minutes; exploratory research can take up to 10 minutes. Review your maximum before starting.";

export function defaultChatResearchBudget(availableCreditUsd, mode = "fast") {
  const available = Number(availableCreditUsd);
  return Number.isFinite(available) && available >= 0.5
    ? Math.min(researchDefaultBudget(mode), available)
    : researchDefaultBudget(mode);
}

// Read only the service's explicit enum; absent/unknown historical metadata
// must not imply that an improvement round ran or was skipped.
export function chatResearchImprovement(tih) {
  switch (tih?.round_status) {
    case "completed": return "done";
    case "skipped_unaffordable": return "skipped";
    case "interrupted": return "interrupted";
    case "running": return "running";
    default: return null;
  }
}

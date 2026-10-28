export const CHAT_RESEARCH_DEFAULT_MAX_USD = 1.5;
export const CHAT_RESEARCH_DESCRIPTION = "GoodAlexander research, billed at cost (typically $0.50-1.00, about 3 minutes)";

export function defaultChatResearchBudget(availableCreditUsd) {
  const available = Number(availableCreditUsd);
  return Number.isFinite(available) && available >= 0.5
    ? Math.min(CHAT_RESEARCH_DEFAULT_MAX_USD, available)
    : CHAT_RESEARCH_DEFAULT_MAX_USD;
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

export const TEAM_CONTEXT_REFRESH_DELAY_MS = 3_000;

export function shouldRefreshTeamContext(status = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (!normalizedStatus) return false;
  return !["current", "empty", "failed", "unavailable"].includes(normalizedStatus);
}

export function teamContextStatusLabel({ status = "", showingPreviousReport = false } = {}) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "current") return "Current";
  if (normalizedStatus === "failed") {
    return showingPreviousReport
      ? "Latest update failed — showing last completed report"
      : "Last update failed";
  }
  return showingPreviousReport
    ? "Updating — showing last completed report"
    : "Generating first report";
}

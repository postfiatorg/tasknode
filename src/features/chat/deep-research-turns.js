export function pendingDeepResearchTurns(turns) {
  return turns.filter(turn => turn.role === "assistant" && turn.metadata?.deepResearch?.jobId &&
    !["completed", "failed", "cancelled"].includes(turn.metadata.deepResearch.status));
}

// The question and answer share a job ID. Only the assistant can be replaced;
// polling must also survive hydration replacing the optimistic message ID.
export function replaceDeepResearchAssistant(turns, jobId, pendingId, replacement) {
  let replaced = false;
  return turns.flatMap(turn => {
    if (turn.role !== "assistant" || (turn.id !== pendingId && turn.metadata?.deepResearch?.jobId !== jobId)) return [turn];
    if (replaced) return [];
    replaced = true;
    return [replacement];
  });
}

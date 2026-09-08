const fallbackQuestions = [
  {
    query: "What are best practices for goal hierarchy, milestone planning, and implementation intentions in operating plans?",
    rationale: "Fallback domain question for improving strategy-to-milestone flow.",
  },
  {
    query: "What are best practices for startup product strategy, focus, tradeoffs, and customer clarity?",
    rationale: "Fallback domain question for improving focus and product judgment.",
  },
];

// The scorer already produces typed research_requests. Use those exact
// semantic requests instead of guessing a topic from words in its narrative.
export function selectContextRewriteResearchQueries(aggregateScore = {}) {
  const selected = [], seen = new Set();
  const requests = Array.isArray(aggregateScore.research_requests) ? aggregateScore.research_requests : [];
  for (const item of requests) {
    if (!item || typeof item !== "object") continue;
    const query = typeof (item.question || item.query) === "string" ? (item.question || item.query).trim().slice(0,2000) : "";
    const rationale = typeof (item.why_it_matters || item.rationale) === "string" ? (item.why_it_matters || item.rationale).trim().slice(0,2000) : "Requested by the context scorer.";
    if (query && !seen.has(query)) { selected.push({query,rationale}); seen.add(query); }
    if (selected.length === 2) break;
  }
  for (const item of fallbackQuestions) {
    if (selected.length >= 2) break;
    if (!seen.has(item.query)) { selected.push(item); seen.add(item.query); }
  }
  return selected;
}

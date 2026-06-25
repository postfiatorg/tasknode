export const contextRewriteScoreDimensions = [
  "human_readability",
  "not_prompt_guide",
  "urgency",
  "values_clarity",
  "strategy_clarity",
  "milestone_map",
  "task_history_interpretation",
  "markdown_renderability",
  "best_practice_grounding",
  "jobs_business_wisdom",
  "concision",
  "no_disclaimer_drift",
  "source_grounding",
  "specificity",
  "downstream_task_utility",
];

function clamp(value, min = 0, max = 15) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function rounded(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function bandForScore(score) {
  const value = clamp(score, 0, 15);
  if (value < 5) return "0-5";
  if (value < 10) return "5-10";
  return "10-15";
}

function median(values = []) {
  const sorted = values.map((value) => Number(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function textArray(value, { maxItems = 12, maxLength = 420 } = {}) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return source
    .map((item) => String(item || "").trim().replace(/\s+/g, " ").slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeResearchRequests(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => {
      if (typeof item === "string") {
        return { question: item.trim().slice(0, 260), why_it_matters: "" };
      }
      return {
        question: String(item?.question || item?.query || "").trim().replace(/\s+/g, " ").slice(0, 260),
        why_it_matters: String(item?.why_it_matters || item?.rationale || "").trim().replace(/\s+/g, " ").slice(0, 420),
      };
    })
    .filter((item) => item.question)
    .slice(0, 3);
}

function scoreTotal(scores = {}) {
  const values = contextRewriteScoreDimensions.map((dimension) => clamp(scores[dimension], 0, 15));
  return rounded(values.reduce((sum, value) => sum + value, 0) / values.length, 1);
}

function scoreShapeError(message, dimension = "") {
  const error = new Error(message);
  error.dimension = dimension;
  return error;
}

function validateScoreShape(parsed = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw scoreShapeError("context_rewrite_score_invalid_shape");
  }
  if (!parsed.scores || typeof parsed.scores !== "object" || Array.isArray(parsed.scores)) {
    throw scoreShapeError("context_rewrite_score_missing_scores");
  }
  for (const dimension of contextRewriteScoreDimensions) {
    if (!Object.hasOwn(parsed.scores, dimension)) {
      throw scoreShapeError("context_rewrite_score_missing_dimension", dimension);
    }
    const value = Number(parsed.scores[dimension]);
    if (!Number.isFinite(value)) {
      throw scoreShapeError("context_rewrite_score_invalid_dimension", dimension);
    }
  }
}

export function normalizeContextRewriteScore(parsed = {}) {
  validateScoreShape(parsed);
  const scores = {};
  for (const dimension of contextRewriteScoreDimensions) {
    scores[dimension] = rounded(clamp(parsed?.scores?.[dimension], 0, 15), 1);
  }
  const total = parsed?.score_total === undefined ? scoreTotal(scores) : rounded(clamp(parsed.score_total, 0, 15), 1);
  return {
    schema: "context_rewrite.score.v1",
    score_total: total,
    band: bandForScore(total),
    scores,
    strengths: textArray(parsed.strengths, { maxItems: 8 }),
    weaknesses: textArray(parsed.weaknesses, { maxItems: 10 }),
    rewrite_priorities: textArray(parsed.rewrite_priorities, { maxItems: 8 }),
    research_requests: normalizeResearchRequests(parsed.research_requests),
    task_history_interpretation: String(parsed.task_history_interpretation || "").trim().slice(0, 1200),
    jobs_business_wisdom: String(parsed.jobs_business_wisdom || "").trim().slice(0, 1200),
    risk_flags: textArray(parsed.risk_flags, { maxItems: 10, maxLength: 160 }),
  };
}

function rankedUnique(items = [], { maxItems = 12 } = {}) {
  const counts = new Map();
  const firstIndex = new Map();
  items.map((item) => String(item || "").trim()).filter(Boolean).forEach((item, index) => {
    const key = item.toLowerCase();
    counts.set(key, { value: item, count: (counts.get(key)?.count || 0) + 1 });
    if (!firstIndex.has(key)) firstIndex.set(key, index);
  });
  return Array.from(counts.values())
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return (right.value.length - left.value.length) || (firstIndex.get(left.value.toLowerCase()) - firstIndex.get(right.value.toLowerCase()));
    })
    .map((item) => item.value)
    .slice(0, maxItems);
}

export function aggregateContextRewriteScores(scoreOutputs = []) {
  const normalized = scoreOutputs.map(normalizeContextRewriteScore);
  if (normalized.length === 0) {
    throw new Error("context_rewrite_score_quorum_not_met");
  }
  const dimensionMedians = {};
  for (const dimension of contextRewriteScoreDimensions) {
    dimensionMedians[dimension] = rounded(median(normalized.map((run) => run.scores[dimension])), 1);
  }
  const total = scoreTotal(dimensionMedians);
  const researchRequests = normalized.flatMap((run) => run.research_requests || []);
  return {
    schema: "context_rewrite.aggregate_score.v1",
    score_total: total,
    band: bandForScore(total),
    dimensions: dimensionMedians,
    run_count: normalized.length,
    strengths: rankedUnique(normalized.flatMap((run) => run.strengths), { maxItems: 10 }),
    weaknesses: rankedUnique(normalized.flatMap((run) => run.weaknesses), { maxItems: 12 }),
    rewrite_priorities: rankedUnique(normalized.flatMap((run) => run.rewrite_priorities), { maxItems: 10 }),
    research_requests: rankedUnique(researchRequests.map((item) => item.question), { maxItems: 8 })
      .map((question) => {
        const match = researchRequests.find((item) => item.question.toLowerCase() === question.toLowerCase());
        return {
          question,
          why_it_matters: match?.why_it_matters || "",
        };
      }),
    task_history_interpretations: rankedUnique(normalized.map((run) => run.task_history_interpretation), { maxItems: 4 }),
    jobs_business_wisdom: rankedUnique(normalized.map((run) => run.jobs_business_wisdom), { maxItems: 4 }),
    risk_flags: rankedUnique(normalized.flatMap((run) => run.risk_flags), { maxItems: 10 }),
    runs: normalized,
  };
}

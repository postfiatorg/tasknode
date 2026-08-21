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

const questionBank = [
  {
    patterns: [/proof[-\s]?of[-\s]?reserves/i, /\btreasury\b/i, /\bbuy[-\s]?side\b/i, /\bcustody\b/i, /\bsettlement\b/i],
    query: "What are current best practices for institutional crypto proof-of-reserves, treasury management, and buy-side settlement workflows?",
    rationale: "Selected from scorer concerns about institutional finance grounding.",
  },
  {
    patterns: [/\balpha\b/i, /\bsignal/i, /\bmarket outcome/i, /\btrading\b/i, /\bbacktest/i],
    query: "What are best practices for validating alpha signals from workflow data against market outcomes?",
    rationale: "Selected from scorer concerns about alpha validation and trading evidence.",
  },
  {
    patterns: [/\bexpert network\b/i, /\bcontributor\b/i, /\btask loop\b/i, /\bevidence submission\b/i, /\bverification\b/i, /\bincentive/i],
    query: "What are best practices for expert-network contributor task loops, evidence submission, verification, and incentive design?",
    rationale: "Selected from scorer concerns about contributor workflow and task-loop utility.",
  },
  {
    patterns: [/\bgoal hierarchy\b/i, /\bmilestone\b/i, /\bimplementation intention/i, /\boperating plan\b/i, /\bsequencing\b/i],
    query: "What are best practices for goal hierarchy, milestone planning, and implementation intentions in operating plans?",
    rationale: "Selected from scorer concerns about milestone sequencing.",
  },
  {
    patterns: [/\bproduct strategy\b/i, /\bfocus\b/i, /\btradeoff/i, /\bcustomer clarity\b/i, /\bsaying no\b/i],
    query: "What are best practices for startup product strategy, focus, tradeoffs, and customer clarity?",
    rationale: "Selected from scorer concerns about focus and customer clarity.",
  },
  {
    patterns: [/\blayer\s*1\b/i, /\bvalidator\b/i, /\bgovernance\b/i, /\bpermissioned ledger\b/i, /\binteroperability\b/i],
    query: "What are current best practices for institutional blockchain adoption, validator governance, and interoperability?",
    rationale: "Selected from scorer concerns about institutional blockchain positioning.",
  },
];

function aggregateScoreText(aggregateScore = {}) {
  const requests = Array.isArray(aggregateScore.research_requests) ? aggregateScore.research_requests : [];
  return [
    ...(Array.isArray(aggregateScore.weaknesses) ? aggregateScore.weaknesses : []),
    ...(Array.isArray(aggregateScore.rewrite_priorities) ? aggregateScore.rewrite_priorities : []),
    ...(Array.isArray(aggregateScore.risk_flags) ? aggregateScore.risk_flags : []),
    ...(Array.isArray(aggregateScore.jobs_business_wisdom) ? aggregateScore.jobs_business_wisdom : []),
    ...requests.map((item) => item?.question || item?.query || item || ""),
    ...requests.map((item) => item?.why_it_matters || item?.rationale || ""),
  ].join("\n");
}

export function selectContextRewriteResearchQueries(aggregateScore = {}) {
  const text = aggregateScoreText(aggregateScore);
  const selected = [];
  const seen = new Set();

  for (const item of questionBank) {
    if (!item.patterns.some((pattern) => pattern.test(text))) continue;
    if (seen.has(item.query)) continue;
    selected.push({ query: item.query, rationale: item.rationale });
    seen.add(item.query);
    if (selected.length === 2) break;
  }

  for (const item of fallbackQuestions) {
    if (selected.length >= 2) break;
    if (seen.has(item.query)) continue;
    selected.push(item);
    seen.add(item.query);
  }

  return selected.slice(0, 2);
}

You are scoring a Task Node Context Rewrite source packet.

Return JSON only. Do not include Markdown fences.

Task Node context documents are human-readable operating briefs. They are not prompts, AI instructions, task ledgers, apology blocks, legal/therapy disclaimers, or generic productivity essays.

Score the current context document as a future Task Node operating brief, using the source packet as evidence. Return exactly 15 dimension scores. Each dimension is 0-15:

- 0-5: weak, generic, stale, repetitive, prompt-like, ungrounded, or missing the dimension.
- 5-10: usable but incomplete, vague, conflicted, too broad, or weakly supported.
- 10-15: strong, specific, concise, grounded, tactically useful, and visibly improves downstream task decisions.

Dimensions:

1. `human_readability`
2. `not_prompt_guide`
3. `urgency`
4. `values_clarity`
5. `strategy_clarity`
6. `milestone_map`
7. `task_history_interpretation`
8. `markdown_renderability`
9. `best_practice_grounding`
10. `jobs_business_wisdom`
11. `concision`
12. `no_disclaimer_drift`
13. `source_grounding`
14. `specificity`
15. `downstream_task_utility`

Rules:

- Penalize documents that repeat task history instead of interpreting it.
- Penalize machine-facing instruction language.
- Penalize vague self-help, generic founder language, and bloated plans.
- Reward clear tradeoffs, decision rules, urgency, values, strategy, and tactics that flow up to strategy.
- Reward relevant external know-how and Steve Jobs business judgment: focus, saying no, taste, end-to-end ownership, customer clarity, and craft.
- If evidence is missing, mark the gap. Do not invent support.
- Include 2-3 research requests that would improve the rewrite. These must be domain-level questions or web searches, not raw private text.

Output shape:

{
  "schema": "context_rewrite.score.v1",
  "score_total": 0,
  "band": "0-5",
  "scores": {
    "human_readability": 0,
    "not_prompt_guide": 0,
    "urgency": 0,
    "values_clarity": 0,
    "strategy_clarity": 0,
    "milestone_map": 0,
    "task_history_interpretation": 0,
    "markdown_renderability": 0,
    "best_practice_grounding": 0,
    "jobs_business_wisdom": 0,
    "concision": 0,
    "no_disclaimer_drift": 0,
    "source_grounding": 0,
    "specificity": 0,
    "downstream_task_utility": 0
  },
  "strengths": ["specific strength"],
  "weaknesses": ["specific weakness"],
  "rewrite_priorities": ["highest leverage rewrite priority"],
  "research_requests": [
    {
      "question": "domain-level question or web search",
      "why_it_matters": "how this would improve the context document"
    }
  ],
  "task_history_interpretation": "how task history should influence the rewrite without repeating tasks",
  "jobs_business_wisdom": "Jobs-derived business principle to apply if relevant",
  "risk_flags": ["grounding, staleness, privacy, or repetition risk"]
}

Run decorrelation: {{RUN_DECORRELATION}}

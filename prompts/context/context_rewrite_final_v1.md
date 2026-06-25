You are producing the final Context Rewrite artifact for Task Node.

Return JSON only. Do not include Markdown fences.

The final `markdown` field must be a complete, well-thought-through, human-readable Markdown context document. It must not expose internal scores or score improvements.

Document standard:

- Human readable, not machine readable.
- Not a prompting guide and not instructions to an AI.
- Conveys urgency without melodrama.
- Contains values, strategy, constraints, decision rules, and tactical milestone maps that flow up to strategy.
- Uses task history as evidence, not as a task ledger to repeat.
- Uses relevant academic, technical, market, operational, or workflow best practices when they fit the user's work.
- Uses Steve Jobs business wisdom when relevant: focus, saying no, taste, end-to-end ownership, customer clarity, and craft.
- Avoids repetition, apology language, generic self-help, and suggestions to see lawyers or therapists.
- Preserves concrete, grounded source facts. If a source is missing, do not invent it.
- Renders cleanly in Task Node Markdown.
- Is substantial enough to replace the user's current context document as an operating source of truth. Do not compress it into a short brief.
- Treats concision as removal of repetition and low-value sprawl, not as a mandate to make the document short.
- Preserves all strategically relevant projects, product surfaces, technical claims, market context, dependencies, and open questions from the source packet.
- Has enough detail to be reviewed as a real context document. For a large source document, the rewrite should remain a large, structured document, not a one-page summary.
- Includes clear Markdown sections for values, strategy, current state, decision rules, milestone map, product/workstream context, open questions, and what Task Node should generate next.

The source packet may include private context. Keep the output useful but do not dump private raw logs. Synthesize without abbreviating away important source facts.

Use the aggregate scoring JSON as a rewrite brief. Address the weaknesses and rewrite priorities. Use the web research packet only for general best practices, not as facts about the user. Use Jobs retrieval as operating judgment, not a style veneer.

Output shape:

{
  "schema": "context_rewrite.final.v1",
  "title": "document title",
  "markdown": "# Title\n\n...",
  "metadata": {
    "summary": "one sentence summary of the rewrite",
    "jobs_principles": ["focus"],
    "research_used": ["short source or best-practice note"],
    "source_caveats": ["missing source caveat if relevant"]
  }
}

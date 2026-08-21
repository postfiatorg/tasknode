You are polishing the final Context Rewrite artifact for Task Node.

Return JSON only. Do not include Markdown fences.

Take the provided draft plan/context document and make it:

1. more readable;
2. more persuasive;
3. more flowing;
4. free of AI slop terms such as "it's not X, it's Y", "load bearing", and em dashes;
5. tighter and less repetitive;
6. more logically consistent;
7. better formatted;
8. more likely to induce action;
9. faithful to all core content, removing only duplicate or repetitive statements.

Do not shorten the document by deleting substance. Do not introduce new user facts. Preserve concrete projects, constraints, values, strategy, milestones, open questions, and decision rules. Use the source packet only as grounding to avoid losing important content; the draft Markdown is the main text to improve.

The output must remain a complete, substantial, human-readable Markdown context document that renders cleanly in Task Node.

Output shape:

{
  "schema": "context_rewrite.polish.v1",
  "title": "document title",
  "markdown": "# Title\n\n...",
  "metadata": {
    "summary": "one sentence summary of the polished rewrite",
    "polish_focus": ["readability", "persuasion", "flow"],
    "removed_repetition": ["short note if relevant"],
    "source_caveats": ["missing source caveat if relevant"]
  }
}

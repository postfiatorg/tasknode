You are Task Node, a concise execution assistant for Post Fiat.
Help the user clarify goals, plan useful work, and move toward high-quality personal task execution.
Do not claim wallet, payment, task reward, or production account actions are complete unless the app has actually done them.
Keep answers direct and practical. Ask a short clarifying question only when the next action is genuinely ambiguous.
When the Frontier chat route provides a web search tool, use it only when the user asks for current, external, or source-grounded information that is not already available in the conversation, attachments, context document, memory, or task state. Do not use web search for ordinary drafting, reasoning, summarization, coding, or private/local user data.

## Reviewer To Do List

Review implementation against this document (task node instructions v1). Mark each item when verified.

### Memory Efficiency
- [ ] Prompt input blocks bounded; large context clipped or digested before call.
- [ ] Prompt output schema minimal for downstream storage.

### Code Quality
- [ ] Prompt version recorded when output persisted to DB or PFTL payload.
- [ ] Structured output prompts match parser validation in caller.

### Coherence
- [ ] Prompt policy matches surface doc behavior (e.g., evidence types, mode rules).
- [ ] Used-by call sites in docs-content.js still accurate.

### Bloat
- [ ] Prompt text avoids redundant restatement of data already in input blocks.
- [ ] No duplicate prompt files for same behavior without version bump.

### Security
- [ ] Prompt instructs model not to invent hidden state or exfiltrate secrets.
- [ ] Private/user data handling matches provider privacy mode for caller.

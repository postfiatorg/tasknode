Read this screenshot as verification evidence.

Return a concise evidence description. Include visible text, completion state,
important UI state, and proof-relevant numbers. Do not invent hidden state. If a
claim is not visible, say so.

Task title: {{TASK_TITLE}}
Task description: {{TASK_DESCRIPTION}}
Verification criteria: {{VERIFICATION_CRITERIA}}

## Reviewer To Do List

Review implementation against this document (evidence screenshot read v1). Mark each item when verified.

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

<account_tasks_context>
Use this account task state as background context. It is a cached projection grouped by status. If it conflicts with the current conversation or visible product state, say the task cache may be stale. Do not claim a task, verification, refusal, or reward changed unless the current action actually changed it.
Sync: {{SYNC_LINE}}
<outstanding_tasks count="{{OUTSTANDING_COUNT}}">
{{OUTSTANDING_TASKS}}
</outstanding_tasks>
<pending_verification_tasks count="{{PENDING_VERIFICATION_COUNT}}">
{{PENDING_VERIFICATION_TASKS}}
</pending_verification_tasks>
<refused_tasks count="{{REFUSED_COUNT}}">
{{REFUSED_TASKS}}
</refused_tasks>
<rewarded_tasks count="{{REWARDED_COUNT}}">
{{REWARDED_TASKS}}
</rewarded_tasks>
</account_tasks_context>

## Reviewer To Do List

Review implementation against this document (account tasks context v1). Mark each item when verified.

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

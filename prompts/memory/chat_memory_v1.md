You create compact private memory records from one Task Node chat exchange.
Return only valid JSON with keys user_request_summary, system_response_summary, and memory_text.
Return raw JSON only: no markdown fence, no prose before or after the JSON object.
user_request_summary must be 2-3 sentences summarizing what the user asked or implied.
system_response_summary must be 2-3 sentences summarizing what the assistant answered or committed to.
memory_text must preserve durable facts, preferences, goals, constraints, decisions, and follow-ups useful for future work.
Do not include secrets, seed phrases, private keys, access tokens, API keys, or passwords.

## Reviewer To Do List

Review implementation against this document (chat memory v1). Mark each item when verified.

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

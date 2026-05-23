You create account-level deep memory from exactly 36 compact Task Node memory records.
Return raw JSON only: no markdown fence, no prose before or after the JSON object.
Return keys user_request_summary_bullets, system_response_summary_bullets, and memory_text.
user_request_summary_bullets must be an array of up to 5 strings, each 1-2 sentences.
system_response_summary_bullets must be an array of up to 5 strings, each 1-2 sentences.
memory_text must be exactly 3 sentences summarizing what the user is exploring and how the system responded.
Do not include secrets, seed phrases, private keys, access tokens, API keys, or passwords.

## Reviewer To Do List

Review implementation against this document (deep memory v1). Mark each item when verified.

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

You score a submission against its task offer and verification record.
Return only JSON. Do not use markdown.

Read the inputs this way:
- `task_offer`: What the user agreed to do.
- `initial_submission`: The first evidence packet.
- `verification_request`: The follow-up ask, if any.
- `verification_response`: The user's follow-up response, if any.
- `processed_evidence`: Extracted text, screenshot descriptions, URL content, or file text.

Scoring rules:
- Reward completion of the agreed task, not effort claims.
- Reject unrelated, unverifiable, or clearly fake evidence.
- Reduce reward for missing steps, weak evidence, or evasive verification responses.
- Keep feedback short and operational.

Output fields:
- `decision`: `reward`, `partial_reward`, or `reject`.
- `reward_pft`: decimal string.
- `completion`: integer 0 to 100.
- `evidence_quality`: integer 0 to 100.
- `reason`: 2 to 4 concise sentences.
- `user_feedback`: 1 to 2 concise sentences.

## Reviewer To Do List

Review implementation against this document (reward scoring v1). Mark each item when verified.

### Memory Efficiency
- [ ] Prompt input blocks bounded; large context clipped or digested before call.
- [ ] Prompt output schema minimal for downstream storage.
- [ ] Scoring input uses processed evidence summaries, not raw media.

### Code Quality
- [ ] Prompt version recorded when output persisted to DB or PFTL payload.
- [ ] Structured output prompts match parser validation in caller.
- [ ] Score output fields match `task-reward-outcome.js` consumption.

### Coherence
- [ ] Prompt policy matches surface doc behavior (e.g., evidence types, mode rules).
- [ ] Used-by call sites in docs-content.js still accurate.
- [ ] Aligns with verification evidence doc surface matrix.

### Bloat
- [ ] Prompt text avoids redundant restatement of data already in input blocks.
- [ ] No duplicate prompt files for same behavior without version bump.
- [ ] Rubric concise; no duplicate task step text in scoring prompt.

### Security
- [ ] Prompt instructs model not to invent hidden state or exfiltrate secrets.
- [ ] Private/user data handling matches provider privacy mode for caller.
- [ ] Prompt requires grounding in supplied evidence only.

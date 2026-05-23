You repair a malformed task generation response.
Return only JSON matching `pf.taskgen.output.v1`. Do not use markdown.

Preserve the intended task when possible. Remove unsupported fields. If a field
is missing, fill the smallest reasonable value that keeps the task specific and
verifiable.

Use exactly the app-supported evidence surfaces: text, URL, screenshot/image,
uploaded file or document, public commit link when explicitly appropriate, or
mixed evidence made from those surfaces. Do not request video, screen
recording, audio, live calls, calendar invites, or another evidence surface the
app cannot submit. Return 2 to 5 concrete steps.

Required output fields:
- `schema`
- `title`
- `description`
- `task_kind`
- `steps`
- `submission_requirement`
- `verification_policy`
- `reward_offer`
- `deadline`

Do not add any field that is not listed above.

## Reviewer To Do List

Review implementation against this document (taskgen repair v1). Mark each item when verified.

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

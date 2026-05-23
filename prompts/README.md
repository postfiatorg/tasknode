# Prompts

Source-controlled prompt assets live here so production behavior can be
reviewed, versioned, and replayed.

## Layout

- `task_engine/`: Canonical prompts for PFTL task request generation,
  verification, evidence reading, and reward scoring policy.
- `chat/`: Chat system instructions plus account context, task, and memory
  injection templates.
- `context/`: Context document editing prompts used by the chat-based Context
  Refine mode.
- `memory/`: Async memory and deep-memory summarization prompts.
- `profile/`: Public profile scoring and summary prompts, including the daily
  airdrop scoring prompt and the public profile snapshot prompt. Private
  image-generation prompts do not belong here.
- `openai_jobs_*.md` and `steve_jobs_*.md`: Product prompt artifacts for the
  Motivation/Jobs surfaces. They are not task-engine policy.
- `profile_nft_image.placeholder.md`: Safe tracked fallback for profile NFT
  image generation. The production NFT image prompt belongs in ignored
  `private_prompts/profile_nft_image.md` or an explicit
  `PROFILE_NFT_PROMPT_PATH`; do not commit the private prompt body.

Runtime code should record the prompt version and prompt digest whenever a
prompt output becomes part of a PFTL payload, database cache, or audit trail.

## Reviewer To Do List

Review implementation against this document (README). Mark each item when verified.

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

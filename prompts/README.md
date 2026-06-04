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
- `non_production/`: Prompt research, local-only harness prompts, drafts, and
  reserved prompt artifacts that are not used by a live app surface. Steve Jobs
  reference material lives in `non_production/steve_jobs_ref/`. The Profile NFT
  placeholder prompt lives in `non_production/profile_nft_dev/`; production
  generation requires a private prompt from `PROFILE_NFT_PROMPT_B64`,
  `PROFILE_NFT_PROMPT_TEXT`, `PROFILE_NFT_PROMPT_PATH`, or ignored
  `private_prompts/profile_nft_image.md`.

Runtime code should record the prompt version and prompt digest whenever a
prompt output becomes part of a PFTL payload, database cache, or audit trail.

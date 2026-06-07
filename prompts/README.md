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
- `profile/`: Public profile scoring, recommendation, summary, and profile NFT
  image prompts used by live profile surfaces.
- `non_production/`: Prompt research, local-only harness prompts, drafts, and
  reserved prompt artifacts that are not used by a live app surface. Steve Jobs
  reference material lives in `non_production/steve_jobs_ref/`. The Profile NFT
  placeholder prompt lives in `non_production/profile_nft_dev/` for fallback
  tests only; live generation uses `prompts/profile/profile_nft_image_v1.md`.

Runtime code should record the prompt version and prompt digest whenever a
prompt output becomes part of a PFTL payload, database cache, or audit trail.

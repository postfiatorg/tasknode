# Prompts

Source-controlled prompt assets live here so production behavior can be
reviewed, versioned, and replayed.

## Layout

- `task_engine/`: Canonical prompts for PFTL task request generation,
  verification, evidence reading, and reward scoring policy.
- `chat/`: Chat system instructions plus account context, task, and memory
  injection templates.
- `docs/`: Canonical ODV and Trading Coach personality prompts shared by the
  primary chat personality router and PFDocs mentions. Jobs remains in
  `chat/jobs_standard_chat_codex_style_draft.md`; only that personality may
  receive Jobs pgvector excerpts.
- `kravis.md`: Canonical downside-first private-equity personality prompt used
  by the primary chat personality router.
- `context/`: Context document editing prompts used by the chat-based Context
  Refine mode.
- `memory/`: Async memory and deep-memory summarization prompts.
- `profile/`: Public profile scoring, recommendation, summary, and profile NFT
  image prompts used by live profile surfaces.
- `hive/`: Hive coordination prompts, including Hive Chat immediate-response
  instructions, Network Task routing policy, Board Manager/Secretary prompts,
  and active-project planning prompts.
- `hive/reports/`: Hive report writer prompts, including the shared report
  writer system prompt, common report instructions, per-report instructions,
  phase instructions, and message wrappers used by the report worker and Hive
  Brain prompt disclosure UI.
- `non_production/`: Prompt research, local-only harness prompts, drafts, and
  reserved prompt artifacts that are not used by a live app surface. Steve Jobs
  reference material lives in `non_production/steve_jobs_ref/`. The Profile NFT
  placeholder prompt lives in `non_production/profile_nft_dev/` for fallback
  tests only. Live generation uses the two-pass
  `prompts/profile/profile_nft_privacy_abstraction_v1.md` and
  `prompts/profile/profile_nft_privacy_review_v1.md` gateway; OpenAI receives
  only the validated high-level rendered art brief.

Runtime code should record the prompt version and prompt digest whenever a
prompt output becomes part of a PFTL payload, database cache, or audit trail.

Live prompt text must be stored in this directory tree. Runtime code may load,
template, and compose prompt files, but should not embed live model
instructions directly in provider, worker, repository, or UI source files.

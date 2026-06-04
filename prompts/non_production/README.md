# Non-Production Prompts

This folder contains prompt artifacts that are not loaded by a live app surface.

Use this folder for research prompts, drafts, local-only harness prompts, and
reserved prompt ideas. Production prompts loaded by `server/prompt-registry.js`,
the in-app Help prompt registry, or the Python task reference should stay in
their production folders.

## Folders

- `steve_jobs_ref/`: Steve Jobs and Jobs-style reference prompts, brainstorms,
  style guides, and older draft chat prompts.
- `codex_ref/`: Codex prompt drafts that are not loaded by the app.
- `task_engine_ref/`: Task-engine reference documents, reserved prompts, and
  legacy combined prompts that are not runtime-loaded.
- `deathmarch_local/`: Local-only Deathmarch Discord harness prompt.
- `profile_nft_dev/`: Dev/test Profile NFT placeholder prompt. Production
  generation fails closed unless a private prompt is configured.

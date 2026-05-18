# Prompts

Source-controlled prompt assets live here so production behavior can be
reviewed, versioned, and replayed.

## Layout

- `task_engine/`: Canonical prompts for PFTL task request generation,
  verification, evidence reading, and reward scoring policy.
- `chat/`: Chat system instructions plus account context, task, and memory
  injection templates.
- `memory/`: Async memory and deep-memory summarization prompts.
- `openai_jobs_*.md` and `steve_jobs_*.md`: Product prompt artifacts for the
  Motivation/Jobs surfaces. They are not task-engine policy.

Runtime code should record the prompt version and prompt digest whenever a
prompt output becomes part of a PFTL payload, database cache, or audit trail.

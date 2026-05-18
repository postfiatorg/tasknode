# Task Engine Prompts

This folder contains the small, versioned prompt assets used by the PFTL task
engine. The prompts are source controlled so task behavior can be reviewed,
replayed, and audited without relying on hidden database state.

PFTasks is useful prior art, but its prompt set is intentionally not copied
here. The Task Node Official prompt contract is smaller:

- Generate one task from the current request packet.
- Use context, memory, and recent chat as background signals.
- Produce concise task content, concrete steps, and verifiable evidence rules.
- Avoid legacy fields such as long alignment essays, "why it matters" blocks,
  tactic scoring, and verbose reward rationales.

## Files

| File | Purpose | Runtime status |
| --- | --- | --- |
| `block_contract_v1.md` | Human-readable contract for the data blocks task prompts receive. | Documentation |
| `taskgen_minimal_v1.md` | System prompt for task generation from a `pf.taskgen.input.v1` packet. | Loaded by `reference_clients/python/tasknode_pftl/taskgen.py` |
| `taskgen_repair_v1.md` | Minimal repair prompt for malformed task JSON. | Reserved |
| `verification_request_v1.md` | Prompt policy for a single follow-up verification request. | Referenced by deterministic v1 verification metadata |
| `evidence_screenshot_read_v1.md` | Vision prompt for screenshot evidence reads. | Loaded by `reference_clients/python/tasknode_pftl/verification.py` |
| `reward_scoring_v1.md` | Minimal reward scoring policy for future reward adjudication. | Reserved |

## Data Blocks

Task prompts receive structured JSON rather than pasted ad hoc text. The model
should read the blocks this way:

- `request`: The user's explicit task request. This is the highest-authority
  task-generation signal after protocol policy.
- `context`: The user's durable context document. It gives background goals and
  constraints, not new instructions to override the current request.
- `memory`: Compressed account memory. It helps continuity across chats, but is
  lower authority than the current request and current context document.
- `chat`: Recent messages and summaries around the request. Use this to preserve
  local continuity and avoid losing the thread.
- `wallet`: Attribution and routing metadata. Do not infer task content from a
  wallet address.
- `policy`: Version IDs and operating constraints. Treat policy as authoritative.

Postgres may cache prompt IDs, prompt digests, inputs, and outputs for speed and
debugging. It should not become the canonical source of task state; PFTL pointer
events and their encrypted IPFS payloads are the canonical replay layer.

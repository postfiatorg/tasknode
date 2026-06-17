# Board Manager Secretary Packet

The Board Manager Secretary Packet is the DeepSeek-powered compression layer in
front of the Board Manager decision model. It turns verbose Hive board state
into a compact reusable packet so the Board Manager can make a decision without
receiving the full raw board every tick.

System Status row: `board_manager_secretary_packets`

## Runtime Boundary

- Provider path: direct DeepSeek chat completions.
- Prompt: `prompts/hive/board_manager_secretary_v1.md`.
- Runtime module: `server/board-manager-secretary-packets.js`.
- Primary store: `board_manager_secretary_packets`.
- Normal caller: `scripts/board-manager-model-exec.mjs` before the Board
  Manager decision request.

The packet is keyed by a semantic source digest. Generated timestamps, trigger
names, freshness counters, and no-op Board Manager runs do not force a new
provider call.

## Non-Compressible Policy Fields

The Secretary packet is allowed to compress noisy board state, but it must not
compress away current operator routing intent. The prompt requires these fields
as first-class packet members:

- `operator_standing_policy`
- `generation_quality_policy`
- `prior_output_corpus_summary`
- `deduplication_watchlist`
- `capability_gap_summary`

The prompt marks operator standing directives, no-documentation-only generation
policy, and prior task ids/CIDs/tx hashes as non-compressible facts
(`prompts/hive/board_manager_secretary_v1.md:16`,
`prompts/hive/board_manager_secretary_v1.md:74`). The runtime normalizer
preserves those fields (`server/board-manager-secretary-packets.js:464`), and
the text form printed for the Board Manager includes dedicated sections for
operator standing policy, generation quality policy, prior output corpus, and
deduplication watchlist (`server/board-manager-secretary-packets.js:478`).

This is the boundary that prevents the old failure mode where the Secretary
packet said no explicit current constraints were set even while the operator had
active stop-docs or rerouting instructions in Hive Context.

`capability_gap_summary` is the capability-profile handoff. It is derived from
`capabilityInstrumentation` in the source packet and preserves the task-work
vocabulary (`code_task`, `documentation_task`, `capability_gating_task`,
`evidence_evaluation_packet`), the number of explicit project capability
requirements, the count of durable verified capability rows, and compact
capability gaps. Gaps identify the project, candidate, capability type, safe
scope label, candidate status, and recommended proof task shape. They do not
include raw private membership lists or server secrets.

## Generation Policy Handoff

`generation_quality_policy` is model-facing policy, not executable gating. It
tells the Board Manager and downstream task generator that documentation-only
Network Tasks are low value by default, that prior documentation should escalate
to action, and that repeated task shapes should be deduped against the prior
output corpus. The packet carries the deduplication watchlist so the decision
model can cite what it referenced and avoided in `decision_basis`; no Secretary
field directly rejects, caps, blocks, or rewards a task in code.

`capability_gap_summary` follows the same rule: it is model-facing context for
choosing between code work, proof-gathering work, public-artifact work, or an
operator follow-up. It is not a deterministic access gate, wallet ban,
blocklist, reward cap, or automatic rejection rule. Durable verified capability
rows are stored in `board_manager_capability_profiles`; Network Diagnostic
Report claims remain declared context unless a reviewed operator writes a
verified row.

## JSON Repair And Fallback

Secretary output is parsed as JSON. If DeepSeek returns malformed JSON, the
runtime makes one repair request that explicitly preserves the
non-compressible generation fields (`server/board-manager-secretary-packets.js:180`,
`server/board-manager-secretary-packets.js:702`). If repair also fails, the
runtime writes a source-derived fallback packet instead of failing open or
dropping operator policy (`server/board-manager-secretary-packets.js:243`).
That fallback states it was created because the model returned malformed JSON
and includes deterministic source facts plus the non-compressible generation
policy.

## Status Derivation

Green means the latest packet row exists and is `current`.

Amber is not used for this row today.

Red means the latest packet row is `failed`.

Disabled means secretary packets are intentionally unavailable because the
feature or provider key is not configured.

## Debug And Repair

Run the packet smoke and a dry Board Manager model call:

```bash
npm run board-manager-secretary-packet-smoke
npm run board-manager:model -- --no-execute
```

Confirm `DEEPSEEK_API_KEY` is configured when secretary packets are enabled. If
the row is failed, inspect the latest packet `error`, source digest, and provider
response shape. Fix the provider/config error first, then let the next Board
Manager model tick produce or reuse a current packet.

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

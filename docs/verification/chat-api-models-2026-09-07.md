# Chat model selector and API billing — 2026-09-07

Added GPT-6 Astra, Claude Fable 5.1, and Kimi K3 to the server-backed model picker alongside Instant, Thinking, and Help. Existing account-local selection persistence applies.

## Provider and pricing evidence

Vercel's public model catalogue at https://ai-gateway.vercel.sh/v1/models returned all three exact IDs:

| Label | Model ID | Base input / cached input / output USD per million |
| --- | --- | --- |
| GPT-6 Astra | openai/gpt-6-astra | 10 / 1 / 50 |
| Claude Fable 5.1 | anthropic/claude-fable-5.1 | 10 / 0.25 / 50 |
| Kimi K3 | moonshotai/kimi-k3 | 3 / 0.30 / 15 |

These are estimate rates. Final ledger debits equal Gateway-reported cost, without markup, including actual pricing adjustments. Astra estimates apply its catalogue long-context tier beginning at 272,001 input tokens. Missing provider cost stops billing instead of guessing a debit. Instant, Thinking, and Help retain their existing user tariffs.

Exact model selections bypass operator model defaults and Ambient substitution, including image requests. Missing Vercel configuration disables those options. Streaming now passes the full provider response into usage accounting so Gateway cost metadata survives.

## Verification

- `node scripts/chat-api-models-smoke.mjs`: passed. Exact IDs, image routing, estimates, signed-out gating, missing configuration, no fallback after provider failure, streamed/non-streamed cost parity, zero cost, missing-cost guard, isolated runtime ledger debits, Astra long-context estimate, unchanged legacy tariffs.
- `node scripts/chat-mode-deprecation-smoke.mjs`: passed.
- `node scripts/inference-failover-smoke.mjs`: passed, 105 assertions.
- `node scripts/inference-feature-smoke.mjs`: passed.
- `node scripts/inference-no-regex-check.mjs`: passed, 238 reachable files.
- `node scripts/system-status-smoke.mjs`: passed.
- `node scripts/telegram-bot-webhook-smoke.mjs`: passed.
- `node scripts/chat-api-models-browser-smoke.mjs`: passed using a dedicated Vite server and Chrome CDP fixture; rendered model options and prices, 1280px/390px viewports, all three selections.
- `npm run lint` and `npm run build`: passed.

## Initial live verification limitation

Tiny streaming probes requested “Reply with exactly: ready” with a 256-token limit. The local API container lacks a Vercel key; the development env file's credential received HTTP 401 for all three models. No live completion, provider charge, or production ledger debit was verified. No user account was charged by fixture tests. A valid deployed Gateway credential is required before live qualification. No deployment or push performed.

## Live retest with supplied credential files

The user subsequently supplied separate credential text files. `MODEL_CREDENTIAL_DIR=/home/pfrpc/repos MODEL_PROBE_OUTPUT=docs/verification/chat-api-models-live-2026-09-07.json node scripts/chat-api-models-live-smoke.mjs` tested the actual inference and billing functions with high reasoning, a 1,024-token output ceiling, and a small arithmetic request.

Astra and Kimi K3 passed streaming and non-streaming calls, returned the requested model IDs and correct answer, and produced Gateway cost metadata equal to the calculated debit. Four successful requests cost $0.003455 total as reported by Vercel; no user ledger was debited. The probe loop took 8.069 seconds.

Fable 5.1 returned HTTP 400 in streaming and a separate non-streaming diagnostic. Vercel classified the error as `no_zdr_providers_available`: this model retains data and is ineligible for the credential's Zero Data Retention configuration. This is a provider policy restriction, not an invalid API key or request schema. No ZDR setting was changed, and no model was substituted. A credential/configuration permitting the model's retention policy is required for a successful Fable test.

Secrets were read only into process memory and were not included in logs or evidence. Detailed successful response IDs, timings, tokens, and costs are in `docs/verification/chat-api-models-live-2026-09-07.json`.

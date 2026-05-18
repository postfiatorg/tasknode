# Code Review: AI Providers

Source doc: `docs/wiki/architecture/ai-providers.md`
Branch: `review/chat-history-ownership`
Review status: complete
Code review complete: yes
Last updated: 2026-05-18

## Scope

Reviewed the provider routing boundary for Chat modes:

- `server/chat-router.js`
- `server/chat-search-tools.js`
- `server/chat-estimate.js`
- `server/product-contracts.js`
- `server/repositories/chat-billing.js`
- `scripts/runtime-store-smoke.mjs`
- `scripts/chat-attachment-smoke.mjs`
- `scripts/security-smoke.mjs`

## Summary

No P0 was found in this pass.

The strongest issue is billing correctness for Frontier web search. The
provider usage path charges web-search calls after execution, but the estimate
and credit gate do not include possible tool cost before execution.

## Findings

### P1 - Frontier web-search tool cost is omitted from preflight credit checks

Surfaces:

- `server/chat-search-tools.js` / `openAiTools`, `webSearchUsdPerCall`
- `server/chat-estimate.js` / `chatEstimate`
- `server/product-contracts.js` / `chatExecutionPreflight`
- `server/chat-router.js` / `openAiResponseRequest`, `openAiUsage`

Current behavior:

- `openAiTools` enables hosted `web_search` for current-information messages.
- `openAiResponseRequest` allows up to `max_tool_calls: 4` when tools are
  present.
- `openAiUsage` adds `webSearchCalls * webSearchUsdPerCall` to final billed
  usage.
- `chatEstimate` only estimates token cost. It does not include any web-search
  tool estimate.
- `chatExecutionPreflight` checks available credit against `estimate.estimatedUsd`.

Why this matters:

- A Frontier request can pass the credit gate with enough balance for tokens but
  not enough balance for the web-search calls that the same request is allowed
  to execute.
- The UI estimate understates the request cost for web-search prompts.
- The account can go negative by tool cost even though the product contract says
  preflight checks estimated cost and available credit before execution.

Proposed fix:

1. Have `chatEstimate` call the same web-search decision used by
   `openAiResponseRequest` when the normalized mode is an OpenAI mode.
2. Add an estimated tool-cost field, probably
   `estimatedToolCostUsd = webSearchUsdPerCall * maxToolCalls`, when web search
   is enabled.
3. Include that tool estimate in `estimatedUsd` and expose it separately in the
   response so the UI can explain the estimate.
4. Add smoke coverage proving a low-credit account is rejected when token cost
   fits but estimated web-search cost does not.

### P2 - Streaming fallback usage undercounts full provider input

Surfaces:

- `server/chat-router.js` / `streamOpenAi`, `streamOpenRouter`, `fallbackUsage`
- `server/product-contracts.js` / `chatStreamStart`

Current behavior:

- Streaming paths prefer provider usage when the stream includes it.
- If usage is missing, `fallbackUsage` estimates input tokens from only the
  current `message` and output tokens from returned text.
- It does not include history, memory context, task context, attachments, or web
  search tool cost.

Why this matters:

- A provider stream that completes without usage can underbill exactly the
  requests most likely to be expensive: long-context, attachment-heavy, or
  memory/task-enriched chats.
- The ledger marks usage as estimated, but the estimate is materially lower than
  the request that was actually sent.

Proposed fix:

1. Pass the preflight estimate into stream finalization and use it as the
   minimum fallback input/tool cost when provider usage is missing.
2. Keep output fallback based on returned text.
3. Persist a metadata flag on the model run when provider usage is missing.
4. Add a fixture test for streaming completion without usage.

### P2 - Non-stream provider error parsing loses upstream status on non-JSON bodies

Surfaces:

- `server/chat-router.js` / `fetchJson`

Current behavior:

- `fetchJson` reads provider response text and immediately calls `JSON.parse`
  when text exists.
- If the provider returns a non-JSON error body, the JSON parse throws before
  the code attaches `response.status` and a provider message.
- The stream path already handles this more defensively.

Why this matters:

- Provider outages, gateway errors, or HTML/plain-text error bodies become a
  generic parser failure instead of preserving the upstream HTTP status.
- This makes operational debugging harder and can produce misleading API errors.

Proposed fix:

1. Parse JSON in a guarded block, matching the stream error path.
2. Preserve `response.status`.
3. Store a short body excerpt in `providerMessage` when JSON parsing fails.
4. Add a direct unit smoke for non-JSON `500` and `429` provider responses.

### P2 - Unknown chat modes silently route to Private Instant

Surfaces:

- `server/chat-router.js` / `normalizedChatMode`, `chatModeConfig`
- `server/product-contracts.js` / `chatPayload`
- `server/chat-estimate.js` / `estimatePayload`

Current behavior:

- Any unknown mode is normalized to `Private Instant`.
- This is helpful as an internal fallback, but it is currently also used for
  external request payloads.

Why this matters:

- A UI/client typo or stale mode name can silently send the request to a
  different provider family, with different pricing, model capability, and
  attachment behavior.
- The user receives a real answer, so the mistake is easy to miss.

Proposed fix:

1. Keep `normalizedChatMode` for internal display defaults.
2. Add a request validator for external chat payloads.
3. Return `400 chat_mode_unknown` for unknown external modes.
4. Add regression coverage for send, stream, and estimate.

### P3 - Frontier modes have no explicit kill switch

Surfaces:

- `server/chat-router.js` / `chatProviderEnabled`

Current behavior:

- OpenRouter has `OPENROUTER_CHAT_ENABLED=false` and
  `TASKNODE_ENABLE_OPENROUTER_CHAT=false`.
- OpenAI is enabled whenever `OPENAI_API_KEY` exists.

Why this matters:

- Operators can disable Private modes without removing secrets, but cannot do
  the same for Frontier modes.
- That is awkward during provider incidents, spend spikes, or staged rollout.

Proposed fix:

1. Add `OPENAI_CHAT_ENABLED=false` and `TASKNODE_ENABLE_OPENAI_CHAT=false`.
2. Include this in readiness/app-state mode status.
3. Add a smoke assertion matching the existing OpenRouter kill-switch behavior.

## Fix Order

1. Web-search estimate and credit gate.
2. Non-JSON provider error parsing.
3. Unknown mode request validation.
4. Streaming fallback usage.
5. OpenAI kill switch.

## Evidence Captured

Code paths reviewed:

- `docs/wiki/architecture/ai-providers.md`
- `server/chat-router.js`
- `server/chat-search-tools.js`
- `server/chat-estimate.js`
- `server/product-contracts.js`
- `scripts/runtime-store-smoke.mjs`
- `scripts/chat-attachment-smoke.mjs`
- `scripts/security-smoke.mjs`

Verification run on 2026-05-18:

- `npm run quality` - passed
- `npm run security-smoke` - passed
- `npm run runtime-smoke` - passed
- `npm run chat-attachment-smoke` - passed

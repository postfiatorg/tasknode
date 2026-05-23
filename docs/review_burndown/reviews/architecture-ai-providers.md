# Review Plan: AI Providers

Source doc: `docs/wiki/architecture/ai-providers.md`
App doc group: Architecture
App doc slug: `ai-providers`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/ai-providers-billing` (Phase 1 partial fixes)

## Important App Surfaces

- `server/chat-router.js`
- `server/chat-search-tools.js`
- `server/chat-estimate.js`
- `server/chat-provider-message-builders.js`
- `server/chat-attachment-utils.js`
- `server/product-contracts.js`
- `prompts/chat/*.md`
- `scripts/runtime-store-smoke.mjs`, `scripts/chat-spirit-prompt-smoke.mjs`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed (static + estimate/send paths).
- [x] Persistence and ownership boundaries reviewed (N/A for provider boundary).
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Conversation history sent to provider but omitted from estimate

**Files:** `server/chat-router.js:809-814`, `server/chat-estimate.js` (prior), `server/chat-provider-message-builders.js`

**What happens:** Execution loads up to 12 prior turns into OpenAI `input` / OpenRouter `messages`. Preflight estimate counted only the current message, instructions, and context blocks.

**Impact:** Long threads could pass the 402 credit gate then cost more than reserved.

**Fix:** **Fixed** — `chatHistoryCharacterEstimate` mirrors provider history shaping; `chatEstimateForAccount` and send preflight load history; estimate includes `historyInputTokens`.

---

### 2. P1 — Multimodal attachments under-estimated

**Files:** `server/chat-attachment-utils.js:204-210` (prior)

**What happens:** Non-text attachments counted only a short `Attached {kind}: {name}` label; execution sends full base64 payloads.

**Fix:** **Fixed** — image/file/pdf estimates use conservative size-based character floors.

---

### 3. P1 — Context Edit estimate omitted history/proposal; send double-counted history

**Files:** `server/context-edit-chat.js`, `server/chat-estimate.js`, `server/chat-router.js`

**What happens:** Estimate used incomplete `renderContextEditPrompt`; execution put history in instructions **and** OpenAI `input` transcript.

**Fix:** **Fixed (partial)** — estimate includes history + active proposal; OpenAI input omits history when `instructionsOverride` is set (Context Edit path).

---

### 4. P1 — Stream/fallback usage could underbill Frontier web search

**Files:** `server/chat-router.js:480-490`, `622-644`

**What happens:** `fallbackUsage` omitted `webSearchCalls`/`toolCostUsd`; stream path relied on `output` items only for search counts.

**Fix:** **Fixed** — fallback reserves max search budget for OpenAI modes; `openAiUsage` also reads usage metadata fields when present.

---

### 5. P1 — No post-execution credit floor (open)

**Files:** `server/product-contracts.js:728-729`, `server/repositories/chat-billing.js`

**What happens:** Preflight checks estimate once; actual provider usage debits without re-check.

**Fix:** Open — requires explicit overage policy (clamp, reject, or hold/settle).

---

### 6. P2 — API default mode vs app-state default drifted

**Files:** `server/chat-router.js:72`, `server/app-state.js:64-90`, `server/product-contracts.js:506`

**What happens:** API fallback was always `Private Instant` while UI preferred enabled `Frontier Instant`.

**Fix:** **Fixed** — `effectiveDefaultChatMode()` aligns API fallback with enabled Frontier when OpenAI route is ready.

---

### 7. P2 — Readiness reported OpenRouter missing when `OPENROUTER` env used

**Files:** `server/product-contracts.js:2721`, `server/chat-router.js:78-79`

**Fix:** **Fixed** — readiness uses `chatProviderConfigured("openrouter")`.

---

### 8. P2 — OpenAI vs OpenRouter cost basis divergence (open)

**Files:** `server/chat-router.js:462-477`, `159-167`

**What happens:** OpenRouter prefers provider `usage.cost`; OpenAI uses configured `chatModePrices` rates + tool line items.

**Fix:** Open — document cross-mode ledger semantics; optional normalization layer.

---

## What looks correct

| Area | Assessment |
|------|------------|
| Mode matrix | Provider/model/reasoning/search wiring matches wiki |
| Private modes | No web-search tools; ZDR prefs applied |
| Preflight search reserve | Frontier estimates max `$0.04` tool budget |
| Memory/task/context in estimate | Included when account context loaded (runtime smoke) |
| Provider disabled/missing key | 409/503 before provider call |
| Attachment validation | Rejects bad payloads before estimate/send |

---

## Fix bundles

1. **`EstimateExecutionParity`** — **Fixed (partial)**: history, attachments, context-edit estimate/send alignment.
2. **`WebSearchBillingIntegrity`** — **Fixed (partial)**: fallback + usage metadata search counts.
3. **`ModeSurfaceCoherence`** — **Fixed (partial)**: default mode + readiness OpenRouter check.
4. **`CreditGateHardening`** — Open: post-execution floor / hold-settle.
5. **`ProviderAccountingUnification`** — Open: cross-provider cost normalization + ledger fixtures.

---

## Verification

**Base:** `origin/main` @ `4e34fa8`

```bash
npm run quality
npm run runtime-smoke
npm run chat-spirit-prompt-smoke
npm run security-smoke
```

**Not verified:** Live OpenAI/OpenRouter stream usage payloads with real web-search calls; post-debit overdraw scenarios.

---

## Review Findings (legacy)

Prior docs-only review items around mode matrix and ZDR policy remain accurate. No P0 cross-account provider issues found in static review.

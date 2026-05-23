# Review Plan: Context

Source doc: `docs/wiki/surfaces/context.md`
App doc group: Surfaces
App doc slug: `context`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/context-surface` (Phase 1 fixes implemented)

## Important App Surfaces

- `src/main.jsx` / `ContextView`
- `src/features/context/context-view-utils.jsx`
- `src/features/context/context-publish.js`, `src/features/context/context.css`
- `shared/context-html.js`, `shared/context-line-map.js`
- `server/repositories/context.js`
- `server/context-publish.js`, `server/context-ipfs.js`, `server/context-history-rpc.js`
- `server/context-line-map.js`, `server/pftl-cache-reducer.js`
- `server/db/migrations/003_context_cache.sql`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed.
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Publish snapshot froze wrong pointer metadata before reducer could correct it

**Files:** `server/context-publish.js`, `server/repositories/context.js` (`insertPointer`)

**What happens:** After publish, `saveContextHistoryProjection` wrote pointer rows using server clock time, draft revision, and client word count. The PFTL reducer later projected chain metadata for the same `(tx_hash, memo_index, cid)`, but `ON CONFLICT DO NOTHING` kept the publish snapshot.

**Impact:** History list could permanently show wrong timestamps, revision labels, word counts, and sort order even after sync completed.

**Fix:** **Fixed** — `insertPointer` upserts on stable pointer id and lets `pftl_cache.*` sources replace publish-placeholder metadata. Postgres smoke covers publish-then-reducer parity.

---

### 2. P1 — Editor line numbers diverged from Context Refine line map

**Files:** `src/main.jsx` (prior gutter helper), `server/context-line-map.js`, wiki claim in `docs/wiki/surfaces/context.md`

**What happens:** The Context editor gutter used a simplified HTML→text stripper while Refine prompts used `contextBodyText` (list prefixes, entity decoding, whitespace normalization).

**Impact:** Users saw line N in the editor while Refine received line M — systematic anchor drift for HTML documents.

**Fix:** **Fixed** — shared `contextBodyText` / `contextLineCount` in `shared/context-line-map.js`; client gutter and server packet use the same normalization. `context-line-map-parity-smoke` guards HTML fixtures.

---

### 3. P1 — Debounced autosave cancelled on navigation without flush

**Files:** `src/main.jsx` (`ContextView` debounce effect)

**What happens:** Leaving Context within the 900ms debounce window cleared the timer and never called save, even when `dirtyRef` was true.

**Impact:** Fast navigation after edits silently dropped unsaved draft work.

**Fix:** **Fixed** — debounce cleanup flushes a pending save via `saveContextRef` when dirty and not already saving.

---

### 4. P2 — Repository history read accepts arbitrary wallet address (deferred)

**Files:** `server/repositories/context.js` (`getContextHistory`)

**What happens:** Repository layer does not verify the wallet is the account's currently linked wallet; HTTP routes gate this today.

**Fix:** Open — defense-in-depth link check inside repository or caller contract test.

---

## Evidence

- `npm run quality` (includes `context-line-map-parity-smoke`, `context-edit-smoke`)
- `npm run db:context-smoke` — account draft, history scoping, publish/reducer metadata upsert
- `npm run context-history-rpc-smoke`
- `npm run runtime-smoke` — delink boundary (existing)

## Deferred

Repository-level linked-wallet assertion on history reads; optional `beforeunload` guard when dirty.

# Ethereum Top-Up And Account Funding Audit

Date: 2026-05-25  
Auditor: review agent  
Base commit reviewed: `b287b2f` (Skip prefunded Ethereum top-up addresses)  
Related commits: `69eb193` (Baseline first Ethereum top-up sync), `2483ca2` (CSP WASM)  
Branch with follow-up fixes: `review/ethereum-top-up-audit`

## Executive Summary

The **5 USDC on a zero-balance account** incident was real and correctly diagnosed: the app showed **on-chain observed balance** in the top-up modal while the **billing ledger stayed at $0** because the address was assigned without verifying the chain was empty, and first-sync logic could baseline historical funds without issuing credit.

Commit `b287b2f` fixes the **primary user-visible failure mode** (prefunded derived address shown to a new account). This audit finds **additional P1 gaps** in the same boundary that explain why top-up and account-linkage keep producing P0-class confusion:

1. Deposit address mappings live only in **runtime JSON**, not Postgres — fragile on Fly and incompatible with multi-instance durability expectations.
2. **`hasRecordedCredit` used `currentCreditUsd > 0`**, so accounts that **spent down legitimate deposits** could be treated like pre-fix orphans and **retired on the next modal open** (fixed on audit branch).
3. **Total RPC probe failure still returned an unverified address** before this audit branch — operator outage could repeat assignment without emptiness check.
4. UI displays **`observedBalances`** without clearly separating **“seen on chain”** from **“credited to spend balance”**.

The b287b2f repair on Fly for `0xE858…e402` → `0x7Ea525…` was the right operational triage. The architecture still needs Postgres-backed deposit rows and clearer UX/state separation.

---

## Incident Timeline (Reported)

| Step | What happened |
|------|----------------|
| 1 | User opened top-up; modal showed **5.00 USDC** on assigned address |
| 2 | Wallet/usage balance showed **$0 available** |
| 3 | Funds were already on the derived address **before** this account owned it |
| 4 | No billing ledger credit existed for that USDC |
| 5 | Fix deployed: retire prefunded address, allocate clean `0x7Ea525…`, verify zeros |

**Root cause class:** assignment boundary treated **derivation index availability** as sufficient; it did not require **chain-empty + billing baseline** before exposing an address.

---

## Architecture (Current)

```text
Signed-in app account (session.accountId)
        │
        ▼
POST /api/usage/top-up/start
        │
        ├─► getOrCreateVerifiedEthereumTopUpAccount()
        │     ├─ derive candidate from ETH_DEPOSIT_XPUB + cursor
        │     ├─ RPC probe ETH/USDC/USDT balances
        │     ├─ retire if prefunded / baseline-only orphan
        │     └─ persist mapping in runtime-store.json
        │
        ▼
UI modal (ethereum-top-up.jsx) shows depositAccount.observedBalances
        │
        ▼
POST /api/usage/top-up/sync (poll + manual refresh)
        │
        └─► creditDelta → appendUsageCredit (Postgres billing_ledger when DB enabled)
```

**Correct product boundary (documented):**

- Top-up addresses bind to **app account ID**, not linked PFT wallet (`docs/ETHEREUM_TOP_UPS.md`, `usageTopUpStart` copy).
- Custodial operator rail — no MetaMask, no withdrawals.
- Internal **usage ledger** is spend authority; chain balance is funding source only.

---

## What b287b2f Fixed

| Area | Change |
|------|--------|
| `getOrCreateVerifiedEthereumTopUpAccount` | Loop up to 20 candidates; RPC probe; retire prefunded |
| `retireEthereumDepositAccount` | Track retired rows + reason (`prefunded_before_assignment:USDC`) |
| `syncEthereumTopUpAccount` | First-sync baseline only when appropriate; delta credit after assignment |
| `runtime-store-smoke.mjs` | Prefunded skip + post-assignment credit delta tests |
| Docs | `ETHEREUM_TOP_UPS.md`, deployment wiki |

**Verified on main @ b287b2f:** `npm run runtime-smoke` passes including prefunded skip case.

---

## Findings

### P0 (Historical — addressed by b287b2f)

1. **Prefunded derived address shown to new account**
   - **Files:** `server/ethereum-deposits.js` (pre-b287b2f), `src/features/billing/ethereum-top-up.jsx:236-244`
   - **Impact:** User sees spendable-looking token balance while billing is $0 — trust-breaking, support-heavy.
   - **Verification:** Fly account with 5 USDC on `0xE858…e402`; runtime smoke now reproduces and rejects.
   - **Status:** Fixed in `b287b2f`.

### P1 (Open or fixed on audit branch)

1. **Deposit mapping stored only in runtime JSON, not Postgres**
   - **Files:** `server/runtime-store.js:23-26,1283-1410`; no SQL migration for deposit accounts
   - **Impact:** Address assignment, cursor, observed/credited balances, and retirement history live in `/data/runtime-store.json` on Fly. Loss/desync of that file reopens index collisions and orphan UX. Multi-app-instance would not share deposit state.
   - **Verification:** `rg ethereumDeposit server/db/migrations` → no matches; PR-09 review already flagged auth identities in JSON — same class.
   - **Fix:** Migrate `ethereum_deposit_accounts` + `ethereum_deposit_retirements` to Postgres; keep runtime store for non-canonical cache only.

2. **`hasRecordedCredit` conflated “current balance” with “ever credited”** — **fixed on audit branch**
   - **File:** `server/ethereum-deposits.js:149-153` @ b287b2f
   - **Impact:** Account deposits $18.34, spends it all (`currentCreditUsd=0`, `currentSpendUsd>0`). Next `top-up/start` computed `baselineOnly=true` and could **retire a legitimate address** that still holds on-chain funds.
   - **Verification:** New runtime-smoke case: spend via `appendChatTurn`, replay `usageTopUpStart`, expect same address.
   - **Fix:** `accountHasBillingCreditForDeposit()` checks credit, spend, or `lastCreditedLedgerIds`.

3. **Total RPC probe failure returned unverified address** — **fixed on audit branch**
   - **File:** `server/ethereum-deposits.js:156-162` @ b287b2f
   - **Impact:** If all three asset probes fail, start still returned the candidate address with `syncErrors` — same failure class as pre-fix (assignment without emptiness proof).
   - **Fix:** Return `503 deposit_balance_probe_failed` instead of exposing address.

4. **UI equates observed chain balance with usable funds**
   - **File:** `src/features/billing/ethereum-top-up.jsx:236-245`, `formatDepositAssetBalance`
   - **Impact:** Modal shows on-chain USDC amount even when billing ledger is zero (historical bug; still confusing during partial sync / pending).
   - **Fix:** Show separate lines: “On-chain observed”, “Credited to balance”, “Available to spend” from `usage.availableCreditUsd`; hide or grey out observed when not credited and not pending.

5. **`69eb193` baseline-first-sync without start-time probe**
   - **Impact:** Introduced “baseline without credit” path that was correct for **post-assignment** deltas but insufficient alone when assignment skipped chain check.
   - **Status:** Mitigated by b287b2f start probe; keep both layers.

6. **Destructive ops and shared dev index cursor**
   - **Files:** `scripts/fly-dev-data-bridge.mjs` (unrelated but same operator session); deposit cursor global in runtime store
   - **Impact:** Manual test deposits to derived indices pollute shared xpub space; retirement helps but cursor monotonic — document operator discipline (index 0 reserved, test funds labeled).

### P2

1. **Background poll every 8s while modal open** — `ethereum-top-up.jsx:106-109`; acceptable but amplifies RPC load; no backoff on repeated 503.
2. **CoinGecko price fetch for ETH** — external dependency during sync; env fallback exists.
3. **Pending balance path** — `pendingBalanceBlockTag` vs `balanceBlockTag`; documented but easy to misconfigure.
4. **BillingSettings + WalletView duplicate top-up flows** — two entry points, same API; OK but double test surface.

---

## Account Linkage Cross-Cutting Issues

Repeated P0s on **account creation / linkage / top-up** share one theme: **multiple identity and funding stores without a single durable source of truth**.

| Concern | Auth / accounts | Ethereum top-up |
|---------|-----------------|-----------------|
| Canonical store | runtime JSON (+ partial Postgres billing) | runtime JSON only |
| User expectation | One account cloud | One deposit address per account |
| Failure mode | Duplicate identity / wrong link | Wrong address / uncredited chain funds |
| Fly durability | `/data/runtime-store.json` volume on app process | Same file |

**Recommendation:** Treat **account_id-scoped funding rows** as Postgres-first in the same migration wave as auth provider identities (PR-09 follow-up).

---

## Code References (Critical Paths)

```108:195:server/ethereum-deposits.js
export async function getOrCreateVerifiedEthereumTopUpAccount({ accountId = "" } = {}) {
  // candidate loop, probe, retire prefunded, baseline sync
}
```

```397:504:server/ethereum-deposits.js
export async function syncEthereumTopUpAccount({ accountId = "" } = {}) {
  // firstAssetSync baseline vs creditDelta; idempotent uniqueKey per raw balance
}
```

```1301:1368:server/runtime-store.js
export function getOrCreateEthereumDepositAccount({ ... }) {
  // global cursor + addressIndex; not transactional across machines
}
```

```1769:1821:server/product-contracts.js
export async function usageTopUpStart(payload, method, session = null) {
  // requires session.accountId; calls verified allocator
}
```

---

## Checks Run (Audit)

| Check | Result |
|-------|--------|
| `npm run runtime-smoke` @ b287b2f | pass |
| `npm run runtime-smoke` @ audit branch (spent-credit + RPC fail-closed) | pass |
| Code review of `ethereum-deposits.js`, `runtime-store.js`, UI modal | complete |
| Fly route smoke (reported by operator) | pass on dev |

---

## Fixes On Audit Branch (`review/ethereum-top-up-audit`)

1. Replace `hasRecordedCredit` with `accountHasBillingCreditForDeposit()` (credit, spend, or ledger ids).
2. Fail closed with `503 deposit_balance_probe_failed` when all asset probes fail.
3. Runtime smoke: address stable after deposited credit is fully spent.

---

## Merge Recommendation

| Item | Action |
|------|--------|
| b287b2f prefunded skip | **Keep deployed** — correct hotfix |
| Audit branch P1 fixes | **Merge** after `npm run quality` + integration re-run |
| Postgres deposit tables | **New engineering PR** — required before calling funding boundary production-grade |
| UI credit vs observed split | **Follow-up UX PR** |
| Auth + deposit durable store | **Coordinate with PR-09** |

---

## Residual Risks

- Operator sends USDC to **retired** address after rotation — funds not lost (custody) but UX/support burden remains until sweep tooling exists.
- Wrong-chain deposits — warned in UI, not auto-detected.
- Single Fly volume for runtime store — backup/restore discipline required.
- No automated test on live Fly RPC + real xpub without secrets in CI.

---

```text
Review: Ethereum top-up audit
Boundary: Account funding / ETH deposit rail / usage billing linkage
Branch: review/ethereum-top-up-audit
Base: b287b2f
Findings:
- P0: prefunded address shown (fixed b287b2f)
- P1: JSON-only deposit state; spent-credit false orphan (fixed audit branch); RPC fail-open (fixed audit branch); UI observed vs credited
- P2: polling, price oracle, duplicate UI entry points
Fixes included: billing-credit detection; RPC fail-closed; spent-credit smoke
Checks run: runtime-smoke (pass)
Manual evidence: Fly repair 0xE858 retired → 0x7Ea525 clean (operator report)
Merge recommendation: merge audit branch; plan Postgres deposit migration
```

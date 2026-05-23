# Review Plan: Wallet

Source doc: `docs/wiki/surfaces/wallet.md`
App doc group: Surfaces
App doc slug: `wallet`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/wallet-auth-unlock` (Phase 1 fixes implemented)

## Important App Surfaces

- `src/features/wallet/WalletView.jsx`
- `src/features/wallet/WalletUnlockModal.jsx`
- `src/features/wallet/WalletSeedBackupModal.jsx`
- `src/features/wallet/wallet-state.js`, `src/wallet-core.js`
- `server/product-contracts.js` wallet actions
- `server/runtime-store.js` wallet/account state
- `server/wallet-proof.js`, `server/pftl-balance.js`, `server/pftl-transactions.js`, `server/pftl-faucet.js`
- `src/features/tasks/TaskDetailModal.jsx`, `task-request-unlock-policy.js`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed (create, link, unlock, retry).
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Initiation gift retry allowed for `wallet_link` proofs

**Files:** `server/product-contracts.js` (`claimWalletCreateInitiationGift`, `walletInitiationRetry`), `server/runtime-store.js`

**What happens:** OAuth-eligible accounts could link an existing seed via `wallet_link`, then call `POST /api/wallet/initiation/retry` and attempt the 12 PFT create gift even though the wallet was not created through `wallet_create`.

**Impact:** Gift economics tied to wallet creation could be claimed without the intended proof path.

**Fix:** **Fixed** — linked-wallet `proofPurpose` gates `claimWalletCreateInitiationGift`; retry returns 409 `wallet_create_proof_required` for link-only wallets. Runtime smoke covers link + retry rejection.

---

### 2. P1 — Task detail signing used weaker unlock check than task request

**Files:** `src/features/tasks/TaskDetailModal.jsx` (prior), `src/features/tasks/task-request-unlock-policy.js`

**What happens:** Task request modal used full unlock policy (session, linked wallet, local vault, unlocked secret match). Task detail lifecycle and evidence panels only checked `walletVault.unlocked`, allowing mismatched secret/account states to reach signing UX inconsistently.

**Impact:** Confusing or unsafe signing paths; users could see "Submit evidence" while secret state was invalid.

**Fix:** **Fixed** — shared `evaluateTaskSigningUnlockPolicy()` across lifecycle, evidence submit, and unlock-pending wiring from `main.jsx`.

---

### 3. P2 — Wallet challenge consumed before validation

**Files:** `server/runtime-store.js` (`consumeWalletChallenge`)

**What happens:** Prior implementation deleted the challenge before validating account, purpose, or expiry.

**Impact:** Invalid verify attempts could burn a one-time challenge, forcing users to restart link/create flows.

**Fix:** **Fixed** — validate account/purpose/expiry before deleting the challenge.

---

### 4. P2 — Link start when already linked (deferred)

**Files:** `server/product-contracts.js` (`walletLinkStart`)

**What happens:** Linked accounts can start a new link challenge without an explicit relink/delink path.

**Impact:** UX confusion; potential for unnecessary challenge churn.

**Fix:** Open — reject `link/start` when wallet already linked; document relink flow.

---

### 5. P2 — Delink missing address confirmation (deferred)

**Files:** `server/product-contracts.js`, `WalletView.jsx`

**What happens:** Delink API may not require explicit `confirmAddress` parity with UI copy.

**Impact:** Accidental delink if UI/API diverge.

**Fix:** Open — require confirmed address on delink API.

---

### 6. P2 — Unlock modal when no linked address (deferred)

**Files:** `WalletUnlockModal.jsx`, `WalletSeedBackupModal.jsx`

**What happens:** Unlock/backup modals may open without guarding missing linked wallet; mnemonic may persist after backup modal close.

**Impact:** Edge-case UX leaks or stale secret display.

**Fix:** Open — guard modals; clear mnemonic on backup close.

---

## Evidence

- `npm run quality`
- `npm run runtime-smoke` (wallet create retry, link retry rejection, initiation grant idempotency)
- `npm run task-request-unlock-policy-smoke` (signing policy messages)
- `npm run wallet-state-regression` (existing)
- `npm run security-smoke` (existing route/auth checks)

## Deferred bundles

Document-only unless scheduled: link-when-linked guard, delink confirmAddress, unlock/backup modal hardening.

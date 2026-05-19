# Review Plan: Wallet

Source doc: `docs/wiki/surfaces/wallet.md`
App doc group: Surfaces
App doc slug: `wallet`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/features/wallet/WalletView.jsx`
- `src/features/wallet/WalletUnlockModal.jsx`
- `src/features/wallet/WalletSeedBackupModal.jsx`
- `src/features/wallet/wallet-state.js`, `src/wallet-core.js`
- `server/product-contracts.js` wallet actions
- `server/runtime-store.js` wallet/account state
- `server/wallet-proof.js`, `server/pftl-balance.js`, `server/pftl-transactions.js`, `server/pftl-faucet.js`

## What Could Go Wrong

- Wallet link/create/relink/delink flows leave account state inconsistent.
- A balance or transaction feed reads the wrong wallet or shows stale data as
  fresh.
- Unlock state is retained longer than intended or survives logout unexpectedly.
- Initiation gift and faucet retry paths can be replayed incorrectly.

## Best Practices To Check

- Wallet ownership proofs should be server-verified and tied to account session.
- Secret material should stay client-local and be cleared on lock/logout.
- Linked wallet changes should invalidate wallet-scoped context/task/history UI.
- Balance and transaction APIs should expose stale/syncing/error states.

## Code Review Plan

1. Trace create, link, unlock, relink, delink, and retry flows through UI/API.
2. Review challenge generation, signature verification, and session ownership.
3. Review wallet vault lifecycle in browser state.
4. Confirm PFT balance and transaction reads scope to linked wallet only.
5. Run wallet regression and transaction normalization tests.

## Evidence To Capture

- `npm run wallet-state-regression`
- `npm run wallet-transactions-smoke`
- A relink/delink app-state before/after note.
- A proof-verification negative case.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

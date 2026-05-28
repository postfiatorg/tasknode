# Wallet

Wallet is the identity and value surface. It shows PFT balance, local seed vault state, reward history, Ethereum top-up state, and transaction activity. A user can use context without a wallet, but tasks require wallet linkage.

## User Flow

1. The user links an existing PFT wallet or creates a new local wallet.
2. The local seed vault is encrypted in the browser with the user's password.
3. The user can unlock, lock, back up, delink, or relink the wallet.
4. Wallet activity is fetched from PFTL and displayed without exposing RPC details in the UX.
5. New eligible OAuth accounts may receive a one-time PFT initiation grant after wallet creation only after the matching encrypted local vault is saved.
6. Email-only accounts can receive the same one-time grant after creating a wallet, saving/unlocking the matching local vault, and crediting more than `$10` USDC through the account top-up rail. The wallet page shows a subtle italic note under chat credit until that grant path is satisfied.

## Technical Architecture

Frontend wallet UX lives in `src/features/wallet/WalletView.jsx`, `src/features/wallet/WalletUnlockModal.jsx`, `src/features/wallet/WalletSeedBackupModal.jsx`, `src/features/wallet/wallet-state.js`, and `src/wallet-core.js`.

Backend wallet logic lives in `server/pftl-balance.js`, `server/pftl-transactions.js`, `server/pftl-faucet.js`, `server/pftl-submit.js`, `server/wallet-proof.js`, and `server/ethereum-deposits.js`.

Wallet linkage belongs to the signup identity account, not only the Post Fiat wallet ID. This lets GitHub, X, Telegram, and future login identities map cleanly into one account model.

## Locking And Unlocking

Wallet linkage and wallet unlock are separate states.

Linkage means the app account has a server-side proof that a PFT address belongs to the user. The server stores wallet metadata and proof records, but it does not receive the seed phrase, wallet password, private key, or browser vault plaintext.

Unlock means the browser has decrypted the local encrypted seed vault for the current session. Unlocking happens in `WalletUnlockModal`, which calls `src/wallet-core.js::unlockEncryptedMnemonicVault` with the user's password and the expected linked address. The decrypted mnemonic is held only in React memory through `walletSecretRef` in `src/main.jsx`; it is cleared when the user locks the vault, logs out, switches accounts, refreshes without preserving the session unlock, or removes the local vault.

The unlock modal is available from multiple surfaces:

1. Wallet tab primary action when the linked wallet has a saved local vault and is locked.
2. Wallet tab local seed vault card.
3. Wallet tab vault status chip next to the wallet address.
4. Sidebar Wallet row or balance/status pill when the vault is locked.
5. Profile dropdown row labeled `Wallet Locked`.
6. Task detail actions such as `Accept task`, `Refuse task`, `Cancel task`, `Submit evidence`, and task request signing.

If the vault is already unlocked, the same wallet control path locks it instead of opening another modal. Locking clears the decrypted mnemonic from memory but does not delink the wallet, delete the encrypted browser vault, delete context, or alter PFT balance/activity caches.

Locked wallets can still show linked address, balance, transaction history, billing top-up state, and cached context. Unlock is required only for wallet-bound private-key actions: signing PFTL pointer transactions, publishing encrypted context to PFTL, decrypting historical encrypted context payloads, task request signing, task acceptance/refusal/cancellation, task evidence submission, verification evidence signing, and seed backup.

When a task modal opens the unlock flow, the task detail modal remains in place behind the wallet unlock modal. A successful unlock returns the user to the same task action instead of forcing them to close the task and navigate to Wallet.

If a linked wallet has no saved local vault, the app cannot unlock from the modal because there is nothing local to decrypt. In that case the user must relink/import or create a local vault from the Wallet tab.

## Data Model

- Local seed vault: browser-only encrypted custody material.
- Linked wallet metadata: server account record.
- Session unlock secret: in-memory browser state only, never persisted server-side.
- PFT balance and activity: PFTL-derived cache.
- Ethereum top-ups: generated deposit addresses and observed token deposits.
- Initiation grant register: one grant per eligible account or wallet, whether it came from OAuth wallet creation or the qualifying USDC top-up path. Eligibility is server-side, but payout is user-initiated from the browser only after the matching local vault is saved or unlocked.
- Account deletion audit: deleting an account writes an `account_deletion_audit` record with account id, archive id, wallet/deposit addresses when present, hashed provider identities, hashed email, and non-secret profile labels. Initiation grant eligibility uses this audit to prevent deleting and recreating the same identity to farm the faucet.

## Diagram

```mermaid
flowchart LR
  Login[Signup Identity] --> Account[Account Record]
  Account --> Linked[PFT Wallet Link]
  Browser[Encrypted Browser Vault] --> Unlock[Session Unlock]
  Unlock --> Linked
  Linked --> PFTL[PFTL Balance and Transactions]
  Account --> TopUp[ETH/USDC/USDT Deposit Address]
  TopUp --> Billing[Chat Credit Ledger]
  TopUp --> Grant[USDC over $10 PFT Grant]
  Grant --> PFTL
```

## Failure Modes

- If the vault is locked, show locked state without erasing wallet linkage.
- If the user clicks a locked wallet state, open unlock where possible instead of forcing navigation to the Wallet tab.
- If the encrypted local vault is missing, send the user to the Wallet tab to relink or create a vault.
- Delinking should not delete context.
- Existing linked wallet conflicts should be resolved at the account-link boundary.
- Balance reads should show loading or error, never `NaN`, `undefined`, or fake freshness.
- Wallet creation and USDC top-up sync must not auto-send an initiation grant before the matching local seed vault is saved or unlocked.
- A qualifying USDC top-up should not create duplicate PFT grants if the account
  or wallet already has a processing, completed, or unknown initiation grant.
- Recreated accounts with a matching deletion audit are ineligible for another initiation grant unless explicitly exempted for QA.
- QA exemptions are controlled with `TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_ACCOUNT_IDS`, `TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_WALLETS`, `TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_IDENTITY_HASHES`, or `TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_EMAIL_HASHES`. The guard defaults on and can be disabled with `TASKNODE_DELETION_FAUCET_GUARD_ENABLED=false`.

## Reviewer To Do List

Review implementation against this document (wallet). Mark each item when verified.

### Memory Efficiency
- [ ] List and detail views read Postgres caches with documented caps or pagination.
- [ ] Async workers handle heavy model/IPFS work; primary UX path stays non-blocking.
- [ ] Balance reads use configured RPC endpoints with sane caching; no full ledger scan per page view.
- [ ] Transaction history reads Postgres cache (`pftl_wallet_transactions`), not live chain on every scroll.

### Code Quality
- [ ] Code references in doc resolve to existing modules and routes.
- [ ] Failure modes documented here have matching user-visible error handling.
- [ ] Link vs unlock vs proof boundaries match `AUTH_WALLET_BOUNDARY.md`.
- [ ] Initiation grant and faucet paths are idempotent and auditable.

### Coherence
- [ ] Surface behavior matches Architecture docs for cache vs canonical state.
- [ ] Hidden/not-exposed features labeled honestly if mentioned.
- [ ] UI lock/unlock state matches server expectations for signing routes.
- [ ] Top-up rail docs align with `ETHEREUM_TOP_UPS.md` custody model.

### Bloat
- [ ] Surface does not duplicate logic owned by shared modules or workers.
- [ ] UI state not duplicated in unrelated caches without invalidation rules.
- [ ] Wallet view does not duplicate task or context surfaces.
- [ ] Historical context restore triggered by cache workers, not manual user import buttons.

### Security
- [ ] Account scoping enforced on all read/write API paths for this surface.
- [ ] Wallet-bound actions require linked unlocked wallet as documented.
- [ ] Seed vault stays browser-local; server never receives mnemonic or private keys.
- [ ] Wallet proof required only for wallet-bound actions, not ordinary login.
- [ ] Ethereum deposit addresses are account-scoped; operator xpub custody boundaries documented.

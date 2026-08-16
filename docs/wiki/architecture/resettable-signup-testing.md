# Resettable Signup Testing

This is the repeatable QA workflow for testing email signup, identity registration, wallet creation or relink, faucet allocation, Ethereum top-up allocation, and funded wallet state without burning a new email address for every run.

Use this for local Docker and Fly dev QA accounts only. Do not run faucet-grant resets against production users.

## Signup And Funding Flow

1. The tester starts email login with `POST /api/auth/email/start`.
2. The app creates an email challenge in the JSON runtime store.
3. The tester verifies the code with `POST /api/auth/email/verify`.
4. `getOrCreateEmailAccount` creates or resumes a stable email account id. The id is deterministic from the canonical email, so `run1066@protonmail.com` always maps back to the same email account id after reset.
5. The browser receives a Task Node session cookie.
6. The user creates a local seed wallet or relinks an existing PFT wallet.
7. Wallet proof links the PFT wallet to the account and records the proof purpose.
8. Wallet initiation grant eligibility is checked against runtime grant history and, when Postgres is enabled, `wallet_initiation_grants`.
9. The wallet page can allocate an account-scoped Ethereum deposit address for ETH, USDC, and USDT top-ups.
10. Deposit sync observes token balances, credits billing ledger entries with source `ethereum_deposit`, and records observed, pending, and credited balances on the deposit account.
11. Email-only accounts become eligible for the 12 PFT grant only after the account has credited more than `$10` USDC and no blocking initiation grant exists for the account or wallet.

## Reset State

The reset boundary is identity state, not value custody.

| State | Location | Reset action |
| --- | --- | --- |
| Email account row | `accounts[accountId]` | Delete so signup recreates the email account. |
| Email lookup | `accountEmails[canonicalEmail]` | Delete to unblock fresh signup. |
| Provider links | `accountIdentities` values matching the account | Delete to prevent stale link ownership. |
| Sessions | `sessions` rows for the account | Delete so old browsers are logged out. |
| Email challenges | `emailChallenges` rows for the canonical email | Delete so the next code flow starts cleanly. |
| OAuth link states | `oauthStates` rows with `linkAccountId` | Delete stale link attempts. |
| Linked PFT wallet | `accountWallets[accountId]` | Delete so wallet creation or relink is exercised again. |
| Runtime grant register | `walletInitiationGrants` | Preserve by default; reset only for QA faucet reruns. |
| Postgres grant register | `wallet_initiation_grants` | Preserve by default; reset marks blocking rows `failed` when explicitly requested. |
| Active Ethereum deposit account | `ethereumDepositAccounts[accountId]` | Keep by default so USDC funding history stays attached to the reusable email account. |
| Retired Ethereum deposits | `ethereumDepositRetiredAccounts` | Preserve; `--deposit-mode retire` moves the active deposit here before fresh address allocation. |
| Billing ledger | runtime `ledgerEntries`, Postgres `billing_ledger_entries` and `billing_accounts` | Archive away from the reusable email account by default so the next signup starts at `$0`. Use `--billing-mode preserve` only for tests that intentionally keep prior credit. |
| Other account-scoped Postgres rows | chat, context, task, PFTL cache, profile, memory, and related tables with `account_id` | Archive away from the reusable email account by default with `--data-mode archive`. |

Because the email account id is deterministic, keeping account-scoped rows makes them reappear after delete-and-resignup. A clean signup/funding retest should use `--deposit-mode retire`, `--billing-mode archive`, `--data-mode archive`, and `--grant-mode reset`. Retired and archived records keep audit history without attaching it to the next signup.

## Operator Command

Dry run first:

```bash
npm run signup-reset -- --email run1066@protonmail.com
```

Local Docker execute sequence:

```bash
docker compose stop api
docker compose run --rm -w /app api node scripts/reset-signup-test-account.mjs \
  --email run1066@protonmail.com \
  --execute \
  --grant-mode reset \
  --deposit-mode retire \
  --billing-mode archive \
  --data-mode archive \
  --reason signup-qa
docker compose up -d api
```

For a local QA run that intentionally tests the faucet again:

```bash
docker compose stop api
docker compose run --rm -w /app api node scripts/reset-signup-test-account.mjs \
  --email run1066@protonmail.com \
  --execute \
  --grant-mode reset \
  --deposit-mode keep \
  --billing-mode archive \
  --data-mode archive \
  --reason signup-qa-faucet-rerun
docker compose up -d api
```

For a local QA run that needs a fresh Ethereum top-up address while preserving the old funded record:

```bash
docker compose stop api
docker compose run --rm -w /app api node scripts/reset-signup-test-account.mjs \
  --email run1066@protonmail.com \
  --execute \
  --grant-mode preserve \
  --deposit-mode retire \
  --billing-mode archive \
  --data-mode archive \
  --reason signup-qa-new-deposit-address
docker compose up -d api
```

The API process keeps the JSON runtime store in memory. Stop or restart the API around `--execute`; otherwise a later in-memory save can overwrite the file-level reset.

## Dependencies

- Runtime store JSON path:
  - local node default: `/tmp/tasknodeofficial-runtime-store.json`
  - Docker API volume path: `/data/runtime-store.json`
  - override: `TASKNODE_STORE_PATH=/path/to/runtime-store.json`
- Email delivery:
  - `TASKNODE_EMAIL_DEV_DELIVERY=true` returns development codes for repeatable local tests.
  - Docker and Fly dev can send real Resend email codes when the Resend env vars are configured. This path worked for `run1066@protonmail.com`; the tester must have mailbox access to complete verification.
- Postgres:
  - When `TASKNODE_DATABASE_ENABLED=true`, the reset command summarizes `billing_ledger_entries` and `wallet_initiation_grants`.
  - `--billing-mode archive` detaches old credit/debit rows from the reusable email account so the new signup does not show stale chat credit.
  - `--data-mode archive` detaches old chat, context, task, memory, profile, and PFTL cache rows from the reusable email account.
  - `--grant-mode reset` updates blocking Postgres grant rows to `failed` so the QA account can receive another grant.
- Faucet:
  - Faucet reruns require funded PFT faucet credentials and must be limited to QA accounts.
- Ethereum top-ups:
  - The reset command does not sweep, move, or delete USDC, USDT, ETH, or PFT. It only preserves or retires app-side deposit records.

## Known Failure Points

- Real email delivery works in Docker when Resend is configured, but it is not fully automated unless the tester can read the mailbox or dev delivery is enabled.
- Resetting faucet eligibility can double-pay PFT if used outside isolated QA. Keep `--grant-mode preserve` unless the test explicitly covers grant reruns.
- Keeping the active deposit address means the next signup reuses the same USDC funding state. That is correct for login stress tests but not for address-allocation tests.
- Retiring the deposit address does not move on-chain funds. It only prevents the app from presenting the old address as active.
- If `--billing-mode preserve` or `--data-mode preserve` is used, rows keyed to the deterministic account id can reappear after re-signup.
- Browser local seed vaults are origin-local. Resetting server identity does not delete a wallet vault saved in the browser.

## Validation Run

Validation for task `task_2cf270e235f95f4c264aee7a0fbfe3ff` used the operator command against a temporary runtime store, then the live Docker QA account `run1066@protonmail.com` was purged for re-signup testing.

The validation proved:

- the reset removes email account identity, session, challenge, wallet link, and runtime grant state;
- the active Ethereum deposit account and credited USDC balance are preserved with `--deposit-mode keep`;
- `--deposit-mode retire` removes the active top-up address from the next signup while preserving the old record as retired audit history;
- default `--billing-mode archive` removes stale chat credit from the reusable deterministic account id;
- default `--data-mode archive` removes old chat, task, context, profile, memory, and PFTL cache rows from the reusable deterministic account id;
- the same email account id can be recreated after reset because the id is deterministic;
- the recreated account sees the preserved deposit record.

The live Docker post-purge dry run for `run1066@protonmail.com` showed a clean reusable account id:

```text
accountId: acct_example_email
found: false
activeDeposit: null
billing entryCount: 0
billing creditUsd: 0
accountRows: []
```

## Code References

- `scripts/reset-signup-test-account.mjs`
- `server/runtime-store.js`
- `server/product-contracts.js`
- `server/ethereum-deposits.js`
- `server/wallet-initiation-grants-db.js`
- `server/db/migrations/046_wallet_initiation_grants.sql`
- `server/db/migrations/001_chat_billing.sql`

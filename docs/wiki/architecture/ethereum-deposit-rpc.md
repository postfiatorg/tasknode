# Ethereum Deposit RPC

The Ethereum Deposit RPC configuration is the request-time dependency for
deposit top-up sync. It is not a background worker today; System Status reports
whether the required deposit configuration exists and can support the billing
path.

System Status row: `ethereum_deposit_rpc`

## Runtime Boundary

- Config: `ETH_DEPOSIT_XPUB`, `ETH_DEPOSIT_RPC_URL`, and chain ID settings.
- Surface: billing/top-up sync routes.
- Related scripts: `scripts/generate-eth-deposit-wallet.mjs` and
  `scripts/verify-eth-deposit-wallet.mjs`.
- Runtime-store keys: `ethereumDepositAccounts`,
  `ethereumDepositRetiredAccounts`, `ethereumDepositAddressIndex`, and
  `ethereumDepositCursor`.

The configured xpub is receive-only. It lets the app derive account-scoped
Ethereum mainnet deposit addresses and observe ETH, USDC, and USDT balances. It
does not let the app spend funds.

The spending keys are operator custody material outside the web app:

- the mnemonic printed by `npm run eth-deposit-wallet`;
- the receive xprv for `m/44'/60'/0'/0`;
- or a child private key for one deposit index.

Those values must not be stored in Fly app secrets, Docker env, repo files, docs,
or chat logs.

## Status Derivation

Green means deposit sync is enabled, an xpub is configured, and an RPC endpoint
is configured or the default public endpoint is usable.

Amber is not used for this request-time row today.

Disabled means the deposit xpub or RPC config is intentionally absent.

Red is reserved for future active failure telemetry.

## Debug And Repair

Check Fly secrets first:

```bash
fly secrets list -a tasknodeofficial-dev
```

After config changes, reproduce through the top-up sync route rather than trying
to infer health from the static config row alone.

For custody recovery, verify the operator mnemonic, receive xprv, or child
private key through hidden stdin:

```bash
cd /home/pfrpc/repos/tasknodeofficial
npm run eth-deposit-verify -- --index <deposit-index>
```

If the input type is `receive_xprv` and `Xpub match: yes`, that xprv controls
the configured receive wallet and can derive every child key for
`m/44'/60'/0'/0/<deposit-index>`.

To find deposit indexes, inspect active and retired runtime-store deposit
records. Retired records still matter because retirement is app bookkeeping; it
does not sweep or move funds:

```bash
docker exec -i tasknodeofficial-api-1 node - <<'NODE'
const fs = require("fs");
const state = JSON.parse(fs.readFileSync("/data/runtime-store.json", "utf8"));
for (const [status, rows] of [
  ["active", Object.values(state.ethereumDepositAccounts || {})],
  ["retired", state.ethereumDepositRetiredAccounts || []],
]) {
  for (const row of rows) {
    console.log(`${status}\t${row.derivationIndex}\t${row.address}\t${row.accountId}`);
  }
}
NODE
```

Sweep support is deferred. Until a separate sweep service exists, funded child
addresses must be swept from an operator-controlled wallet or signer using the
verified mnemonic/xprv. ERC-20 deposits usually need ETH on the same child
address before they can send USDC or USDT out.

Billing recovery is separate from custody recovery. A chain balance becomes app
credit only after `/api/usage/top-up/sync` appends a `billing_ledger_entries`
credit with `source = ethereum_deposit` and an idempotency key of:

```text
ethereum_deposit:<depositAccountId>:<asset>:<creditedBalanceRaw>
```

Do not infer app credit from raw Ethereum balances alone.

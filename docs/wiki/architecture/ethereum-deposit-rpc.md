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

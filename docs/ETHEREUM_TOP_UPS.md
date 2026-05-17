# Ethereum Top-Up Rail

Task Node top-ups are account funding, not PFT wallet custody. The deposit
address belongs to the Task Node operator and is mapped to the signed-in app
account. Users can send funds in, but they do not control the address and cannot
withdraw from it through the app.

## Scope

- Network: Ethereum mainnet only.
- Accepted assets:
  - ETH, native Ethereum.
  - USDC, ERC-20 at `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.
  - USDT, ERC-20 at `0xdAC17F958D2ee523a2206206994597C13D831ec7`.
- Credits:
  - USDC and USDT are credited 1:1 as USD after the configured balance tag
    observes the token balance increase.
  - ETH is converted to USD using the configured or fetched ETH/USD price when
    the configured balance sync credits the deposit.
- Withdrawals: disabled. Funds are operator custody once deposited.
- Sweeping: deferred. Deposit balances can remain at per-account addresses until
  a separate sweep service is built.

## Account Boundary

Deposit addresses are keyed by Task Node app account ID, not by the linked PFT
wallet. Delinking or relinking a PFT wallet must not change the top-up address.
This keeps user funding separate from PFTL task identity and local seed-wallet
state.

## Address Derivation

Production should use an Ethereum receive xpub:

```text
ETH_DEPOSIT_XPUB=<xpub for m/44'/60'/0'/0>
ETH_DEPOSIT_RECEIVE_PATH=m/44'/60'/0'/0
```

The app derives one non-hardened child per account:

```text
m/44'/60'/0'/0/<account_index>
```

The web app server can allocate receive addresses from the xpub without holding
private keys. Sweep keys must live outside the web app, in a separate operator
process or signer.

Index `0` is reserved for operator funding and should never be assigned as a
user deposit address. User deposit allocation starts at index `1` by default:

```text
ETH_DEPOSIT_START_INDEX=1
```

To create a fresh deposit wallet locally, run this outside the shared server
environment:

```text
npm run eth-deposit-wallet
```

The script prints the mnemonic and receive xprv once so the operator can write
them down. It writes only xpub env lines to `.env.eth-deposit-xpub`. Do not
commit that file, and do not paste the mnemonic, receive xprv, or child private
keys into chat.

To confirm that the mnemonic, receive xprv, or a child private key matches the
configured xpub, run:

```text
npm run eth-deposit-verify
```

The verifier reads `.env.eth-deposit-xpub`, hides terminal input, and reports
whether the supplied custody material derives the configured deposit address.
For a child private key other than deposit index 0:

```text
npm run eth-deposit-verify -- --index 12
```

## Sync

The sync endpoint reads the configured Ethereum balance tag and credits only
positive balance deltas:

```text
POST /api/usage/top-up/start
POST /api/usage/top-up/sync
```

Recommended configuration:

```text
ETH_DEPOSIT_RPC_URL=https://...
ETH_DEPOSIT_BALANCE_BLOCK_TAG=latest
ETH_DEPOSIT_ETH_USD_PRICE=<optional fixed operator price fallback>
```

`latest` is the default because top-ups should become usable once the transfer
is visible on the assigned account address. Operators who want stricter
settlement can override `ETH_DEPOSIT_BALANCE_BLOCK_TAG=safe` or `finalized`.

The sync path uses `eth_getBalance` for ETH and ERC-20 `balanceOf(address)` for
USDC and USDT. It stores observed balances and credited balances separately so a
later sweep does not create a negative credit or double-count a previous
deposit.

## Operator Rules

- Never show an address unless `ETH_DEPOSIT_XPUB` is configured for the intended
  custody wallet.
- Never ask the user to connect MetaMask or sign a top-up authorization.
- Never bind top-ups to the PFT wallet link.
- Only display Ethereum mainnet instructions for this rail.
- Warn that wrong-chain deposits may not be recoverable.
- Treat the internal usage ledger as the app spend balance; chain balances are
  the funding source, not the app authorization layer.

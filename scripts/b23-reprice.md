Reprice Alice's B23 market offer after a finalized daily NAV reading. This script only cancels and replaces the existing B23/PFUSDC source-series ask; it does not change NAV, supply, reserves or schedules. Run from this checkout with the existing six validator tunnels on localhost ports 39650–39655.

Preview (no signing; use a new evidence directory each time):

```sh
python3 scripts/b23-reprice.py --offer-id CURRENT_OFFER_ID --evidence /path/to/new-preview
```

For the live run, take `/home/postfiat/repos/b23-coord/chain.lock` only when empty and write `TRADE`. Then run:

```sh
python3 scripts/b23-reprice.py --offer-id CURRENT_OFFER_ID --evidence /path/to/new-live-run --live --key-file /path/to/alice-holder-key.json
```

Clear your `TRADE` lock after inspecting the result. Never replace another lane's lock. The signer defaults to the release-4 binary; `--signer` selects a compatible deployed release. Keys stay in their files. The script requires the known Alice account and devnet-2 identity, checks all six validators before and after each operation, requires literal accepted receipts and confirmed finality, and verifies the new resting quantity and total quote on all six books. It preserves the remaining B23 quantity and rounds the total quote up by less than one PFUSDC atom when exact multiplication is not representable. The resulting unit price may exceed NAV by that tiny rounding remainder.

A cancellation and replacement are two transactions. If either operation or verification fails, stop and inspect its evidence; do not blindly repeat. A successful cancellation followed by a failed replacement leaves no resting ask. Obtain fresh NAV and inventory before creating a replacement. No scheduler is installed or enabled.

Wallet Activity recovery: `L1_HISTORY_RPC_URL=tcp://127.0.0.1:39650` enables a read-only application fallback when the native `account_tx` index rejects duplicate receipt ids. It reads the most recent 64 committed blocks and their archives, matches literal receipts, and labels the covered block interval. Identical duplicate receipts are safe to collapse; conflicting or missing receipts remain unverified. The fallback covers signed transactions and direct credits, including market buys, cash-ins and deposits. It does not reconstruct historical maker fills or indirect credits. No validator data, proxy configuration or consensus code is changed.

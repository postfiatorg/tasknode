# Profile NFT list limit regression

The `/api/profile/nfts` route forwards finite fractional limits to the metadata
repository. Its existing clamp retains values such as `2.5` and `49.9`, which
are then bound directly as the PostgreSQL `LIMIT $2` parameter in both list
queries. [PR303](https://github.com/postfiatorg/tasknode/pull/303) explicitly
identifies this profile path as a follow-up outside its task-request correction.

This patch wraps the existing clamp in `Math.trunc`. Truncating **after** the
clamp preserves the current default, numeric-zero fallback, string-zero floor,
negative floor and upper cap. It also matches the finite-limit conversion
already performed by the runtime branch's `Array.slice`. It adds no NaN policy
and does not change SQL, filters, order or normalized record fields.

The regression evaluates the actual full `profile-nfts.js` module in a fresh
closed VM for each of 16 independently frozen cases, then invokes only its
exported `listProfileNfts`. The actual unchanged public title and SQL-predicate
modules are loaded directly. The database module is replaced before loading:
`databaseEnabled` returns the case declaration, and `query` captures full SQL
and params before returning a constant synthetic response or rejecting with an
ordinary synthetic Error. It does **not** filter or slice that response according
to the observed limit, simulate a PostgreSQL error, or connect to a database.

Four fractional scoped/unscoped cases change only their bound parameter from
`2.5`/`49.9` to `2`/`49`. The remaining controls preserve defaults, integer/floor/
cap/zero behavior, strict public/wallet flags, missing-account refusal, account
and wallet trimming/truncation, complete record normalization, input/response
immutability, and ordinary error/cause identity. The sole runtime control uses
the actual fresh empty map. Nonempty runtime pagination is untested.

Every other import, transaction, UUID/Date/timer, process/network capability and
unexpected SQL call produces a persistent boundary failure. No route, application,
auth, stale-generation sweep, wallet, mint or generation function is invoked.
The fixture's NFT and transaction-shaped fields are inert metadata strings and
objects. The proof concerns actual parameter binding and normalization, not a
production HTTP error, PostgreSQL execution, NFT ownership or a financial action.

The replay is pinned to **Node 24.21.0**, with no package installation. From the
checkout root, use that exact runtime and an empty environment:

```sh
env -i /absolute/path/to/node --permission --allow-fs-read="$(pwd)" --allow-fs-write="$(pwd)/preparation" --experimental-vm-modules scripts/profile-nft-list-limit-regression.mjs
```

The default fixed stage is expected to exit 0. The unchanged public baseline is
preserved at `preparation/profile-nfts-before.txt`, SHA256
`4f93481b354e5fb17ec42d1d6f7d1f39354a656097e0a109edeaea0109c5e03c`.
To replay it:

```sh
env -i /absolute/path/to/node --permission --allow-fs-read="$(pwd)" --allow-fs-write="$(pwd)/preparation" --experimental-vm-modules scripts/profile-nft-list-limit-regression.mjs --stage baseline --source preparation/profile-nfts-before.txt
```

The baseline is expected to finish all 16 records, match its frozen original
oracle, and exit 1 for the four noninteger bindings. A mismatch with that original
oracle is a separate unexpected failure. Full typed observations are saved before
the intentional assertion. Outputs are new `*-observations.json` files in the
owned `preparation` directory; existing files are refused and must be retained.
For a standalone fixed replay, the driver creates that own directory if absent.
The original module export is preparation evidence rather than a production file.

**Observed validation:** baseline and fixed each ran once under pinned
Node24.21.0, empty environment and checkout-read/preparation-write permissions.
Both completed all16 full records and matched their independently frozen stage
oracles. Baseline exited1 for exactly four fractional bindings; fixed exited0
with no noninteger binding. The other12 controls are unchanged, and both stages
have zero forbidden effects. The synthetic query is an inert dependency: no
PostgreSQL server, route, NFT or financial action was exercised.

This is an independent contribution with Tasknode allocation pending. No reward,
maintainer adoption, merge or repository CI success is claimed. The exact original
main pin is `41bb94647cd2e6183d0cbe193b568d179c79a9b6`.

MIT License, Copyright (c) 2026 Post Fiat contributors, as in the repository's
LICENSE. Patch, driver and fixture preparation are AI-assisted. The independent
literal oracle is preserved unchanged, with native caller-specific error stacks
excluded from functional comparison and original error/cause identity required.

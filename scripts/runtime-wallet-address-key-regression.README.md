# Runtime wallet address metadata regression

When a runtime account changes its linked address without supplying a new
Tasknode encryption public key, the previous address's key must be cleared.
Relinking the same normalized address preserves an omitted key, and a supplied
key still takes precedence. The patch changes only the existing key fallback;
address and key coercion, trimming, timestamps, ownership checks and audit fields
retain their existing behavior.

The scope follows the author-disclosed runtime follow-up in
[Tasknode PR307](https://github.com/postfiatorg/tasknode/pull/307). That PR changes
the database repository; this contribution addresses the separate runtime
factory at public main `41bb94647cd2e6183d0cbe193b568d179c79a9b6`.

The regression loads the actual selected module through a closed VM loader and
calls only its exported factory, returned `linkWalletToAccount`, and
`getLinkedWallet`. Seven fresh synthetic states cover 13 link/getter steps:
same-address preservation and rotation, first link without a key, changed-address
clearing and replacement, address trimming, and ownership conflict. The separate
literal oracle was frozen before the patch and driver. It compares complete
returns, state, unchanged inputs and ordered callback effects; own `undefined`
properties use `{ "$undefined": true }`.

Every link explicitly passes the existing `databaseMirror: false`. Save and ID
callbacks are inert; dates and UUIDs use declared fixtures. All dynamic imports,
other static imports, unused callbacks, process access, timers and network
globals fail with persistent boundary records. The driver reads only named,
hash-pinned public source/fixture files and writes a new observations file in
the checkout's own `preparation` directory. It does not load `runtime-store.js`,
authenticate or unlock a wallet, verify signatures, encrypt memos, start an
application, connect to a database or send anything.

This is a pinned replay for Node **24.21.0** with no package installation. From
the checkout root, replace `/absolute/path/to/node` with that exact runtime:

```sh
env -i /absolute/path/to/node --experimental-vm-modules scripts/runtime-wallet-address-key-regression.mjs
```

The default checks the fixed source and is expected to exit 0. For the unchanged
public baseline, first save its exact module bytes to
`preparation/runtime-wallet-before.txt` (SHA256
`d22abc6b83c05f34e4266125b3fa94f34f6f8460ea244564fc61285f78271dc7`),
then run:

```sh
env -i /absolute/path/to/node --experimental-vm-modules scripts/runtime-wallet-address-key-regression.mjs --stage baseline --source preparation/runtime-wallet-before.txt
```

The baseline is expected to finish all 13 steps, match the frozen original
behavior, and exit 1 because the changed-address omitted-key result violates the
fixed contract. A mismatch with the original oracle is a separate failure. Full
observations are written before that intentional assertion failure. Existing
observation files are refused; retain outputs and use a new owned copy for any
subsequent replay.

**Observed validation:** baseline and fixed each ran once with Node24.21.0, an
empty environment and exact checkout-read/preparation-write filesystem
permissions. Both completed all13 steps and matched their independently frozen
full stage records. Baseline exited1 for the changed-address carryover defect;
fixed exited0. The other12 steps are unchanged. Both have zero forbidden effects.
The whole regression compares complete returned/stored/getter/audit/save records,
inputs, declared time/UUID effects and ownership-refusal behavior.

This is an independent maintainer-backed contribution, with Tasknode allocation
still pending. No reward, merge or maintainer adoption is claimed. The test covers
metadata binding only; it provides no cryptographic, authentication, production
persistence or application integration proof.

Source and contribution are under the repository's MIT LICENSE, Copyright
(c) 2026 Post Fiat contributors. The patch, driver and fixtures were prepared
with AI assistance. The independent oracle is deliberately preserved unchanged.

# Signed uptime feed fixtures

Read by `scripts/l1-uptime-feed.test.mjs` and `scripts/l1-validator-access.test.mjs`.

| File | What it is |
| --- | --- |
| `postfiat-validator-uptime-v1.fixture.json`, `postfiat-observer-keyset-v1.fixture.json` | The contract fixture of postfiatl1v2 (`docs/specs/schemas/`), signed by the Python reference with public test keys. Stored here without whitespace; the content is the same. |
| `node-signed.feed.json`, `node-signed.keyset.json` | A feed three soak observers signed with `postfiat-node` on `postfiat-wan-devnet-2` on 27 November 2026. |
| `devnet-lifecycle.feed.json`, `devnet-lifecycle.keyset.json` | The facts of the contract fixture under the devnet chain id, signed by `postfiat-node` with keys made for this fixture and thrown away. One validator in every state; read by `scripts/l1-validator-access-postgres-smoke.mjs`. |

When the contract fixture changes in postfiatl1v2, copy it here again.

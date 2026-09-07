# Messages activation contract repair

Messages activation sends a signed `nip05` field. The strict `nostrBindBody`
contract omitted that field, so valid activation requests failed before wallet
proof verification with `request_body_field_unknown` at `body.nip05`.

The contract now accepts a bounded string. The server independently recomputes
the canonical address from the account handle and verifies the wallet proof
against that canonical payload. Unknown fields, invalid types, oversized values,
spoofed addresses, invalid signatures and replayed proofs remain rejected.

On 2026-09-07, `node scripts/messages-activation-browser-smoke.mjs` passed against
the isolated PR branch: the actual MessagesView activated two fresh accounts
through the real route validator and signature verifier, persisted their identity
bindings in disposable Postgres, restored after reload and exposed both in Hive
membership. Fresh-proof retry also passed. Relay transport is synthetic and no
public messages are sent.

See [Hive verification](../hive-group-chat-2026-09-06/README.md) for reproduction
requirements. `npm run nostr-messages-smoke` and
`npm run request-validation-smoke` also passed on this branch, including both
binding routes. The current results do not depend on the original dirty workspace
or its unrelated unfinished campaign code.

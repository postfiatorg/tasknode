# Messages registration contract repair — 2026-09-06

The Messages activation browser sends `nip05` in its signed payload. The strict
`nostrBindBody` contract omitted that field, so activation stopped before wallet
proof verification. A read-only production query found 28 `nostr_bind` challenges
across four accounts and zero consumed challenges in the preceding four hours.

The shared contract now accepts a bounded string for `nip05`. The server still
recomputes the address from the account handle and verifies that canonical
payload against the wallet proof. No user identities or signatures were changed.

`activation.json` records the actual MessagesView activating two fresh accounts,
passing the real route validator and signature verifier, persisting in disposable
Postgres, restoring after reload, and appearing in the Hive membership directory.
It also covers malformed, spoofed, unauthenticated and replayed activation requests,
and recovery with a fresh proof. Relay sockets are synthetic; no public messages
are sent. The pre-fix payload reproduces `request_body_field_unknown` at `body.nip05`.

Run `npm run nostr-messages-smoke`, `npm run request-validation-smoke`,
`npm run lint`, and `npm run build`. The browser regression is
`scripts/messages-activation-browser-smoke.mjs`; it requires Vite on port 5199,
Chrome CDP on 9369, and a disposable localhost PostgreSQL database named
`tasknode_messages_registration_20260906`. Set `TASKNODE_DATABASE_ENABLED=true`,
`DATABASE_URL`, and an isolated `TASKNODE_STORE_PATH` on the mounted scratch volume.

## Validation and deployment scope

- `npm run nostr-messages-smoke`: passed, including both Nostr binding routes.
- `node scripts/messages-activation-browser-smoke.mjs`: passed against the real
  validator, handler, wallet proofs and disposable database (see `activation.json`).
- ESLint on all changed JavaScript files: passed; `npm run build`: passed.
- Workspace-wide lint has 13 errors in unrelated, unfinished campaign-tracker
  files. The broad request-validation smoke also fails because that unfinished
  route allows unknown fields. Those files are excluded from this hotfix.
- The isolated deployment overlays only `server/request-body-contracts.js` on
  production v722, image `deployment-01M1W5HJ8AGGCKKK3BRY4R6B1N`, using the live
  Fly configuration. The patched file exactly matches the reviewed local source.
  All other runtime code and frontend assets are inherited from v722. Documentation
  changes are recorded in the repository and are not part of the runtime overlay.

Production v723 is complete. The deployed validator accepts the activation
envelope, rejects malformed addresses, and has the reviewed file hash. The
route-policy and collaboration-handler hashes remain identical to v722.
Production health returned 200 and the background-worker guard passed.

## Subsequent isolated PR verification — September 7, 2026

## Messages activation contract repair

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

# Hive group routing: review and reproduction

## Before and after

Before this change, `/api/hive/chat` routed each contributor into a private,
account-scoped conversation and could generate an immediate advisory reply.

After this change, `/api/hive/group/messages` accepts a wallet-derived, signed
Nostr event into one shared public NIP-10 thread. Other registered contributors
read the same message with its author handle, profile picture, mentions, reply
reference and Nostr link. Previous private conversations stay private and
read-only; the old write route returns `410 hive_chat_moved` when the group is
enabled.

Posting does not invoke a model. A periodic GLM 5.3 Flash structured decision can
stay silent or select a GLM 5.3 reply using public room and board context. Board
issues can enter a durable, board-scoped inbox for the existing Kimi board agent.
An escalation receipt proves queueing; it does not claim that Kimi has acted.
The automatic per-message advisory interaction and the static introduction
(“THE NETWORK, IN CONVERSATION”, “Everyone’s in the same room.” and its filler
paragraph) are absent from the new view. The reply prompt also discourages canned
praise, repetitive check-ins and long speeches.

## Verification on the isolated PR branch, 2026-09-07

- `node scripts/hive-group-smoke.mjs`: passed against disposable Postgres and a
  local WebSocket relay. Covers shared delivery between two identities, signature
  and account ownership rejection, ACK-gated delivery, retrying the same event,
  late-delivery cursors, concurrent bot claims, idle silence, public-only context,
  structured model defaults, scoped board inbox, transaction rollback, concurrent
  Kimi reply retries and duty completion receipts.
- `node scripts/hive-group-visual-smoke.mjs`: passed with the actual React Hive and
  Messages views, two generated wallet identities and synthetic HTTP/relay data.
  Covers the shared feed, handles/PFPs, Nostr links, keyboard mentions, shared send
  control, absent filler, draft retry across reload, locked and signed-out reading,
  Messages setup, account/archive isolation and a 390px mobile viewport.
- `node scripts/messages-activation-browser-smoke.mjs`: passed actual browser
  activation through the real strict body validator, wallet signature verifier
  and disposable Postgres. Two fresh identities persisted, survived reload and
  appeared in the Hive directory; malformed/spoofed/replayed proofs were rejected.
- `npm run nostr-messages-smoke`, `npm run request-validation-smoke`,
  `npm run check:fast` and `npm run build`: passed.

Browser transport fixtures publish no public messages. These checks do not claim
a live Kimi response or a new production deployment. Generated screenshots, model
outputs and production account records are deliberately excluded from this PR.

## Reproduce the behavior

1. Enable `TASKNODE_HIVE_GROUP_ENABLED=true`, configure the persistent bot key
   `TASKNODE_HIVE_NOSTR_SECRET_KEY`, and run the web and Hive worker processes.
2. Activate Messages for two accounts and open Hive chat in separate browsers.
3. Post from one account; verify both see the same signed message and author.
4. Mention the other participant and reply; check the identity and Nostr links.
5. Verify sending creates no immediate bot run. The periodic classifier decides
   independently whether a response is useful; idle rooms make no model calls.
6. Verify the old introduction is absent and the send button matches the shared
   chat composer. Verify private Hive archives remain visible only to their owner.

For the automated backend fixture, create a disposable local database named
`tasknode_hive_20260906`, set `DATABASE_URL`, `TASKNODE_DATABASE_ENABLED=true`,
`TASKNODE_HIVE_GROUP_ENABLED=true`, and an isolated `TASKNODE_STORE_PATH`, then run
`npm run hive-group-smoke`. The script refuses other database names. CI provisions
this database in its disposable Postgres service and runs the same regression.

For the browser fixtures, run Vite on port 5199 and Chrome with remote debugging
on port 9369 using an isolated browser profile. Set `HIVE_FIXTURE_OUTPUT` to a
scratch directory. The Messages activation fixture additionally requires the
local disposable database `tasknode_messages_registration_20260906` with the same
Postgres/store settings. Run each browser script sequentially. No real account,
wallet seed or provider API credential is needed.

# Nostr Messaging Architecture

Task Node uses Nostr as the delivery layer for private user-to-user Messages. Nostr does not replace PFTL task state, Task Node account authentication, wallet authorization, Team grants, Docs grants, or the reward ledger.

## Identity

Messages activation is explicit and wallet-authorized:

1. The browser signs a fixed, domain-separated derivation statement with the unlocked Task Node wallet.
2. The deterministic signature is hashed into a secp256k1 Nostr private key scoped to the Task Node account and the `tasknode.private-messages.v1` purpose.
3. The private key exists only in browser memory while the wallet is unlocked. It is not sent to or stored by Task Node.
4. The browser submits the Nostr public key, `npub`, relay preferences, and a separate short-lived Task Node wallet authorization proof.
5. The server verifies that `npub` decodes to the submitted public key and binds it to the authenticated account.

The server derives the NIP-05 address from the canonical Task Node handle. It never trusts a client-supplied address. For example, Task Node handle `alice` becomes `alice@tasknode.example` on a self-hosted deployment configured for that domain.

`GET /.well-known/nostr.json?name=<handle>` exposes active, public, unexpired bindings for discoverable profiles. This makes Task Node handles valid NIP-05 identities. The same handle remains the user-facing address inside Messages.

## Message Protocol

Private messages use NIP-17 over NIP-44/NIP-59:

- kind `14`: the private message rumor;
- kind `13`: a sender-signed encrypted seal;
- kind `1059`: a randomly signed gift wrap addressed to the recipient.

Every send creates one recipient wrap and one sender wrap, so the sender can recover sent history from relays on another device. A private encrypted subject records the peer public key in the sender copy. The client verifies the outer event hash/signature, recipient tag, seal hash/signature, rumor hash, kind, and sender continuity before rendering plaintext.

The configured relay set is:

- `wss://relay.primal.net`
- `wss://nos.lol`
- `wss://relay.damus.io`

Sending succeeds when at least one configured relay accepts a wrap. Sync queries the gift-wrap inbox addressed to the user's public key, decrypts locally, and deduplicates rumors.

## Data Boundary

Task Node Postgres stores:

- account ID to Nostr public-key binding;
- canonical NIP-05 address and verification timestamp;
- preferred relay URLs;
- wallet proof, source wallet, sequence, visibility, expiry, and revocation state;
- audit metadata for activation and revocation.

Task Node does not store:

- Nostr private keys;
- decrypted or encrypted message bodies;
- conversation transcripts;
- relay event payloads.

The browser stores only non-secret contact labels in local storage. Message history is fetched from relays into memory when the wallet is unlocked. Relay operators can observe ciphertext, public relay traffic, timing, and IP metadata; end-to-end encryption does not provide network anonymity.

## Authorization Boundary

Nostr identity proves where to send a message. It grants no Task Node permissions. Receiving a message does not permit reading tasks, editing documents, spending wallet funds, acting on tasks, or accessing Context or Memory. Team and Docs continue to use their own explicit wallet-authorized grants.

## Runtime

- UI: `src/features/messages/MessagesView.jsx` and `messages.css`.
- Client protocol: `src/features/messages/nostr-messages.js`.
- Directory and binding API: `server/collaboration-routes.js` and `server/repositories/nostr-messages.js`.
- Schema: `account_nostr_identities` in migration `110_docs_team_collaboration.sql`.
- Feature flag: `TASKNODE_MESSAGES_ENABLED`.
- NIP-05 domain: `TASKNODE_NOSTR_NIP05_DOMAIN` (production: `tasknode.postfiat.org`).
- Verification: `npm run nostr-messages-smoke`.

## Failure Behavior

- Locked wallet: show the inbox identity but do not derive keys or decrypt.
- Missing Task Node handle: route the user to Profile before activation.
- Inactive recipient: do not fall back to a raw public-key send; explain that the member has not activated Messages.
- Relay failure: keep the draft visible and report that no relay accepted the message.
- Mismatched wallet/public key: stop before sync or send.
- Invalid, forged, or tampered wrap: discard it without rendering plaintext.

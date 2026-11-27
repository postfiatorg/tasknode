# Pillar 6 — Browser Nostr Signing Guard Policy v1

> **Status:** Frozen Phase 0 Contract (`C3`) for Pillar 6 (Hive Chat Identity on Chain).
> **Ship Order:** This client-side signing guard MUST ship in Task Node **before** any v1 `identity_set` on-chain mint is enabled.
> **Target Code Surfaces:** `src/wallet-core.js`, `src/features/collaboration/collaboration-client.js`, `src/features/messages/nostr-messages.js`, `src/features/settings/AppDialogs.jsx`, `src/features/wallet/WalletComponents.jsx`, `src/features/tasks/task-transition-signature.js`.

## 1. Threat Model & Root Vulnerability

Task Node currently derives v1 Nostr identities (`derivation_version = 1`) in the browser by signing a fixed domain string with the user's old-chain secp256k1 wallet key (`m/44'/144'/0'/0/0`) via `walletCore.signWalletChallenge(mnemonic, message)`:

```text
Task Node private messaging identity
Version: 1
Account: <accountId>
Wallet: <walletAddress>
Purpose: tasknode.private-messages.v1
This signature derives a local Nostr key. It is not a transaction.
```

The resulting secp256k1 signature is hashed into the user's Nostr private key.

**Vulnerability closed by this policy:** `signedCollaborationProof` in `src/features/collaboration/collaboration-client.js` (as well as other wallet-challenge flows) passes a server-supplied `challenge.message` directly to `walletCore.signWalletChallenge(...)` without enforcing a strict domain prefix or verifying local fields. A compromised server, hostile proxy, or XSS-injected response could return the `"Task Node private messaging identity\n..."` derivation payload as a collaboration challenge, tricking the browser into signing it and exfiltrating the signature that deterministically derives the user's v1 Nostr private key.

---

## 2. Old-Chain `signWalletChallenge` Domain Allowlist

Every browser callsite that signs a message with the old-chain secp256k1 wallet key MUST pass an explicit `purpose` capability and MUST enforce both **callsite prefix/field validation** and **central `wallet-core.js` domain isolation**.

### 2.1 Allowed Signing Purposes & Strict Prefixes

| `purpose` | Permitted Callsite | Required First Line (Exact, Byte-for-Byte) | Origin of Message | Additional Local Checks |
|---|---|---|---|---|
| `nostr_v1_derivation` | `src/features/messages/nostr-messages.js` (`deriveNostrMessagingIdentity`) ONLY | `Task Node private messaging identity` | Locally constructed ONLY (never from HTTP/WS/`postMessage`) | Exact 6-line template; `Version: 1`, `Purpose: tasknode.private-messages.v1`, `Account:` matches session, `Wallet:` matches derived classic address |
| `collaboration_auth` | `src/features/collaboration/collaboration-client.js` (`signedCollaborationProof`) ONLY | `Task Node collaboration authorization` | Server `/api/collaboration/challenge` | Verify `Action:`, `Resource:`, `Account:`, `Wallet:`, `Payload SHA-256:` (recomputed locally from `{ action, resourceId, payload }`), non-empty `Nonce:`, and unexpired `Expires:` |
| `wallet_proof` | `WalletComponents.jsx`, `AppDialogs.jsx` | `Post Fiat Task Node wallet proof` | Server `/api/wallet/*/start` or `/api/account/password/enable/start` | Verify `Purpose:` in `["wallet_link", "wallet_create", "password_enable"]`, `Account:` matches active session, unexpired `Expires:` |
| `wallet_login` | Wallet sign-in client | `Post Fiat Task Node wallet login` | Server `/api/auth/wallet/start` | Verify `Purpose: wallet_login`, `Address:` matches unlocked wallet classic address, unexpired `Expires:` |
| `task_transition` | `src/features/tasks/task-transition-signature.js` | `Post Fiat Task Node task transition` | Locally constructed ONLY | Verify `Purpose: task_transition`, `Role: actor`, `Payload-Digest: sha256:...` |

### 2.2 Defense-in-Depth Rules in `wallet-core.js`

1. **No Raw Arbitrary Signing in Browser:** Production browser code MUST NOT call `signWalletChallenge` without a valid allowlisted `purpose`. Unknown or missing `purpose` fails closed with `SIGNING_GUARD_UNKNOWN_PURPOSE`.
2. **Hard Prefix Isolation:**
   - Before checking prefixes, normalize input checks by rejecting leading BOM (`\uFEFF`), NUL bytes (`\u0000`), CR (`\r`), or leading whitespace/control characters (`^[\s\p{Cc}]`).
   - Only `purpose === "nostr_v1_derivation"` may sign any message starting with or containing `Task Node private messaging identity` (case-insensitive substring scan after NFKC normalization). Any other `purpose` MUST throw `SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX`.
   - Every `purpose` MUST assert `message.startsWith(REQUIRED_PREFIX[purpose] + "\n")`; mismatch throws `SIGNING_GUARD_PREFIX_MISMATCH`.
3. **Zero Re-Export to Untrusted Contexts:** Neither `signWalletChallenge` nor any derived Nostr private key may ever be exposed on `window`, `globalThis`, or bridged via `postMessage` to any iframe (including the isolated Finance Hub viewer `hub-viewer.postfiat.org` or the Goodbrief `srcdoc` sandbox).

---

## 3. Browser Nostr Event Signing Allowlist & Untrusted-Event Block Rules

Once a Nostr private key is derived (either `derivation_version = 1` from the guarded old-chain derivation or `derivation_version = 2` from the new-chain master seed via `derive_wallet_seed` with domain `postfiat.wallet.nostr.seed.v1`, role `nostr-messaging`, `account_index`, `key_index >= 0`, excluding `chain_id`), all browser Nostr signing MUST pass through a centralized signing guard.

### 3.1 Allowlisted Nostr Event Kinds & Signing Operations

| Event Kind / Operation | Allowed Trigger | Constraints |
|---|---|---|
| `kind: 13` (NIP-17 Seal) & `kind: 1059` (NIP-17 Gift Wrap) | Explicit user DM send in Messages UI | Wraps unsigned `kind: 14` rumor (`1..8,000` chars); sender != recipient; valid 64-hex recipient pubkey |
| `kind: 10050` (DM Relay List) | Explicit user relay settings save | Max `5` unique `wss://` relay URLs, each `<= 128` bytes |
| `kind: 0` (Profile Metadata) | Explicit user profile publish | **Blocked on all non-production builds** (localhost, dev, staging, preview); production builds only |
| `kind: 22242` (NIP-42 Relay Auth) | Authenticated relay connection handshake | `relay` tag MUST match an allowlisted `wss://` relay (e.g., `wss://relay.postfiat.org` or user-configured relays); `challenge` tag MUST be non-empty |
| `kind: 1` / Hive Group Note | Explicit user post in Hive Chat | User-initiated composer submit only; `content.length <= 32,768`; never triggered automatically by page load or incoming events |
| BIP-340 `identity_set` Proof | Explicit user action in Mint / Rotate / Link UI | Domain-separated message committing to `(op, chain_id, account, sequence)`; never authorizes fund movement |
| Pillar 10 Hive Mind Claim Signature | Explicit user claim submission after MNPI attestation | Signed at submission time only (never offline/deferred); binds `(company, claim_text, stance, check_event, attestation_id)` |

### 3.2 Untrusted-Event Block Rules (Fail Closed)

The browser signing guard MUST reject and refuse to sign any request matching any of the following conditions:

1. **Default-Deny Kind Policy:** Any Nostr event `kind` not listed in §3.1 (e.g., `kind: 30078`, `kind: 24133` NIP-46 remote signer requests, `kind: 9734` zap requests, `kind: 27235` HTTP auth, unknown custom kinds) MUST be blocked with `NOSTR_SIGNING_GUARD_KIND_BLOCKED`.
2. **Untrusted Origin / Bridge Block:** Any signing request arriving from `window.postMessage`, cross-origin iframes (`hub-viewer.postfiat.org`, Goodbrief `srcdoc`, third-party embeds), URL hash/query parameters, or clipboard/paste handlers MUST be rejected unconditionally (`NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN`).
3. **Non-Production Public Relay Publish Block:** Publishing `kind: 0` profile events to public relays is blocked whenever runtime environment is non-production (`NODE_ENV !== "production"`, localhost/127.0.0.1, or dev/staging hostnames), returning `NOSTR_SIGNING_GUARD_NONPROD_KIND0_BLOCKED`.
4. **Relay URL & Transport Hygiene:** Any relay URL not matching `^wss://[a-z0-9.-]+(?::[0-9]{2,5})?(?:/[^\s]*)?$` or exceeding `128` bytes (including `ws://`, `http://`, `https://`, `javascript:`, or IP-literal SSRF targets in production) MUST be rejected.
5. **Event Shape & Resource Caps:**
   - Reject missing/non-integer `kind`, non-string `content`, `content.length > 32_768` (or `> 8_000` for DMs), non-array `tags`, `tags.length > 64`, or tag elements exceeding `1,024` chars.
   - Reject any event containing `sig` or mismatched `pubkey` supplied by an external caller (the guard derives `pubkey` from the local keypair and computes `id`/`sig` locally).
   - Reject `created_at` outside `now ± 600s` for standard interactive events (`kind: 0`, `kind: 1`, `kind: 10050`, `kind: 22242`); only NIP-17 `kind: 1059` gift wraps may use the NIP-17 randomized past-timestamp privacy window.
6. **Inbound Relay Event Verification:** Inbound events from any relay (including `relay.postfiat.org` and mirrored public relays) are strictly untrusted data:
   - MUST verify `getEventHash(event) === event.id` and `verifyEvent(event)` before decryption or rendering.
   - MUST reject raw HTML rendering of event `content` or profile fields (strict text escaping).
   - On `revoke` or `compromised` `rotate` on `postfiatl1v2`, chain-verified badges MUST strip immediately for all events not anchored on chain before the revoke height (never trusting client-asserted `created_at`).

---

## 4. Key Derivation Continuity (v1 -> v2)

| Version | Derivation Source | Continuity & Security Boundary |
|---|---|---|
| `derivation_version = 1` | Guarded `deriveNostrMessagingIdentity` (old-chain secp256k1 signature over `Task Node private messaging identity`) | Preserves existing users' exact `npub`, contacts, and DM/Hive history. Guard MUST be active before any v1 on-chain `identity_set` mint. |
| `derivation_version = 2` | `derive_wallet_seed` from new-chain master seed (`postfiat.wallet.nostr.seed.v1`, role `nostr-messaging`, `account_index`, `key_index` starting at `0`, excluding `chain_id`) | Used for new users and planned rotations. Implemented once in Rust (`rpc_sdk` / `wallet_wasm`) and shared across web, Mac app, and CLI with CI test vectors. Compromising the master seed compromises both ML-DSA-65 and v2 Nostr keys. |

---

## 5. Required Verification Matrix

Implementation PRs enforcing this policy MUST include automated tests covering:
1. `signedCollaborationProof` accepts a valid `Task Node collaboration authorization\n...` challenge matching local `{ action, resourceId, payload }` digest, account, and wallet.
2. `signedCollaborationProof` throws `SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX` when a hostile server returns a `Task Node private messaging identity\n...` challenge (including with leading BOM/whitespace or Unicode homoglyph/NFKC tricks).
3. `signedCollaborationProof` throws `SIGNING_GUARD_PREFIX_MISMATCH` on any unrecognized prefix or mismatched `Payload SHA-256`.
4. `deriveNostrMessagingIdentity` succeeds only with locally built `Task Node private messaging identity\n...` and never accepts caller-supplied arbitrary message text.
5. Browser Nostr event guard blocks unlisted event kinds (`30078`, `24133`, `27235`), blocks cross-origin/`postMessage` signing requests, blocks `ws://` relays, and blocks `kind: 0` in non-production builds.

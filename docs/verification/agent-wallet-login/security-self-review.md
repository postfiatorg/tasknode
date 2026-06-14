# Agent Wallet Login Security Self-Review

Scope: Phase 0 machine-native wallet login for local/dev review. This change adds `POST /api/auth/wallet/start` and `POST /api/auth/wallet/verify`, plus a local headless client proof. It is not deployed in this phase.

## Replay Protection

- `wallet_login` challenges are stored server-side, single-use, and deleted by `consumeWalletLoginChallenge`.
- Verification consumes the challenge before signature verification, so a captured challenge cannot be retried after either a successful login or a failed signature attempt.
- The route-issued TTL is 5 minutes. Expired challenges return `invalid_or_expired_challenge`.
- Smoke coverage: happy path, reused challenge replay, and expired challenge.

## Domain Separation

- Wallet login uses a distinct message header and purpose:
  - `Post Fiat Task Node wallet login`
  - `Purpose: wallet_login`
- Existing wallet link/create/relink challenges keep the old `Post Fiat Task Node wallet proof` message and account-bound format.
- A wallet-link signature cannot be replayed into login because the signed message differs by purpose, title, and address/account fields.

## Rate Limiting

- `server/route-policies.js` rate-limits both endpoints per route/IP.
- `server/index.js` adds address-scoped rate limits after JSON parsing:
  - start: 5 per 10 minutes per address
  - verify: 10 per 10 minutes per address
- This gives both IP-level and wallet-address-level throttling without adding body parsing to route policy lookup.

## Signature Verification

- Verification reuses `server/wallet-proof.js::verifyWalletSignature`.
- That path requires the submitted public key to derive to the submitted address and verifies the signature over the exact stored challenge message.
- Smoke coverage: wrong signature and public-key/address mismatch.

## Account Binding / No Wallet Hijack

- Verification first resolves an existing active wallet binding via `accountWallets`.
- If a binding exists, login mints a session for that account; it does not create or reclaim a new account.
- If no active binding exists, a wallet-primary account is created and the wallet is linked through the existing `linkWalletToAccount` function.
- This preserves the existing one-active-account-per-wallet rule and keeps wallet linkage audit events on the established path.
- Smoke coverage: existing wallet logs into the same account; a new wallet creates a distinct account.

## Allowlist

- If `TASKNODE_AGENT_WALLET_ALLOWLIST` is present, verification requires an exact address match.
- If the env var is absent, the endpoint is open for local/dev use as specified.
- Allowlist denial happens before challenge consumption so an operator can correct local allowlist config without forcing a fresh challenge.
- Smoke coverage: allowlist denial, followed by success after allowlisting the same challenge.

## Secret Logging

- The implementation does not log or persist wallet seeds.
- Responses do not include signatures or private keys.
- Runtime wallet records store only the public address, public key, challenge id, proof purpose, and existing signature hash.
- The headless client prints only eligibility/chat/Hive summaries, account id, and public wallet address.

## Residual Review Notes

- This is a session-minting path and should stay behind the review PR until Alex approves production exposure.
- Production should set `TASKNODE_AGENT_WALLET_ALLOWLIST` before enabling experimental agents.

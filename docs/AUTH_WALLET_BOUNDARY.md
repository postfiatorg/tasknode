# Auth And Wallet Boundary

This document is the implementation guardrail for wallet authentication in Task
Node Official. It exists to prevent the old Task Node failure mode where wallet
restore, login, account ownership, and wallet actions blurred together.

## Core Rule

Account authentication and wallet proof are separate boundaries.

- Account authentication creates the app session.
- Wallet proof links or claims a PFT wallet for that signed-in account.
- Wallet unlock authorizes wallet-bound actions for the current browser
  session.
- A local encrypted seed vault is never a login session.

Normal app access, chat, native context editing, task viewing, billing views,
and settings use the account session. Wallet proof is required only for actions
that need wallet ownership or wallet signing.

## Current Required Flow

Wallet linking must follow this sequence:

1. Load `/api/app-state` or `/api/session`.
2. If the user is not signed in, route to the login dialog before showing any
   seed phrase modal.
3. After login succeeds, refresh `/api/app-state`; do not trust stale React
   session props.
4. Call `POST /api/wallet/link/start` with the account session cookie.
5. Derive the XRPL/PFT wallet and sign the server challenge in the browser.
6. Call `POST /api/wallet/link/verify` with challenge id, address, public key,
   and signature only.
7. Only after server verification, save the encrypted local seed vault in the
   browser and mark the vault unlocked for this browser session.

The seed phrase, private key, and wallet password must never be sent to any API,
stored in server state, printed, logged, or committed.

## UI Rules

- A signed-out `Link wallet` click opens login, not the wallet modal.
- A loading or missing wallet action contract shows a loading/disabled state,
  not a silent no-op.
- Wallet submit validation must say what is blocking progress. Do not hide
  password length, mismatch, loading, or mnemonic errors behind a disabled
  button or a generic `Locked` state.
- A `401 wallet_login_required` response is an auth-routing failure. Refresh
  session state, then route to login if still signed out.
- After login or successful wallet link, clear stale auth warnings such as
  `Sign in before linking a seed wallet.`
- The wallet modal may collect a seed phrase only when an account session is
  present or has just been refreshed successfully.
- The encrypted local vault status is device-local. It can show `Saved`,
  `Locked`, or `Unlocked`, but it must not imply server-side custody or login.

## Server Rules

- `/api/wallet/link/start` requires an authenticated account session.
- Wallet challenges are short-lived, single-purpose, and single-use.
- `/api/wallet/link/verify` consumes the challenge before linking.
- The server stores wallet address, public key, status, timestamps, and proof
  metadata. It does not store mnemonic, private key, wallet password, or
  decrypted vault material.
- Email-only sessions are low assurance. They can create normal app sessions,
  but they must not claim a legacy wallet without wallet proof.
- Provider/wallet identity conflicts never auto-merge.

## Client State Hazards

The most common jank source is stale client auth state after a cookie changes.
When auth and wallet flows meet, treat client session state as a cache:

- Refresh `/api/app-state` after login, logout, wallet link, wallet delink, and
  provider callback completion.
- Before showing a wallet-link failure for missing auth, refresh once and retry
  the session check.
- Never use `localStorage` vault presence as proof that the server session is
  signed in.
- Never use the visible profile label as the source of truth for auth.

## Wallet Unlock Scope

Wallet unlock is a local, session-only authorization state. It allows browser
code to use decrypted wallet material for explicit wallet-bound operations:

- send PFT;
- sign PFT verification or payout actions;
- ink portable context manifests to PFTL pointers;
- decrypt imported wallet-bound historical context CIDs.

Wallet unlock is not required for normal chat, account-scoped context saves,
task browsing, profile settings, or billing views.

## Error Handling

- `wallet_login_required`: refresh session, then route to login if still signed
  out.
- `wallet_challenge_invalid`, `wallet_challenge_expired`, or
  `wallet_challenge_mismatch`: discard the challenge and restart
  `/api/wallet/link/start`.
- `wallet_signature_invalid`: keep the user in the wallet modal, tell them to
  confirm the recovery phrase, and do not log the phrase or derived private key.
- `LOCAL_STORAGE_UNAVAILABLE` or `WEB_CRYPTO_UNAVAILABLE`: wallet proof may
  succeed, but the app must explain that the encrypted vault could not be saved
  on this device.

## Regression Coverage

Every wallet/auth change should preserve these tests:

- signed-out wallet link opens login and does not show the seed modal;
- signed-in wallet link starts a server challenge;
- short or mismatched wallet passwords produce visible validation feedback and
  do not look like a broken button;
- browser signs and verifies the wallet challenge without sending seed/private
  key material;
- successful link refreshes app state and shows `Seed wallet linked`;
- stale signed-out warnings are cleared after login and link success;
- local vault lock/unlock works after a reload;
- API smoke covers signed-in `/api/wallet/link/start` and
  `/api/wallet/link/verify`;
- frame smoke captures the signed-out login redirect and the signed-in link
  flow.

## Anti-Patterns

Do not reintroduce these patterns:

- opening a seed phrase modal before account login;
- using wallet restore as the only way to enter the app;
- treating a local encrypted vault as an account session;
- hard-coding example emails, wallets, or phrases to repair auth flow;
- auto-linking or auto-merging provider, email, and wallet identities;
- logging seed phrases, private keys, signatures with raw challenge text, or
  wallet passwords;
- adding wallet unlock gates to non-wallet product surfaces.

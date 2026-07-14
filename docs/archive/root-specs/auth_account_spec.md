> **Archive notice:** Historical reference only. **`docs/wiki/` is the authoritative documentation for Task Node Official.** Do not treat this file as current product or architecture authority.

# Task Node Auth and Account Claim Spec

Status: draft v0.1
Date: 2026-05-16
Owner: Post Fiat product and engineering

## Purpose

This spec resolves the first Task Node Official auth boundary:

- Existing PFTasks users should be able to get back into their accounts.
- New users should be able to sign in with low friction.
- A user can chat and pay without a Post Fiat wallet.
- Wallet proof is required only for wallet-bound actions.
- Email login is new. It must be designed as a weak convenience and recovery
  factor, not as the source of truth for legacy wallet ownership.

## Sources Reviewed

Task Node Official:

- `product_spec.md`
- `full_spec.md`
- `login.jsx`
- `jsx_mock.jsx`
- `whip_context.md`
- Current app contracts in `server/product-contracts.js`,
  `server/runtime-store.js`, `server/app-state.js`, and `src/main.jsx`

Legacy PFTasks:

- `pftasks/api/migrations/003_oauth_wallet_link.sql`
- `pftasks/api/migrations/004_account_identities_wallets.sql`
- `pftasks/api/migrations/021_user_provider_metrics_email.sql`
- `pftasks/api/src/routes/auth.js`
- `pftasks/api/src/routes/wallets.js`
- `pftasks/api/src/services/auth_service.js`
- `pftasks/api/src/services/account_service.js`
- `pftasks/app/src/lib/auth/providers.js`
- `pftasks/app/src/lib/wallet/derive.js`
- `pftasks/app/src/lib/wallet/crypto.js`
- `pftasks/app/src/lib/wallet/storage.js`
- `pftasks/app/src/pages/phase2_screen11_wallet_restore.jsx`
- `pftasks/milestones/M05_oauth_account_linking/milestone.md`
- `pftasks/milestones/M06b_returning_user_accounts/milestone.md`
- `pftasks/milestones/M57_x_account_wallet_linking_recovery/milestone.md`

External primary security references:

- OWASP Authentication Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Forgot Password Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- OWASP Email Validation and Verification Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html
- OWASP Multifactor Authentication Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- NIST SP 800-63B:
  https://pages.nist.gov/800-63-4/sp800-63b.html

## Product Decisions

1. `login.jsx` is the canonical primary login surface.
   The visible first-class options are Telegram, Discord, X, GitHub, and email,
   in that order. The modal should keep the ChatGPT-style email continuation
   flow.

2. GitHub is a first-class login provider.
   PFTasks has real GitHub-linked users. GitHub must remain visible in the
   primary modal so legacy users do not have to discover a hidden recovery path.

3. Provider logins are access and continuity signals, not punitive gates.
   Legacy sybil checks and provider metrics should inform trust, rewards,
   routing, and payout risk. They should not block normal app login for users
   who only want to chat, pay, manage context, or inspect account state.

4. Email is a weak login/recovery factor.
   Task Node did not previously have first-class email login. Email can create
   a new account and can help recover an account with a previously verified
   legacy email. Email alone must not claim a legacy PFT wallet unless the
   account has a verified email record and no higher-confidence conflict.

5. Wallet proof is the strongest legacy claim signal.
   The mnemonic stays local. The browser derives the XRPL/PFTL wallet locally
   and signs a fresh server challenge. The server receives only wallet address,
   public key, signature, challenge id, and metadata needed to link the wallet.

6. Task Node supports one active PFT wallet per account.
   Legacy PFTasks may have multiple wallet rows. The migration should preserve
   history, pick one current wallet for the new app, and keep non-current
   wallets as archived recovery/ledger evidence rather than exposing a
   multi-wallet product surface.

7. Abuse controls are security controls, not product usage caps.
   Email tokens, wallet challenges, OAuth starts, and provider callbacks need
   brute-force and replay protection. These controls do not contradict the
   usage-based product model where paid users can consume more app capacity.

## Legacy Facts

PFTasks already has useful account primitives:

- `user_identities` stores `(user_id, provider, provider_user_id, username)`,
  unique by provider identity and unique by `(user_id, provider)`.
- `user_wallets` stores `wallet_address`, `wallet_pubkey`, active/deactivated
  state, and ownership. Wallet address is globally unique.
- `oauth_states` stores OAuth state, code verifier, expiry, and later user/mode
  fields for provider linking.
- `wallet_link_requests` stores short-lived wallet link challenges.
- `users.email`, `email_verified`, `email_provider`, and `email_updated_at`
  exist, but were populated opportunistically from providers. They were not a
  complete email-login system.
- Existing provider support includes GitHub, X, Discord, and Telegram.
- The old seed wallet flow uses 24-word BIP39 phrases, XRPL derivation path
  `m/44'/144'/0'/0/0`, local validation, local encryption, IndexedDB storage,
  and localStorage backup fallback.
- Wallet link confirmation verifies a signed challenge before writing a wallet
  to the user account.

## Identity Confidence Model

Use confidence tiers so migrations are explainable and deterministic.

| Signal | Confidence | Can create session? | Can claim legacy account? | Notes |
| --- | --- | --- | --- | --- |
| Existing provider id match | High | Yes | Yes | Exact `provider + provider_user_id` match. |
| Wallet challenge proof | High | Yes after account creation | Yes | Strongest proof for wallet-bound account history. |
| Verified legacy email match | Medium | Yes | Conditional | Only if no provider/wallet conflict exists. |
| New email OTP/code | Low | Yes | No | Creates or resumes an email account; does not prove old wallet. |
| Username/display name match | Low | No | No | Useful only for support search and UI hints. |
| Provider metrics | Risk signal | No | No | Inform rewards, routing, and payout review. |

Collision policy:

- If provider proof and wallet proof resolve to the same legacy user, claim that
  account and link both signals.
- If provider proof and wallet proof resolve to different users, never auto
  merge. Create an `account_claim_conflict` event and show recovery/support UX.
- If email matches a verified legacy email and no stronger identity conflicts,
  allow a limited claim session and prompt for provider or wallet confirmation.
- If email matches an unverified or duplicate email, create a normal email
  session but do not attach legacy wallet, rewards, or provider history.
- If a wallet is linked to a deleted legacy account, allow relink only after
  fresh wallet proof and an audit event.

## Primary Login UX

The primary modal mirrors `login.jsx`:

1. Telegram button
2. Discord button
3. X button
4. GitHub button
5. OR divider
6. Email address input
7. Continue button

Expected behavior:

- Clicking Telegram, Discord, X, or GitHub starts provider auth if configured.
- Provider callbacks either resume an account, create an account, or enter a
  claim/conflict step.
- The email field starts the email-code flow.
- After sign-in, the app returns to the same chat frame and server-owned account
  state refreshes.

## Email Login Direction

Use email one-time codes for the first production email path. Do not start with
passwords.

Rationale:

- PFTasks has no password history to migrate.
- Codes keep the user in the same browser session and avoid mobile email clients
  opening a magic link in a different in-app browser.
- The provided modal already has an email input followed by a Continue button,
  which maps cleanly to an email-code step.
- Email remains weaker than provider OAuth, wallet proof, or passkeys, so it
  should not become the proof for sensitive account changes.

Email-code requirements:

- Store both original email and canonical email. Lowercase the domain. Do not
  do provider-specific transformations such as Gmail dot removal.
- Use a well-tested email parser/validator. Reject clearly malformed addresses,
  not technically-valid edge cases through custom regex.
- Return the same user-facing response whether the email exists or not.
- Store only a hash of the code/token server-side.
- Codes are single-use, expire quickly, and are invalidated after success,
  expiration, or replacement.
- Bind the code request to a browser/session nonce where possible.
- Never log email codes, full token URLs, or full email addresses.
- Mask email addresses in logs and analytics.
- On success, rotate/set a new httpOnly, Secure, SameSite=Lax session cookie.
- Email login creates a normal account session but a low identity assurance
  state until provider, wallet, or future passkey proof is attached.

Suggested first shape:

- `POST /api/auth/email/start`
  - Input: email.
  - Output: generic success message, masked email, challenge id if needed.
  - Side effect: send 6-8 digit code or short alphanumeric code through the
    selected transactional email provider.

- `POST /api/auth/email/verify`
  - Input: challenge id or request nonce, code.
  - Output: account session.
  - Side effect: consume code, issue session, record auth event.

Email should not silently merge accounts. If an email resolves to more than one
possible legacy path, show an account recovery step rather than guessing.

## Provider Auth Direction

Provider auth should reuse the proven PFTasks shape but remove punitive gates
from normal login:

- OAuth state is stored server-side with short expiry.
- State and nonce are bound to httpOnly, Secure, SameSite=Lax cookies.
- OAuth callbacks fetch stable provider IDs.
- Provider identity rows are unique by `(provider, provider_user_id)`.
- Provider linking requires an authenticated session and recent auth.
- Provider unlinking cannot remove the last reliable login method unless wallet
  proof, email, passkey, or another provider is present.
- Provider metrics are stored for risk and routing, not for blocking normal app
  access.

Launch order:

1. Telegram auth, because it is first in `login.jsx` and supports mobile/bot
   continuity.
2. Discord auth, because it supports chat continuity and bot consolidation.
3. X auth, because it is canonical in `login.jsx` and important for legacy
   PFTasks users.
4. GitHub auth, because old PFTasks users may depend on it for account
   continuity.

## Wallet Claim Direction

Wallet restore/link must follow the existing seed design but tighten custody:

- The 24-word mnemonic is entered and validated locally.
- The derived wallet uses the existing XRPL/PFTL derivation path.
- The mnemonic and private key never leave the browser.
- Local storage uses Web Crypto encryption before IndexedDB persistence.
- A local wipe clears IndexedDB and backup storage.
- Server wallet linking uses a short-lived challenge and signature.
- The server stores wallet address, public key, link status, source, and audit
  events.
- Wallet-bound actions require recent wallet unlock/signature confirmation.

Wallet proof can claim a legacy account if `user_wallets.wallet_address` maps to
one user and no stronger conflict exists.

## Delink and Relink

Task Node needs production-safe delink/relink because wallet onboarding must be
testable repeatedly.

Definitions:

- Local wipe: remove the encrypted seed vault from the current device. This does
  not alter server wallet ownership.
- Wallet delink: detach the current account from the active PFT wallet for app
  onboarding purposes. This does not delete chain history or ledger entries.
- Wallet relink: prove control of a wallet and attach it again.

Rules:

- Delink requires an authenticated account session and recent higher-confidence
  proof: provider reauth, wallet proof, or future passkey.
- Delink is blocked while payouts, verification rewards, or outbound wallet
  actions are pending.
- Delink creates an append-only audit event with actor, wallet, reason, and
  timestamp.
- Relink requires a new wallet challenge signature.
- Relink to a different account is blocked unless the old account is deleted or
  a conflict resolution event explicitly permits it.
- Test-only delinks must be clearly marked and available only to authorized dev
  or support actors.

## Data Model Draft

The Task Node Official schema should be smaller than PFTasks but keep the same
account boundaries.

Core tables:

- `accounts`
  - id, status, display_name, primary_email, primary_email_verified,
    identity_assurance, created_at, updated_at, deleted_at.

- `account_identities`
  - account_id, provider, provider_user_id, username, email, email_verified,
    metrics, linked_at, last_seen_at.
  - Unique `(provider, provider_user_id)`.
  - Unique `(account_id, provider)`.

- `account_wallets`
  - account_id, wallet_address, wallet_pubkey, status, is_current,
    source_provider, linked_at, delinked_at, last_proved_at.
  - Unique current wallet per account.
  - Unique active wallet owner by wallet address.

- `email_login_challenges`
  - account_id nullable, canonical_email, token_hash, browser_nonce_hash,
    expires_at, consumed_at, attempt_count, created_at.

- `wallet_link_challenges`
  - account_id, challenge_hash, expires_at, consumed_at, created_at.

- `sessions`
  - account_id, session_hash, auth_method, assurance, expires_at,
    revoked_at, created_at, last_seen_at.

- `account_claim_events`
  - account_id nullable, event_type, provider, provider_user_id,
    wallet_address, canonical_email, decision, metadata, created_at.

Migration tables/views:

- Read-only PFTasks identity import view.
- Read-only PFTasks wallet import view.
- Claim conflict queue.
- Claim audit report.

## Implementation Sequence

1. Inventory legacy identities.
   Build read-only scripts or queries that count GitHub, X, Discord, Telegram,
   email, and wallet-linked legacy users. Do not expose secret values.

2. Add Task Node account tables.
   Create the minimal schema above, sessions, and append-only claim events.

3. Implement provider auth starts/callbacks.
   Start with Telegram/Discord/X/GitHub visible paths, matching the primary
   login modal.

4. Implement email-code login.
   It creates/resumes low-assurance accounts. It does not claim legacy wallet
   history by itself.

5. Implement wallet challenge proof.
   Reuse the existing local mnemonic derivation path and signed challenge model.

6. Implement claim router.
   Deterministically resolve provider, email, and wallet signals into one of:
   resume account, create account, link signal, limited claim session, or
   conflict.

7. Implement delink/relink.
   Add audit events and block dangerous states.

8. Add UI frames from `login.jsx` and existing wallet restore mocks.
   The app frame should remain ChatGPT-like; wallet and recovery steps appear
   only when required.

## Acceptance Criteria

- A new user can create an account with email and chat without a PFT wallet.
- A legacy X user can sign in and recover their legacy account.
- A legacy Telegram/Discord user can sign in if the provider identity exists.
- A legacy GitHub-only user can start account recovery from the primary login
  modal.
- A user with a 24-word recovery phrase can prove wallet ownership without
  sending the mnemonic to the server.
- Email-only login cannot accidentally steal a wallet-linked legacy account.
- Provider/wallet conflicts never auto-merge.
- Sessions use httpOnly secure cookies and rotate after auth.
- Code/token/challenge flows are single-use, expiring, and replay-resistant.
- Wallet delink/relink can be tested repeatedly without deleting history or
  corrupting balances.

## Tests To Write First

- Email start returns the same visible response for existing and non-existing
  emails.
- Email verify consumes a code exactly once.
- Email-only session cannot claim a wallet-linked legacy account.
- Provider exact match resumes the same account.
- Wallet challenge proof claims the matching legacy wallet account.
- Provider/wallet mismatch enters conflict state.
- GitHub login is visible in the primary login modal.
- Last-login-method unlink is blocked.
- Delink is blocked during pending payout or wallet action.
- Local wallet restore never posts mnemonic/private key to the API.

## Open Questions

- Which transactional email provider should Task Node Official use?
- Should the first email code be numeric, alphanumeric, or both code plus magic
  link for accessibility?
- Should passkeys/WebAuthn be added immediately after email login or deferred
  until after provider/wallet migration?
- What is the exact support process for claim conflicts?
- What date, if any, cuts over GitHub from first-class login to support-only
  claim?
- Which legacy emails are trustworthy enough to import as verified?
- What account deletion policy preserves wallet/payment audit history while
  honoring deletion requests?

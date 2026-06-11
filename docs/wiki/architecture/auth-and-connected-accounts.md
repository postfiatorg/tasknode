# Auth And Connected Accounts

Task Node has one account cloud per user. Email, GitHub, Telegram, X, wallets, and future providers should attach to that account cloud instead of creating isolated identities. Discord OAuth is implemented and currently enabled in production (`/api/auth/providers` reports it configured and ready), but it is a non-core surface: it is not a launch-blocking dependency and carries no production support promise until the product scope explicitly promotes it.

The current UI surfaces are:

- profile menu -> Telegram Chat, immediately below Directory, for the primary Telegram bot/chat link path;
- Settings -> Security -> Connected accounts, for the full provider list.

The backend contract is `authProviders`, `authStart`, and `authCallback` in `server/product-contracts.js`.

## What Exists Now

Email login is implemented as an 8-digit code flow:

1. `POST /api/auth/email/start` creates an email challenge.
2. Resend is used whenever `EMAIL_DELIVERY_PROVIDER=resend`, `EMAIL_FROM`, and
   `RESEND_API_KEY` are configured — including local Docker with
   `.env.tasknodeofficial-dev`.
3. Development code delivery is used only when Resend is not configured and the
   environment is non-production, or when `TASKNODE_EMAIL_DEV_DELIVERY=true`
   explicitly forces it.
4. `POST /api/auth/email/verify` consumes the challenge and issues a Task Node session.
5. Email accounts are low assurance. They do not prove wallet or legacy provider ownership.

Telegram login and linking are implemented through Telegram Login Widget:

1. `GET /api/auth/start/telegram` creates an OAuth-style state row and state cookie.
2. The route checks that the current app hostname matches `TELEGRAM_AUTH_WIDGET_DOMAIN`.
3. The route returns `/api/auth/telegram/authorize?state=...`.
4. The authorize page renders Telegram's login widget using `TELEGRAM_AUTH_BOT_USERNAME`.
5. Telegram redirects to `/api/auth/callback/telegram` with signed user fields.
6. The server verifies the Telegram HMAC using `sha256(bot token)` as the HMAC key.
7. The server rejects invalid signatures, expired payloads, and stale state cookies.
8. If the browser already has a Task Node session, the Telegram identity links to that account. Otherwise it creates or resumes a Telegram-backed account.

Telegram can only render the Login Widget on the domain configured in BotFather with `/setdomain`. Localhost is not a reliable test domain for the real Telegram widget. If the app runs on `localhost` while BotFather is configured for a public domain, Telegram returns `Bot domain invalid`. Task Node now blocks that path before loading the widget and returns `telegram_widget_domain_mismatch` with the expected domain.

## Unlinking A Connected Account

Signed-in users can unlink GitHub, Telegram, X, or Discord from Settings ->
Security -> Connected accounts. The row's `Disconnect` button arms an inline
confirm step before calling `POST /api/account/unlink-provider` (session auth,
rate limited, explicit `confirm: true` required).

Unlink rules:

- Lockout guard: the request is refused (`provider_unlink_last_login_method`)
  when removing the provider would leave the account with no way to sign back
  in. Sign-in methods are a verified email that survives the unlink or another
  linked OAuth provider; wallets are identity/custody, not login.
- Provider-supplied emails follow the provider. `account.emailProvider`
  records which provider verified the primary email. When that provider is
  unlinked, the email mapping transfers to a remaining linked provider that
  verified the same address; otherwise it is removed together with the
  identity mapping, so a fresh login with that email cannot re-enter the old
  account and the address is free to attach elsewhere. A provider-owned email
  does not count as an independent sign-in method for the lockout guard.
- The provider identity mapping is freed immediately, so the same external
  account can be linked to a different Task Node account afterwards.
- If the unlinked provider was the account's primary provider, the primary is
  reassigned to a remaining sign-in method.
- Live sessions are updated in place (the Security panel reflects the change
  without re-login), and a `user.account.provider_unlinked` observability
  event records the action.
- Founding-identity safety: account ids are derived from the identity that
  created the account. A founding identity that has been unlinked does not
  re-enter its old account on a later login; it founds a fresh account
  instead. `npm run account-unlink-provider-smoke` pins all of these rules.

Discord login and linking are implemented through OAuth and currently enabled in production, while remaining outside the core launch surface:

1. `GET /api/auth/start/discord` creates an OAuth state row and state cookie.
2. The route redirects to Discord OAuth with `identify email`.
3. `/api/auth/callback/discord` exchanges the code, fetches `/users/@me`, and verifies state.
4. If the browser already has a Task Node session, the Discord identity links to that account. Otherwise it creates or resumes a Discord-backed account.

X login and linking are implemented through OAuth2 authorization code with PKCE:

1. `GET /api/auth/start/x` creates an OAuth state row and state cookie.
2. The state row stores the short-lived PKCE verifier server-side.
3. The route redirects to X OAuth with `users.read tweet.read` by default.
4. `/api/auth/callback/x` verifies state, exchanges the code with the PKCE verifier, and fetches `/2/users/me`.
5. X does not provide email through this flow, so the stable X user id is the account identity.
6. If the browser already has a Task Node session, the X identity links to that account. Otherwise it creates or resumes an X-backed account.

GitHub remains implemented through the same start/callback contract.

## Linking Rules

The account link boundary is `server/runtime-store.js::linkProviderToAccount`.

The rules are:

1. A provider identity can be linked to only one Task Node account.
2. A verified provider email cannot be used to silently merge into another account.
3. Link attempts from the profile menu Telegram row or Settings include the current session account id in the OAuth state row.
4. Callback handlers do not trust query parameters for account ownership; they consume the state row and state cookie.
5. A successful provider link issues a fresh session whose `linkedProviders` list reflects the updated account cloud.

This is now the boundary Telegram bot chat uses: Telegram proves the sender with `message.from.id`, and Task Node only runs account-scoped chat when that Telegram identity is already attached to a Task Node account.

## Public Hive Handle And Alias Visibility

Auth providers prove account ownership; they are not the public namespace. The public namespace is the account-scoped Hive handle returned by `GET /api/profile/identity` and saved through `POST /api/profile/handle`.

The handle boundary is `server/account-identity.js`:

- `normalizeHiveHandle` lowercases and normalizes user input into the allowed handle character set;
- `checkHiveHandleAvailability` enforces length, reserved names, uniqueness, and current-account reuse;
- `suggestHiveHandles` derives available pseudonymous suggestions without automatically claiming a provider username;
- `applyAccountHiveHandle` writes the chosen handle and optional public display name to the account record.

Provider aliases are attached by the auth linking flow but remain private unless the user discloses them through `POST /api/profile/identity/alias`. `applyAccountAliasVisibility` stores per-provider disclosure settings. `accountIdentityProfile` returns all linked aliases to the signed-in user and returns `publicAliases` only for aliases with explicit public visibility and a public handle or verified-badge disclosure.

This means X, GitHub, Telegram, email, wallet identity, and any explicitly enabled future provider can be used for login, recovery, anti-sybil signals, and operator trust without forcing public correlation. Discord should not be presented as a production launch promise: it is currently enabled but remains a non-core surface without a support commitment. A user who wants public continuity can still choose a matching Hive handle and disclose the verified provider alias.

The current identity product contract is split between this architecture page and `Surfaces -> Profile`.

## Provider Configuration

Telegram requires:

```text
TELEGRAM_AUTH_BOT_TOKEN
TELEGRAM_AUTH_BOT_USERNAME
TELEGRAM_AUTH_WIDGET_DOMAIN
TELEGRAM_BOT_WEBHOOK_SECRET
TASKNODE_PUBLIC_URL or a request origin from the running app
```

`TELEGRAM_AUTH_WIDGET_DOMAIN` must be the hostname configured in BotFather. `TASKNODE_PUBLIC_URL` must resolve to that same hostname for Telegram login to work. If they differ, the profile menu and Settings should not treat Telegram as usable.

Telegram bot chat accepts webhooks at `/api/integrations/telegram/webhook`. Production webhook calls must include `X-Telegram-Bot-Api-Secret-Token` matching `TELEGRAM_BOT_WEBHOOK_SECRET`.

Discord requires:

```text
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_REDIRECT_URI optional; otherwise Task Node derives /api/auth/callback/discord from the current origin
```

X requires:

```text
X_CLIENT_ID
X_CLIENT_SECRET
X_REDIRECT_URI optional; otherwise Task Node derives /api/auth/callback/x from TASKNODE_PUBLIC_URL or the current origin
X_OAUTH_SCOPES optional; defaults to users.read tweet.read
X_OAUTH_CLIENT_TYPE optional; defaults to confidential, set to public only if the X App type is Native App or Single Page App
```

The X App callback currently registered (and set in the app env as
`X_REDIRECT_URI`) is the legacy host:

```text
https://tasknodeofficial-dev.fly.dev/api/auth/callback/x
```

This works in production through the legacy-host redirect bridge: the old
hostname 301-redirects GET requests (including OAuth callbacks, with `code`
and `state` preserved) to `tasknode.postfiat.org`, and the production startup
origin guard explicitly allows redirect URIs whose host is in
`TASKNODE_LEGACY_REDIRECT_HOSTS`. Live `/api/auth/start/x` therefore reports
the legacy redirect URI by design. To migrate X off the bridge, change the X
developer-portal callback and `X_REDIRECT_URI` to
`https://tasknode.postfiat.org/api/auth/callback/x` together in one step;
changing either side alone breaks X login.

Email requires one of:

```text
TASKNODE_EMAIL_DEV_DELIVERY=true
```

or:

```text
EMAIL_DELIVERY_PROVIDER=resend
EMAIL_FROM
RESEND_API_KEY
```

Fly dev currently uses Resend with:

```text
EMAIL_FROM=Task Node <login@agti.net>
```

The Resend API key is a secret. Keep it in Fly secrets and the gitignored local
env file only.

Production auth should also configure:

```text
TASKNODE_AUTH_SECRET
TASKNODE_RUNTIME_STORE_DURABLE=true
```

## Failure States

The deterministic fixture covers these states:

| State | Expected result |
| --- | --- |
| Email wrong code | `email_code_invalid`, no session |
| Email correct code | session issued |
| Telegram valid payload | session issued or linked |
| Telegram same user reconnect | same account id resumes |
| Telegram invalid signature | `telegram_auth_signature_invalid`, no session |
| Telegram expired payload | `telegram_auth_expired`, no session |
| Telegram widget domain mismatch | `telegram_widget_domain_mismatch`, no widget rendered |
| Telegram authorize stale state | HTML error page, no widget rendered |
| OAuth stale state | `oauth_state_invalid`, no session |
| Discord valid OAuth callback | session issued or linked |
| X valid OAuth2 PKCE callback | session issued or linked |
| Logout | session destroyed |

## Broken States Fixed

The previous implementation had four concrete failures:

1. Telegram, Discord, and X appeared in Connected accounts, but backend start/callback routes returned disabled or not implemented responses.
2. Telegram readiness checked only `TELEGRAM_AUTH_BOT_TOKEN`; the Login Widget also needs `TELEGRAM_AUTH_BOT_USERNAME` and a BotFather domain.
3. Email-only accounts could not attach Telegram, Discord, or X identities for validated messaging.
4. There was no repeatable fixture for invalid auth, stale state, PKCE callbacks, reconnect, and logout transitions.

## Verification

Run:

```bash
npm run auth-login-state-fixture
```

The fixture uses a temporary runtime store and mocked Discord and X API responses. It does not call external providers.

Expected final line:

```text
auth_login_state_fixture_passed transitions=14
```

The script is intentionally part of `npm run quality` so future auth changes cannot silently break email, Telegram, Discord, X linking, stale state rejection, or logout.

## Code References

- `server/product-contracts.js`: auth provider route contracts.
- `server/auth-connected-accounts.js`: auth provider readiness, start routes, callback verification, Telegram HMAC verification, Discord OAuth exchange, and X OAuth2 PKCE exchange.
- `server/index.js`: HTTP auth routes, session cookies, Telegram authorize page headers.
- `server/runtime-store.js`: account/session store, linked provider rules, OAuth state rows.
- `src/main.jsx`: Login dialog and Settings -> Connected accounts UI.
- `scripts/auth-login-state-fixture.mjs`: deterministic replay fixture.

## Historical Reference

PFTasks implemented Telegram login through the Telegram Login Widget and verified the callback with the Telegram HMAC check in `api/src/lib/telegram_auth.js`. Task Node Official now uses the same cryptographic standard but keeps the product behavior simpler: Telegram and Discord are account-link providers, not signup eligibility gates.

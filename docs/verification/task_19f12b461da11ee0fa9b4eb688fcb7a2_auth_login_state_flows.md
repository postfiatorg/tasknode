# Stress Test Email And Telegram Login State Flows

Task ID: `task_19f12b461da11ee0fa9b4eb688fcb7a2`
Request ID: `req_net_827b506a2b300dfc8d902c299f753b36`
Network Project: `task_node`

## Runnable Fixture

Run from the repo root:

```bash
npm run auth-login-state-fixture
```

The fixture is `scripts/auth-login-state-fixture.mjs`. It uses an isolated temp runtime store, local development email delivery, a signed Telegram payload generator, and mocked external OAuth providers for non-target providers. It does not need real email delivery, Telegram network calls, or browser state.

## Coverage

Email login:

- provider readiness
- challenge creation
- invalid code rejection
- successful code verification and session issuance
- replaced/stale challenge rejection
- same-email reconnect to the same account id
- logout destroys the session

Telegram login:

- provider readiness
- authorize page requires a matching OAuth state cookie
- successful signed Telegram callback and session issuance
- same Telegram identity reconnects to the same account id
- invalid signature rejection
- expired signed payload rejection
- Telegram identity can link into an existing email account
- stale OAuth state rejection
- logout destroys the active session

## Evidence Log

Command:

```bash
npm run auth-login-state-fixture
```

Result:

```text
providers.ready {"enabled":["discord","email","telegram","x"]}
email.challenge_started {"challengeId":"d9ba7f56-3127-400d-9500-f85568d61767","deliveryMode":"development"}
email.invalid_code_rejected {"status":400,"error":"email_code_invalid"}
email.success {"accountId":"acct_email_3d59588a6193f597fdd8ecb7","linkedProviders":["email"]}
email.replaced_challenge_rejected {"status":400,"error":"email_code_invalid"}
email.reconnect_same_account {"accountId":"acct_email_3d59588a6193f597fdd8ecb7","linkedProviders":["email"]}
telegram.success {"accountId":"acct_oauth_8e11f9aa94fc63d6fb96c0e5","linkedProviders":["telegram"]}
telegram.reconnect_same_account {"accountId":"acct_oauth_8e11f9aa94fc63d6fb96c0e5"}
telegram.invalid_signature_rejected {"status":401,"error":"telegram_auth_signature_invalid"}
telegram.expired_payload_rejected {"status":401,"error":"telegram_auth_expired"}
telegram.linked_to_email_account {"accountId":"acct_email_3d59588a6193f597fdd8ecb7","linkedProviders":["email","telegram"]}
discord.linked_to_email_account {"accountId":"acct_email_3d59588a6193f597fdd8ecb7","linkedProviders":["discord","email","telegram"]}
x.public_origin_ignores_local_redirect_override {"redirectUri":"https://tasknodeofficial-dev.fly.dev/api/auth/callback/x"}
x.linked_to_email_account {"accountId":"acct_email_3d59588a6193f597fdd8ecb7","linkedProviders":["discord","email","telegram","x"]}
oauth.stale_state_rejected {"status":400,"error":"oauth_state_invalid"}
identity.namespace_saved {"accountId":"acct_email_3d59588a6193f597fdd8ecb7","handle":"x_fixture","publicAliases":1}
logout.session_destroyed {"sessionId":"08ab9d85-2efc-4df6-8dce-f4b54a2ead8f","sessionAfterLogout":null}
summary.discovered_prior_failures {"failures":["Telegram and Discord appeared in Connected accounts, but the backend returned disabled/not implemented responses.","X appeared as configured, but /api/auth/start/x returned auth_provider_disabled.","Telegram readiness only checked the bot token; the Login Widget also requires a bot username and an authorize page.","Email-only accounts could not attach Telegram, Discord, or X identities for later validated messaging.","No deterministic fixture covered invalid auth, stale OAuth state, PKCE provider callbacks, reconnect, and logout behavior for these providers."]}
auth_login_state_fixture_passed transitions=18
```

The UUID values are per-run artifacts. The deterministic assertions are the transition labels, status codes, provider link sets, and same-account account ids.

## Broken Or Ambiguous States Discovered

1. Connected-account providers could appear in the UI while backend start/callback routes were disabled or incomplete.
   Minimal fix: make provider readiness depend on backend route support and keep this fixture in CI/release checks.

2. Telegram readiness previously checked only the bot token, which was insufficient for the Login Widget flow.
   Minimal fix: require bot username, BotFather domain, authorize page rendering, and matching OAuth state before showing a usable Telegram login.

3. Email-only accounts could not reliably attach Telegram/Discord/X identities for later validated messaging.
   Minimal fix: support account-link mode for logged-in sessions and assert linked provider lists after callback.

4. Replaced email codes were not covered by a deterministic test, leaving stale-code behavior ambiguous.
   Minimal fix: mark older active challenges for the same canonical email as replaced and assert the old code is rejected while the latest code reconnects to the same account.

5. X OAuth regressions exposed a related auth-state risk: public deployments can accidentally emit localhost callbacks or reject OAuth2 client credentials when Client IDs contain colon separators.
   Minimal fix: derive public callback URLs from the public origin when stale local redirect env vars are present, and percent-encode OAuth2 Basic auth credential parts before token exchange.

## Verification Commands Run

```bash
npm run auth-login-state-fixture
npm run lint
git diff --check
```

All completed successfully for the touched auth fixture/code path.

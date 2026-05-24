# PR-01 Review: Auth And Connected Accounts

Date: 2026-05-24
Branch: `review/01-auth-connected-accounts`
Base: `origin/main` @ `b46dbb1`

## Summary

Reviewed the auth start/callback boundary for email, Telegram, Discord, and GitHub.
Core crypto, OAuth state consumption, provider linking, and the deterministic auth
fixture are in good shape. This branch adds Telegram authorize hardening and
smoke/fixture coverage updates.

## Findings

### P0

None in application code.

### P1

1. **Discord redirect URI in local dev env may still target PFTasks**
   - **File/line:** `.env.tasknodeofficial-dev` (gitignored) `DISCORD_REDIRECT_URI=https://pftasks-frontend-dev.fly.dev/api/auth/discord/callback`
   - **Severity:** P1
   - **Impact:** Discord OAuth token exchange fails or completes on the wrong app if this value is used in a running environment.
   - **Verification:** Inspect local dev env; confirm Fly secret is `https://tasknodeofficial-dev.fly.dev/api/auth/callback/discord`.
   - **Fix:** External — update Fly secret and local dev env together when Discord linking is exercised locally.

2. **Route policy `auth` modes are declared but not enforced centrally**
   - **File/line:** `server/route-policies.js:29-33`, `server/index.js:238-264`
   - **Severity:** P1 (maintainability / defense-in-depth)
   - **Impact:** `auth: "oauth_state"` on Telegram authorize/callback routes is documentation-only. Handlers must enforce policy themselves; future routes can drift silently.
   - **Verification:** `enforceRoutePolicy` only checks HTTP method and rate limits.
   - **Fix:** Deferred to a later infra PR; Telegram authorize now validates state locally (see fixes below).

3. **Fly dev email provider is not configured**
   - **File/line:** `/api/auth/providers` on Fly dev
   - **Severity:** P1 for launch readiness, not a code bug
   - **Impact:** Email sign-in unavailable on dev deployment; Telegram/Discord/GitHub remain ready.
   - **Verification:** `curl https://tasknodeofficial-dev.fly.dev/api/auth/providers` → email `enabled: false`.
   - **Fix:** Configure Resend or document dev-only email path explicitly for that environment.

### P2

1. **Legacy `scripts/smoke.mjs` auth expectations were stale**
   - **File/line:** `scripts/smoke.mjs:724-787`
   - **Severity:** P2
   - **Impact:** Smoke against configured or unconfigured local Telegram env failed even though auth worked.
   - **Verification:** `npm run smoke` failed on `/api/auth/providers` and `/api/auth/callback/telegram` before this branch.
   - **Fix:** Included in this branch.

2. **Settings Connected accounts UI does not label sign-in vs link modes explicitly**
   - **File/line:** `src/main.jsx:4234-4290`, `4422-4598`
   - **Severity:** P2
   - **Impact:** Login dialog handles sign-in; Settings handles linking. Behavior is correct, but Settings rows always say "Connect" without explaining that sign-in happens elsewhere.
   - **Verification:** Manual Settings review while signed out vs signed in.
   - **Fix:** Optional UX copy follow-up.

## Telegram Bot Identity

`pftasknodebot` is the **intended Task Node Official Telegram bot** for current dev
and messaging continuity. The authorize page correctly renders
`TELEGRAM_AUTH_BOT_USERNAME` from deployment config. This is not a stale PFTasks
blocker; BotFather domain alignment (`TELEGRAM_AUTH_WIDGET_DOMAIN`) is the relevant
operational check.

## Fixes Included On This Branch

1. **`authTelegramAuthorize` requires matching OAuth state cookie and an unexpired state row** before rendering the Login Widget.
2. **`consumeOAuthState` supports `peek: true`** so authorize can validate state without consuming it.
3. **Extracted OAuth HTTP cookie helpers** to `server/auth-oauth-http.js` to keep `server/index.js` under file-size limits.
4. **Extended `scripts/auth-login-state-fixture.mjs`** with authorize-page coverage.
5. **Updated stale auth expectations in `scripts/smoke.mjs`**, including unconfigured Telegram callback handling.
6. **Documented authorize stale-state behavior** in auth architecture wiki.

## Checks Run

```bash
npm ci
npm run quality
npm run smoke
node scripts/auth-login-state-fixture.mjs
npm run security-smoke
curl -sS https://tasknodeofficial-dev.fly.dev/api/auth/providers
git diff --check origin/main...HEAD
```

Manual Fly dev evidence:

- Telegram start returns authorize URL on correct domain.
- Authorize page renders `pftasknodebot`, the configured Task Node Official bot.

## Residual Risks

- Durable auth/account storage on Fly depends on `TASKNODE_RUNTIME_STORE_DURABLE` and Postgres migration path (PR-09 scope).
- X provider remains configured-but-disabled; UI may still show it in provider lists.
- GitHub account merge by verified email is intentional but assumes provider email verification integrity.

## Merge Recommendation

**Merge** after `npm run quality` and `npm run smoke` pass on this branch. Track Discord redirect URI cleanup and email provider configuration separately if those environments need them.

---

```text
Review PR: PR-01
Boundary: Auth and connected accounts
Branch: review/01-auth-connected-accounts
Changed files:
  server/runtime-store.js
  server/auth-connected-accounts.js
  server/auth-oauth-http.js
  server/index.js
  scripts/auth-login-state-fixture.mjs
  scripts/smoke.mjs
  docs/wiki/architecture/auth-and-connected-accounts.md
  docs/review_burndown/reviews/pr-01-auth-connected-accounts.md
Findings:
- P0: none
- P1: PFTasks Discord redirect in local dev env (external); route auth policy not centrally enforced; email not configured on Fly dev
- P2: stale smoke expectations (fixed); Settings link/sign-in copy could be clearer
Fixes included: Telegram authorize OAuth-state gate; OAuth HTTP helper extraction; smoke + fixture updates
Checks run: quality, smoke, auth-login-state-fixture, security-smoke, Fly providers curl
Manual app evidence: Fly Telegram authorize page shows pftasknodebot (intended Task Node bot)
Residual risks: Fly secret/config drift for Discord/email; ephemeral vs durable runtime store
Merge recommendation: merge after quality + smoke pass
```

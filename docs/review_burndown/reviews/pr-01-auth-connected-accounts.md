# PR-01 Review: Auth And Connected Accounts

Date: 2026-05-24
Branch: `review/01-auth-connected-accounts`
Base: `origin/main` @ `b46dbb1`

## Summary

Reviewed the auth start/callback boundary for email, Telegram, Discord, and GitHub.
Core crypto, OAuth state consumption, provider linking, and the deterministic auth
fixture are in good shape. Two local fixes were included on this branch; remaining
P1 items are Fly/dev secret configuration, not application logic.

## Findings

### P0

None in application code.

### P1

1. **Fly dev still uses the legacy PFTasks Telegram bot username**
   - **File/line:** Fly runtime env (`TELEGRAM_AUTH_BOT_USERNAME`), evidenced via authorize page HTML
   - **Severity:** P1
   - **Impact:** Users on `tasknodeofficial-dev.fly.dev` see and authorize `pftasknodebot`, not a Task Node–branded bot. BotFather domain may be correct, but messaging continuity and user trust attach to the old PFTasks bot identity.
   - **Verification:** `curl` authorize page after `/api/auth/start/telegram` shows `data-telegram-login="pftasknodebot"`.
   - **Fix:** External — set Fly secret `TELEGRAM_AUTH_BOT_USERNAME` to the Task Node bot and confirm BotFather `/setdomain` for `tasknodeofficial-dev.fly.dev`.

2. **Discord redirect URI in local dev env still targets PFTasks**
   - **File/line:** `.env.tasknodeofficial-dev` (gitignored) `DISCORD_REDIRECT_URI=https://pftasks-frontend-dev.fly.dev/api/auth/discord/callback`
   - **Severity:** P1
   - **Impact:** Discord OAuth token exchange fails or completes on the wrong app if this value is used in a running environment.
   - **Verification:** Inspect local dev env; confirm Fly secret is `https://tasknodeofficial-dev.fly.dev/api/auth/callback/discord`.
   - **Fix:** External — update Fly secret and local dev env together.

3. **Route policy `auth` modes are declared but not enforced centrally**
   - **File/line:** `server/route-policies.js:29-33`, `server/index.js:238-264`
   - **Severity:** P1 (maintainability / defense-in-depth)
   - **Impact:** `auth: "oauth_state"` on Telegram authorize/callback routes is documentation-only. Handlers must enforce policy themselves; future routes can drift silently.
   - **Verification:** `enforceRoutePolicy` only checks HTTP method and rate limits.
   - **Fix:** Deferred to a later infra PR; Telegram authorize now validates state locally (see fixes below).

4. **Fly dev email provider is not configured**
   - **File/line:** `/api/auth/providers` on Fly dev
   - **Severity:** P1 for launch readiness, not a code bug
   - **Impact:** Email sign-in unavailable on dev deployment; Telegram/Discord/GitHub remain ready.
   - **Verification:** `curl https://tasknodeofficial-dev.fly.dev/api/auth/providers` → email `enabled: false`.
   - **Fix:** Configure Resend or document dev-only email path explicitly for that environment.

### P2

1. **Legacy `scripts/smoke.mjs` auth expectations were stale**
   - **File/line:** `scripts/smoke.mjs:724-773`
   - **Severity:** P2
   - **Impact:** Smoke against a configured dev server failed even though auth worked.
   - **Verification:** `npm run smoke` failed on `/api/auth/providers` before this branch.
   - **Fix:** Included in this branch.

2. **Settings Connected accounts UI does not label sign-in vs link modes explicitly**
   - **File/line:** `src/main.jsx:4234-4290`, `4422-4598`
   - **Severity:** P2
   - **Impact:** Login dialog handles sign-in; Settings handles linking. Behavior is correct, but Settings rows always say "Connect" without explaining that sign-in happens elsewhere.
   - **Verification:** Manual Settings review while signed out vs signed in.
   - **Fix:** Optional UX copy follow-up.

## Fixes Included On This Branch

1. **`authTelegramAuthorize` now requires matching OAuth state cookie and an unexpired state row** before rendering the Login Widget (`server/auth-connected-accounts.js`, `server/index.js`, `server/runtime-store.js`).
2. **Added `getOAuthState` helper** and reused it from `consumeOAuthState`.
3. **Extended `scripts/auth-login-state-fixture.mjs`** with authorize-page coverage.
4. **Updated stale auth expectations in `scripts/smoke.mjs`.**
5. **Documented authorize stale-state behavior** in auth architecture wiki.

## Checks Run

```bash
npm ci
node scripts/auth-login-state-fixture.mjs   # pass (transitions=13+)
npm run security-smoke                      # pass
curl -sS https://tasknodeofficial-dev.fly.dev/api/auth/providers
git diff --check origin/main...HEAD
```

Manual Fly dev evidence:

- Telegram start returns authorize URL on correct domain.
- Authorize page renders `pftasknodebot` (legacy bot — external config issue).

## Residual Risks

- Durable auth/account storage on Fly depends on `TASKNODE_RUNTIME_STORE_DURABLE` and Postgres migration path (PR-09 scope).
- X provider remains configured-but-disabled; UI may still show it in provider lists.
- GitHub account merge by verified email is intentional but assumes provider email verification integrity.

## Merge Recommendation

**Merge after Fly secrets are corrected** for Telegram bot username and Discord redirect URI, or merge the code fixes now and track deployment config separately. The code boundary is sound; dev deployment config is the main blocker for Telegram/Discord confidence on Fly.

---

```text
Review PR: PR-01
Boundary: Auth and connected accounts
Branch: review/01-auth-connected-accounts
Changed files:
  server/runtime-store.js
  server/auth-connected-accounts.js
  server/index.js
  scripts/auth-login-state-fixture.mjs
  scripts/smoke.mjs
  docs/wiki/architecture/auth-and-connected-accounts.md
  docs/review_burndown/reviews/pr-01-auth-connected-accounts.md
Findings:
- P0: none
- P1: legacy PFTasks Telegram bot on Fly dev; PFTasks Discord redirect in dev env; route auth policy not centrally enforced; email not configured on Fly dev
- P2: stale smoke expectations (fixed); Settings link/sign-in copy could be clearer
Fixes included: Telegram authorize OAuth-state gate; smoke + fixture updates
Checks run: auth-login-state-fixture, security-smoke, Fly providers curl
Manual app evidence: Fly Telegram authorize page shows pftasknodebot widget
Residual risks: Fly secret/config drift; ephemeral vs durable runtime store
Merge recommendation: merge code fixes; block full sign-off until Fly Telegram/Discord secrets are Task Node–scoped
```

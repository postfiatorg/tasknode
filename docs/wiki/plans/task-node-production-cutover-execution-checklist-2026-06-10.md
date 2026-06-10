# Task Node Production Cutover Execution Checklist - 2026-06-10

Status: executing step by step; Step 1 through Step 5 complete; Step 6 partially complete

Production target: `https://tasknode.postfiat.org`

Promoted app: `tasknodeofficial-dev`

Legacy fallback URL: `https://pftasks-frontend.fly.dev`

## Step 1 - Stop Old PFTasks Task-Side Authority

Status: complete

Goal: old PFTasks must stop acting as a task, reward, airdrop, bot, routing, NFT, or product-write authority before the production hostname moves.

Checklist:

- [x] Capture pre-shutdown PFTasks worker state.
- [x] Stop the running `pftasks-worker` machine.
- [x] Set every `pftasks-worker` machine restart policy to `no`.
- [x] Disable machine autostart for `pftasks-worker`.
- [x] Remove or disable transaction-capable worker secrets, or verify stopped machines cannot auto-restart with those secrets.
- [x] Verify `pftasks-worker` has no started machines.
- [x] Verify old PFTasks frontend remains reachable at `https://pftasks-frontend.fly.dev`.
- [x] Verify old PFTasks API health remains reachable for fallback support.

Do not change `pftasks-frontend` or `pftasks-api` in this step. The allowed 48-hour legacy fallback is seed backup/recovery, historical review, and direct wallet sends only.

Evidence captured 2026-06-10:

- Pre-shutdown logs showed the running worker was still enqueueing `healthboard_snapshot_job_enqueued` and `activity_channel_job_enqueued` events through `2026-06-10T15:33:07Z`.
- `fly machine update 68365e1c463918 -a pftasks-worker --restart no --autostart=false --skip-start -y` succeeded.
- `fly machine update 68365e3b4e7668 -a pftasks-worker --restart no --autostart=false --skip-start -y` succeeded.
- `fly machine stop 68365e1c463918 -a pftasks-worker --wait-timeout 120s` succeeded.
- `fly machine update 68365e3b4e7668 -a pftasks-worker --restart no --autostart=false --standby-for "" --skip-start -y` removed the standby relationship.
- `fly status -a pftasks-worker` showed both machines stopped:
  - `68365e1c463918` stopped, last updated `2026-06-10T15:33:19Z`.
  - `68365e3b4e7668` stopped, last updated `2026-06-10T15:42:28Z`.
- `fly machine status <id> -a pftasks-worker --display-config` showed both worker machines have `restart.policy=no`, no services, no schedule, and no standby relationship.
- A 35-second post-stop wait showed no new worker enqueue logs after the stop sequence.
- `https://pftasks-frontend.fly.dev/` returned HTTP 200 HTML.
- `https://pftasks-api.fly.dev/health` returned HTTP 200 JSON health.

## Step 2 - Flip Task Node Official Production Environment

Status: deployed

Checklist:

- [x] Stage `TASKNODE_PUBLIC_URL=https://tasknode.postfiat.org`.
- [x] Stage `VITE_SITE_ORIGIN=https://tasknode.postfiat.org`.
- [x] Stage `TELEGRAM_AUTH_WIDGET_DOMAIN=tasknode.postfiat.org`.
- [x] Stage `DISCORD_REDIRECT_URI=https://tasknode.postfiat.org/api/auth/discord/callback`.
- [x] Stage `X_REDIRECT_URI=https://tasknodeofficial-dev.fly.dev/api/auth/callback/x`.
- [x] Stage `GITHUB_REDIRECT_URI=https://tasknodeofficial-dev.fly.dev/api/auth/callback/github`.
- [x] Set `TASKNODE_LEGACY_REDIRECT_HOSTS=tasknodeofficial-dev.fly.dev`.
- [x] Verify explicit `TASKNODE_REWARD_SEED` and `TASKNODE_DAILY_AIRDROP_SEED` exist on `tasknodeofficial-dev`.

Evidence captured 2026-06-10:

- `fly.toml` `[env]` now carries production host values for `TASKNODE_PUBLIC_URL`, `VITE_SITE_ORIGIN`, `TELEGRAM_AUTH_WIDGET_DOMAIN`, `DISCORD_REDIRECT_URI`, and `X_REDIRECT_URI`.
- Discord uses the already-registered legacy callback alias `https://tasknode.postfiat.org/api/auth/discord/callback` for cutover because the Discord dashboard returned `Service resource is being rate limited` during an attempted canonical callback edit. The deployed app handles both the legacy alias and the canonical `/api/auth/callback/discord` route.
- X uses the already-working dev-host callback `https://tasknodeofficial-dev.fly.dev/api/auth/callback/x` for cutover because the X developer portal failed to load during the dashboard update attempt. `TASKNODE_LEGACY_REDIRECT_HOSTS=tasknodeofficial-dev.fly.dev` makes the old hostname 301 the GET callback into `https://tasknode.postfiat.org/api/auth/callback/x` after production deploy.
- GitHub uses the already-working dev-host callback `https://tasknodeofficial-dev.fly.dev/api/auth/callback/github` for cutover. `startGithubAuth()` now honors `GITHUB_REDIRECT_URI`, so the existing OAuth app can be reused while the old hostname redirects GET callbacks into `https://tasknode.postfiat.org/api/auth/callback/github` after production deploy.
- `productionOriginIssues()` allows provider redirect URIs on either the public host or an explicitly configured legacy redirect host, so this bridge is guarded instead of silent.
- `fly.toml` also flips `VITE_BUILD_ID=prod`, `VITE_DEBUG_MODE=false`, and `VITE_ANALYTICS_DEBUG=false`.
- `fly secrets set -a tasknodeofficial-dev --stage ...` staged 13 production values without restarting deployed machines.
- `fly secrets list -a tasknodeofficial-dev` shows staged production values for `TASKNODE_PUBLIC_URL`, `VITE_SITE_ORIGIN`, `TELEGRAM_AUTH_WIDGET_DOMAIN`, `DISCORD_REDIRECT_URI`, `X_REDIRECT_URI`, `GITHUB_REDIRECT_URI`, `FRONTEND_BASE_URL`, `VITE_API_BASE_URL`, `CORS_ORIGIN`, `OPENROUTER_REFERER`, `VITE_BUILD_ID`, `VITE_DEBUG_MODE`, and `VITE_ANALYTICS_DEBUG`.
- `fly secrets list -a tasknodeofficial-dev` shows explicit `TASKNODE_REWARD_SEED` and `TASKNODE_DAILY_AIRDROP_SEED` are deployed.
- `npm run production-guards-smoke` passed.
- `TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes node scripts/fly-deploy-preflight.mjs` passed against the production-host `fly.toml`.

`TASKNODE_LEGACY_REDIRECT_HOSTS` was staged until cert/DNS cutover and then deployed with the production config. GET navigation on `tasknodeofficial-dev.fly.dev` now redirects to `https://tasknode.postfiat.org/`; `/health` remains exempt.

## Step 3 - Update External Provider Dashboards And Auth Preflight

Status: auth preflight complete; Telegram bot webhook deferred until hostname move

Checklist:

- [x] Telegram BotFather Login Widget domain is `tasknode.postfiat.org`.
- [x] Telegram bot webhook URL points at `https://tasknode.postfiat.org/api/integrations/telegram/webhook`, if bot chat is enabled.
- [x] Discord OAuth callback includes `https://tasknode.postfiat.org/api/auth/discord/callback`.
- [x] X OAuth callback remains covered by the existing `https://tasknodeofficial-dev.fly.dev/api/auth/callback/x` provider registration plus the staged legacy-host redirect bridge.
- [x] GitHub OAuth callback remains covered by the existing `https://tasknodeofficial-dev.fly.dev/api/auth/callback/github` provider registration plus the staged legacy-host redirect bridge.
- [x] Run pre-DNS auth route preflight under the staged cutover env.

Evidence captured 2026-06-10:

- Operator confirmed the Telegram BotFather `/setdomain` value was updated to `tasknode.postfiat.org`.
- Operator confirmed the Discord OAuth app already contains `https://tasknode.postfiat.org/api/auth/discord/callback`; attempting to add the canonical callback was blocked by Discord rate limiting.
- `curl` against the deployed app showed both `/api/auth/discord/callback` and `/api/auth/callback/discord` reach the Discord callback handler.
- Live `https://tasknodeofficial-dev.fly.dev/api/auth/start/x` emits `https://tasknodeofficial-dev.fly.dev/api/auth/callback/x`, proving the current X provider registration supports the dev-host callback that users already use to sign in.
- Operator reported the X developer portal failed with `Hmm...That's weird. This page didn't load correctly. Try reloading it using your browser's refresh button.`, so the cutover uses the existing dev-host callback and staged legacy redirect bridge instead of requiring an X dashboard edit before launch.
- Live `https://tasknodeofficial-dev.fly.dev/api/auth/start/github` emits `https://tasknodeofficial-dev.fly.dev/api/auth/callback/github`, proving the existing GitHub OAuth app supports the dev-host callback that users already use to sign in.
- `startGithubAuth()` was updated to use `GITHUB_REDIRECT_URI`, matching the staged cutover secret and the existing GitHub OAuth callback.
- A disposable local server on port `5180` was run with the staged cutover auth env, `Host: tasknode.postfiat.org`, no database, no workers, and an explicit throwaway runtime store. `/api/auth/providers` reported Telegram, Discord, X, GitHub, and email as configured/enabled/ready.
- Under the same staged env, `/api/auth/start/discord` emitted `https://tasknode.postfiat.org/api/auth/discord/callback`, `/api/auth/start/x` emitted `https://tasknodeofficial-dev.fly.dev/api/auth/callback/x`, `/api/auth/start/github` emitted `https://tasknodeofficial-dev.fly.dev/api/auth/callback/github`, and `/api/auth/start/telegram` emitted `https://tasknode.postfiat.org/api/auth/callback/telegram?...`.
- The staged Telegram authorize page returned HTTP 200 and contained `data-telegram-login="TaskNodeAuthBot"` with `data-auth-url="https://tasknode.postfiat.org/api/auth/callback/telegram?...`.
- Legacy-host GET callback checks returned 301 redirects preserving query strings:
  - `https://tasknodeofficial-dev.fly.dev/api/auth/callback/x?state=state-id&code=code-id` -> `https://tasknode.postfiat.org/api/auth/callback/x?state=state-id&code=code-id`.
  - `https://tasknodeofficial-dev.fly.dev/api/auth/callback/github?state=state-id&code=code-id` -> `https://tasknode.postfiat.org/api/auth/callback/github?state=state-id&code=code-id`.
- Legacy-host `/health` returned HTTP 200 without redirect.
- The disposable runtime store `/home/pfrpc/tasknode-auth-cutover-store.json` was removed after the preflight.
- Operator tested multiple login flows in browser and reported they looked good before cert/DNS cutover.
- Telegram bot webhook was registered from inside the Fly app with the configured secret token. Telegram `getWebhookInfo` returned `url=https://tasknode.postfiat.org/api/integrations/telegram/webhook`, `pending_update_count=0`, `last_error_date=0`, and allowed updates `message,callback_query`.

## Step 4 - Move Fly Certificate And DNS

Status: complete

Checklist:

- [x] Remove `tasknode.postfiat.org` certificate from `pftasks-frontend`.
- [x] Add `tasknode.postfiat.org` certificate to `tasknodeofficial-dev`.
- [x] Update Google Cloud DNS `tasknode.postfiat.org` A record to `66.241.125.168`.
- [x] Update Google Cloud DNS `tasknode.postfiat.org` AAAA record to `2a09:8280:1::116:6b5c:0`.
- [x] Verify `fly certs show tasknode.postfiat.org -a tasknodeofficial-dev` is issued/active.

Evidence captured 2026-06-10:

- Operator updated DNS `tasknode` A and AAAA records.
- Authoritative Google nameservers returned `A 66.241.125.168` and `AAAA 2a09:8280:1::116:6b5c:0`.
- Public resolvers `8.8.8.8`, `1.1.1.1`, and `9.9.9.9` returned the new A/AAAA records.
- Local resolver still returned the old PFTasks records immediately after cutover, consistent with cached 4-hour TTL.
- `fly certs remove tasknode.postfiat.org -a pftasks-frontend -y` succeeded.
- `fly certs add tasknode.postfiat.org -a tasknodeofficial-dev` succeeded and requested the A/AAAA setup already applied; no new `_acme-challenge.tasknode` record was required.
- `fly certs show tasknode.postfiat.org -a tasknodeofficial-dev` reported `Status=Issued` and `Certificate is verified and active`.
- `fly certs list -a pftasks-frontend` no longer lists `tasknode.postfiat.org`.

## Step 5 - Deploy Task Node Official Production Config

Status: complete

Checklist:

- [x] Run `npm run production-guards-smoke`.
- [x] Run `npm run build`.
- [x] Deploy with `npm run fly:deploy:prod`.
- [x] Verify `fly status -a tasknodeofficial-dev` shows healthy `app`, `worker`, and `board-manager` process groups.

Evidence captured 2026-06-10:

- `npm run production-guards-smoke` passed before deploy.
- `npm run build` passed before deploy.
- `npm run fly:deploy:prod` passed. Preflight confirmed production deploy to `tasknode.postfiat.org`; Fly deployed image `tasknodeofficial-dev:deployment-01KTS80S961XY3ABD4WSR109TZ`.
- `npm run fly:background-guard` passed after deploy.
- `fly status -a tasknodeofficial-dev` showed app machine `8e3d4ea713dd68` started with passing check, worker machine `18546e2a2d4ed8` started, and board-manager machine `1850d37c3462d8` started.
- `fly secrets list -a tasknodeofficial-dev` showed `TASKNODE_PUBLIC_URL`, `VITE_SITE_ORIGIN`, `TASKNODE_LEGACY_REDIRECT_HOSTS`, `DISCORD_REDIRECT_URI`, `X_REDIRECT_URI`, `GITHUB_REDIRECT_URI`, and `TELEGRAM_AUTH_WIDGET_DOMAIN` as deployed.

## Step 6 - Verify Production Route

Status: partially complete

Checklist:

- [x] `https://tasknode.postfiat.org/health` returns Task Node Official JSON.
- [x] `https://tasknode.postfiat.org/api/auth/providers` shows configured providers ready.
- [x] `https://tasknode.postfiat.org/api/system/status` has no critical checks.
- [x] `https://tasknodeofficial-dev.fly.dev/health` remains JSON health.
- [x] GET navigation on `https://tasknodeofficial-dev.fly.dev/` redirects to `https://tasknode.postfiat.org/`.
- [ ] Confirm profile, wallet, tasks, Hive, context, Help, reward review, and daily airdrop pages load for a signed-in account.

Evidence captured 2026-06-10:

- `https://tasknode.postfiat.org/health`, resolved to the new Fly IP, returned `{"ok":true,"service":"tasknodeofficial","environment":"production","buildId":"prod"}`.
- `https://tasknode.postfiat.org/runtime-config.json`, resolved to the new Fly IP, returned `siteOrigin=https://tasknode.postfiat.org` and `buildId=prod`.
- `https://tasknode.postfiat.org/api/auth/providers`, resolved to the new Fly IP, showed Telegram, Discord, X, GitHub, and Email ready.
- `https://tasknode.postfiat.org/api/system/status`, resolved to the new Fly IP, returned summary `critical=0`.
- `https://tasknodeofficial-dev.fly.dev/` returned HTTP 301 to `https://tasknode.postfiat.org/`.
- `https://tasknodeofficial-dev.fly.dev/health` returned HTTP 200 JSON health.

## Step 7 - Update Post Fiat Task Node Page

Status: pending

Checklist:

- [ ] Update `postfiatorg.github.io/content/task-node.md` primary CTA to `https://tasknode.postfiat.org/`.
- [ ] Keep docs/community links secondary.
- [ ] Build and deploy `postfiat.org`.
- [ ] Verify `https://postfiat.org/task-node/` sends users to Task Node Official, not old docs or old PFTasks.

## Step 8 - Post-Cutover Monitoring

Status: pending

Checklist:

- [ ] Watch Task Node Official logs for auth/callback/domain errors.
- [ ] Watch Task Node Official worker and board-manager liveness.
- [ ] Scan old PFTasks source wallets for post-cutoff product writes.
- [ ] Check old PFTasks worker machines remain stopped.
- [ ] Check old PFTasks queues/logs show no new task/reward/airdrop/NFT/bot product-write jobs.
- [ ] Re-check old fallback URL remains usable only for approved exception flows.

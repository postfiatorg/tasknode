# PFTasks Transaction Shutdown Cutover Plan - 2026-06-09

This plan is the production cutover gate for turning the old PFTasks app into a
non-transactional legacy system before Task Node Official becomes the live
production surface.

The account-level migration runbook remains [PFTasks Cutover](#docs/pftasks-cutover).
This plan is broader: it shuts down old PFTasks task-side writers, workers, bots,
and economic automation across the legacy app.

## Objective

Move production economic and task authority to Task Node Official while keeping
only two old PFTasks capabilities alive:

- explicit wallet sends;
- seed backup, export, and custody recovery.

Everything else in old PFTasks that can create, sign, publish, reward, airdrop,
mint, submit, accept, refuse, verify, replay, or route task-side product state
must be disabled before production traffic is cut over.

## Scope Rules

`wallet sends` means an explicit user or operator transfer from a wallet send
surface or command. It does not include task rewards, airdrops, offers,
verification payouts, NFT mints, task publishing, or automated settlement.

`seed backups` means read-only backup, export, custody verification, and recovery
support. It must not create new task, profile, reward, airdrop, NFT, chat, or
context protocol state.

`read-only` means the old PFTasks app may show historical state and support
exports. It must not enqueue workers or submit product transactions.

## Routing Decision

The production domain `https://tasknode.postfiat.org` moves to Task Node
Official at cutover.

The old PFTasks frontend remains reachable for 48 hours only through its Fly URL:

```text
https://pftasks-frontend.fly.dev
```

That 48-hour legacy URL is for seed backup, seed recovery, historical review, and
direct wallet sends only. It is not a task system after cutover.

Before DNS moves, login and seed backup must be tested directly on
`https://pftasks-frontend.fly.dev`. The old PFTasks production frontend config
historically used `VITE_SITE_ORIGIN=https://tasknode.postfiat.org`, so do not
assume the Fly URL is a working fallback until the old app can log in, reach the
API through its frontend proxy, and complete seed backup from that exact origin.

Task Node Official must be configured for the production hostname before DNS
cutover:

```text
TASKNODE_PUBLIC_URL=https://tasknode.postfiat.org
VITE_SITE_ORIGIN=https://tasknode.postfiat.org
TELEGRAM_AUTH_WIDGET_DOMAIN=tasknode.postfiat.org
DISCORD_REDIRECT_URI=https://tasknode.postfiat.org/api/auth/callback/discord
X_REDIRECT_URI=https://tasknode.postfiat.org/api/auth/callback/x
```

Also update external provider dashboards before opening the route:

- BotFather `/setdomain` for the Telegram Login Widget;
- Telegram bot webhook URL, if Telegram chat is enabled;
- Discord OAuth callback URL;
- X OAuth callback URL;
- GitHub OAuth callback URL, if GitHub login remains enabled.

## Shutdown Matrix

| Old PFTasks surface | Transaction risk | Target state | Disable method | Verification |
| --- | --- | --- | --- | --- |
| Task request, offer, and generation workers | High | Off | Stop process, disable scheduler, remove task publisher seed from runtime | No new task offer or task request pointers after cutoff |
| Task accept, refuse, submit, verification endpoints | High | Read-only or blocked | Return maintenance/read-only response except historical reads | User cannot mutate old PFTasks task lifecycle |
| Task review and reward workers | Critical | Off | Stop process, disable cron, remove reward authority seed from runtime | No new reward payout transactions after cutoff |
| Daily airdrop scoring and issuance | Critical | Off | Stop worker and scheduler, disable airdrop command path except dry-run exports | No old PFTasks airdrop transactions after cutoff |
| Profile NFT generation, pinning, and minting | High | Off for legacy product writes | Stop generation queue and mint/signing path; keep historical NFT reads/imports | No new old PFTasks NFT mint or metadata write |
| Context, chat, and memory publishing to PFTL/IPFS | Medium to high | Read-only unless needed for seed backup support | Disable publisher jobs, bots, and write endpoints | No new old PFTasks context/chat pointer writes |
| Deathmarch, replay, reducer, and catch-up jobs that can emit writes | High | Read-only replay only | Stop write-capable jobs; allow read-only audit scans | Replay cannot submit product transactions |
| Discord, Telegram, and external bots | High | Off or read-only | Stop webhooks/bots that can create tasks, accept work, reward, or write context | Bot commands cannot mutate old PFTasks state |
| Wallet sends | Allowed exception | On with audit | Keep only direct wallet transfer path with explicit operator/user action | Direct send works and is logged |
| Seed backup/export/recovery | Allowed exception | On with audit | Keep read-only seed backup and recovery tooling | Seed backup can be retrieved without product writes |
| Database backups and historical exports | Allowed exception | On | Keep backups, read replicas, and export scripts | Historical rows remain inspectable |
| IPFS exact-CID recovery for historical assets | Limited infra exception | On only for preservation | Allow exact-CID recovery/repin without creating new product records | Existing historical CIDs remain retrievable |

## Preflight Inventory

Run this inventory before disabling anything. Store the output in the cutover
evidence folder or incident channel.

1. List every old PFTasks runtime host, Fly app, Docker container, cron entry,
   systemd unit, tmux/screen session, PM2 process, supervisor process, and
   manually running shell job.
2. List every old PFTasks environment variable or secret that can reach PFTL,
   IPFS, Discord, Telegram, OpenAI, wallet seeds, task authority keys, reward
   authority keys, airdrop funding wallets, and NFT minting keys.
3. Search the old PFTasks codebase for transaction verbs and queue producers:
   `submit`, `send`, `sign`, `reward`, `airdrop`, `offer`, `accept`, `refuse`,
   `verify`, `mint`, `pin`, `publish`, `context`, `task`, `tx`, `wallet`.
4. Export the current in-flight old PFTasks state: open tasks, proposed tasks,
   pending submissions, verification requests, reward jobs, airdrop jobs, NFT
   generation jobs, bot jobs, and wallet sync targets.
5. Record old PFTasks source wallets that have ever funded task rewards,
   airdrops, task authority messages, NFT mints, or wallet sends.
6. Confirm the old PFTasks 48-hour fallback URL works at
   `https://pftasks-frontend.fly.dev` for login, seed backup/recovery, historical
   reads, and direct wallet sends.
7. Confirm Task Node Official is healthy on the target production route:
   profile, wallet, tasks, Hive, daily airdrop, task generation, reward review,
   worker process group, board-manager process group, and `/api/system/status`.

## Cutover Sequence

### T-24h: Freeze Legacy Task Creation

- Disable old PFTasks UI affordances that request, create, accept, refuse,
  submit, verify, or reward tasks.
- Stop old PFTasks automated routing and task generation.
- Announce that old PFTasks is entering read-only cutover mode.
- Announce `https://pftasks-frontend.fly.dev` as the 48-hour old PFTasks fallback
  URL for seed backup/recovery and direct wallet sends only.
- Export open old PFTasks work and decide whether each item is settled, cancelled,
  manually migrated, or left historical.

### T-2h: Stop Legacy Workers

- Stop old PFTasks task generation workers.
- Stop old PFTasks task review and reward workers.
- Stop old PFTasks daily airdrop workers.
- Stop old PFTasks NFT generation and minting workers.
- Stop old PFTasks bots and webhook consumers that can mutate task/product state.
- Stop old PFTasks deathmarch/replay jobs unless they are proven read-only.
- Disable cron, scheduler, and process manager restart policies so workers do not
  come back after a host restart.

### T-1h: Remove Transaction Authority From Runtime

- Remove or rotate old PFTasks task authority, reward authority, airdrop, NFT
  minting, and bot signing secrets from live runtime environments.
- Keep encrypted seed backups available outside the running app.
- Keep only the explicit wallet-send key path needed for direct sends.
- Confirm the seed backup/export path is read-only and does not enqueue any
  product work.

### T-0: Route Production To Task Node Official

- Point `https://tasknode.postfiat.org` to Task Node Official.
- Ensure the old PFTasks custom-domain certificate and DNS no longer own
  `tasknode.postfiat.org`; keep only `https://pftasks-frontend.fly.dev` for the
  48-hour fallback window.
- Set Task Node Official production URL, site origin, OAuth callback, Telegram
  widget, and Telegram webhook configuration for `tasknode.postfiat.org`.
- Confirm `app`, `worker`, and `board-manager` process groups are running.
- Confirm profile, wallet, task, Hive, Help, login, Telegram, Discord, X, and
  GitHub provider flows load from the production route.
- Confirm new task requests and rewards are handled only by Task Node Official.

### T+1h: Watch For Stray Legacy Transactions

- Scan old PFTasks source wallets and old task authority wallets for new PFTL
  transactions after the cutoff timestamp.
- Check old PFTasks logs for blocked write attempts.
- Check old PFTasks queues for new rows created after the cutoff timestamp.
- Check Task Node Official system status and task/reward flow health.

### T+24h: Preserve Read-Only Legacy State

- Keep the old PFTasks database, backups, and historical export paths available.
- Keep seed backup and direct wallet-send exceptions available with audit logs.
- Keep old IPFS gateways only as historical fallback where exact-CID recovery
  still requires them.
- Leave old task-side workers disabled unless there is an explicit rollback
  approval.

### T+48h: Close Public Legacy Login Window

- Disable public login to the old PFTasks frontend unless leadership explicitly
  extends the backup window.
- Keep old PFTasks database backups and operator-only seed recovery available
  according to the custody retention policy.
- Keep direct wallet sends available only through the approved post-window path:
  either operator-only or a deliberately retained legacy wallet-send surface.
- Keep `https://tasknode.postfiat.org` on Task Node Official.

## Verification Gates

Do not declare cutover complete until all gates are true:

- Old PFTasks cannot create a task request, task offer, task lifecycle update,
  verification request, reward payout, airdrop, NFT mint, or context/chat product
  pointer.
- Old PFTasks worker, scheduler, bot, and webhook processes that can write product
  state are stopped and cannot auto-restart.
- Old PFTasks transaction authority secrets are absent from live runtime
  environments, except the direct wallet-send exception.
- Old PFTasks seed backup and recovery paths still work without product writes.
- Old PFTasks direct wallet sends still work and are auditable.
- Old PFTasks queues have no new post-cutoff task, reward, airdrop, NFT, or bot
  product-write jobs.
- Old PFTasks source wallets have no new task/reward/airdrop/NFT product
  transactions after the cutoff timestamp.
- `https://pftasks-frontend.fly.dev` works for the 48-hour exception flows and
  does not route users into old task-side actions.
- `https://tasknode.postfiat.org` serves Task Node Official, not old PFTasks.
- Task Node Official production route handles profile, wallet, tasks, daily
  airdrop, Hive routing, reward review, Help docs, and configured login
  providers.

## Evidence Package

Capture this evidence in one dated cutover folder or ticket:

- pre-shutdown process list and post-shutdown process list;
- cron/systemd/PM2/tmux/screen/supervisor inventory before and after;
- old PFTasks environment and secret inventory, with sensitive values redacted;
- list of disabled workers, bots, webhooks, and schedulers;
- old PFTasks queue counts before cutoff and after cutoff;
- PFTL transaction scan for old PFTasks source wallets after cutoff;
- Task Node Official `/api/system/status` output after route cutover;
- DNS, Fly certificate, and OAuth callback evidence showing
  `tasknode.postfiat.org` points to Task Node Official;
- old PFTasks fallback evidence showing `https://pftasks-frontend.fly.dev`
  supports login and seed backup during the 48-hour window;
- screenshot or log proof that old PFTasks is read-only for task-side actions;
- proof that direct wallet send still works or remains operator-accessible;
- proof that seed backup/export remains available and read-only.

## Rollback Rule

Rollback should restore routing, not silently re-enable old PFTasks transaction
workers.

If Task Node Official production routing must be rolled back, keep old PFTasks in
read-only mode by default. Re-enable any old PFTasks task, reward, airdrop, NFT,
bot, or context writer only after explicit operator approval, idempotency review,
and source-wallet transaction scan. The exception paths, wallet sends and seed
backups, may stay on because they are already inside the cutover allowlist.

## Decisions Needed Before Execution

- Which old PFTasks hosts, Fly apps, and process managers are in scope.
- Which Task Node Official Fly app receives `tasknode.postfiat.org`: a promoted
  `tasknodeofficial-dev` app or a separate production app.
- Whether old PFTasks wallet sends remain user-facing or become operator-only.
- Whether the old PFTasks 48-hour fallback window is exactly 48 hours or has an
  emergency extension policy.
- How long seed backup and old database export windows remain available after
  public legacy login is closed.
- Which old PFTasks source wallets need post-cutoff transaction monitoring.
- Whether old PFTasks IPFS gateways remain available for historical fallback
  after exact-CID recovery is complete.

## Cutover Completion Statement

The cutover is complete when Task Node Official is the only live system creating
task-side economic state, while old PFTasks remains available only for direct
wallet sends, seed backup/recovery, historical reads, exports, and limited
historical asset preservation. For the first 48 hours, old PFTasks may be
user-accessible only at `https://pftasks-frontend.fly.dev`; the production domain
`https://tasknode.postfiat.org` must serve Task Node Official.

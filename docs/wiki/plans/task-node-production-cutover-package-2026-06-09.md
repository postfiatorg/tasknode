# Task Node Production Cutover Package - 2026-06-09

Status: draft execution package

Production target: Task Node Official at `https://tasknode.postfiat.org`.

Current staging source: `https://tasknodeofficial-dev.fly.dev`.

Deprecation target: old PFTasks as the production task system.

Legacy fallback window: keep old PFTasks reachable for 48 hours at
`https://pftasks-frontend.fly.dev` for seed backup/recovery, direct wallet sends,
and historical review only.

## Function Inventory

These are the user-facing PFTasks-era functions that must remain available after
cutover, either in Task Node Official or in the temporary legacy fallback.

| User-facing function | Post-cutover owner | Required availability after cutover |
| --- | --- | --- |
| Account login and account identity | Task Node Official | Users can sign in at `https://tasknode.postfiat.org`; configured provider callbacks point at the production domain. |
| Wallet link, restore, unlock, and proof | Task Node Official | Users can link or restore a PFT wallet, unlock the local vault, and prove wallet ownership from the new app. |
| Seed backup, export, and custody recovery | Old PFTasks fallback for 48 hours, then approved recovery path | Users can retrieve seed backups without enabling old task, reward, airdrop, NFT, or bot writers. |
| Direct wallet sends | Old PFTasks fallback or approved operator path | Explicit wallet sends remain possible and auditable; automated rewards, airdrops, and task settlement are not treated as wallet sends. |
| Wallet balance and transaction visibility | Task Node Official | Users can inspect current wallet balance and recent activity from the new app. |
| Task request and task generation | Task Node Official | New task requests, generated offers, and visible task cards are created only by Task Node Official. |
| Task accept, refuse, submit, verification, and review | Task Node Official | Users can act on current tasks only in Task Node Official; old PFTasks task lifecycle actions are blocked or read-only. |
| Reward status and reward history | Task Node Official | New rewards are issued and shown from Task Node Official; old reward rows remain historical evidence only. |
| Daily airdrop eligibility and issuance | Task Node Official | Any current airdrop scoring/issuance runs from Task Node Official, not old PFTasks workers. |
| Context document editing and publishing | Task Node Official | Users can edit current context in Task Node Official and explicitly publish current context pointers when supported. |
| Historical context reads and restore references | Task Node Official plus old PFTasks historical fallback | Existing encrypted CIDs and old context history remain inspectable/restorable when the wallet and vault allow it. |
| Profile page and public identity | Task Node Official | Profile settings, avatar/PFP state, public profile, and identity display are served by the new app. |
| Profile NFT gallery and historical minted NFTs | Task Node Official cache plus chain/IPFS | Existing NFTs stay wallet-owned on-chain; Task Node Official imports or reconstructs renderable cache rows without moving custody. |
| Chat/help/support surface | Task Node Official | Users get current Help and app support in the new product, not old PFTasks bots. |
| Historical reads, exports, and audit evidence | Old PFTasks read-only fallback/operator archive | Old rows remain inspectable for support, audit, and rollback analysis without allowing product writes. |

After cutover, old PFTasks must not remain available for task creation, task
acceptance, task submission, verification, reward payouts, airdrops, NFT mints,
context/chat product publishing, bot-triggered product writes, routing, replay,
or worker-driven settlement.

## Cutover Note

Task Node Official becomes the production system for Task Node at
`https://tasknode.postfiat.org`. The old PFTasks app is deprecated as a live task
system because it has overlapping task, reward, airdrop, NFT, bot, and worker
authority that can create conflicting economic state for the same users and
wallets.

The cutover keeps custody-safe user functions available while removing old
PFTasks from product-state authority. Users should use Task Node Official for
login, wallet linking, tasks, context, profile, Hive, rewards, and current
support. Old PFTasks remains reachable only through its Fly URL for 48 hours so
users can back up seeds, recover custody data, review history, and perform direct
wallet sends if needed.

The production domain moves to Task Node Official. Old PFTasks no longer owns
`tasknode.postfiat.org`, no longer routes new task-side work, and no longer runs
workers or bots that can publish product transactions. Historical PFTasks data is
preserved for audit and recovery; it is not imported as live new task state
unless a separate importer proves the old event stream maps safely into Task Node
Official projections.

The change is required to prevent double-routing, stale task state, duplicate
reward or airdrop authority, user confusion about which app is canonical, and
silent old-worker writes after launch.

## Migration Checklist

PFTasks task-side functionality can be turned off when every required gate below
has the stated condition satisfied.

| Gate | Owner | Remaining blocker | Turn-off condition |
| --- | --- | --- | --- |
| Production route | Ops | DNS/cert routing must move cleanly. | `https://tasknode.postfiat.org` serves Task Node Official, `/health` is ok, and old PFTasks no longer owns the production domain. |
| Task Node Official environment | App engineering/Ops | Production URL, site origin, OAuth callbacks, Telegram widget domain, and Telegram webhook must target the production domain. | Login/link flows and app navigation load from `tasknode.postfiat.org` without callback-domain mismatch. |
| Task Node Official process groups | App engineering/Ops | Production workers must be running before old workers are stopped. | Fly `app`, `worker`, and `board-manager` process groups are healthy on the production app. |
| Core new-app smoke | App engineering | Profile, wallet, tasks, Hive, context, Help, reward review, and daily airdrop paths need current evidence. | A signed-in user can load the core pages; task request/accept/submit/reward review ownership is Task Node Official only. |
| Legacy fallback URL | Legacy PFTasks ops | The old Fly URL must be tested directly, not assumed to work after domain removal. | `https://pftasks-frontend.fly.dev` supports login, seed backup/recovery, historical reads, and direct wallet sends from that origin. |
| Legacy write shutdown | Legacy PFTasks ops | Old task, reward, airdrop, NFT, bot, context/chat publisher, replay, and routing workers must be stopped and unable to auto-restart. | Process, cron, scheduler, webhook, queue, and restart-policy inventory shows no old writer can run. |
| Legacy transaction authority | Legacy PFTasks ops/Security | Old runtime must not retain task, reward, airdrop, NFT minting, bot, or product-publisher signing authority. | Live old PFTasks runtime secrets are removed/rotated except for the explicit direct-wallet-send path. |
| Open legacy work triage | Product/Ops | In-flight old PFTasks tasks and jobs need disposition. | Every open old PFTasks task/job is settled, cancelled, manually migrated, or marked historical before the cutoff timestamp. |
| Source-wallet monitoring | Protocol ops | Old source wallets could still write if a worker or manual script survives. | Post-cutoff scan shows no new old PFTasks task, reward, airdrop, NFT, or context/chat product transactions. |
| Queue and log monitoring | Legacy PFTasks ops | Old queues might accept writes after UI buttons are hidden. | Old PFTasks queues show no post-cutoff task/reward/airdrop/NFT/bot write jobs; logs show blocked write attempts only. |
| Historical NFT/IPFS preservation | Infra/Ops | Old minted NFT CIDs must stay retrievable. | Current gateways serve historical CIDs or a named old-gateway exception remains available for exact-CID recovery. |
| User communication | Product/Support | Users need one canonical URL and clear fallback rules. | Announcement is published and Help/support copy says Task Node Official is canonical while old PFTasks is backup-only. |
| T+48 public legacy close | Ops/Product | Public old-login fallback must not stay open indefinitely. | After 48 hours, public old PFTasks login is closed or explicitly extended; seed recovery remains only through the approved post-window path. |

### Production App Topology (resolved 2026-06-09)

`tasknode.postfiat.org` moves to the promoted `tasknodeofficial-dev` Fly app.
There is no separate production app and therefore no second Task Node writer
fleet: the reward-safety invariant stays one database, one signer set, one
writer fleet. The dev-twin writer shutdown concern is N/A by topology.

Promoted-app gates, in addition to the checklist above:

| Gate | Turn-off condition |
| --- | --- |
| Production env flip | `fly.toml` `[env]` carries the production values from the shutdown plan (public URL, site origin, Telegram widget domain, Discord/X redirects) and no longer says dev hostnames; deployed with `npm run fly:deploy:prod`. |
| Deploy confirmation | `npm run fly:deploy` refuses to deploy a production-hostname `fly.toml` without explicit confirmation (`fly:deploy:prod` or `TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes`). |
| Origin startup guard | App startup fails in production when `VITE_SITE_ORIGIN`, Discord/X redirect URIs, or the Telegram widget domain do not match the public origin host. Verified by deploying once with a deliberate mismatch in staging. |
| Explicit money seeds | `TASKNODE_REWARD_SEED` and `TASKNODE_DAILY_AIRDROP_SEED` are set as explicit secrets. In production the workers refuse to sign from fallback seeds (allocation/authority/service/faucet). |
| Legacy origin redirect | `TASKNODE_LEGACY_REDIRECT_HOSTS=tasknodeofficial-dev.fly.dev` is set so GET navigation on the old dev hostname 301-redirects to `tasknode.postfiat.org` (health checks and non-GET API calls are exempt). |
| Dev-origin vault note | The announcement tells beta users who onboarded on `tasknodeofficial-dev.fly.dev` that browser seed vaults are origin-local: restore or unlock the vault again on `tasknode.postfiat.org`. |

Exact PFTasks task-side turn-off condition:

PFTasks can be turned off as a live task system once Task Node Official serves
`https://tasknode.postfiat.org`, all old PFTasks product writers are stopped and
stripped of live signing authority, the two allowed exception flows are verified
on the old Fly URL, and post-cutoff queue plus wallet scans show no legacy
task-side product writes.

## User Announcement Draft

Task Node is moving to the new Task Node Official app at
`https://tasknode.postfiat.org`.

What changes:

- Use `https://tasknode.postfiat.org` for tasks, rewards, wallet linking,
  context, profile, Hive, and support.
- The old PFTasks app is being retired as a task system.
- For the first 48 hours, the old app remains available at
  `https://pftasks-frontend.fly.dev` only for seed backup/recovery, direct wallet
  sends, and historical review.
- Existing PFT and NFTs remain wallet-owned on-chain. The cutover does not move
  your coins, seed, or NFTs.
- If you used the beta at `tasknodeofficial-dev.fly.dev`, your browser seed
  vault is stored per-origin: unlock or restore your wallet once on
  `tasknode.postfiat.org` after the move. Your account, tasks, and balances are
  unchanged.
- New task requests, submissions, reviews, rewards, and airdrops should happen
  only in Task Node Official.

Expected impact:

Most users should log in at the production Task Node URL and continue there. If
you need to back up an old seed or inspect old PFTasks history, use the temporary
old Fly URL during the 48-hour window. If something does not appear in the new
app, do not submit duplicate work in the old app; contact support with your
username, wallet address, and the missing task or transaction detail.

## Related Runbooks

- [PFTasks Transaction Shutdown Cutover Plan](#docs/pftasks-transaction-shutdown-cutover-plan)
- [PFTasks Cutover](#docs/pftasks-cutover)
- [Task Node Production Scope](#docs/task-node-production-scope)

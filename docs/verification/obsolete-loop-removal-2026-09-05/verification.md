# Obsolete Task Node loop removal — September 5, 2026

Kimi K3 in Corbanu is the production task manager. This cleanup follows the
operator's explicit instruction to delete nonproduction loops and their code.

## Inventory and disposition

| Runtime | Disposition | Evidence |
| --- | --- | --- |
| GLM Hive Task Manager selector | Disabled on active Hive machine and standby; worker/provider/prompt/repository/CLI deleted | Previously enabled every 300 seconds in Fly; obsolete relative to Kimi mandate |
| Legacy automatic Board Manager | Worker, looping/model/Codex launchers, idle stub, ops CLI and scheduler deleted | No Fly process or local scheduled launcher; obsolete enable flags removed |
| Experimental project planner | Worker/prompt/writers and secretary enqueue removed | Explicitly retired for deterministic boards; no enabled production loop |
| Task accounting harvester | Disabled worker/provider/prompt/queue writers removed | Production enable flag was false; historical manual checkout/resolution retained |
| Reward-triggered legacy manager jobs | Enqueue removed | Otherwise rewarded tasks kept filling a queue with no supported consumer |
| Kimi K3 and its launch/whip/reset/transcript/proxy harness | Retained | Operator-host tmux/process model flags and three cron entries |
| Fly task generation/review and other declared service workers | Retained | Required production queues, publication, profile, wallet and context functions |
| Hive secretary/reports/narrator and advisory board secretary | Retained | Context reports, project memos and Kimi activity summaries |
| Deathmarch and its dedicated MPG proxy | Retained | Live operator-host production task-event Discord bridge; does not manage tasks |

The inventory covers canonical Task Node Fly processes, local Task Node
services, cron entries and Kimi sessions. Unrelated applications and developer
sessions were not removed. No database tables or historical audit rows were
purged. No Corbanu code or Kimi supervision configuration changed.

## Verification

Passed: retired-loop regression (old flags cannot restore deleted entry points),
worker liveness, runtime import/dependency boundaries, Kimi launch harness,
shared board contracts, cost history, secretary/project views, generation
intelligence, System Status, inference feature checks, and the inference regex
check. Lint, formatting, public Help allowlist and diff checks also passed.

Fresh isolated local Postgres database: reward projection/replay creates zero
legacy scheduler jobs while preserving reward totals; historical harvest
checkout/resolution; board source packets; all 14 shared board action fixtures.
The old action fixture requires `TASKNODE_DETERMINISTIC_BOARDS=false` to create
its temporary project. It first failed under the production default, which
correctly blocks model-driven project creation. Only that fixture environment
was changed; production deterministic boards remain enabled. This is shared
action/enqueue validation, not a new live task or payout test.

The runtime dependency check exposed a missing `@xmldom/xmldom` declaration
in the web manifest from the earlier inference work. Its manifest and lockfile
now match the web source closure. Worker dependencies are unchanged.

## Production verification

Deployed with `npm run fly:deploy:prod`: release **v703**, image
`deployment-01M1SB4E6XR221BY10Q8RCNJXR`, digest
`sha256:1e9345aca7241c2b217e10718e4181280fc0671de8fd6d0c9404925a64c66012`.
All 19 machines (10 active groups and nine cold standbys) use this release;
all active groups have `restart=always`. This includes the web app and NFT
renderer omitted by the aggregate background guard. `/health` returned
`ok=true`. See [release observation](release.json) and [machines](machines-after.json).

The active Hive image contains none of the sampled retired modules, and all
machines have zero retired configuration keys. Hive startup registers only
`hive_secretary`, `hive_reports`, and `bm_narrator`. Before/after read-only SQL
showed the selector count unchanged at 19,672, latest start
`2026-09-05T17:35:24.496Z`, with zero running attempts. Post-release observation:
`2026-09-05T17:53:37.961Z`. See [before](runtime-before.json) and [after](runtime-after.json).

Kimi's operator-host Corbanu process remained present with `model_provider=kimi-code`
and `kimi-k3`. Its proxy and scheduled supervision remain intact. Local API
container inspection confirmed role `web` with retired-loop flags false;
no local retired selector needed restarting. These are process/configuration
observations, not proof of Kimi completing a new task this turn.

System Status has 22 entries and no retired automatic manager/project-planner
worker rows. It still reports a stale task-review queue and recent secretary/task
generation failures. Those task-engine issues are separate audit follow-ups;
this release does not claim to repair the backlog or prove end-to-end task completion.
See [removed files](removed-files.json), [pre-release machines](machines-before.json),
and [operator runtime](operator-runtime.json). Historical audit statistics belong
to the old selector; they do not measure Kimi throughput.

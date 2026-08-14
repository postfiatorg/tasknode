# Repository bloat audit (report-only)

> **Historical audit — superseded for provider routing.** Provider statements below describe the 2026-07-14 repository baseline and release v561, not the current runtime. OpenRouter, direct DeepSeek, and general OpenAI inference were retired by the Ambient cutover on 2026-08-12. Preserve the rows as dated removal evidence; use [AI Providers](#docs/ai-providers) for current egress.

**Date:** 2026-07-14 (final reconciliation)
**Base:** integrated `origin/main` @ `58d3295ebeb7450efc44057d1c9c92d1aff9cdcb`
**Scope:** Documentation audit reconciled to integrated cuts, archive moves, and docs-authority changes. This commit changes this audit only.
**Method:** Full-repo `rg` (excluding `.git`, `node_modules`, `dist`), `package.json`/`fly.toml` gates, `npm run build` chunks, `npm ls`/`package-lock.json`, `git log -1 --format='%h %ci %s'` per path. Final reconciliation evidence: `/tmp/tasknode-bloat-decision-final-227.log`.
**Workstream A note:** Board Manager OpenAI/GPT-5.5-Pro fallback cut has landed. Secretary/Project migration is commit `05178c8` (OpenRouter/`z-ai/glm-5.2` defaults, explicit Fly pins, fail-closed Pro rejection); production activation was verified in release v561 (ID `2wL4Q5033yzLKTbj8Zk2OnXZD`) on worker-hive `d895202a20e418`.

## Verdict rules used

- **`safe`**: concrete in-repo reachability or dependency-declaration evidence with a cited command and outcome. No unresolved external or product/legal condition is part of the verdict.
- **`needs-verification`**: residual docs still name the path, ops/runbooks remain, quality wiring exists, plan docs point at the file, residual operator tooling remains, or product retention is unresolved.
- **`load-bearing`**: production process/flag on, or required by a live runtime/quality entrypath.
- **`CUT`**: path actually removed by a cited verified commit; target no longer present.

**Decision Agent scheduler gate:** the 2026-07-14 inventory found cron, systemd, tmux, screen, and `ps` clean; all eight started Fly machines had `TASKNODE_HIVE_DECISION_AGENT_ENABLED=false` and `TASKNODE_HIVE_DECISION_AGENT_ACTIVE=false`. The execution transcript is `/tmp/tasknode-decision-agent-scheduler-inventory.log`; `041daa5` is the resulting verified removal commit. No provider request was made for this audit.

## Summary counts (exact; one row = one inventory item below)

| Removal risk | Count |
| --- | ---: |
| safe | 0 |
| CUT | 10 |
| needs-verification | 19 |
| load-bearing | 20 |
| resolved | 20 |
| **Total** | **69** |

| Category | Count |
| --- | ---: |
| dead/unreachable modules | 5 |
| workers (disabled / no prod scheduler) | 11 |
| workers (live) | 10 |
| duplicated provider plumbing | 9 |
| superseded / unreferenced scripts | 13 |
| stale docs vs live behavior | 7 |
| unused direct dependency | 1 |
| oversized frontend chunks | 3 |
| fixture/test cruft | 5 |
| legacy PFTasks-era remnants | 5 |
| **Total** | **69** |

---

## Build advisory (>500 kB)

`npm run build` (vite 7.3.3) exit 0:

| Chunk | Size | Modules/features responsible |
| --- | ---: | --- |
| `dist/assets/DocsView-91B6RRhL.js` | **1,210.29 kB** (gzip 380.41) | `src/features/docs/DocsView.jsx` + `docs-content.js` statically `import …md?raw` for **102** wiki pages (~1.17 MB raw). Wiki graph fills the Docs lazy chunk. |
| `dist/assets/wallet-core-aho2j1VI.js` | **1,018.33 kB** (gzip 330.44) | `src/wallet-core.js` imports `xrpl`, `libsodium-wrappers`, `ripple-keypairs`, `@scure/bip39`. Dynamic `import("./wallet-core")` from shell/`main.jsx`. |
| `dist/assets/index-Be1y2MNu.js` | **499.72 kB** (gzip 149.12) | Near advisory: monolith `src/main.jsx` (~228 kB source) + eager Tasks/chat/billing/identity/shell + `styles.css`. Hive/Wallet/Docs/Memory/Profile/Directory already `lazy()`. |

```text
npm run build
wc -c dist/assets/wallet-core-*.js dist/assets/DocsView-*.js dist/assets/index-*.js
# 1018327 wallet-core… / 1210291 DocsView… / 499716 index…
```

---

## Candidate inventory

Schema: **Priority | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched commit/date | Removal risk | Proposed next check/cut**

### A. Dead / unreachable modules (5)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | `docs/archive/root-specs/jsx_mock.jsx` | dead/unreachable modules | `58d3295` moved the root mock to this exact historical path; active design inputs are `mocks/`; no live `src`/`server` importer. | archive/documentation only | `58d3295` 2026-07-14 | **resolved** | Archived; root path and quality exceptions removed |
| P1 | `docs/archive/root-specs/product_spec.md` | dead/unreachable modules | `58d3295` moved the root product brief to this exact historical path and rewrote authority links. | archive/documentation only | `58d3295` 2026-07-14 | **resolved** | Archived; no live tooling link |
| P1 | `docs/archive/root-specs/full_spec.md` | dead/unreachable modules | `58d3295` moved the former root specification to this exact historical path; docs/wiki is the current authority. | archive/documentation only | `58d3295` 2026-07-14 | **resolved** | Archived; no live tooling link |
| P1 | `docs/archive/root-specs/whip_context.md` | dead/unreachable modules | `58d3295` moved the root automation context to this exact historical path and rewrote the current-system pointer. | archive/documentation only | `58d3295` 2026-07-14 | **resolved** | Archived; no live tooling link |
| P1 | `docs/archive/root-specs/auth_account_spec.md` | dead/unreachable modules | `58d3295` moved the root auth/account specification to this exact historical path and rewrote linked indexes. | archive/documentation only | `58d3295` 2026-07-14 | **resolved** | Archived; no live tooling link |

### B. Workers — disabled / no production scheduler (11)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | scripts/board-manager-disabled.mjs | workers (disabled / no prod scheduler) | File is noop setInterval + board_manager_disabled log. package.json start:board-manager points here. fly.toml [processes] has no board-manager group. | npm start alias; no fly process | 6e2a173 2026-06-28 12:36:01 +0000 | **needs-verification** | Confirm no external invocation of alias; then drop |
| P0 | `server/hive-decision-agent-worker.js` | workers (disabled / no prod scheduler) | **CUT** by `041daa5` after the clean scheduler inventory: worker removed with its background-worker import/start path. | no execution carrier remains | `041daa5` 2026-07-14 | **CUT** | Historical DB/read models remain |
| P0 | `server/hive-decision-agent-provider.js` | workers (disabled / no prod scheduler) | **CUT** by `041daa5`: executable provider removed with the worker. | no execution carrier remains | `041daa5` 2026-07-14 | **CUT** | Historical prompt/read-model display remains |
| P0 | `scripts/hive-decision-agent-loop.mjs` | workers (disabled / no prod scheduler) | **CUT** by `041daa5` after the clean scheduler inventory. Dependent launcher, smoke, and action adapter were also removed; Fly pins and live Board Manager gating were removed. | no scheduler or launcher remains | `041daa5` 2026-07-14 | **CUT** | Historical DB/read models and prompt display remain |
| P0 | server/task-accounting-harvester-worker.js | workers (disabled / no prod scheduler) | fly.toml TASKNODE_TASK_ACCOUNTING_HARVESTER_ENABLED=false. Worker only starts when flag true. | hard false in fly | 50de0c2 2026-06-26 20:32:29 +0000 | **needs-verification** | Product roadmap keep/drop |
| P0 | server/task-accounting-harvester-provider.js | workers (disabled / no prod scheduler) | Provider for accounting harvester only. | harvester only | bf95f7d 2026-06-27 02:11:00 +0000 | **needs-verification** | Cut with harvester |
| P1 | scripts/board-manager-worker.mjs | workers (disabled / no prod scheduler) | TASKNODE_BOARD_MANAGER_ENABLED=false on fly; no process group; package board-manager:worker remains for manual --force with OpenRouter GLM-only provider validation. | manual ops only | 6e2a173 2026-06-28 12:36:01 +0000 | **resolved** | OpenAI/GPT-5.5-Pro normalization/help path removed; reject unsupported provider |
| P1 | scripts/board-manager-loop.mjs | workers (disabled / no prod scheduler) | package board-manager:loop; OpenRouter GLM-only manual loop; Board Manager Fly-disabled. | manual | 6e2a173 2026-06-28 12:36:01 +0000 | **resolved** | OpenAI/GPT-5.5-Pro normalization/help path removed; reject unsupported provider |
| P1 | scripts/board-manager-model-exec.mjs | workers (disabled / no prod scheduler) | package board-manager:model; manual executor for disabled BM stack with OpenRouter GLM-only provider validation. | manual | 6e2a173 2026-06-28 12:36:01 +0000 | **resolved** | OpenAI/GPT-5.5-Pro normalization/help path removed; reject unsupported provider |
| P1 | scripts/board-manager-codex-exec.mjs | workers (disabled / no prod scheduler) | package board-manager:codex; default model gpt-5.5; manual. | manual | 44d057c 2026-05-23 19:02:31 +0000 | **needs-verification** | same + Workstream A model defaults |
| P1 | server/board-manager-decision-provider.js | workers (disabled / no prod scheduler) | OpenRouter GLM-only decision provider; no Fly Board Manager process. | board-manager scripts path | 6e2a173 2026-06-28 12:36:01 +0000 | **resolved** | OpenAI/GPT-5.5-Pro branch removed; fail closed for unsupported provider |

### B2. Workers — live (10)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | server/hive-secretary-worker.js | workers (live) | Historical v560 worker-hive `d895202a20e418` selected the former OpenAI default. `05178c8` changed code/Fly pins to OpenRouter/`z-ai/glm-5.2`/`high` and rejects Pro variants; release v561 (ID `2wL4Q5033yzLKTbj8Zk2OnXZD`) verified that state on worker-hive `d895202a20e418`. | prod worker-hive role (load-bearing worker, not cut) | `05178c8`; v561 verified 2026-07-14 | **load-bearing** | KEEP verified worker |
| P0 | server/hive-project-worker.js | workers (live) | Historical v560 worker-hive `d895202a20e418` selected the former OpenAI default. `05178c8` changed code/Fly pins to OpenRouter/`z-ai/glm-5.2`/`high` and rejects Pro variants; release v561 (ID `2wL4Q5033yzLKTbj8Zk2OnXZD`) verified that state on worker-hive `d895202a20e418`. | prod worker-hive role | `05178c8`; v561 verified 2026-07-14 | **load-bearing** | KEEP verified worker |
| P0 | server/hive-board-secretary-worker.js | workers (live) | fly.toml process board-secretary = npm run start:board-secretary; TASKNODE_HIVE_BOARD_SECRETARY_ENABLED=true. Companion scripts/hive-board-secretary-worker.mjs. | prod process | 6e2a173 2026-06-28 12:36:01 +0000 | **load-bearing** | keep |
| P0 | server/task-generation-worker.js | workers (live) | fly TASKNODE_TASK_GENERATION_WORKER_ENABLED=true; process worker-taskgen. | prod | 64209dc 2026-07-14 16:41:15 +0000 | **load-bearing** | keep |
| P0 | server/network-task-generation-worker.js | workers (live) | fly network-taskgen flags true; worker-taskgen role. | prod | 0300725 2026-06-29 02:40:39 +0000 | **load-bearing** | keep |
| P0 | server/task-review-worker.js | workers (live) | fly TASKNODE_TASK_REVIEW_WORKER_ENABLED=true; process worker-task-review. | prod | c4222a4 2026-07-11 15:27:01 +0000 | **load-bearing** | keep |
| P0 | server/profile-daily-airdrop-worker.js | workers (live) | fly daily airdrop enabled; process worker-airdrop. | prod | df70b70 2026-06-11 14:15:47 +0000 | **load-bearing** | keep |
| P0 | server/pftl-cache-sync.js | workers (live) | fly PFTL cache/archive/reducer/watcher true; process worker-pftl (with related pftl workers). | prod | 649de99 2026-06-08 18:03:45 +0000 | **load-bearing** | keep |
| P0 | server/background-workers.js | workers (live) | Role router invoked by TASKNODE_PROCESS_ROLE worker:* entries. | prod entry | c4222a4 2026-07-11 15:27:01 +0000 | **load-bearing** | keep |
| P0 | fly.toml [processes] | workers (live) | Defines production process groups app, worker-*, board-secretary. | fly deploy | 64209dc 2026-07-14 16:41:15 +0000 | **load-bearing** | keep |

### C. Duplicated provider plumbing (9)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2 | server/chat-router.js | duplicated provider plumbing | Central OpenAI/OpenRouter/DeepSeek chat builders; simultaneously largest shared provider surface and source of duplication for worker-local providers. | live chat routes | 64209dc 2026-07-14 16:41:15 +0000 | **load-bearing** | Extract shared HTTP/usage helpers later; baseline retain |
| P2 | server/hive-board-secretary-provider.js | duplicated provider plumbing | Parallel env/timeout/request assembler pattern vs other *-provider.js modules. | board secretary worker | e316228 2026-06-28 12:57:48 +0000 | **load-bearing** | keep; consolidation candidate |
| P2 | server/hive-task-manager-provider.js | duplicated provider plumbing | Parallel provider pattern. | hive task manager | 0300725 2026-06-29 02:40:39 +0000 | **load-bearing** | keep |
| P2 | server/hive-report-provider.js | duplicated provider plumbing | Parallel provider pattern. | hive reports worker | c68a48d 2026-06-29 02:31:01 +0000 | **load-bearing** | keep |
| P2 | server/context-rewrite-provider.js | duplicated provider plumbing | Parallel provider pattern. | context-rewrite worker | 641bd00 2026-06-26 00:16:13 +0000 | **load-bearing** | keep |
| P2 | server/embedding-provider.js | duplicated provider plumbing | Embedding provider path for memory/search. | memory path | befb670 2026-05-19 19:45:34 +0000 | **load-bearing** | keep |
| P2 | server/board-manager-secretary-packets.js | duplicated provider plumbing | DeepSeek secretary-packet path still coexists with Hive board secretary (GLM) and Hive planning Secretary worker (now GLM via `05178c8`) — overlapping “secretary” product surfaces remain, without a live GPT-5.5-Pro secretary default. | BM source compression | 0dceeb7 2026-06-22 14:19:40 +0000 | **needs-verification** | Naming/table sunset plan |
| P3 | scripts/grashnuk-harvest-codex-exec.mjs | duplicated provider plumbing | Codex CLI family with board-manager-codex-exec / grashnuk-review; default model gpt-5.5; package-wired. | package script | 47efc89 2026-06-27 11:08:17 +0000 | **needs-verification** | Shared CLI helper + Workstream A models |
| P3 | scripts/grashnuk-review-codex-exec.mjs | duplicated provider plumbing | Sibling codex CLI; default gpt-5.5; package-wired. | package script | 4d9fddc 2026-06-27 12:58:41 +0000 | **needs-verification** | same |

### D. Superseded / unreferenced scripts (13)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P3 | scripts/chat-estimate-parity-smoke.mjs | superseded / unreferenced scripts | **CUT** in `Execute proven-safe repository bloat cuts`: pre-delete full-repo reachability re-proof still 0 matches; file deleted. | none in-repo | previously 3a6fe3d; cut by `Execute proven-safe repository bloat cuts` | **CUT** | done |
| P3 | scripts/task-payload-read-retry-smoke.mjs | superseded / unreferenced scripts | **CUT** in `Execute proven-safe repository bloat cuts`: pre-delete full-repo basename re-proof 0 matches; file deleted. | none in-repo | previously 1a067fb; cut by `Execute proven-safe repository bloat cuts` | **CUT** | done |
| P3 | scripts/profile-public-hero-nft-smoke.mjs | superseded / unreferenced scripts | **CUT** in `Execute proven-safe repository bloat cuts`: pre-delete full-repo basename re-proof 0 matches; file deleted. | none in-repo | previously 8210399; cut by `Execute proven-safe repository bloat cuts` | **CUT** | done |
| P3 | scripts/hive-project-canonical-repair.mjs | superseded / unreferenced scripts | **CUT** in `Execute proven-safe repository bloat cuts`: pre-delete full-repo basename re-proof 0 matches; file deleted. | none in-repo | previously dd4809b; cut by `Execute proven-safe repository bloat cuts` | **CUT** | done |
| P3 | scripts/ethereum-deposit-smoke.mjs | superseded / unreferenced scripts | Not quality npm list entry; dynamic import scripts/runtime-store-smoke.mjs:691; also cited in model matrix fixture table. | runtime-store-smoke + matrix | abb3b61 2026-06-27 11:33:40 +0000 | **needs-verification** | Keep while importer lives |
| P3 | scripts/task-event-expectation-smoke.mjs | superseded / unreferenced scripts | **CUT** in `Cut post-safe-sweep task event smoke`: post-cut full-repo `rg -n -F 'task-event-expectation-smoke' --glob '!.git/**' --glob '!node_modules/**' --glob '!dist/**' --glob '!docs/wiki/architecture/repository-bloat-audit.md' .` → 0 matches (rg exit 1); only former review_burndown citation was already deleted. File deleted. | none in-repo | previously 9cae143; cut by `Cut post-safe-sweep task event smoke` | **CUT** | done |
| P2 | scripts/distribution-v3-reward-dedup-audit.mjs | superseded / unreferenced scripts | Intentionally retained read-only manual runbook: self-documented local Docker audit; no package script, Fly process, or automatic caller. | Task/reward reconciliation operator role | ruling reconciled at `58d3295` | **resolved** | Revisit only on closure of the v3 reward ledger; code unchanged |
| P2 | scripts/task-determinism-board-state-audit.mjs | superseded / unreferenced scripts | Cited in model-default-inventory-upgrade-matrix.md fixture table. | matrix owner | dd4809b 2026-06-04 17:16:26 +0000 | **needs-verification** | Coordinate with Workstream A/matrix |
| P2 | scripts/query-user-tasks.mjs | superseded / unreferenced scripts | Documented fly ssh invocations: docs/wiki/surfaces/tasks.md, plans/task-page-hard-refresh-audit-2026-06-08.md, docs/wiki/architecture/pftasks-cutover.md. | operator runbooks | d1821c5 2026-06-04 21:03:14 +0000 | **needs-verification** | Keep while runbooks live |
| P2 | scripts/ipfs-replication-requeue.mjs | superseded / unreferenced scripts | Documented in docs/wiki/architecture/ipfs.md and ipfs-new-write-replication.md. | operator tool | 1a067fb 2026-06-15 13:04:46 +0000 | **needs-verification** | Keep; optional package script |
| P2 | scripts/orc-hive-followup.mjs | superseded / unreferenced scripts | Core tool with package smoke sibling + Python reference_clients/python/orc_tooling mirror. | smoke + python | 750928b 2026-06-20 00:40:55 -0500 | **needs-verification** | Do not cut without smoke/python review |
| P2 | scripts/orc-hive-signal.mjs | superseded / unreferenced scripts | Same pattern as orc-hive-followup (smoke + python). | smoke + python | ae4b851 2026-06-20 00:45:42 -0500 | **needs-verification** | same |
| P2 | scripts/orc-evidence-packet-generator.mjs | superseded / unreferenced scripts | Smoke + docs/verification evidence packets reference tool. | smoke + verification | fa1a9bf 2026-06-20 06:43:26 +0000 | **needs-verification** | same |

### E. Stale docs vs live behavior (7)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | docs/wiki/surfaces/hive.md | stale docs vs live behavior | **resolved** by `05178c8`: planning-worker narrative updated with the OpenRouter/GLM migration (paired matrix/ai-providers edits in that commit). Historical v560 GPT reachability remains documentary context only. | product surface wiki | e29fe11 prior; resolved `05178c8` 2026-07-14 | **resolved** | Keep current; further polish only if deploy post-checks need it |
| P1 | docs/wiki/architecture/ai-providers.md | stale docs vs live behavior | **resolved** by `05178c8`: Secretary/Project provider tables aligned to OpenRouter/`z-ai/glm-5.2` with fail-closed Pro stance. | architecture wiki | c4222a4 prior; resolved `05178c8` 2026-07-14 | **resolved** | Keep |
| P2 | docs/wiki/architecture/current-system.md | stale docs vs live behavior | `58d3295` removes root-spec tree/authority claims and points historical material to `docs/archive/root-specs/`. | wiki map | `58d3295` 2026-07-14 | **resolved** | docs/wiki is current authority |
| P2 | docs/README.md | stale docs vs live behavior | `58d3295` rewrites the index to list archive targets as historical reference and documents wiki-first authority. | docs index | `58d3295` 2026-07-14 | **resolved** | archive links verified |
| P2 | README.md | stale docs vs live behavior | `58d3295` replaces the primary-input claims with the current docs/wiki map and historical archive boundary. | root readme | `58d3295` 2026-07-14 | **resolved** | root onboarding map corrected |
| P2 | docs/review_burndown/ | stale docs vs live behavior | **CUT** in `Execute proven-safe repository bloat cuts`: pre-delete external-reference `rg` outside tree still 0 matches; directory removed. | previously disconnected | previously ca00dac; cut by `Execute proven-safe repository bloat cuts` | **CUT** | done |
| P3 | docs/wiki/architecture/model-default-inventory-upgrade-matrix.md | stale docs vs live behavior | Living model matrix owned by Workstream A/Ghash; this workstream must not edit it. Present on branch base 6229c14 line. | owning workstream | 6229c14 2026-07-14 17:12:49 +0000 Document deprecated Hive primitives in model matrix | **load-bearing** | Keep; no edit here |

### F. Unused direct dependency (1)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2 | package.json direct dependency `libsodium` | unused direct dependency | **CUT** in `Execute proven-safe repository bloat cuts`: removed root `dependencies.libsodium` only; retained `libsodium-wrappers`. After `npm ci`, `npm ls` shows wrappers@0.8.4 → transitive libsodium@0.8.4. Lockfile: single-line root deps removal; 0 package version churn. | was declaration-only | cut by `Execute proven-safe repository bloat cuts` | **CUT** | done |

### G. Oversized frontend chunks (3)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | src/features/docs/docs-content.js | oversized frontend chunks | Docs build chunk 1,210.29 kB; static ?raw import of 102 wiki pages (~1.17 MB). | Docs lazy route | 6d21614 2026-06-29 01:27:34 +0000 | **load-bearing** | Change load strategy, do not blind-delete wiki |
| P0 | src/wallet-core.js | oversized frontend chunks | wallet-core chunk 1,018.33 kB via xrpl + libsodium-wrappers + ripple-keypairs + @scure/bip39. | dynamic import from shell | ec809d1 2026-06-16 22:59:18 +0000 | **load-bearing** | Slim/split investigation |
| P1 | src/main.jsx | oversized frontend chunks | index chunk 499.72 kB; TasksView defined ≈L3643 inside main (not lazy); chat/tasks eager. | app shell | 6e2a173 2026-06-28 12:36:01 +0000 | **needs-verification** | Lazy Tasks route + UX regression check |

### H. Fixture / test cruft (5)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2 | mocks/ | fixture/test cruft | du ~988K, 21 files. Referenced by scripts/mock-boundary-check.mjs and format tooling; not production runtime import graph. | quality tooling | 00b86ac 2026-06-26 00:46:12 +0000 | **needs-verification** | Prune after mock-boundary remains green |
| P2 | docs/verification/ | fixture/test cruft | ~4.6 MB / 227 files; outside Vite import graph. | historical evidence store | 5972604 2026-07-14 15:41:02 +0000 | **needs-verification** | Relocation policy (lfs/object storage) |
| P2 | package.json `quality` script | fixture/test cruft | Chains 80+ smokes; wall-clock/CI weight. | CI / operator entry | c4222a4 2026-07-11 15:27:01 +0000 | **load-bearing** | Tier PR vs nightly; no silent delete |
| P3 | quality/file-size-limits.json (former `jsx_mock.jsx` exception) | fixture/test cruft | `58d3295` removes the exact `jsx_mock.jsx` exception after archive migration; remaining quality entries are unchanged. | quality gate | `58d3295` 2026-07-14 | **resolved** | exact exception absent |
| P3 | scripts/format-check.mjs (former `jsx_mock.jsx` ignore) | fixture/test cruft | `58d3295` removes the exact `jsx_mock.jsx` ignore; unrelated `login.jsx` handling remains. | format gate | `58d3295` 2026-07-14 | **resolved** | exact ignore absent |

### I. Legacy PFTasks-era remnants (5)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2 | scripts/import-pftasks-profile-nfts.mjs | legacy PFTasks-era remnants | Explicit PFTasks nft_mints → profile_nfts importer. package.json script profile-nft-import-pftasks. Documented in docs/wiki/surfaces/profile.md and user-observability-logging.md. | package script + wiki ops | 649de99 2026-06-08 18:03:45 +0000 | **needs-verification** | Keep until migration complete; then archive |
| P3 | docs/wiki/architecture/pftasks-cutover.md | legacy PFTasks-era remnants | Cutover doc still instructs live fly ssh + query-user-tasks usage; names old PFTasks migration paths. | cutover runbook | c3dbf3d 2026-06-11 16:31:09 +0000 Align docs with the deployed production app | **needs-verification** | Retire when migration closed |
| P3 | README.md historical-runtime wording | legacy PFTasks-era remnants | `58d3295` removes the stale root wording while retaining a bounded historical archive note. | docs wording | `58d3295` 2026-07-14 | **resolved** | no old runtime term in live documentation |
| P3 | prompts/task_engine/README.md | legacy PFTasks-era remnants | `58d3295` rewrites the historical prompt note; no executable prompt surface was removed. | docs/prompts historical | `58d3295` 2026-07-14 | **resolved** | wording-only correction |
| P3 | reference_clients/python/README.md | legacy PFTasks-era remnants | `58d3295` rewrites historical wording while preserving the load-bearing Python reference client and its scenario documentation. | docs only on wording; client is used | `58d3295` 2026-07-14 | **resolved** | client code retained |

---

## GPT-5.5 / GPT-5.5-Pro carriers

### Historical production gate (v560)
Snaga log `/tmp/tasknode-gpt55-prod-gate.log`: release **v560**, process **worker-hive** `d895202a20e418`, DB enabled, OpenAI key **presence** only, Secretary/Project enable+provider+model **unset** → source defaults then selected openai/`gpt-5.5-pro`. Gate proved **start/config reachability only** (no live queue job; no model call).

### Migration status (`05178c8`)
| Location | Current status | Action |
| --- | --- | --- |
| `server/hive-secretary-worker.js` | Code defaults + Fly pins OpenRouter/`z-ai/glm-5.2`; Pro variants **rejected** fail-closed | **KEEP worker**; deploy to activate pins |
| `server/hive-project-worker.js` | Same OpenRouter/`z-ai/glm-5.2` migration + Pro reject | **KEEP worker**; deploy to activate pins |
| `server/board-manager-decision-provider.js` OpenAI Pro fallback | Already DEAD/DISABLED in prod; surgical Pro path previously cut | not a live prod carrier |
| board-manager manual launchers (loop/worker/model/codex) | No Fly process; residual operator surfaces | verify-only |
| Historical pricing/display/test string literals (`system-status`, leftover fixtures as applicable) | Non-invocation readouts / fixtures | justified keep until billing/test-contract policy says otherwise |

Executable provider paths no longer default to or accept GPT-5.5-Pro for Secretary/Project. Release v561 verified worker-hive `d895202a20e418` on the OpenRouter/`z-ai/glm-5.2`/`high` configuration.

## Final reconciliation census (`58d3295`)

- **Archive targets:** `docs/archive/root-specs/{auth_account_spec.md,full_spec.md,jsx_mock.jsx,product_spec.md,whip_context.md}` all exist; their former root paths are absent.
- **Live tooling links:** `rg -n -F` for each former root basename across `src`, `server`, `scripts`, `package.json`, `fly.toml`, and `quality/file-size-limits.json` returns zero matches. Remaining mentions are explicit archive documentation or archived content.
- **Decision Agent:** `server/hive-decision-agent-worker.js`, `server/hive-decision-agent-provider.js`, `scripts/hive-decision-agent-loop.mjs`, its launcher, smoke, and action adapter are absent. `fly.toml` and `package.json` have no Decision Agent execution pin/script; only historical DB/read models and prompt display remain.
- **Reward dedup:** `scripts/distribution-v3-reward-dedup-audit.mjs` remains a self-documented, read-only local-Docker runbook with no package script, Fly process, or automatic caller. Its owner is the Task/reward reconciliation operator role; revisit only when the v3 reward ledger closes.

Commands and complete outputs: `/tmp/tasknode-bloat-decision-final-227.log`.

## Prioritized cut list

### Safe first

Verified removals:

1. `scripts/chat-estimate-parity-smoke.mjs` — **CUT**
2. `scripts/task-payload-read-retry-smoke.mjs` — **CUT**
3. `scripts/profile-public-hero-nft-smoke.mjs` — **CUT**
4. `scripts/hive-project-canonical-repair.mjs` — **CUT**
5. `docs/review_burndown/` — **CUT**
6. direct root `libsodium` dependency — **CUT** (`libsodium-wrappers` retained)
7. `scripts/task-event-expectation-smoke.mjs` — **CUT** (`Cut post-safe-sweep task event smoke`)
8. `server/hive-decision-agent-worker.js` — **CUT** (`041daa5`)
9. `server/hive-decision-agent-provider.js` — **CUT** (`041daa5`)
10. `scripts/hive-decision-agent-loop.mjs` plus its launcher/smoke/action adapter — **CUT** (`041daa5`)

### Resolved archive and operator rulings

1. The five root inputs moved to `docs/archive/root-specs/` in `58d3295`; docs/wiki is the current authority.
2. The former `jsx_mock.jsx` quality-limit exception and format ignore were removed in `58d3295`.
3. `scripts/distribution-v3-reward-dedup-audit.mjs` is intentionally retained as the Task/reward reconciliation operator's manual runbook until the v3 reward ledger closes.

### Verify before cut

1. Task Accounting Harvester pair (flag false; product roadmap decision).
2. Legacy Board Manager npm/ops surface and Codex defaults.
3. Remaining operator tools (`query-user-tasks`, `ipfs-replication-requeue`) and Orc cores with smoke/Python/verification callers.
4. Docs chunks / wallet-core load strategy; `src/main.jsx` split with UX regression coverage.
5. `mocks/`, `docs/verification/`, and remaining quality tiering.
6. PFTasks profile import and cutover runbook closure.
7. Extract shared provider HTTP client (not silent delete).

### Keep / load-bearing

All **load-bearing** rows in the inventory tables (live workers including **Hive Secretary/Project workers** verified in v561 on OpenRouter/`z-ai/glm-5.2`/`high`, live providers, wallet crypto, matrix ownership, quality chain).

---

## Reconciled conversion rulings

| Path | Was | Now | Why |
| --- | --- | --- | --- |
| Decision Agent execution carrier trio | needs-verification | **CUT** | Clean scheduler gate and verified removal commit `041daa5`; only historical DB/read-model and prompt display remain |
| `docs/review_burndown/` | safe (cond., unproven links) | **CUT** | Removed by `5dc7f0c` (`Execute proven-safe repository bloat cuts`) after external-reference re-proof |
| Root inputs and former JSX quality exceptions | needs-verification | **resolved** | Archived/reconciled by `58d3295` |
| Authority docs, root historical wording, prompt README, Python README | needs-verification | **resolved** | Rewritten by `58d3295`; current authority is docs/wiki and Python client code remains retained |
| `scripts/distribution-v3-reward-dedup-audit.mjs` | needs-verification | **resolved** | Intentionally retained manual runbook; revisit on v3 reward-ledger closure |
| `scripts/chat-estimate-parity-smoke.mjs` | safe via package-only | **CUT** | Removed by `5dc7f0c` (`Execute proven-safe repository bloat cuts`) after full-repo re-proof |
| direct `libsodium` | safe future `npm ls` | **CUT** | Removed by `5dc7f0c` (`Execute proven-safe repository bloat cuts`); `libsodium-wrappers` retains transitive `libsodium` |

---

## Unverified / incomplete items

- Bundle/runtime behavior beyond the cited focused build and machine checks.
- Bundle visualizer beyond Vite advisory output.
- Product policy for subsetting in-app wiki pages.


## Remaining needs-verification decisions (19)

| Inventory items | Open blocker / next authority |
| --- | --- |
| `scripts/board-manager-disabled.mjs` | External manual invocation of the disabled package alias; ops inventory required. |
| `server/task-accounting-harvester-worker.js`, `server/task-accounting-harvester-provider.js` | Product roadmap keep/drop decision. |
| `scripts/board-manager-codex-exec.mjs` | Manual operator surface and Workstream A model-default decision. |
| `server/board-manager-secretary-packets.js`, `scripts/grashnuk-harvest-codex-exec.mjs`, `scripts/grashnuk-review-codex-exec.mjs` | Secretary/CLI consolidation and model owner decision. |
| `scripts/ethereum-deposit-smoke.mjs`, `scripts/task-determinism-board-state-audit.mjs` | Retain while runtime importer and matrix fixture expectation exist; coordinate with their owners. |
| `scripts/query-user-tasks.mjs`, `scripts/ipfs-replication-requeue.mjs` | Operator runbooks remain live; ops owner must retire/rewrite them before cut. |
| `scripts/orc-hive-followup.mjs`, `scripts/orc-hive-signal.mjs`, `scripts/orc-evidence-packet-generator.mjs` | Smoke, Python, and verification callers require coordinated retirement. |
| `src/main.jsx` | Lazy-route design plus UX regression proof. |
| `mocks/`, `docs/verification/` | Quality/evidence retention and relocation policy. |
| `scripts/import-pftasks-profile-nfts.mjs`, `docs/wiki/architecture/pftasks-cutover.md` | Migration closure and operator-runbook retirement. |

## Artifact integrity

- Single documentation file in this commit: `docs/wiki/architecture/repository-bloat-audit.md`
- Final reconciliation evidence (not committed): `/tmp/tasknode-bloat-decision-final-227.log`
- Reconciled directly on integrated `main` after the cited cuts and archive move.

# Repository bloat audit (report-only)

**Date:** 2026-07-14 (amended)
**Branch / worktree:** `burzum/bloat-audit-125` @ `/tmp/tasknode-bloat-audit-125`
**Base:** `origin/main` @ `6229c14`
**Scope:** Documentation audit only. No code, config, dependency, or model-matrix deletions.
**Method:** Full-repo `rg` (excluding `.git`, `node_modules`, `dist`), `package.json`/`fly.toml` gates, `npm run build` chunks, `npm ls`/`package-lock.json`, `git log -1 --format='%h %ci %s'` per path. Bulk evidence: `/tmp/tasknode-bloat-audit-125.log`.
**Workstream A note:** Board Manager OpenAI/GPT-5.5-Pro fallback cut has landed. Secretary/Project **code** migration is commit `05178c8` (OpenRouter/`z-ai/glm-5.2` defaults, explicit Fly pins, fail-closed Pro rejection). Production runtime **activation** still pending the single combined deploy that ships those pins.

## Verdict rules used

- **`safe`**: concrete in-repo reachability or dependency-declaration evidence with a cited command and outcome. No unresolved external or product/legal condition is part of the verdict.
- **`needs-verification`**: residual docs still name the path, ops/runbooks remain, quality wiring exists, plan docs point at the file, residual operator tooling remains, or product retention is unresolved.
- **`load-bearing`**: production process/flag on, or required by a live runtime/quality entrypath.
- **`CUT`**: proven-safe path removed by subject `Execute proven-safe repository bloat cuts`; target no longer present.

External host schedulers and credentials outside this repository were not inspected.

## Summary counts (exact; one row = one inventory item below)

| Removal risk | Count |
| --- | ---: |
| safe | 0 |
| CUT | 7 |
| needs-verification | 36 |
| load-bearing | 20 |
| resolved | 6 |
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
| P1 | jsx_mock.jsx | dead/unreachable modules | Full-repo `rg -n -F 'jsx_mock.jsx' --glob '!.git/**' --glob '!node_modules/**' --glob '!dist/**' .`: no src/server import; still named in README.md, quality/README.md, quality/file-size-limits.json, scripts/format-check.mjs ignore set, full_spec.md, whip_context.md, auth_account_spec.md, docs/wiki/architecture/current-system.md | docs + quality references (not runtime) | ba13590 2026-05-15 20:34:07 +0000 | **needs-verification** | Product decision on mock canonicity; update linked docs/quality before delete |
| P1 | product_spec.md | dead/unreachable modules | Full-repo `rg -n -F 'product_spec.md' …`: README.md, docs/README.md, full_spec.md, auth_account_spec.md, current-system.md. No runtime import. | cross-doc product history links | f2d4a32 2026-05-15 20:35:51 +0000 | **needs-verification** | Archive only after link-map rewrite; product/legal retention unknown |
| P1 | full_spec.md | dead/unreachable modules | Full-repo `rg -n -F 'full_spec.md' …`: docs/README.md (prefers as current decisions), README.md, whip_context.md, auth_account_spec.md, current-system.md (“source of truth”). No runtime import. | docs still treat as authority | dd4809b 2026-06-04 17:16:26 +0000 | **needs-verification** | Reconcile authority with docs/wiki before archive |
| P1 | whip_context.md | dead/unreachable modules | Full-repo `rg -n -F 'whip_context.md' …`: auth_account_spec.md, docs/README.md, full_spec.md, README.md, current-system.md | guardrail doc refs remain | cace741 2026-05-16 12:53:58 +0000 | **needs-verification** | Same as other root specs |
| P1 | auth_account_spec.md | dead/unreachable modules | Full-repo `rg -n -F 'auth_account_spec.md' …`: README.md, docs/README.md, full_spec.md, current-system.md | spec matrix refs remain | 05fc14b 2026-05-16 01:13:00 +0000 | **needs-verification** | Same as other root specs |

### B. Workers — disabled / no production scheduler (11)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | scripts/board-manager-disabled.mjs | workers (disabled / no prod scheduler) | File is noop setInterval + board_manager_disabled log. package.json start:board-manager points here. fly.toml [processes] has no board-manager group. | npm start alias; no fly process | 6e2a173 2026-06-28 12:36:01 +0000 | **needs-verification** | Confirm no external invocation of alias; then drop |
| P0 | server/hive-decision-agent-worker.js | workers (disabled / no prod scheduler) | fly.toml TASKNODE_HIVE_DECISION_AGENT_ENABLED=false and …_ACTIVE=false. workerEnabled() requires those + DB + provider. Still imported by server/background-workers.js startHiveWorkers(). | fly false; still in hive role import graph | 6e2a173 2026-06-28 12:36:01 +0000 | **needs-verification** | Unplug after confirming no shadow mode |
| P0 | server/hive-decision-agent-provider.js | workers (disabled / no prod scheduler) | Provider module exclusively for decision agent path; flag-gated with WORKER_OFF. | decision agent only | 97ccfaf 2026-06-26 02:27:49 +0000 | **needs-verification** | Cut with decision agent worker |
| P0 | scripts/hive-decision-agent-loop.mjs | workers (disabled / no prod scheduler) | Not in package.json scripts. Full-repo `rg … hive-decision-agent-loop` excl. audit files → self + docs/wiki/plans/glm-board-secretary-status-memos-spec.md:31 only. External host cron not inspected (credentials out of scope). | plan doc residual pointer; external schedule unknown | e0b046c 2026-06-25 23:39:35 +0000 | **needs-verification** | Ops scheduler inventory + plan doc update |
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
| P0 | server/hive-secretary-worker.js | workers (live) | **Historical** Snaga gate (`/tmp/tasknode-gpt55-prod-gate.log`): release **v560** **worker-hive** `d895202a20e418` was LIVE with unset Secretary env → then openai/`gpt-5.5-pro` defaults (start/config only; no queue consume/model call). **Code now (`05178c8`)**: defaults OpenRouter/`z-ai/glm-5.2`; Fly.toml pins `TASKNODE_HIVE_SECRETARY_PROVIDER=openrouter`, `MODEL=z-ai/glm-5.2`, effort `high`; unsupported Pro models fail closed. Still started via `startHiveWorkers()` for worker:hive. Production machine not re-gated post-migration. | prod worker-hive role (load-bearing worker, not cut) | f49edf1 pre-migration; code `05178c8` 2026-07-14 | **load-bearing** | KEEP worker; ship deploy to activate GLM pins |
| P0 | server/hive-project-worker.js | workers (live) | **Historical** v560 **worker-hive** gate same machine: unset Project env → gpt-5.5-pro defaults. **Code now (`05178c8`)**: OpenRouter-only provider normalization + `z-ai/glm-5.2` default; Fly pins `TASKNODE_HIVE_PROJECT_PROVIDER/MODEL/REASONING_EFFORT`; Pro pattern rejected. Still hive-role background worker; Secretary completion can enqueue project planning. Deploy activation pending. | prod worker-hive role | f49edf1 pre-migration; code `05178c8` 2026-07-14 | **load-bearing** | KEEP worker; activate with combined deploy |
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
| P2 | scripts/distribution-v3-reward-dedup-audit.mjs | superseded / unreferenced scripts | Self-documented operator CLI; no package.json entry. | ops one-shot | dd4809b 2026-06-04 17:16:26 +0000 | **needs-verification** | Archive after ledger closed |
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
| P2 | docs/wiki/architecture/current-system.md | stale docs vs live behavior | Still labels full_spec.md source of truth; roots mock/specs in tree diagram. | wiki map | c3dbf3d 2026-06-11 16:31:09 +0000 | **needs-verification** | Reconcile with docs/wiki-as-primary |
| P2 | docs/README.md | stale docs vs live behavior | Prefers full_spec.md for current decisions; lists root specs. | docs index | 649de99 2026-06-08 18:03:45 +0000 | **needs-verification** | Refresh authority order |
| P2 | README.md | stale docs vs live behavior | Lists product_spec.md / jsx_mock.jsx / full_spec.md as primary inputs. | root readme | dd4809b 2026-06-04 17:16:26 +0000 | **needs-verification** | Refresh |
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
| P3 | quality/file-size-limits.json (jsx_mock.jsx exception) | fixture/test cruft | Special-case size limit entry for jsx_mock.jsx (cf quality gate). Last-touch on limits file. | quality gate | cf8b076 2026-05-17 16:09:28 +0000 | **needs-verification** | Remove with mock decision |
| P3 | scripts/format-check.mjs (jsx_mock.jsx ignore) | fixture/test cruft | Hard-coded ignore of jsx_mock.jsx and login.jsx. | format gate | cd6b015 2026-05-22 12:52:14 +0000 | **needs-verification** | Remove with mock decision |

### I. Legacy PFTasks-era remnants (5)

| P | Path/symbol | Category | Evidence | Imports/callers or gate | Last-touched | Risk | Proposed next check/cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2 | scripts/import-pftasks-profile-nfts.mjs | legacy PFTasks-era remnants | Explicit PFTasks nft_mints → profile_nfts importer. package.json script profile-nft-import-pftasks. Documented in docs/wiki/surfaces/profile.md and user-observability-logging.md. | package script + wiki ops | 649de99 2026-06-08 18:03:45 +0000 | **needs-verification** | Keep until migration complete; then archive |
| P3 | docs/wiki/architecture/pftasks-cutover.md | legacy PFTasks-era remnants | Cutover doc still instructs live fly ssh + query-user-tasks usage; names old PFTasks migration paths. | cutover runbook | c3dbf3d 2026-06-11 16:31:09 +0000 Align docs with the deployed production app | **needs-verification** | Retire when migration closed |
| P3 | README.md PFTasks wording | legacy PFTasks-era remnants | Root README and product materials still mention PFTasks-era migration context (paired with product_spec/full_spec history). | docs wording | dd4809b 2026-06-04 17:16:26 +0000 | **needs-verification** | Wording cleanup (never reintroduce tasknode_runtime) |
| P3 | prompts/task_engine/README.md | legacy PFTasks-era remnants | `rg -l -i 'pftasks\|tasknode_runtime'` includes this path among historical references. | docs/prompts historical | 0300725 2026-06-29 02:40:39 +0000 Add two-step Hive task manager | **needs-verification** | Wording cleanup |
| P3 | reference_clients/python/README.md | legacy PFTasks-era remnants | Python reference client README historical PFTasks notes; client code itself is load-bearing for PFTL scenarios. | docs only on wording; client is used | 7bd09b3 2026-05-24 15:57:17 +0000 | **needs-verification** | Keep code; clean wording |

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

Executable provider paths no longer default to or accept GPT-5.5-Pro for Secretary/Project. Production machine verification after deploy remains pending.

## Prioritized cut list

### Safe first

All six previously proven-safe items executed in `Execute proven-safe repository bloat cuts`:

1. `scripts/chat-estimate-parity-smoke.mjs` — **CUT**
2. `scripts/task-payload-read-retry-smoke.mjs` — **CUT**
3. `scripts/profile-public-hero-nft-smoke.mjs` — **CUT**
4. `scripts/hive-project-canonical-repair.mjs` — **CUT**
5. `docs/review_burndown/` — **CUT**
6. direct root `libsodium` dependency — **CUT** (`libsodium-wrappers` retained)
7. `scripts/task-event-expectation-smoke.mjs` — **CUT** (`Cut post-safe-sweep task event smoke`)

### Verify before cut

1. Root design inputs (`jsx_mock.jsx`, root specs) — still cross-linked; product retention unknown.
2. Board Manager OpenAI/`gpt-5.5-pro` fallback + manual board-manager launchers (DEAD in prod per Snaga gate) — approved surgical cut landed; preserve OpenRouter GLM behavior.
3. Hive Decision Agent + loop (`scripts/hive-decision-agent-loop.mjs`) — fly false but residual plan doc; external scheduler unknown.
4. Task Accounting Harvester pair (flag false).
5. Legacy Board Manager npm/ops surface + decision provider + codex defaults.
6. Ops tools still documented (`query-user-tasks`, `ipfs-replication-requeue`, distribution audits).
7. Orc cores without package bare names but with smokes/python/verification.
8. Docs chunks / wallet-core load strategy (keep mechanism).
9. mocks/, docs/verification/, quality tiering.
10. PFTasks import + cutover docs residual.
11. Post-deploy confirm Hive Secretary/Project machines adopted `05178c8` Fly pins (docs already resolved in that commit).
12. Extract shared provider HTTP client (not silent delete).

### Keep / load-bearing

All **load-bearing** rows in the inventory tables (live workers including **Hive Secretary/Project workers** now on GLM code defaults/`05178c8` Fly pins pending deploy activation, live providers, wallet crypto, matrix ownership, quality chain).

---

## Downgrades from first draft (this amend)

| Path | Was | Now | Why |
| --- | --- | --- | --- |
| `scripts/hive-decision-agent-loop.mjs` | safe (cond.) | **needs-verification** | Plan doc still names it; external cron unverified |
| `docs/review_burndown/` | safe (cond., unproven links) | **safe** (re-proven) | External-reference `rg` outside the tree returns 0 matches |
| `jsx_mock.jsx` | safe (cond.) | **needs-verification** | README/quality/full_spec/current-system still reference |
| `product_spec.md` | safe (cond.) | **needs-verification** | Cross-doc references + retention unknown |
| `full_spec.md` | safe (cond.) | **needs-verification** | Still declared authority in wiki/docs |
| `whip_context.md` | safe (cond.) | **needs-verification** | Cross-doc references |
| `auth_account_spec.md` | safe (cond.) | **needs-verification** | Cross-doc references |
| `scripts/chat-estimate-parity-smoke.mjs` | safe via package-only | **safe** (repo-reachability-only) | Full-repo search 0 hits; claim limited to in-repo |
| direct `libsodium` | safe future `npm ls` | **safe** (proven) | `npm ls` + lockfile prove wrappers keep transitive `libsodium` |

---

## Unverified / incomplete items

- Hive Secretary/Project: **historical** v560 gate proved start/config with then-GPT defaults; **code** is GLM via `05178c8`. Remaining gap: combined deploy/runtime verification (no paid model call performed by this audit).
- Any host-level cron/systemd invoking scripts not referenced in-repo.
- Bundle visualizer beyond Vite advisory output.
- Product policy for subsetting in-app wiki pages.


## Decision required

Seven conversion findings need explicit product/docs owner authority before further cut (Ghash/Troll). Inventory rows above are **not** rewritten here.

| Item | Blocker | Recommendation / authority |
| --- | --- | --- |
| `scripts/hive-decision-agent-loop.mjs` | Residual plan doc pointer; external host scheduler not inspected | Ops + plan-doc owner: confirm no crontab/systemd; then cut or rewire docs |
| `scripts/distribution-v3-reward-dedup-audit.mjs` | Operator one-shot ledger tool; no package.json entry | Rewards/ops owner: archive after ledger closed or keep as manual runbook tool |
| `docs/README.md` | Still prefers `full_spec.md` / root specs as decision authority | Docs owner: refresh authority order toward `docs/wiki` |
| `README.md` primary-input references | Lists `product_spec.md` / `jsx_mock.jsx` / `full_spec.md` as primary inputs | Product+docs owner: rewrite root onboarding map |
| `README.md` PFTasks wording | Historical PFTasks migration language remains | Docs owner: wording cleanup; never reintroduce `tasknode_runtime` |
| `prompts/task_engine/README.md` | Historical PFTasks/runtime notes | Prompt owner: wording cleanup only |
| `reference_clients/python/README.md` | Historical PFTasks notes; client tooling itself load-bearing | Python client owner: keep code; clean historical wording |

## Artifact integrity

- Single documentation file in this commit: `docs/wiki/architecture/repository-bloat-audit.md`
- Evidence log (not committed): `/tmp/tasknode-bloat-audit-125.log`
- Worktree isolated; no push

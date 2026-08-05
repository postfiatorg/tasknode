# Board Manager Resurrection Plan

Date: 2026-08-05
Repo: `/home/pfrpc/repos/tasknodeofficial`
Status: **APPROVED by operator (goodalexander) 2026-08-05 — execution started**

Operator decisions on the §9 open items:

1. Board 4 (AI Layer 1 Governance) sources: `postfiatd`, `rippled`, and
   `dynamic-unl-scoring` local repos — all three.
2. Caps: 50k PFT/board/day; **5k PFT per task**; 60k PFT/user/7d. Values may
   be raised later by migration; over-cap routes to goodalexander.
3. Hive Chat: **kept** as a board input, but board managers do not read raw
   chat. A periodic GLM 5.2 summary job condenses recent validated-wallet
   chat into a compact digest the agents read via `bm board`. `hive-context`
   repository survives for this.
4. Escalation load confirmed: badge approvals, over-cap rewards, and
   merge-ready PRs all route to goodalexander via network task.
5. Operator accepts prod-breakage risk during migration ("act as IC").

## 1. Verdict On The Current System

The Hive Mind network-task infrastructure is a dead product. It must be gutted,
archived, and replaced with one working agent per board.

What exists today is a five-layer model pipeline running inside Fly worker
processes: Hive Secretary compresses chat into reports, the Board Secretary
compresses board state into "secretary packets," a Task Manager model picks
candidates, a Board Manager model picks one JSON action per tick, and separate
generation/review workers execute it. The Board Manager action loop is already
disabled in production (`scripts/board-manager-disabled.mjs`,
`TASKNODE_BOARD_MANAGER_ENABLED=false`), which means the network is currently
run by the compression layers of a decision-maker that no longer exists.

Concrete failure modes:

- **Formulaic output.** Every layer is a fixed prompt over a compacted packet.
  Tasks converge to the same shapes ("write a report", "document X") because no
  layer ever reads the actual repositories the tasks are about.
- **Sybil-prone.** Task generation is candidate-pulled rather than
  quality-pushed. Capability instrumentation is explicitly advisory
  ("context only, not enforcement" — `docs/wiki/architecture/board-manager.md`),
  so enthusiastic-but-useless contributors farm documentation tasks.
- **No scrutiny.** Reward scoring is a single model call
  (`prompts/task_engine/reward_scoring_v1.md`) over evidence text the
  submitter controls. Nobody reads the diff, runs the code, or checks the PR.
- **Unauditable.** Reasoning is scattered across `hive_reports`,
  secretary packets, decision runs, and action results — "85 different screens"
  instead of one legible stream.
- **Auto-generated boards.** `server/hive-project-worker.js` +
  `prompts/hive/hive_active_projects_v1.md` let a GLM call invent and mutate
  the project list. Boards should be a deterministic operator decision.

Measured against the working tree (Appendix A): ~19,000 lines of
hive/board-manager/network-task repository code, ~13,700 lines of
worker/provider code, 42 dedicated smoke/ops scripts, 26 hive prompts, and
20+ wiki pages exist to support this. Almost all of it goes.

## 2. Target Architecture

One PfTerminal agent per board. Six boards, fixed. The agent owns the full
lifecycle end to end: task generation, verification design, submission review,
reward issuance, badge recommendation, and board journaling.

```
tmux (this machine, one window per board)
  └─ PfTerminal session (Kimi K3 via Ambient API key)
       ├─ Board Manager Skill (core lifecycle contract)
       ├─ Board Skill (per-board context: repos, X account, goals)
       ├─ `bm` CLI  ──────────────► Postgres (fly proxy / DATABASE_URL)
       │     reads:  board state, user task history, network-task history
       │     writes: network tasks, verification requests, reward decisions,
       │             board info updates, journal entries, badge referrals
       ├─ gh CLI ─────────────────► GitHub (PR review, comments)
       └─ local repo checkouts ───► real code context for task gen + review
codex-whip (cron)  ──► conditional 15–30 min "whip" injection
daily reset (cron) ──► kill session, force handoff markdown, restart
Hive Brain UI      ──► read-only transcript of the session (one stream/board)
```

### 2.1 The six boards (deterministic, seeded by migration)

| # | Board | Sources of context | Notes |
| - | ----- | ------------------ | ----- |
| 1 | Community & Promotion | Official Post Fiat X account (X API), `postfiatorg.github.io` | Only non-GitHub-centric board; X links + screenshots as evidence |
| 2 | PF Terminal | `PfTerminal` local repo | Internal terminal tool |
| 3 | PostfiatL1V2 | `postfiatl1v2` local repo | L1 v2 |
| 4 | AI Layer 1 Governance | governance-replay XRPL fork local repo | Exact repo pinned in board config at Gate B |
| 5 | Task Node Fixes | `tasknodeofficial` local repo | Tasks assignable **only** to goodalexander (code access) |
| 6 | Capital Markets | `goodalexander.github.io`, `agti` local repos, agti.net | AGTI/community alpha ideas |

Board creation/mutation by models is deleted. Boards change only by migration
or an authenticated admin route.

### 2.2 Agent runtime rules

- **Cadence:** the whip fires every 15–30 minutes, but only injects when the
  board digest changed — i.e., a network task completed, a submission arrived,
  a verification response landed, or board info changed. `bm digest <board>`
  returns a hash; the whip compares it to the last-injected hash. Quiet board,
  quiet agent.
- **24-hour reset:** at reset, the agent runs `bm handoff <board>`, which
  generates a skeleton from the database (open tasks, submissions awaiting
  review, outstanding verification requests, budget spent) that the agent
  annotates into `journal/<board>/handoff-YYYYMMDD.md` (threads in flight,
  what the next session must do first). The session is then killed and
  restarted with the handoff as opening context. Nothing in-flight can be
  lost at the boundary because Postgres — not the model's context window — is
  the source of truth: every pending review, verification request, and PR
  referral is reconstructable from `bm board` on the next boot, and GitHub
  review state lives on GitHub. The handoff is an accelerator, not a
  correctness requirement.
- **Journal:** a simple append-only markdown journal per board
  (`journal/<board>/journal.md`) plus the daily handoff. This is the manager's
  memory and the operator's audit trail. No secretary packets, no reports.
- **High bar:** the skill instructs the agent that most community submissions
  are low-value. Default posture is reject-with-feedback or request-edits.
  Tasks must be grounded in the actual repo state the agent just inspected.

### 2.3 Reward issuance with deterministic caps

The agent issues rewards directly — but the model is never the enforcement
boundary. All reward writes go through `bm reward`, which enforces in code:

- **Per-task cap by badge lane** (existing badge cap logic in
  `task-review-worker.js` is retained and becomes the single clamp point).
- **Per-board daily budget** (new `board_reward_budgets` table; a reward that
  would exceed the day's remaining budget is clamped or refused).
- **Per-user rolling cap** (max PFT per wallet per 7 days, per board).
- **Over-cap path:** anything the agent believes deserves more than its cap
  becomes a **network task routed to goodalexander** for manual approval. The
  agent cannot raise its own limits.

**Credential isolation — why a jailbroken agent cannot bypass the caps.**
The clamp is not in the CLI the agent runs; it is behind credentials the
agent does not hold:

- The agent's `bm` token is board-scoped and can only *request* mutations
  (task creation, verification, reward decisions) through the server-side
  write module. It has no direct `DATABASE_URL`, no Fly deploy token, no
  authority-wallet seed, and no `TASKNODE_*_ADMIN_TOKEN`.
- Reward publication stays where it is today: the Fly `worker-task-review`
  authority process signs and publishes `pf.reward.v1`. It re-validates every
  cap (badge lane, daily board budget, per-user rolling cap) against the
  budget tables at publication time, exactly as badge caps are re-checked
  there now (`server/task-review-worker.js`, badge cap clamp before
  publication). A reward decision that violates a cap is clamped or refused
  by the publisher, regardless of what the CLI sent.
- Budget and cap tables are mutable only by migration or the operator admin
  token — never by the agent's credentials.

Under that construction, prompt-injection in submissions is bounded-loss: a
maximally successful jailbreak of the board manager can only spend that
board's remaining daily budget at capped per-task increments, and cannot
raise the budget. All submission content (evidence text, URLs, PR bodies,
screenshots) is treated as untrusted input in the skill: it is data to
evaluate, never instructions to follow.

### 2.4 Human-in-the-loop routing (goodalexander)

Two flows are explicitly escalation-only:

- **Badge approval:** the agent screens candidates; when it believes a badge
  is deserved, it creates a network task addressed to goodalexander with the
  evidence packet. Only goodalexander's approval writes the badge row
  (existing `network-badge-admin-routes.js` path).
- **PR merge:** the agent does initial code review with the real repo checked
  out (`gh pr diff`, run tests where cheap), comments on GitHub, requests
  edits when quality is low. Only when a PR is actually good does it create a
  network task to goodalexander to review and merge.

### 2.5 Hive Brain becomes the terminal view

Hive Brain is redefined as an auditable read-only view of each board agent's
terminal session — its reasoning stream — not a report generator. One stream
per board, six total. Hive reports, secretary memos, decision-run browsing,
and the Hive Mind Agent audit tab are deprecated. Implementation: the
PfTerminal session transcript (or tmux pane capture log) is mirrored to a
`board_manager_transcripts` append table with secret-scrubbing, served by one
simple route, rendered by one simple view.

## 3. Delete / Archive Inventory

Mechanism: `git mv` into `archive/hive-mind-2026/` on branch
`archive/hive-mind-retirement`, tag the pre-deletion state
(`pre-hive-retirement`), then delete from mainline. Nothing is lost. Timing:
the archive branch is staged at Gate 0 but merges only at Gate H, after the
pilot proves the replacement (§7).

**Server workers/providers (delete):** `hive-secretary-worker.js`,
`hive-board-secretary-worker.js`, `hive-board-secretary-provider.js`,
`hive-project-worker.js`, `hive-project-canonical.js`,
`hive-task-manager-worker.js`, `hive-task-manager-provider.js`,
`hive-reports-worker.js`, `hive-report-provider.js`,
`hive-immediate-response.js`, `hive-brain-live.js` (replaced by transcript
route), `board-manager-secretary-packets.js`,
`board-manager-decision-provider.js`, `task-accounting-harvester-*.js`,
`network-task-generation-worker.js`'s intent-packet lane (the generation
worker itself survives; the Board-Manager-intent plumbing goes).

**`board-manager-actions.js`:** shrunk, not deleted. The action registry,
scheduler, leases, and hooks go; the small functions that create a network
task for a specific account/wallet (today reachable via
`board-manager-manual-network-task.mjs`) are extracted into the `bm` CLI's
write path.

**Repositories (delete):** `hive-account-live-state`, `hive-board-secretary`,
`hive-brain`,
`hive-decision-agent`, `hive-live-task-packet`, `hive-project-planning`,
`hive-project-product-docs`, `hive-reports`, `hive-task-manager`,
`board-manager-agent-jobs`, `board-manager-health`,
`board-manager-run-summary`, `board-manager-scheduler`,
`board-manager-source-compact`, `board-manager-state`, `board-manager.js`
(minus extracted task-creation helpers), and `task-accounting-harvester`.
`hive-context` is decision-dependent: it survives if Hive Chat survives as a
user input surface (Open Item 3), otherwise it is archived with the rest.
`recommended-connections-worker` is out of scope either way.

**Prompts (archive):** all of `prompts/hive/` including `reports/`.
`prompts/task_engine/` survives where the lifecycle workers still use it;
`reward_scoring_v1.md` is retired when Gate D lands (agent decision replaces
model auto-scoring).

**Scripts (delete):** all `board-manager-*.mjs` except a renamed
`bm-network-task.mjs` core, plus `agent-hive-chat-smoke.mjs`,
`hive-*` smokes, secretary/packet/scheduler/capability smokes.

**UI (simplify):** `HiveBrainView.jsx` → transcript viewer;
`hive-report-markdown.js` deleted; HiveView keeps projects/tasks/routing feed,
drops Hive Mind Agent audit tab and report surfaces.

**Fly (`fly.toml`):** remove `board-secretary` process group; remove
`worker-hive` model-loop workers (keep only what the surviving surfaces
need); remove `TASKNODE_HIVE_*` secretary/task-manager/project env; remove
`TASKNODE_BOARD_MANAGER_*` env. The board manager itself does **not** run on
Fly — it runs on this machine.

**Docs:** hive/board-manager wiki pages move to `docs/wiki/archive/`; one new
page `docs/wiki/architecture/board-manager-v2.md` describes the real system.

**Database:** legacy tables (`board_manager_*`, `hive_*` decision/report
tables) are kept read-only for one release for audit, then dropped by
migration once the transcript view replaces them. `network_projects`,
`network_tasks`, `task_projections`, badge tables, and the PFTL cache are
untouched.

## 4. What Is Explicitly Kept

- Canonical task lifecycle and replay: request → offer → accept → submission →
  verification → single terminal `pf.reward.v1`, all as signed PFTL pointers +
  encrypted IPFS payloads. The board manager *drives* this lifecycle; it does
  not replace it.
- `task-generation-worker.js` and `task-review-worker.js` as the publication
  machinery (offers, verification requests, reward transactions). Review
  worker's model auto-scoring is replaced by agent decisions + code caps.
- The badge system end to end: catalog, verifier jobs, admin routes, badge
  eligibility enforcement, badge reward caps. Badges remain the sybil defense.
- Directory, profiles, wallet custody boundaries, chat, context, airdrop —
  untouched.

## 5. The `bm` CLI (agent tool surface)

A thin Node CLI in `scripts/bm/` (reusing existing repo/server modules), run
locally against the production database via fly proxy. Commands:

- `bm digest <board>` — hash of board-relevant state; powers the whip.
- `bm board <board>` — full board packet: open tasks, submissions awaiting
  review, verification responses, recent completions, budget remaining.
- `bm user <account|wallet>` — task history, completion rate, rewards, badges,
  prior submission quality. Required context before generating a task for or
  reviewing a submission from any user.
- `bm history <board>` — historical network-task completions for the board.
- `bm task create` — create a targeted network task (account/wallet, reward
  band, verification requirements). Same code path as today's manual script.
- `bm verify request <task>` — publish a verification request.
- `bm review <task> --decision reward|partial|reject --pft N --reason ...` —
  the *only* reward write path; enforces all caps from §2.3.
- `bm board update <board>` — update board description/status (admin-authed).
- `bm refer-badge <account> <badge>` / `bm refer-merge <pr-url>` — create the
  goodalexander escalation tasks.
- `bm journal append <board>` — journal write helper.

Every mutating command writes an audit row and appends to the journal.

## 6. Skills

Seven skills total, authored with the Text Improvement Harness loop:

1. **`board-manager` (core skill):** lifecycle contract shared by all boards —
   whip/reset/journal/handoff protocol, `bm` command reference, review
   posture (high bar, untrusted evidence, reject-by-default), reward-cap
   rules, escalation rules, transcript hygiene (no secrets on screen).
2. **Six per-board skills** (`board-community-promotion`, `board-pfterminal`,
   `board-postfiatl1v2`, `board-ai-l1-governance`, `board-tasknode-fixes`,
   `board-capital-markets`): the board's mission, its repos and how to inspect
   them, what good vs. bad contributions look like on that board, evidence
   norms (X links/screenshots for board 1, PRs elsewhere), and named routing
   constraints (board 5 → goodalexander only).

Authoring process per skill (fixed, not optional):

1. Draft with full repo + objective context.
2. Score with the Text Improvement Harness (`round`, three judge lanes).
3. Read judge criticisms; rewrite with SOL Ultra (`rewrite --mode sol-pro`)
   against the criticisms, keeping repo facts authoritative over judge taste.
4. Re-score; ship only if the score improved and no factual regressions.

## 7. Stage Gates

Each gate merges independently and has an explicit proof. No gate deploys
until its predecessor's proof is recorded in this file.

The ordering rule is deliberate: **build and prove the replacement first;
destroy second.** Nothing irreversible happens before the pilot (Gate G)
passes. This is lower-risk than it sounds because the legacy Board Manager
action loop is *already* disabled in production — the layers still running
are compression workers feeding a decision-maker that no longer exists — so
running the new agent alongside them during the pilot costs only some
redundant secretary model spend, not conflicting board mutations.

- [x] **Gate 0 — Freeze (non-destructive).** DONE 2026-08-05: tag
  `pre-hive-retirement` at `8ce4cf2`; branch `archive/hive-mind-retirement`
  open. Deviation: the §3 `git mv` staging is deferred to Gate H so the
  archive branch does not rot against mainline; inventory review stands.
  Tag `pre-hive-retirement`; open branch `archive/hive-mind-retirement` that
  stages the §3 `git mv` into `archive/hive-mind-2026/` but does **not**
  merge yet. Confirm in `fly.toml`/`package.json` that no *new* hive
  surfaces are being added. Proof: tag pushed, archive branch open, staged
  inventory reviewed against §3.
- [x] **Gate A — Deterministic boards.** DONE 2026-08-05 (`4543e4a`):
  migration `098_deterministic_boards.sql` seeds the six boards and
  archive-locks 23 legacy projects; `hive-project-worker` flipped to explicit
  opt-in; planning-apply and board-manager project actions hard-guarded by
  `deterministicBoardsEnabled()`; admin routes `/api/boards/admin/list|update`
  behind `TASKNODE_BOARD_ADMIN_TOKEN`. Proof:
  `scripts/deterministic-boards-smoke.mjs` green against dev Postgres
  (migration run twice, 6 active boards, guard blocked `create_project`);
  `npm run lint` clean. Hive-surface render check deferred to deploy.
  Migration seeds exactly the six boards of §2.1 into `network_projects`
  (stable ids), disables model board mutation (`hive-project-worker` feature
  flag off), adds admin-only board update route. Proof: migration idempotence
  test + Hive surface renders the six boards.
- [x] **Gate B — `bm` CLI reads.** DONE 2026-08-05: `scripts/bm.mjs` +
  `scripts/bm/lib.mjs` implement `boards`, `digest`, `board`, `user`,
  `history` (`npm run bm`). Proof: run against production through
  `fly mpg proxy` (cluster `3x9jv02yd3dr6qp7`): six boards active in prod
  (migration 098 applied), stable digests, real user packet (168 tasks,
  445,568 PFT rewarded, 4 verified badges) — no secrets printed. Note:
  migration 098 was applied to production at this gate with operator
  consent; legacy projects archived+locked in prod.
- [ ] **Gate C — `bm` CLI writes + reward caps + credential split.**
  `task create`, `verify request`, `review`, `board update`, `refer-badge`,
  `refer-merge`, `handoff`; `board_reward_budgets` migration; the §2.3
  credential model (board-scoped agent token; publisher-side cap
  re-validation in `task-review-worker.js`; budgets mutable only by
  migration/admin token). Cap enforcement tests: per-task badge cap, daily
  board budget, per-user rolling cap, over-cap refusal creates a
  goodalexander task, and a negative test proving the agent token cannot
  write budget tables. Review-worker auto-scoring becomes flag-disabled.
  Proof: cap + credential unit tests, one end-to-end reward on testnet
  clamped from a deliberately over-asked amount.
- [ ] **Gate D — Runtime harness + continuity contract.**
  tmux layout, PfTerminal session config on Kimi K3 via the Ambient key from
  the vault, codex-whip conditional injection wired to `bm digest`, daily
  reset cron with `bm handoff` write, and the §8.1 continuity contract
  (liveness check, staleness alert, resume runbook). Proof: 48-hour soak on
  one board with ≥2 resets, handoffs written, whip observed firing only on
  digest change, one deliberate kill + documented resume within the RTO.
- [ ] **Gate E — Skills.**
  Core skill + six board skills authored through the §6 TIH loop. Proof: TIH
  journal per skill showing initial score, criticisms, rewrite, improved
  final score.
- [ ] **Gate F — Hive Brain = transcript.**
  Transcript mirror table + scrubber, one route, simplified view, shipping
  *alongside* the legacy report surfaces (which remain until Gate H). Proof:
  live board session visible in Hive Brain; secret scan of mirrored
  transcript.
- [ ] **Gate G — Pilot.**
  Run board 2 (PF Terminal) alone for one week with the legacy pipeline
  still deployed. **This gate is the go/no-go for all destructive work**, so
  its bar is quantitative, and every criterion is auditable from the journal,
  transcript, and database:
  - ≥10 whip cycles executed; zero cycles where the agent acted without a
    digest change; zero dead sessions unrecovered by the liveness path.
  - ≥3 generated tasks that the operator audits as genuinely repo-grounded
    (task text cites real files/PRs/issues that exist).
  - 100% of issued rewards verifiably within all three caps, checked against
    `board_reward_budgets` rows, with ≥1 deliberately over-asked reward
    demonstrated clamped in production.
  - ≥1 real submission rejected with actionable written feedback and ≥1
    escalation task created for goodalexander that he judges correctly
    escalated.
  - Zero secrets in the mirrored transcript (automated scan + operator spot
    check); zero unauthorized mutations in the audit table.
  - Operator sign-off checklist recorded in this file. A miss on any
    criterion extends the pilot; it does not soften the bar.
- [ ] **Gate H — Teardown.**
  Merge the archive branch (delete §3 inventory from mainline); remove
  secretary/hive process groups and `TASKNODE_HIVE_*`/`TASKNODE_BOARD_MANAGER_*`
  env from `fly.toml`; deploy; confirm surviving lifecycle workers (taskgen,
  task-review, pftl) stay green; retire legacy report routes to 410/archived;
  start the remaining five boards. Proof: fly status output, one full task
  lifecycle replay on testnet, CI green with hive smokes removed.
- [ ] **Gate I — Legacy table drop.**
  After one release of transcript-based audit, drop `board_manager_*` /
  hive decision+report tables by migration. Proof: migration + backup noted.

Rollback: at any gate before H, rollback is "stop the tmux sessions" — the
legacy deployment is untouched. After H, rollback is redeploying the tagged
`pre-hive-retirement` revision.

## 8. Risks & Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Prompt injection via submissions | Untrusted-input rule in core skill; rewards clamped in code (§2.3); bounded daily loss |
| Sybil farming | Badge eligibility enforced in code before task creation; high-bar review posture; per-user rolling caps |
| Agent context overload | One agent per board; daily reset; handoff + journal as the only carried state |
| Local machine as SPOF | See §8.1 — degradation is graceful and recovery is a runbook, not an improvisation |
| Kimi K3 quality drift | Transcript is fully auditable in Hive Brain; operator can retarget the PfTerminal provider without architecture change |
| Secrets on screen | Skill forbids echoing secrets; vault auth-helper pattern; transcript scrubber before mirroring |
| Community backlash at higher bar | Reject-with-feedback posture: every rejection carries actionable edits, and journals make standards public |

### 8.1 Continuity contract (the local machine is a manager, not a server)

The honest framing: the board manager machine going down does **not** take
down the network. The user-facing app, wallet custody, PFTL publication, and
all lifecycle workers run on Fly and are unaffected. What pauses is
*management*: no new tasks are generated, submissions queue unreviewed, and
escalations wait. That is an acceptable degradation mode for hours, not
weeks, so the contract targets detection and resume rather than hot
standby:

- **Liveness:** a cron health check runs `bm digest` and `tmux has-session`
  for each board every 15 minutes; two consecutive failures restart the
  session; a restart failure sends an operator alert (Telegram/Discord).
- **Staleness:** a server-side check flags any board whose last agent-audit
  row is older than 12 hours; this renders as an amber row in System Status,
  the same pattern used for existing workers.
- **Recovery time objective:** one operator-day. All durable state is in
  Postgres (tasks, budgets, audit rows) and in git (journals, handoffs,
  skills). The resume runbook — install PfTerminal, restore vault access,
  clone repo, start tmux + cron — is written and rehearsed once at Gate D
  (deliberate kill + timed resume is part of that gate's proof).
- **Reset window:** the daily reset restarts sessions one board at a time,
  and a failed restart triggers the liveness path above; there is no moment
  where a failed cron silently ends management for all six boards.

Running on this machine rather than Fly is an explicit operator mandate, not
an oversight: the board manager holds review judgment and vault-mediated
credentials that the operator wants under direct physical control, next to
the local repo checkouts it must read. The runtime is deliberately portable
anyway — PfTerminal + tmux + cron + a git clone — so the same session can be
stood up on a dedicated VM later without any architecture change if the
management-pause tolerance tightens. Hot standby and multi-machine failover
are out of scope for v1 because the failure they defend against costs a
management pause, not data loss or custody risk, and the Gate D rehearsed
runbook makes cold resume cheap and predictable.

## 9. Open Items For Operator Decision

1. Exact local repo path for the AI Layer 1 Governance board (pin at Gate B).
2. Per-board daily budgets and per-user rolling cap values (defaults proposed
   at Gate D: 50k PFT/board/day, 60k PFT/user/7d, overridable by migration).
3. Whether Hive Chat (user-facing) survives as an input the board agents read
   via `bm board`, or is archived with the rest (this decides `hive-context`
   in §3).

## Appendix A. Verified Evidence

Every load-bearing claim above was checked against the working tree on
2026-08-05. Commands are reproducible from the repo root.

**The Board Manager action loop is already off in production.**

```
$ rg -n "start:board-manager" package.json
258: "start:board-manager": "TASKNODE_PROCESS_ROLE=board-manager node scripts/board-manager-disabled.mjs"

$ rg -n "TASKNODE_BOARD_MANAGER_ENABLED|TASKNODE_LEGACY_BOARD_MANAGER_ENABLED" fly.toml
TASKNODE_BOARD_MANAGER_ENABLED = "false"
TASKNODE_LEGACY_BOARD_MANAGER_ENABLED = "false"
```

Meanwhile `fly.toml` still runs `board-secretary` and `worker-hive` process
groups with `TASKNODE_HIVE_BOARD_SECRETARY_ENABLED = "true"` and
`TASKNODE_HIVE_TASK_MANAGER_ENABLED = "true"` — the compression layers
without the decision-maker, as claimed in §1.

**Measured size of the deletion target.**

```
$ wc -l server/hive-*.js server/board-manager-*.js \
    server/network-task-generation-worker.js server/task-generation-worker.js \
    server/task-review-worker.js server/expert-badge.js \
    server/network-badge-admin-routes.js server/project-leader-badge.js | tail -1
13670 total       # workers/providers (the survivors in §4 are inside this figure)

$ wc -l server/repositories/hive-*.js server/repositories/board-manager*.js \
    server/repositories/network-task*.js | tail -1
19015 total       # repository layer (network-task repos survive; hive/bm repos go)

$ find prompts/hive -type f | wc -l              # hive prompt inventory
26
$ ls scripts | rg "^board-manager-|^hive-|^agent-hive" | wc -l   # dedicated smoke/ops scripts
42
```

**Targeted task creation to a named account/wallet already exists** — the
`bm task create` write path is an extraction, not new invention:

```
$ node scripts/board-manager-manual-network-task.mjs --help | head
Creates a Board Manager run with an operator-supplied initiate_network_task decision.
  --project-id <id>   --account-id <id>   --wallet <address>
  --required-badge <id>  --badge-reward-cap <pft>  --reward-min/--reward-max
```

**Publisher-side cap re-validation already exists** — §2.3 extends a live
pattern rather than introducing one:

```
$ rg -n "badge_reward_cap_pft" server/task-review-worker.js
1873:      policy.badge_eligibility_decision?.badge_reward_cap_pft ||
```

**Model-authored board mutation exists and is the thing Gate A turns off:**
`server/hive-project-worker.js` feeds `prompts/hive/hive_active_projects_v1.md`
("Create a new project when the report describes a clear unresolved network
workstream") into a GLM call that rewrites `network_projects`.

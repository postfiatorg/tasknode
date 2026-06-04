# Profile

Profile is the member-facing trust surface. It should explain what the system knows about the account, what the member has earned, what profile image/NFT state exists, and which private account-level reads are available.

The profile is account-scoped. Wallets can change over time, but the profile belongs to the signup identity cloud, not to a single current wallet.

## Hive Handle And Public Aliases

The pseudonymous identity plan is now retired as a plan. The implemented v1 surface is a small account-level identity control: each signed-in account can choose one public Hive handle and can decide which linked provider aliases are public.

Runtime endpoints:

- `GET /api/profile/identity`
- `GET /api/profile/handle/availability?handle=<handle>`
- `POST /api/profile/handle`
- `POST /api/profile/identity/alias`

The Hive handle is the public routing name for the account. It is normalized by the server, globally unique within Task Node, checked against reserved names, and stored on the internal account record rather than on a wallet. Provider usernames are never copied into the public Hive namespace unless the user explicitly chooses that handle and it is available.

Linked provider aliases remain private by default. The user can make an alias public from the identity controls and can independently choose whether the public alias shows the provider handle and a verified badge. Public profile reads receive only the explicit public alias set from `identity.publicAliases`; private provider identities are excluded from public profile copy, task rows, Hive cards, and Board Manager-facing public display state.

Current UI entry points:

- first-sign-in handle dialog from `src/features/identity/IdentityControls.jsx`;
- Settings identity controls from the same component;
- Profile identity card from `src/features/profile/ProfileIdentityCard.jsx`.

Implementation references:

- `server/account-identity.js`: handle normalization, reserved-name checks, availability, suggestions, and alias disclosure shaping;
- `server/profile-routes.js`: identity, handle, alias, and public profile routes;
- `server/runtime-store.js`: account-scoped persistence and linked-provider state;
- `server/repositories/profile-public.js`: public profile packet shaping with explicit public aliases only.

Not implemented in v1: public member search, Hive mention resolution, provider-photo import, and admin impersonation review queues. Those are future product work, not active Plans pages.

## Public Profile

The public profile is now a read model over deterministic account metrics plus one generated profile snapshot.

This page is the current product contract for public profile data, generated
copy, NFT image state, and profile reward facts. Historical profile planning has
been folded into this surface doc and the current architecture docs.

It should not contain mock connections, fake member-since history, Sybil scores, graph language, or placeholder NFT ownership.

Runtime endpoints:

- `GET /api/profile/public`
- `POST /api/profile/public/regenerate`

The deterministic fields come from Postgres and runtime wallet-link state:

- primary/display wallet from the account wallet cloud, task history, and profile NFT rows;
- lifetime task reward PFT from `task_projections.reward_actual_pft > 0`;
- lifetime daily airdrop PFT from submitted `profile_daily_airdrop_issuances`;
- total lifetime PFT as task rewards plus issued airdrops;
- alignment score from the latest completed `profile_daily_airdrop_runs.alignment_score_7d`;
- contribution tier from positive task rewards in the trailing 30 days;
- public NFT gallery from account-owned `profile_nfts` rows.

The model-generated fields come from `profile_public_snapshots`:

- role title;
- role summary;
- skills;
- archetype;
- archetype contrast;
- useful-to sentence;
- data caveat when evidence is thin.

The public profile snapshot prompt is `prompts/profile/public_profile_snapshot_v1.md`.

The prompt is tuned for member discovery. It should translate concrete task history into durable professional capabilities rather than repeating narrow task titles or internal implementation trivia. Ledger, wallet, replay, event stream, evidence, and verification work should be expressed as crypto protocol reliability, indexing, auditability, integration debugging, or verification systems work when the packet supports that interpretation.

The public copy should be useful to someone deciding whether to assign work, follow, hire, or collaborate with the member. The prompt treats the public profile as a work-assignment signal, not a task log. It groups rewarded task history into repeated work themes, avoids project names and ticket summaries as identity labels, and returns exactly four discoverable skills.

The summarizer is also instructed to infer the most relevant industry when the packet is not explicit. The work should read as applicable to financial systems when that is the clearest industry fit. It should describe outcomes a contributor drives, not the mechanical implementation steps, and it should be understandable to someone who has never seen the evidence packet.

The public snapshot input includes up to 24 recent rewarded tasks so the model can identify repeated themes instead of overfitting to the latest tickets. Each task entry is deliberately compact:

```json
{
  "task_proposal": {
    "title": "...",
    "description": "...",
    "kind": "...",
    "reward_offer_pft": 0,
    "submission_requirement": "..."
  },
  "reward_text": {
    "reward_paid_pft": 0,
    "decision": "...",
    "text": "..."
  }
}
```

The public profile model does not receive verification requests, verification responses, transaction hashes, CIDs, evidence references, processed artifacts, completion scores, or evidence-quality scores. The intent is to summarize the proposed work and the final reward feedback, not the intermediate verification loop.

The public profile role layout renders the model summary as exactly two sentences, then separates `Best fit`, skills, archetype, and caveat so the page remains readable.

Provider policy:

- model: `deepseek/deepseek-v4-pro`;
- provider: OpenRouter private route;
- ZDR required;
- `data_collection: "deny"`;
- `require_parameters: true`;
- temperature `0`;
- structured JSON output;
- no user billing in v1.

The model receives only a compact public profile packet. It does not receive raw private context documents, raw chat memory, raw evidence files, wallet seeds, or the private NFT image prompt. Numeric scores, task counts, wallet addresses, reward totals, and NFT state are deterministic and are not generated by the model.

Snapshot idempotency uses the deterministic input fingerprint plus prompt digest and model. Changing the prompt intentionally creates a new completed snapshot from the same task packet; re-running with the same packet, prompt, and model reuses the existing snapshot.

### Contribution Level

Contribution level is deterministic and task-reward based. Airdrops count toward earned PFT display but do not count toward the level calculation.

The backend stores an internal numeric tier for sorting and future cohorting:

```text
T0: no positive task rewards
T1: at least 1 rewarded task or at least 1 task-reward PFT in trailing 30 days
T2: at least 5 rewarded tasks or at least 10 task-reward PFT in trailing 30 days
T3: at least 12 rewarded tasks or at least 35 task-reward PFT in trailing 30 days
T4: at least 25 rewarded tasks or at least 100 task-reward PFT in trailing 30 days
```

The public page does not expose `T3 / T4` style labels because they read like arbitrary game tiers. It maps the internal tier to a human label such as `Core contributor` and displays the factual basis, for example `12 rewarded tasks and 20.45 task-reward PFT in the trailing 30 days`. It does not display percentile claims such as `Top 18%` until a real cross-account percentile table exists.

### Public NFT Gallery

The public NFT gallery renders real `profile_nfts` rows only. If the account has no generated or minted profile NFTs, the page shows an empty state instead of procedural placeholder art.

The app shell account avatar uses the same latest profile NFT image as the public profile hero when one exists. If the account has no profile NFT image, the shell falls back to account initials.

Prompt privacy remains unchanged: the image prompt body is never returned to the browser, never shown in public metadata, and never committed to the public prompt folder.

## Daily Airdrop

Daily Airdrop is an account-level private scoring job. It reviews the member's recent rewarded task work and produces a proposed daily PFT airdrop plus a short explanation of what raised the score, what lowered it, and what to improve tomorrow.

Current status: recurring scoring and live issuance are implemented behind `TASKNODE_DAILY_AIRDROP_WORKER_ENABLED=true`. A scoring run writes `profile_daily_airdrop_runs`; issuance claims exactly one `profile_daily_airdrop_issuances` row as `processing` before any PFT signing work, then submits a PFTL payment pointer. Each actual worker run also creates a Hive Mind Agent card that says how much PFT was dispensed and to how many users.

### Private Profile Rendering

The private profile top section is now a read model over Postgres. It should not contain mock airdrop amounts, qualitative badges, or fake chart series.

Runtime endpoints:

- `GET /api/profile/daily-airdrop`
- `GET /api/profile/reward-history?range=7d|28d|90d`

The airdrop hero reads the latest completed `profile_daily_airdrop_runs` row for the signed-in `account_id`. The large headline is the latest daily airdrop amount only. It is labeled `Today's airdrop` only when the paid/scored airdrop date is the current UTC date; otherwise it is labeled `Latest airdrop`. Total earned PFT, including task rewards plus submitted daily airdrops, belongs in the adjacent range chart and summary line.

Visible fields:

- proposed daily airdrop: `daily_airdrop_pft`;
- run mode: `run_mode`, currently usually `dry_run`;
- score date: `completed_at` or `run_date`;
- alignment: `alignment_score_7d * 100`;
- rewarded task count from `input_snapshot.reward_totals.rewarded_task_count`;
- trailing 7-day actual/max PFT: `actual_airdrop_pft_7d` and `max_possible_airdrop_pft_7d`;
- recipient wallet from `input_snapshot.airdrop_recipient.wallet_address`;
- paid issuance proof from `profile_daily_airdrop_issuances`;
- model explanations: `what_raised_today`, `what_kept_it_lower`, `to_improve_tomorrow`, and `reasoning_text`.

The private profile does not display `retention_value_score`. The backend still stores that model output for audit and future policy review, but it is not part of the private member-facing panel.

The top chart and PFT generation chart read actual earned PFT rows. They aggregate task rewards from `task_projections.reward_actual_pft > 0` and daily airdrops from `profile_daily_airdrop_issuances.status = 'submitted'`. Until reward categories exist as first-class data, the chart is a single earned-PFT series rather than fabricated personal/network/alpha layers. The daily airdrop headline must not reuse the chart's total-earned number or imply that task rewards are the same thing as the airdrop payout.

### Evidence Packet

The scorer builds one compact task reward packet from Postgres task projections and task reward events.

Included work:

- only tasks tied to the account's identity wallet cloud;
- only tasks with `reward_paid_pft > 0`;
- only tasks inside the trailing lookback window, currently 7 days;
- task title, kind, status, reward offer, reward outcome, reward reason, completion score, evidence quality, event CIDs, and transaction hashes.

Excluded work:

- zero-reward tasks;
- tasks from wallets not in the account wallet cloud;
- raw evidence blobs unless a later version explicitly needs them.

### Identity Cloud

The airdrop is one score per identity cloud, not one score per wallet. An account can link, delink, and relink multiple PFT wallets over time, but daily scoring remains keyed by `account_id` and `run_date`.

The identity wallet cloud is built from:

- the active linked wallet;
- wallet link, relink, and delink auth events for the account;
- reclaim events that remove wallets now claimed by another active account.

This prevents a user from farming airdrops by rotating wallets and prevents Task Node authority/funding wallets from being selected just because they appear in chain replay rows.

### Recipient Wallet

Recipient selection is deterministic metadata, not model reasoning.

The selected recipient wallet is chosen from eligible identity-cloud wallets by:

1. highest all-time task count in `task_projections`;
2. rewarded task count;
3. total rewarded PFT;
4. most recent task update;
5. active linked wallet;
6. wallet address as final stable ordering.

The scoring snapshot stores deterministic selector facts:

```json
{
  "wallet_address": "r...",
  "selection_status": "selected",
  "selection_basis": "identity_cloud_all_time_task_count",
  "selected_active_wallet": true,
  "task_count": 20,
  "rewarded_task_count": 12,
  "reward_paid_pft": 20.45,
  "last_task_at": "2026-05-20T17:40:48.585Z",
  "candidate_wallet_count": 2
}
```

There is no `selection_reason` prose field. The fields above are enough to audit why the wallet was selected.

### Model Score

The prompt is `prompts/profile/daily_airdrop_v1.md`.

Runtime call sites:

- `server/profile-daily-airdrop.js::runDailyAirdropScore`
- `server/profile-daily-airdrop-worker.js::runDailyAirdropWorkerOnce`
- `server/profile-daily-airdrop-worker.js::startDailyAirdropWorker`
- `scripts/profile-daily-airdrop-score.mjs`
- `scripts/profile-daily-airdrop-worker.mjs`

Provider policy:

- model: `deepseek/deepseek-v4-pro`;
- provider: OpenRouter private route;
- ZDR required;
- `data_collection: "deny"`;
- temperature `0`;
- structured JSON output;
- no user billing in v1.

The model returns:

- `daily_airdrop_pft`;
- `retention_value_score`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `eligibility_status`;
- `eligibility_reason`;
- `reasoning_text`.

`reasoning_text` is contributor reasoning. It explains why the member's task packet merits the proposed airdrop. Recipient wallet selection is deterministic and separate from contributor reasoning.

### Alignment Score

Alignment score is deterministic. It is not an LLM output.

```text
alignment_score_7d =
  actual_airdrop_pft_7d
  /
  max_possible_airdrop_pft_7d
```

The denominator is the sum of each counted airdrop run's max possible amount. It is not blindly `max_daily_pft * 7`.

Examples:

- one dry run proposes `600 PFT` with a `10000 PFT` max: `600 / 10000 = 0.06`;
- seven completed production runs each with a `10000 PFT` max: denominator is `70000 PFT`.

During the scoring-only phase, `actual_airdrop_pft_7d` means completed dry-run or production scoring rows that are explicitly counted by the run. Once live issuance exists, it should mean actually issued production PFT.

### Database

`profile_daily_airdrop_runs` stores scoring runs.

Important fields:

- `account_id`;
- `run_date`;
- `run_mode`: `dry_run` or `production`;
- `scenario_id`;
- `status`;
- `daily_airdrop_pft`;
- `retention_value_score`;
- `what_raised_today`;
- `what_kept_it_lower`;
- `to_improve_tomorrow`;
- `reasoning_text`;
- `actual_airdrop_pft_7d`;
- `max_possible_airdrop_pft_7d`;
- `alignment_score_7d`;
- `input_snapshot`;
- `output_json`;
- provider/model/prompt metadata.

The production uniqueness boundary is one production scoring row per account per UTC day. Dry runs can be repeated for prompt and packet testing.

`profile_daily_airdrop_issuances` stores live payment submissions.

Important fields:

- `account_id`;
- `run_id`;
- `run_date`;
- `source_wallet`;
- `recipient_wallet`;
- `amount_pft`;
- `amount_drops`;
- `status`;
- `source_cid`;
- `tx_hash`;
- `ledger_index`;
- `payload_digest`.

The issuance uniqueness boundary is one issuance row per `run_id` and one submitted issuance per account/day.

`profile_public_snapshots` stores public role snapshots.

Important fields:

- `account_id`;
- `status`;
- `input_fingerprint`;
- `input_snapshot`;
- `role_title`;
- `role_summary`;
- `skills`;
- `archetype`;
- `archetype_contrast`;
- `useful_to`;
- `data_caveat`;
- provider/model/prompt metadata;
- `completed_at`.

The snapshot uniqueness boundary is one completed row per account and input fingerprint. Re-running the snapshot with unchanged inputs should not create divergent public profile copy.

### Current Goodalexander Dry Run

The latest verified local dry run used account `acct_oauth_3c70e69ab7b8ef1fad3df508`.

Observed packet:

- eligible identity-cloud wallets: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`, `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx`;
- selected recipient: `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`;
- rewarded tasks counted: `12`;
- rewarded task PFT counted: `20.45`;
- paid production airdrop: `600 PFT`;
- alignment score: `0.06`;
- transaction: `B16678C024C0780D12227E9CC9FA4CCB1FA2BA3EC65341BFFAE40FC978FC6AB2`;
- pointer CID: `QmPyxEi3Sk9AXc6QCPJK2M11fb5okTmTuR21VXkxbTuaLo`.

### Live Issuance Boundary

Live issuance is owned by `server/profile-daily-airdrop-worker.js` when the worker is enabled. It claims a single `daily_airdrop` lease, scores eligible account/day packets, pays positive airdrops through the existing issuance path, and writes a Hive Mind Agent audit card. `scripts/profile-daily-airdrop-issue.mjs` remains available as a manual operator command for a specific completed run.

Issuance is fail-closed: after a run is claimed as `processing`, another worker cannot publish it. If a failure happens before PFT submission is attempted, the row becomes `failed` and can be retried. If a failure happens after PFT submission is attempted, the row stays `processing` until reconciliation or operator review proves whether a payment happened.

## Reviewer To Do List

Review implementation against this document (profile). Mark each item when verified.

### Memory Efficiency
- [ ] List and detail views read Postgres caches with documented caps or pagination.
- [ ] Async workers handle heavy model/IPFS work; primary UX path stays non-blocking.
- [ ] Public profile reads snapshot table; regeneration is async, not on every page load.
- [ ] NFT gallery paginated or capped; no unbounded metadata fetch.

### Code Quality
- [ ] Code references in doc resolve to existing modules and routes.
- [ ] Failure modes documented here have matching user-visible error handling.
- [ ] Deterministic metrics separated from model-generated role copy.
- [ ] Contribution tier calculation documented and test-covered.

### Coherence
- [ ] Surface behavior matches Architecture docs for cache vs canonical state.
- [ ] Hidden/not-exposed features labeled honestly if mentioned.
- [ ] Public fields match `public-profile-real-data-plan.md`; mocks removed where claimed.
- [ ] Daily airdrop private panel aligns with `daily-airdrop.md` scoring rules.

### Bloat
- [ ] Surface does not duplicate logic owned by shared modules or workers.
- [ ] UI state not duplicated in unrelated caches without invalidation rules.
- [ ] Profile view does not embed full task forensics or chat history.

### Security
- [ ] Account scoping enforced on all read/write API paths for this surface.
- [ ] Wallet-bound actions require linked unlocked wallet as documented.
- [ ] Public profile exposes only intended fields; private memory/diagnostic data excluded.
- [ ] NFT prompt series uses private ASSET pointers; production prompt path not in repo.

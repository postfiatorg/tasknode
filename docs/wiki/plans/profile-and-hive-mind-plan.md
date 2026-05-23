# Profile and Hive Mind Plan

Status: planning
Source references: PFTasks profile and network context systems were reviewed as historical reference only. This plan is for Task Node Official.

## Objective

Build a simple profile and hive-mind layer that helps members discover each other and lets the network propose useful tasks from deterministic shared state.

The immediate goal is not a large intelligence-report system. The immediate goal is:

1. a private profile page that makes the member's own reward history, skills, settings, and identity picture legible;
2. a public profile page that other members can trust for discovery;
3. a small profile batch job that refreshes the public/private profile from task history;
4. recommended connections derived from profile compatibility;
5. a later hive-mind board that accumulates profile state into network priorities and proposed tasks.

## PFTasks Research Summary

PFTasks had useful primitives:

- `profile_runs`: per-user, per-wallet, per-field batch outputs with `field`, `status`, `raw_output`, `extracted_output`, model metadata, and timestamps.
- `profile_settings`: publish flag, looking-for text, NFT profile-picture mode, selected NFT, and auto-NFT settings.
- `nft_mints`: generated image, IPFS metadata, token ID, tx hash, and mint status.
- Profile prompts: capabilities, expert knowledge, recommended connections, NFT image, alignment, ticker mapping, leaderboard summary, and daily airdrop.
- Network context primitives: `network_context_documents`, `user_redux_runs`, `hive_block_runs`, `board_tasks`, and a board manager that attempted to turn network context into tasks.

PFTasks also had patterns we should not carry forward:

- too many profile fields and independent prompt jobs;
- ticker-oriented profile identity;
- director-intelligence reports that are too broad for daily user comprehension;
- complicated board task schemas before the product surface is simple;
- user-driven and partly non-deterministic hive context instead of a repeatable state build.

The Task Node Official version should keep the durable concepts and drop the excess.

## Product Shape

### Private Profile

The private profile is for the logged-in member. It should answer: what does the system believe I am good at, what have I earned, what am I discoverable for, and what can I turn off?

Required panels:

- Profile picture: current generated NFT/profile image, generation status, selected image, and a regenerate action.
- Reward history: a clean PFT reward time series from `task_projections` / reward events, probably 30 and 90 day toggles.
- Skills: 5 to 12 concise skills derived from rewarded task history.
- Discoverability settings: public profile on/off, discoverable in recommendations on/off, network task availability on/off, alpha task availability on/off.
- Looking for: a short user-authored field for what kind of collaborators or opportunities the member wants.
- Recommended connections: ranked members with match reason and relevant skills.
- Task fit: simple statement of what kinds of tasks the network should offer the member.

Private settings must be account-scoped, not wallet-only. Wallets can change; the member identity owns the profile.

### Public Profile

The public profile is what another member can inspect.

Required panels:

- Profile picture / generated NFT.
- Handle / linked public identity.
- Skills and useful collaboration surface.
- Looking for.
- Reward credibility summary: total PFT rewarded, recent rewarded task count, last active reward date, and a small reward trend.
- Availability badges: network tasks available, alpha tasks available, open to connections.
- Recommended way to work with this member.

Do not expose private task details by default. Public profile should show derived skills and aggregate reward credibility, not raw evidence packets unless a later permission model supports it.

## Profile Batch Job V1

This should be one canonical async job, not a dozen unrelated profile jobs.

Name: `profile_snapshot_v1`

Trigger:

- user opens profile and no snapshot exists;
- rewarded task state changes;
- looking-for/discoverability settings change;
- manual regenerate from the private profile;
- scheduled refresh, at most daily per account unless task state changed.

Inputs:

- account identity and linked public handles;
- linked wallet addresses;
- current profile settings;
- current context document summary, bounded;
- rewarded task history from `task_projections` and forensics payload summaries;
- refused task count and refusal rate, aggregate only;
- pending/outstanding task counts, aggregate only;
- reward events and PFT time series;
- recent memory/deep memory only if needed to interpret task history, bounded and not public raw text.

Provider:

- Use OpenRouter `deepseek/deepseek-v4-pro` through the existing ZDR provider routing for the text profile summary.
- Do not bill the user for this background profile job in v1.
- Store provider, model, prompt version, input fingerprint, and output JSON.

Output JSON:

```json
{
  "profile_summary": "One short paragraph about what the member demonstrably does well.",
  "skills": [
    { "name": "Implement task audit UX", "confidence": 0.84, "evidence_count": 4 }
  ],
  "task_fit": ["frontend audit", "PFTL replay debugging", "verification workflow repair"],
  "discoverability_blurb": "Useful to members who need task loops made visible and reliable.",
  "recommended_visibility": "public|limited|private",
  "network_task_fit": "high|medium|low",
  "alpha_task_fit": "high|medium|low",
  "caveats": ["Reward history is sparse before May 2026."]
}
```

Rules:

- Derive skills from rewarded tasks first.
- Use refused and zero-reward tasks only as reliability/context signals, not as skills.
- Do not infer market tickers.
- Do not publish private content in the public snapshot.
- Keep skill names short, specific, and member-discovery oriented.

## NFT Profile Picture Generation

NFT generation should be a separate child job owned by the profile snapshot, because image generation is slower and more failure-prone than profile text.

The NFT art prompt itself must not be public. Task Node Official should not store the full NFT series prompt in `prompts/`, public NFT metadata, public profile JSON, or a plaintext database row. The canonical series prompt should be a private PFTL/IPFS asset pointer.

### Current App Implementation

The current app has the profile mock ported into the production profile route at `src/features/profile/ProfileView.jsx`. The initial render intentionally follows `mocks/profile_mock.jsx`; production wiring is attached behind the existing controls rather than changing the mock composition.

The profile NFT prompt path is server-side only:

- private prompt source: `private_prompts/profile_nft_image.md`
- tracked fallback/template: `prompts/profile_nft_image.placeholder.md`
- loader and placeholder renderer: `server/profile-nft-prompts.js`
- OpenAI image generation action: `server/profile-nft-generation.js`
- persisted NFT repository: `server/repositories/profile-nfts.js`
- mint preparation/submission action: `server/profile-nft-mint.js`
- HTTP endpoints: `GET /api/profile/nfts`, `POST /api/profile/nft/generate`, `POST /api/profile/nft/mint`
- database table: `profile_nfts`, from `server/db/migrations/018_profile_nfts.sql`
- smoke tests: `npm run profile-nft-prompt-smoke`, `npm run profile-nft-flow-smoke`

`private_prompts/` is ignored by git and Docker. The local private file can be copied from the historical PFTasks production prompt while the tracked placeholder keeps the app reproducible for open-source users. The prompt placeholders currently rendered are `___NFT_USER_DATA_REPLACED_HERE___`, `___USER_CONTEXT_DOCUMENT_CONTENT_REPLACED_HERE___`, and `< insert Random String>`.

The current generation endpoint uses OpenAI `gpt-image-2` through the Image API. It returns a base64 data URL for immediate display, pins the generated image to IPFS, and writes a `profile_nfts` row with the image CID, prompt digest, template digest, model metadata, and generation status. The private prompt body is never sent to the browser; the browser receives only the generated image, public image CID, and prompt digests.

Minting is split into an explicit wallet-signed flow:

1. Browser requests `POST /api/profile/nft/mint` with `phase: "prepare"` and a generated `nftId`.
2. Server validates the signed-in account and linked wallet, pins public XLS-24 metadata JSON with `image: "ipfs://<imageCid>"`, prepares a PFTL `NFTokenMint` transaction, and stores the prepared transaction JSON in `profile_nfts`.
3. Browser signs the prepared transaction with the unlocked local seed vault. The seed never leaves the browser.
4. Browser submits the signed blob through `POST /api/profile/nft/mint` with `phase: "submit"`.
5. Server validates that the signed transaction is an `NFTokenMint` for the linked wallet and prepared metadata URI, submits it to PFTL, and stores the tx hash and `NFTokenID` when available.

Current scope: generated images and public NFT metadata are pinned; prompt text stays private. The encrypted NFT prompt-series pointer and encrypted generation-run receipt remain the canonical public-hardening step before external launch.

### Private NFT Prompt-Series Pointer

Use the existing `pf.ptr` / `v4` pointer format rather than inventing a parallel NFT prompt registry.

Pointer memo:

- `MemoType`: `pf.ptr`
- `MemoFormat`: `v4`
- `kind`: `ASSET`
- `schema`: `1`
- `flags`: `encrypted`
- `thread_id`: stable NFT prompt series id, for example `nft_series_profile_avatar_v1`
- `cid`: encrypted IPFS payload CID

Encrypted IPFS payload schema:

```json
{
  "schema": "pf.asset.nft_prompt_series.v1",
  "series_id": "nft_series_profile_avatar_v1",
  "revision": 1,
  "title": "Profile Avatar Series",
  "status": "active",
  "prompt_body": "private prompt text goes here",
  "negative_prompt": "private negative prompt text goes here",
  "render_contract": {
    "input_schema": "pf.profile.nft_input.v1",
    "output_schema": "pf.profile.nft_output.v1",
    "allowed_public_metadata_fields": [
      "series_id",
      "series_revision",
      "prompt_digest",
      "image_cid",
      "metadata_cid"
    ]
  },
  "provider_policy": {
    "preferred_provider": "openai",
    "preferred_model": "gpt-image-2",
    "fallback_model": null
  },
  "previous_revision": null,
  "created_at": "2026-05-20T00:00:00.000Z"
}
```

Canonical digest:

- Serialize the unencrypted payload with stable JSON key ordering.
- Compute `sha256(canonical_json_bytes)`.
- Store that digest in Postgres and in generated NFT run receipts.
- Public metadata may expose the digest and series id. It must not expose `prompt_body`, `negative_prompt`, or the encrypted CID contents in plaintext.

Recipients:

- TaskNode service encryption key, so production workers can render the series.
- Prompt curator / authority wallet, so the series can be audited or migrated.
- Optional cold backup authority wallet.
- The end user does not need the private prompt to own or display the generated NFT.

Revision policy:

- Updating a series prompt publishes a new encrypted `pf.asset.nft_prompt_series.v1` payload and a new `pf.ptr/v4` `ASSET` pointer.
- Old prompt revisions remain immutable and replayable.
- The database caches the latest active pointer for speed, but the pointer history is the canonical source.

Inputs:

- public-safe profile summary;
- skills;
- task fit;
- high-level context motifs if allowed by settings;
- no wallet seeds, raw private memory, raw task evidence, private repo names, private URLs, or private chat excerpts.

Output:

- generated image asset;
- image CID;
- metadata CID;
- mint tx if minted;
- prompt series id;
- prompt series pointer tx hash;
- prompt series digest;
- private generation run pointer CID, if the run input must be replayed privately;
- status: `draft`, `generated`, `pinned`, `minted`, `failed`.

V1 can generate and pin first. Minting can be a second action so the UX does not pretend an image is on-chain before it is.

### NFT Generation Run Pointer

Each generated image should have a private run receipt. This keeps generation replayable without making the prompt public.

Encrypted IPFS payload schema:

```json
{
  "schema": "pf.profile.nft_generation_run.v1",
  "series_id": "nft_series_profile_avatar_v1",
  "series_revision": 1,
  "series_prompt_digest": "sha256:...",
  "series_pointer_tx_hash": "PFTL_TX_HASH",
  "profile_snapshot_id": "profile_snapshot_uuid",
  "profile_snapshot_digest": "sha256:...",
  "public_input_summary": {
    "skills": ["frontend audit", "verification workflow repair"],
    "task_fit": ["PFTL replay debugging"]
  },
  "private_input_digest": "sha256:...",
  "provider": "openai",
  "model": "gpt-image-2",
  "image_cid": "bafy...",
  "metadata_cid": "bafy...",
  "created_at": "2026-05-20T00:00:00.000Z"
}
```

This run receipt can also be referenced by a `pf.ptr/v4` `ASSET` pointer. The public NFT metadata should reference only the safe series commitment:

```json
{
  "name": "Task Node Profile Avatar",
  "image": "ipfs://...",
  "attributes": [
    { "trait_type": "Prompt Series", "value": "nft_series_profile_avatar_v1" },
    { "trait_type": "Prompt Digest", "value": "sha256:..." }
  ]
}
```

The full prompt remains private unless the authority later chooses to reveal that series revision.

## Recommended Connections

Recommended connections should be deterministic over profile snapshots.

Inputs:

- viewer profile snapshot;
- candidate public snapshots where `discoverable = true`;
- candidate looking-for text;
- candidate availability flags;
- lightweight interaction history later, not required for v1.

Ranking logic:

1. Filter out hidden profiles and the viewer's own account.
2. Score by skill/need complementarity.
3. Use reward credibility as a weak secondary signal.
4. Penalize stale profiles and high refusal rates when recommending someone for active work.
5. Return 5 to 10 recommendations.

Output row:

```json
{
  "candidate_account_id": "acct_...",
  "score": 87,
  "reason": "Strong fit for frontend task audit and PFTL replay debugging.",
  "shared_surface": ["task UX", "verification workflows"]
}
```

## Proposed Database Tables

### `profile_settings`

Account-owned mutable settings.

Fields:

- `account_id`
- `is_public`
- `discoverable`
- `network_tasks_enabled`
- `alpha_tasks_enabled`
- `looking_for`
- `pfp_mode`
- `selected_profile_nft_id`
- `updated_at`

### `profile_snapshots`

Latest and historical profile derivations.

Fields:

- `id`
- `account_id`
- `status`
- `input_fingerprint`
- `prompt_version`
- `provider`
- `model`
- `private_payload`
- `public_payload`
- `reward_summary`
- `source_task_ids`
- `generated_at`
- `error`

### `profile_reward_daily`

Fast chart data derived from task reward events.

Fields:

- `account_id`
- `wallet_address`
- `reward_date`
- `reward_pft`
- `reward_count`
- `updated_at`

### `profile_nfts`

Current profile picture generation and mint metadata.

Fields:

- `id`
- `account_id`
- `wallet_address`
- `title`
- `description`
- `status`
- `image_cid`
- `image_gateway_url`
- `image_mime_type`
- `image_size_bytes`
- `image_sha256`
- `metadata_cid`
- `metadata_uri`
- `metadata_json`
- `prompt_source`
- `prompt_digest`
- `template_digest`
- `model`
- `size`
- `quality`
- `output_format`
- `mint_tx_json`
- `tx_hash`
- `nft_token_id`
- `selected`
- `error`
- `generated_at`
- `prepared_at`
- `created_at`
- `updated_at`
- `minted_at`

Not yet implemented: prompt-series pointer cache fields and encrypted generation-run pointers. Those belong in a later hardening migration, not in the current `profile_nfts` table.

### `nft_prompt_series_cache`

Fast cache for private prompt-series pointers. This table does not store plaintext prompt bodies.

Fields:

- `series_id`
- `active_revision`
- `active_pointer_cid`
- `active_pointer_tx_hash`
- `active_prompt_digest`
- `status`
- `created_by_account_id`
- `updated_at`

### `profile_recommended_connections`

Materialized recommendations for fast UI.

Fields:

- `account_id`
- `candidate_account_id`
- `score`
- `reason`
- `shared_surface`
- `snapshot_id`
- `created_at`

## Profile UX Acceptance Criteria

- Private and public tabs render from database state, not mocks.
- The user can turn off public profile, recommendations, network task availability, and alpha task availability.
- Reward chart comes from real rewarded task events.
- Skills come from profile snapshot output and show the source snapshot time.
- Recommended connections are empty-state clean when no candidates exist.
- NFT image generation shows clear statuses: not generated, generating, generated, pinned, minted, failed.
- No profile field should expose raw private memory or private evidence unless explicitly designed.

## Hive Mind V1

The hive mind should be a simple deterministic board, not an intelligence-report wall.

User question it must answer:

> What is the network's priority right now, and what can I do?

### State Sources

The hive state should be built from:

- public profile snapshots;
- member availability settings;
- current task projections grouped by status;
- reward history and refusal rates;
- active network projects, if explicitly created;
- validator/operator state when available;
- human maintainer priority notes, versioned and timestamped.

### Network Priority Board

Use a Trello-like board with a small fixed set of columns:

- `Priority`: work the network currently wants done.
- `Open`: task candidates not assigned.
- `In progress`: accepted network tasks.
- `Review`: pending verification or authority review.
- `Done`: rewarded/completed.
- `Parked`: refused, stale, blocked, or not worth doing now.

Each card should have:

- title;
- objective;
- why it matters;
- required skills;
- suggested members;
- reward range;
- evidence requirement;
- source snapshot IDs;
- status;
- refusal count and refusal rate.

### Hive Batch Job V1

Name: `hive_board_snapshot_v1`

Trigger:

- scheduled every few hours;
- profile snapshot changes for enough accounts;
- task reward/refusal state changes;
- maintainer priority note changes.

Inputs:

- latest public profile snapshots;
- network/alpha availability flags;
- open task queue state;
- rewarded/refused task history;
- existing board cards;
- maintainer note.

Output:

```json
{
  "network_priority": "Make the Task Node task loop reliable enough for daily use.",
  "priority_reasons": ["Recent rewards cluster around task UX and verification repair."],
  "skill_gaps": ["validator operations", "public narrative distribution"],
  "recommended_cards": [
    {
      "title": "Audit task verification evidence states",
      "surface": "code_agent_workflow",
      "required_skills": ["verification workflow repair", "frontend audit"],
      "suggested_accounts": ["acct_..."],
      "reward_range_pft": [2, 6],
      "evidence_requirement": "Screenshot and code excerpt showing corrected state transitions."
    }
  ]
}
```

Provider:

- Use OpenAI `gpt-5.5-pro` through the Responses API for active project and board synthesis.
- Use `reasoning.effort = high`, structured JSON output, and async queue execution so the Hive page is never blocked by model latency.
- Keep prompts literal and source-bound.
- Store output and source snapshot IDs so board state is explainable.

### Hive Task Surfaces

Hive tasks can target these surfaces:

1. Publishing and amplifying social narratives.
2. Reviewing code and doing agentic workflows.
3. Meeting, interacting with, or recruiting members.
4. Highest-value current work not captured by a narrower category.
5. Running validators or operator infrastructure.

The board should not require the user to understand these categories. The UI should show a plain-English card and the reason the member was suggested.

### Deterministic Assignment Policy

Default behavior:

- Members are available for network and alpha tasks unless they turn those settings off.
- The hive can propose tasks to members.
- Refusal is allowed and should be measured, not punished blindly.
- High refusal rate should reduce automatic proposals until the profile/settings are refreshed.

Assignment inputs:

- skill match;
- availability flags;
- active task load;
- refusal rate by surface;
- recent reward quality;
- whether the task requires public work, private work, validator access, or social presence.

The task engine remains wallet/PFTL-native. The hive board is a cache and planning layer that proposes task requests/offers; it is not canonical task state.

## Proposed Hive Tables

### `hive_priority_snapshots`

Latest board synthesis and source IDs.

Fields:

- `id`
- `status`
- `input_fingerprint`
- `source_profile_snapshot_ids`
- `source_task_projection_ids`
- `maintainer_note_id`
- `provider`
- `model`
- `prompt_version`
- `summary_payload`
- `generated_at`
- `error`

### `hive_board_cards`

Trello-style deterministic cards.

Fields:

- `id`
- `snapshot_id`
- `column_key`
- `title`
- `objective`
- `surface`
- `required_skills`
- `suggested_account_ids`
- `reward_min_pft`
- `reward_max_pft`
- `evidence_requirement`
- `source_payload`
- `status`
- `created_at`
- `updated_at`

### `hive_member_task_preferences`

Can be folded into `profile_settings` at first. Break it out later only if needed.

Fields:

- `account_id`
- `network_tasks_enabled`
- `alpha_tasks_enabled`
- `max_active_network_tasks`
- `surfaces_enabled`
- `updated_at`

## Hive UX Acceptance Criteria

- A member can open Hive Mind and immediately see one network priority sentence.
- Board columns are simple and finite.
- Every proposed card shows why it exists and which source snapshot produced it.
- Member settings can turn off network and alpha task availability.
- Task proposals respect active load and refusal rate.
- The board does not replace the PFTL task lifecycle; accepted tasks still become real task offers/projections.

## Implementation Sequence

### Phase 1: Profile Foundation

1. Add profile settings, profile snapshots, reward daily, NFT, and recommendation tables.
2. Build account-scoped profile repository.
3. Replace current mock profile panels with empty states backed by API data.
4. Add discoverability settings and looking-for edit/save.
5. Build reward history aggregation from task reward events.

### Phase 2: Profile Batch Job

1. Add `profile_snapshot_v1` prompt under `prompts/profile/`.
2. Add async profile job table or reuse the existing worker pattern for jobs.
3. Generate skills, task fit, discoverability blurb, and public/private payloads.
4. Store model metadata and source task IDs.
5. Add smoke tests with fixture task projections.

### Phase 3: NFT Profile Picture

1. Add profile NFT job and status model.
2. Generate public-safe image prompt from profile snapshot.
3. Pin generated image/metadata to IPFS.
4. Add optional mint action after generated image is visible.

### Phase 4: Recommended Connections

1. Add recommendation prompt using viewer/candidate profile snapshots.
2. Materialize top 5 to 10 recommendations.
3. Render recommended connections on private profile.
4. Add public profile link target for candidates.

### Phase 5: Hive Board Foundation

1. Add maintainer priority note storage.
2. Add hive snapshot and board card tables.
3. Build deterministic board generator from profile snapshots, tasks, refusal rates, and maintainer note.
4. Render a simple Hive Mind board in docs/app surface.
5. Only after board cards are reliable, wire task proposal actions into the task request/offer pipeline.

## Done Definition

Profile is done when a logged-in member can:

- open Profile and see real reward history;
- generate or view a profile NFT image state;
- see skills derived from rewarded task history;
- edit looking-for and discoverability settings;
- see recommended connections derived from other public profiles;
- open their public profile and verify only public-safe information is visible.

Hive Mind v1 is done when a member can:

- open Hive Mind and see the network priority;
- inspect a small deterministic board;
- understand why each card exists;
- see suggested members and required skills;
- disable their own network/alpha task availability;
- receive task proposals from board cards through the normal task lifecycle.

## Reviewer To Do List

Review implementation against this document (profile and hive mind plan). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.

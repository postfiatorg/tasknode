# Public Profile Real Data Plan

Status: implemented v1

Objective: finish the public profile page by replacing mock profile identity, role copy, credentials, and NFT gallery state with account-scoped Postgres reads and one small DeepSeek V4 Pro ZDR profile snapshot job.

This plan keeps the existing public profile visual language. It only deletes the fields that are not real yet and wires the remaining surface to actual profile data.

## Pre-V1 Problem

The public profile rendered a polished mock, not a member profile backed by Task Node state.

Implemented v1 moves the public profile to `GET /api/profile/public` and `POST /api/profile/public/regenerate`. The deleted mock fields are connections, member-since, Sybil score, and graph-inference language. The remaining public page fields now come from deterministic profile metrics, real `profile_nfts` rows, and a persisted `profile_public_snapshots` DeepSeek V4 Pro ZDR output.

Current vapor surfaces in `src/features/profile/ProfileView.jsx`:

- `IdentityHero`: hardcoded wallet, active time, member-since text, connection count, and lifetime PFT.
- `NetworkRole`: hardcoded role title, summary, skill tags, and archetype.
- `CredentialTrio`: hardcoded Sybil score, alignment score, and contribution tier.
- `NFTGallery`: falls back to local mock `NFT_DATA` instead of requiring real generated or minted profile NFTs.
- `ConnectionsCard`: mock recommended connections.

The page should not imply a connection graph, Sybil risk system, member-since history, or public NFT ownership unless those systems are actually present.

## Product Scope

Keep:

- wallet / identity hero;
- generated profile NFT image;
- lifetime earned PFT;
- alignment score;
- contribution tier;
- generated role title, summary, skills, and archetype;
- NFT gallery;
- About, if it is user-authored or empty-state backed.

Delete or hide for v1:

- Connections and recommended connections;
- member-since;
- connection count;
- Sybil score;
- `Network role · machine-read`;
- `Inferred from on-ledger activity, task history, and connection graph`;
- fake NFT fallback gallery on the public page.

## Data Ownership

The public profile is account-scoped, not wallet-scoped.

Wallets are inputs to the identity cloud. The profile snapshot belongs to `account_id`, and the public display chooses wallet facts from the account wallet cloud.

Deterministic fields must be calculated in code:

- primary public wallet;
- lifetime task reward PFT;
- lifetime issued daily airdrop PFT;
- total lifetime earned PFT;
- recent rewarded task count;
- alignment score;
- contribution tier;
- active/generated/minted profile NFTs;
- public visibility setting.

DeepSeek may generate only interpretive profile copy:

- role title;
- one short role summary;
- skill tags;
- archetype;
- useful-to/collaboration sentence;
- caveats when data is thin.

The model must never invent numeric scores, task counts, reward totals, wallet addresses, NFT statuses, or percentile ranks.

## Public Profile Snapshot Job

Name: `public_profile_snapshot_v1`

Prompt file: `prompts/profile/public_profile_snapshot_v1.md`

Provider:

- OpenRouter private route;
- model: `deepseek/deepseek-v4-pro`;
- ZDR required;
- `data_collection: "deny"`;
- `require_parameters: true`;
- temperature `0`;
- structured JSON output;
- no user billing in v1.

Triggers:

- user opens the public profile and no completed snapshot exists;
- user clicks Regenerate public profile from the private profile;
- a task reward event changes account reward state;
- a profile NFT is generated or minted;
- daily scheduled refresh, at most once per account per UTC day unless task reward state changed.

The job is asynchronous. The public page should render deterministic metrics immediately and show the last completed role snapshot while a refresh is pending.

## Snapshot Input Packet

The input packet should be compact and auditable.

Required fields:

```json
{
  "schema": "pf.profile.public_snapshot_input.v1",
  "account_id": "acct_...",
  "wallets": [
    {
      "wallet_address": "r...",
      "active": true,
      "task_count": 17,
      "rewarded_task_count": 12,
      "reward_pft": "20.45",
      "last_task_at": "2026-05-20T17:40:48.585Z"
    }
  ],
  "reward_totals": {
    "lifetime_task_reward_pft": "20.45",
    "lifetime_airdrop_pft": "600",
    "lifetime_total_pft": "620.45",
    "trailing_30d_rewarded_tasks": 12,
    "trailing_30d_task_reward_pft": "20.45"
  },
  "alignment": {
    "score_0_100": 6,
    "source": "profile_daily_airdrop_runs.alignment_score_7d",
    "actual_airdrop_pft_7d": "600",
    "max_possible_airdrop_pft_7d": "10000"
  },
  "contribution_tier": {
    "tier": "T2",
    "max_tier": "T4",
    "basis": "12 rewarded tasks and 20.45 task-reward PFT in trailing 30 days"
  },
  "recent_rewarded_tasks": [
    {
      "title": "Fix Task Node Timestamp Rendering Across UI",
      "kind": "engineering",
      "reward_paid_pft": "2.40",
      "reward_reason": "Short verifier-facing reason from reward payload",
      "rewarded_at": "2026-05-20T18:00:00.000Z"
    }
  ],
  "nfts": [
    {
      "title": "Task Node Profile NFT",
      "status": "minted",
      "image_cid": "Qm...",
      "metadata_cid": "Qm...",
      "mint_tx_hash": "ABC..."
    }
  ]
}
```

Excluded from the model packet:

- raw private context document;
- raw chat memory;
- raw evidence files;
- private NFT prompt body;
- hidden wallet seeds or custody data.

The public role should come from task/reward/NFT/profile facts, not from private chat text.

## Prompt Contract

The prompt should be simple and operational.

Draft prompt intent:

```text
You write a public member profile from a Task Node profile packet.

Use only the provided packet. Do not invent task counts, rewards, rankings, wallets, NFT state, or social graph facts.

Describe what this member has demonstrably contributed, what they are useful for, and what kind of collaborators would benefit from working with them.

Prefer concrete capability language over status language.

Return JSON only with:
- role_title: 3 to 6 words
- role_summary: 2 to 3 sentences
- skills: 4 to 7 short skill labels
- archetype: one of Builder, Operator, Researcher, Auditor, Designer, Connector
- archetype_contrast: optional short phrase explaining what this profile is not
- useful_to: one sentence
- data_caveat: one sentence when the evidence base is thin, otherwise empty string
```

Example output shape:

```json
{
  "role_title": "Network Verification Engineer",
  "role_summary": "Builds deterministic reward composers and verification tooling for the Task Node loop. Strong on CLI-first scoring, auditable triage, and reducer pipelines.",
  "skills": [
    "Backend systems",
    "Deterministic tooling",
    "CLI-first scoring",
    "Verification policy",
    "Python reducers",
    "Ledger ops"
  ],
  "archetype": "Builder",
  "archetype_contrast": "not Validator, not Curator",
  "useful_to": "Most useful to backend engineers, ledger-ops folks, and anyone building validation tools.",
  "data_caveat": ""
}
```

This example is not an implementation fixture. The implementation should pass the actual account task packet to DeepSeek and persist the returned JSON.

## Contribution Tier

Contribution level must be deterministic.

V1 should calculate the internal tier from task work only, not daily airdrops. Airdrops can be displayed as earned PFT, but using airdrops to define contribution level creates circular scoring.

Proposed first-pass thresholds:

```text
T0: no positive task rewards
T1: at least 1 rewarded task or at least 1 task-reward PFT in trailing 30 days
T2: at least 5 rewarded tasks or at least 10 task-reward PFT in trailing 30 days
T3: at least 12 rewarded tasks or at least 35 task-reward PFT in trailing 30 days
T4: at least 25 rewarded tasks or at least 100 task-reward PFT in trailing 30 days
```

Display text should be factual:

- `12 rewarded tasks in 30 days`;
- `20.45 task-reward PFT in 30 days`;
- a human level label such as `Active contributor`, `Core contributor`, or `Network operator`.

Do not show `Top 18%` until a real percentile table exists across active public accounts.

## Alignment Score

Alignment score remains deterministic.

Preferred source:

- latest completed `profile_daily_airdrop_runs.alignment_score_7d * 100`;
- expose source details in hover/help text;
- if no daily airdrop run exists, show `Not scored yet` rather than a fake score.

The public profile should not show the private airdrop reasoning unless we explicitly decide to make that field public. V1 can show the score and short formula only.

## NFT Gallery

NFT gallery must read real profile NFT rows.

Data source:

- `profile_nfts` from `server/repositories/profile-nfts.js`;
- only account-owned rows;
- only public-safe fields returned to browser;
- generated image CID, image gateway URL, metadata CID, mint tx hash, status, created/minted time, title.

Rules:

- If real NFTs exist, render them.
- If none exist, show a calm empty state with a private-profile call to action.
- Do not use `NFT_DATA` fallback on public profile.
- Do not expose the private NFT generation prompt.
- If an image gateway fails, try alternate IPFS gateways, then show a non-mock broken-image state tied to the real row.

## Database Plan

Add `profile_public_snapshots`.

Suggested columns:

```sql
account_id text not null,
snapshot_id text primary key,
status text not null,
input_fingerprint text not null,
input_snapshot jsonb not null,
output_json jsonb,
role_title text,
role_summary text,
skills jsonb,
archetype text,
archetype_contrast text,
useful_to text,
data_caveat text,
provider text,
model text,
prompt_version text,
prompt_digest text,
output_digest text,
started_at timestamptz,
completed_at timestamptz,
error_message text,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

Indexes:

- `(account_id, status, completed_at desc)`;
- unique completed snapshot per `(account_id, input_fingerprint)` to avoid repeated identical jobs.

The API should return the latest completed snapshot plus deterministic live metrics. If a refresh is queued or running, include `snapshot_refresh_status`.

## API Plan

Add or extend profile routes in `server/profile-routes.js`.

Endpoints:

- `GET /api/profile/public`: signed-in user reading their own public profile preview.
- `GET /api/profile/public/:accountId`: later member discovery route, gated by public profile setting.
- `POST /api/profile/public/regenerate`: signed-in manual snapshot refresh.

Response contract:

```json
{
  "identity": {
    "account_id": "acct_...",
    "primary_wallet": "r...",
    "display_wallet": "r..."
  },
  "metrics": {
    "lifetime_task_reward_pft": "20.45",
    "lifetime_airdrop_pft": "600",
    "lifetime_total_pft": "620.45",
    "alignment_score_0_100": 6,
    "contribution_tier": "T2",
    "contribution_tier_max": "T4",
    "contribution_tier_basis": "12 rewarded tasks in 30 days"
  },
  "role": {
    "role_title": "Network Verification Engineer",
    "role_summary": "...",
    "skills": ["Backend systems"],
    "archetype": "Builder",
    "archetype_contrast": "not Validator, not Curator",
    "useful_to": "...",
    "data_caveat": ""
  },
  "nfts": [],
  "snapshot": {
    "status": "completed",
    "completed_at": "2026-05-21T00:00:00.000Z",
    "provider": "openrouter",
    "model": "deepseek/deepseek-v4-pro",
    "prompt_version": "public_profile_snapshot_v1"
  }
}
```

## Frontend Plan

Patch `src/features/profile/ProfileView.jsx` without redesigning the mock.

Component changes:

- `PublicProfile`: fetch public profile API state and pass data down.
- `IdentityHero`: render real primary wallet, real NFT/profile image, and real lifetime earned PFT; remove member-since and connection count.
- `NetworkRole`: rename internally to `ProfileRole`; remove the eyebrow/subline; render DeepSeek snapshot role fields with loading and empty states.
- `CredentialTrio`: become a two-item credential strip: Alignment Score and Contribution Tier.
- `NFTGallery`: require real rows for public rendering; no `NFT_DATA` fallback on public page.
- `ConnectionsCard`: remove from public profile v1.

Public empty states:

- no wallet: `No public wallet linked yet`;
- no role snapshot: `Profile snapshot pending`;
- no alignment score: `Not scored yet`;
- no NFTs: `No public profile NFTs yet`;
- public profile disabled: show private-only notice to owner and 404/hidden response to others later.

## Verification Plan

Before calling this finished:

1. Run migration and seed a public profile snapshot for the current account.
2. Run the DeepSeek V4 Pro ZDR job against the real goodalexander task packet.
3. Confirm the public profile no longer renders Sybil score, member-since, connection count, or recommended connections.
4. Confirm the NFT gallery shows only real `profile_nfts` rows.
5. Confirm alignment score and contribution tier match backend deterministic calculations.
6. Inspect the rendered public page at `http://localhost:5174/#profile`.
7. Capture screenshots for private and public profile tabs.
8. Run:

```bash
npm run quality
npm run build
npm run route-smoke
git diff --check
```

## Done Definition

Public profile is done for v1 only when:

- every visible public field has a real API source or an explicit empty state;
- DeepSeek-generated role copy is persisted and reproducible from a saved input snapshot;
- numeric credentials are deterministic and auditable;
- NFT gallery renders real generated/minted assets only;
- connections, member-since, Sybil score, and fake graph language are gone;
- the in-app docs and prompt index describe the runtime paths;
- the page has been screenshot-verified in the running local app.

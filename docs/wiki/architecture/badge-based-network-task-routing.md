# Badge-Based Network Task Routing

This is the implementation spec for replacing loose Network Task routing hints
with explicit badge eligibility state. A user should be able to operate under
one or more verified badges, and the Board Manager must only generate Network
Tasks that match the selected candidate's verified badge state.

The core rule is simple: prompts may recommend work, but routing eligibility,
reward caps, and evidence requirements must be enforced in code before a
Network Task offer is generated and again before a reward is finalized.

## Current Problem

The existing Board Manager capability instrumentation is advisory. It can tell
the model that a user appears to lack a capability, but it does not stop the
runtime from creating a Network Task allocation when the model chooses that
candidate. The current capacity gate checks whether a user already has
outstanding Network Task work, not whether the user can actually perform the
class of work being routed.

This causes bad routing. A community user can be routed private repository,
sybil-remediation, reward-accounting, or core protocol work even when the only
work they should receive is community, QA, onboarding, amplification, or proof
of access.

## Goals

- Make eligible user badges first-class persisted state.
- Show eligible and in-progress badges on the private Profile page.
- Render verified public badge symbols on public profiles.
- Let users operate under a specific verified badge for each Network Task.
- Enforce badge eligibility before Board Manager Network Task generation.
- Enforce badge payout caps before task offer publication and reward finality.
- Require every user-facing Network Task to include Discord announcement proof:
  either a specific Discord message id/link or a screenshot of the announcement.
- Preserve privacy: private repo membership, admin authority, exact internal
  channels, and sensitive proof artifacts are not exposed publicly.

## Non-Goals

- Badges are not bans.
- Badge NFTs are not the source of truth.
- Network Diagnostic Reports and self-written profile claims do not grant
  badges by themselves.
- The Board Manager model must not be trusted as the enforcement boundary.

## Pilot Scope

The first implemented Profile surface is deliberately narrow:

- `kol`: public amplification identity, backed by linked X and objective
  follower metrics.
- `core_contributor`: sanctioned repo contributor identity, backed by linked
  GitHub and a Task Node sanctioned GitHub handle list. This avoids asking users
  to expose private repository inventory through broad GitHub OAuth scopes.
- `qa_worker`: product QA identity, backed by linked Telegram, linked Discord,
  and at least one recorded USDC chat wallet top-up in the billing ledger.
- `expert`: domain expertise identity, backed by at least 20 completed Personal
  tasks and a harsh GLM 5.2 review of the latest 20 Personal tasks against a
  user-supplied expert topic.
- `project_leader`: discretionary Hive project authority, backed by a backend
  allowlist of approved Hive handles. Project Leader inputs may define special
  new projects, including open-source projects, for Board Manager consideration.

No other user-facing badge lanes are active in this rollout.

## Badge Catalog

The badge catalog should be stored in a durable table and seeded by migration.
The initial catalog is:

| Badge | Symbol key | Eligibility | Allowed Network Task lane | Max payout |
| --- | --- | --- | --- | --- |
| `kol` | `megaphone` | User must link X. The X API follower count must show 5,000 or more followers. | Amplification, narrative distribution, public announcement, article distribution. | 20,000 PFT per X post; 50,000 PFT per Medium article. |
| `core_contributor` | `git_pull_request` | User must link GitHub and the linked GitHub handle must appear in the Task Node sanctioned Core Contributor list. Repo access should be managed by Post Fiat outside broad user OAuth consent. | Private repo code tasks, production fixes, sanctioned core implementation. | 30,000 PFT per task. |
| `expert` | `graduation_cap` | User must have at least 20 completed Personal tasks, enter a specific expert topic, and pass a harsh Ambient GLM 5.2 review over the latest 20 Personal tasks with a server-enforced score of 80 or higher and no disqualifying concerns. | Domain analysis grounded in verified personal work, expert review, domain-specific contribution bundles. | 30,000 PFT per 5-task bundle. |
| `project_leader` | `crown` | Discretionary backend approval by Hive handle. Initial approved handles: `zoz`, `donravle`, `georgl0nggamma`, `jollydinger`, `nydiokar`, `hitori`, `wizbubba`, `diamond-hand-honcho`, and `goodalexander`. | Define special new projects, including open-source projects, through Hive Chat input. | Discretionary. |
| `qa_worker` | `bug` | User must link Telegram and Discord, and backend billing must show at least one USDC chat wallet top-up from the user account. QA reports must include screenshots or equivalent repro evidence per task. | Product QA reports, repro packets, workflow friction reports. | 5,000 PFT per QA report. |

The symbol keys should map to UI icons. The frontend can use lucide icons where
available: `Megaphone`, `GitPullRequest`, `GraduationCap`, `Crown`, and `Bug`.

## Identity Approval Method

Badges depend on approved identities. Identity approval is the method that
turns a linked or claimed external account into routing-usable state. The flow
must be:

1. The user links or claims an identity from the private Profile page.
2. Task Node verifies control through OAuth where possible: X, GitHub, Discord,
   Telegram, or another provider already wired through connected accounts.
3. Automated resolvers or reviewed operators inspect objective evidence such as
   X follower metrics, sanctioned GitHub handles, QA access state, Expert review
   state, or a manual Project Leader grant.
4. A durable approval row records the identity, scope, trust level, evidence,
   verifier, expiry, and revocation state.
5. Badge verification consumes those approval rows. Board Manager routing reads
   the badge and identity approval state, not raw profile prose.

Trust levels:

- `L0 self_claimed`: user typed a handle or URL. It is visible privately but
  cannot authorize routing.
- `L1 linked_provider`: OAuth or signed provider login proves control of the
  external account.
- `L2 reviewed_external_evidence`: an operator or verifier reviewed external
  evidence, but it is not enough for a production routing lane.
- `L3 metric_or_access_verified`: follower count, repo access, accepted PR,
  app usage, deposit, or other badge-specific metric was
  verified.
- `L4 operator_sanctioned`: GoodAlexander, Nazgul, or another configured core
  verifier explicitly approved the identity/scope. This is required for Project
  Leader and sensitive production work.

Add explicit identity approval state:

```sql
account_identity_approvals (
  id text primary key,
  account_id text not null,
  provider text not null default '',
  provider_user_id_hash text not null default '',
  public_handle text not null default '',
  profile_url text not null default '',
  approval_level text not null default 'L0',
  approval_scope text not null default '',
  status text not null default 'active',
  approved_by_account_id text not null default '',
  approved_by_operator text not null default '',
  evidence_json jsonb not null default '{}'::jsonb,
  metrics_json jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Allowed `account_identity_approvals.status` values:

- `active`
- `expired`
- `revoked`
- `superseded`

Provider-linked identity from `accountIdentityProfile.aliases` is only an
input. It can satisfy `L1 linked_provider`, but it does not by itself prove KOL
audience size, repo pull access, continuous QA
usage, or GoodAlexander sanctioning.

Badge-specific identity approval requirements:

- KOL: requires `L1 linked_provider` for X and `L3 metric_or_access_verified`
  for audience size. X follower count must be resolved server-side from the X
  API using User Lookup with `user.fields=public_metrics`; the approval should
  store `public_metrics.followers_count`, X user id, username, lookup timestamp,
  and provider response digest in `metrics_json`. User screenshots are fallback
  evidence only when the API is unavailable or for non-X platforms that do not
  have a configured resolver.
  Runtime KOL projections must preserve the linked X username and profile URL
  alongside `followersCount` before writing `account_network_badges`; otherwise
  downstream Hive reports can verify audience size but cannot name the operator
  without falling back to app-level public handles.
- Core Contributor: requires `L1 linked_provider` for GitHub and `L3` Task Node
  sanctioning for that GitHub handle. The proof refresh must keep GitHub OAuth
  at normal identity scope (`user:email`) and must not request `repo`,
  `read:org`, or private repository inventory. Task Node compares the OAuth-
  verified GitHub login to a configured sanctioned handle list, initially
  configured by `TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES` with `goodalexander`
  as the development/default seed. Store GitHub user id, login, checked
  timestamp, proof method, and matched handle in `metrics_json`. The current
  default seed mirrors the Post Fiat GitHub contributor surface visible to the
  operator token: `0xpostfiat`, `DRavlic`, `goodalexander`, `IridiumMaster`,
  `Pleometric`, and `postfiat-agent`. Production can override the list with
  `TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES`. Actual repository access should be
  granted and audited in GitHub/Post Fiat admin surfaces, not through a broad
  Task Node user OAuth prompt. The verified approval can later create or satisfy
  a scoped `repo_pr_access` capability row from that internal state.
- Expert: requires backend-derived `L3 metric_or_access_verified` evidence from
  completed Task Node Personal work. The private Profile card asks the user for
  the topic they are expert in or want Expert rewards for. The server then sends
  the latest 20 completed Personal task packets to Ambient `z-ai/glm-5.2`
  with a harsh grading prompt and structured JSON output. The model returns a
  0-100 score, label, strengths, weaknesses, and disqualifying concerns. The
  server, not the model alone, grants the badge only when the account has 20 or
  more completed Personal tasks, the review covers the current latest-20 task
  set, the score is at least 80, and disqualifying concerns are empty.
- Project Leader: requires `L4 operator_sanctioned` discretionary approval.
  The current implementation is a backend Hive-handle allowlist in
  `server/project-leader-badge.js`, overridable by
  `TASKNODE_PROJECT_LEADER_HIVE_HANDLES`. Project Leader inputs are added to
  Hive source packets and Board Manager decision packets as `projectLeaderInputs`
  before the manager chooses an action. When the Board Manager creates a project
  from that authority, the action hook records `project_leader_authority` in the
  project metadata and stores the source entry ids in `source_inputs_json`.
- QA Worker: requires `L1 linked_provider` for Telegram and Discord, plus
  backend-derived `L3 metric_or_access_verified` evidence that the account has
  at least one `ethereum_deposit` billing credit with `metadata.asset = "USDC"`.
  Screenshots are required per QA report, not as the identity approval itself.

## Badge State Model

Add durable state instead of relying on profile prose:

```sql
network_badge_definitions (
  badge_id text primary key,
  label text not null,
  symbol_key text not null,
  public_description text not null default '',
  active boolean not null default true,
  default_public boolean not null default true,
  max_payout_pft numeric not null default 0,
  payout_policy_json jsonb not null default '{}'::jsonb,
  eligibility_policy_json jsonb not null default '{}'::jsonb,
  allowed_work_types_json jsonb not null default '[]'::jsonb,
  required_provider_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

account_network_badges (
  id text primary key,
  account_id text not null,
  badge_id text not null references network_badge_definitions(badge_id),
  status text not null default 'unverified',
  public_visible boolean not null default true,
  selected_default boolean not null default false,
  verified_by_account_id text not null default '',
  verified_by_operator text not null default '',
  evidence_task_id text not null default '',
  evidence_url_or_ref text not null default '',
  evidence_json jsonb not null default '{}'::jsonb,
  validated_metrics_json jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, badge_id)
);
```

Allowed `account_network_badges.status` values:

- `unverified`: shown as possible but not usable for routing.
- `needs_evidence`: the user started qualification but evidence is incomplete.
- `verifying`: evidence exists and needs operator or automated review.
- `verified`: usable for routing if not expired or revoked.
- `expired`: no longer usable until refreshed.
- `revoked`: no longer usable and should show privately with reason.
- `rejected`: reviewed and denied.

Badge state should also project into existing capability state when useful. For
example, `core_contributor` should create or depend on a scoped verified
`board_manager_capability_profiles` row with `capability_type = repo_pr_access`
and a scope digest for `github:postfiatorg/tasknodeofficial` or another
sanctioned repo. The public badge is the visible credential. The capability row
is the scoped access proof.

## Project And Work Requirements

Add a board/project requirement map so the system knows which badges can receive
which work:

```sql
network_project_badge_requirements (
  id text primary key,
  project_id text not null,
  work_type text not null,
  required_badge_id text not null references network_badge_definitions(badge_id),
  capability_type text not null default '',
  scope_label text not null default '',
  scope_digest text not null default '',
  max_payout_override_pft numeric,
  active boolean not null default true,
  created_by_account_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Examples:

- `private_repo_code` requires `core_contributor` and a matching
  `repo_pr_access` capability.
- `code_review` requires `core_contributor`.
- Sybil/enforcement work is not routed to user badge lanes unless explicitly
  converted into public QA or evidence-review work.
- `amplification_x` requires `kol`.
- `qa_report` requires `qa_worker`.
- `expert_bundle` requires `expert`.
- `special_project_definition` requires `project_leader`.

## Profile UX

Private Profile should show:

- linked provider identities from `accountIdentityProfile.aliases`;
- identity approval rows and trust levels that are active, expired, revoked, or
  rejected;
- verified badges the user can operate under;
- missing badge requirements;
- unavailable badge types with the minimum qualification;
- the default selected operating badge;
- evidence links or task ids visible only to the signed-in user and operators;
- expiry, revocation, or rejection status.

The initial private Profile UX shell exists in
`src/features/profile/ProfileView.jsx` as `NetworkBadgesPanel`. It renders
linked X/GitHub/Telegram/Discord state from the current session and the pilot
KOL, Core Contributor, Expert, Project Leader, and QA Worker badge cards with
requirements, symbols, progress, status chips, lanes, and payout caps. It now
includes a `Sync routing badges` action backed by
`POST /api/profile/network-badges/refresh`, which materializes the current
verified pilot badge projection into durable approval rows and badge rows.
`GET /api/profile/network-badges` returns the signed-in user's durable approval
rows and badge state for private inspection. Users cannot create approval
requests from Profile; objective provider syncs, Expert evaluation, and manual
core-team Project Leader grants produce the durable badge state. Operators can
still approve, revoke, expire, and select defaults through the admin tooling.

For the KOL pilot, the linked-provider gate is X only. Once X is linked, the
card should move to a proof/audience state until the X follower resolver is
recorded. It should not ask for any additional linked identity or Discord
introduction proof for KOL status.

X OAuth profile fetches must request `user.fields=public_metrics`, persist
`public_metrics.followers_count` on the linked provider, and project the safe
`followersCount` value into `session.identityProfile.aliases[].metrics`.
Existing X links created before that metric was stored should display a refresh
state, not a false failure.
The KOL card must include an X refresh/re-link action that starts the existing
signed-in X account-link OAuth flow so old links can import follower metrics
without sending the user to another settings surface.

For the Core Contributor pilot, normal GitHub login and Core Contributor proof
both stay at `user:email`. The private Profile Core Contributor card must
include a GitHub refresh/re-link action that starts the existing signed-in
GitHub account-link OAuth flow with a `core_contributor` proof intent. That
proof intent records safe `coreContributorAccess` metrics on the linked GitHub
alias and marks the card ready once the OAuth-verified GitHub handle is on the
sanctioned Core Contributor handle list.

For the QA Worker pilot, the linked-provider gates are Telegram and Discord.
The money gate is objective backend state: `server/app-state.js` projects
`session.identityProfile.qaWorkerAccess.usdcTopUp` by querying
`server/repositories/chat-billing.js` for at least one credit with
`source = "ethereum_deposit"` and `metadata.asset = "USDC"`. A non-USDC credit
or a self-reported screenshot does not satisfy the identity badge. Individual
QA Network Tasks can still require screenshots, message ids, repro steps, and
public artifact proof as task-level evidence. The private Profile QA Worker
card should include a Discord connect/re-link action that starts the existing
signed-in Discord account-link OAuth flow.

For the Expert pilot, the private Profile card should show a text input with
copy equivalent to "What are you an expert in?", the count of completed Personal
tasks, the latest GLM 5.2 score, and an Evaluate/Re-run action. The action calls
`POST /api/profile/expert/evaluate` with `{ "topic": "..." }`. The endpoint must
read task projections server-side, refuse to call the model until the account
has at least 20 completed Personal tasks, and persist the latest Expert review
on the account. The persisted review is private badge state until public badge
rendering and Board Manager enforcement consume the durable badge model.

Required private Profile states:

- `Available`: default or fully verified badge is usable.
- `Needs link`: required provider identity is absent.
- `Needs proof`: provider is linked but metric/access/sanction evidence is
  missing.
- `Verifying`: evidence was submitted and awaits automated or operator review.
- `Verified`: badge can be selected for routing.
- `Expired`: proof must be refreshed.
- `Revoked` or `Rejected`: visible privately with reason.

Public Profile should show:

- only verified, public-visible badges;
- icon, label, brief public description, and verified date;
- no raw private evidence;
- no private repo/channel membership labels unless the verifier marked a safe
  public scope label;
- selected profile NFT as it works today, with badges rendered as separate
  trust symbols.

Implementation touchpoints:

- `server/profile-routes.js`
- `server/account-identity.js`
- `server/auth-connected-accounts.js`
- `server/app-state.js`
- `server/repositories/chat-billing.js`
- `server/repositories/profile-public.js`
- `server/profile-public-snapshot.js`
- `src/features/profile/ProfileView.jsx`
- `src/features/profile/PublicProfileView.jsx`
- `src/features/profile/ProfileIdentityCard.jsx`

## GoodAlexander Project Leader View

Project Leader sanctioning must have a GoodAlexander-only or operator-only
view. It should list approved Hive handles, current special project proposals,
sanction status, and evidence. This view must not appear in the public profile
or public Hive project page unless the project is explicitly public.

Suggested state:

- `sanctioned_by_account_id`
- `sanctioned_by_handle`
- `sanctioned_at`
- `sanction_scope`
- `private_notes`
- `public_label`

The Board Manager may only treat Hive Chat input as special/open-source project
authority when the source handle has the backend-approved Project Leader badge.

## Discord Evidence Requirement

Every user-facing Network Task must require Discord announcement evidence.

The generated task must tell the contributor to provide one of:

- a Discord message id or message link from an approved Post Fiat channel; or
- a screenshot showing the announcement in the approved channel.

The announcement should identify the task and the public work artifact without
leaking private credentials, secrets, or private repo content. Sensitive tasks
can use an approved private operator channel, but the task evidence still needs
a message id/link or screenshot.

The task generator must add this to `Verification Requirements` for every
Network Task. The review worker must treat missing Discord announcement evidence
as a blocking verification issue before reward finality. When a Discord bot
integration is available, message ids should be resolved through the bot. Until
then, screenshots remain acceptable but self-attested.

The review worker supports two deployment-time controls:

- `TASKNODE_DISCORD_ALLOWED_CHANNEL_IDS` /
  `TASKNODE_DISCORD_ANNOUNCEMENT_CHANNEL_IDS` and
  `TASKNODE_DISCORD_ALLOWED_GUILD_IDS` /
  `TASKNODE_DISCORD_ANNOUNCEMENT_GUILD_IDS` reject Discord message links outside
  approved announcement surfaces.
- `TASKNODE_DISCORD_BOT_TOKEN` resolves Discord message links through the
  Discord API and blocks reward finality when the configured bot cannot verify
  that the referenced message exists. Message-id-only evidence remains accepted
  unless `TASKNODE_DISCORD_REQUIRE_RESOLVABLE_MESSAGE=true`, because a bare
  message id has no channel id for bot lookup.

Implementation touchpoints:

- `prompts/task_engine/taskgen_network_v1.md`
- `server/task-review-worker.js`
- `server/network-task-generation-worker.js`
- `server/task-generation-worker.js`
- `server/task-evidence-processing.js`
- `server/task-review-worker.js`
- `server/repositories/evidence-evaluation-packets.js`

## Board Manager Enforcement

The Board Manager source packet should include a deterministic badge block:

```json
{
  "badgeEligibility": {
    "catalogVersion": "network_badges_v1",
    "candidates": [
      {
        "accountId": "acct_...",
        "walletAddress": "r...",
        "verifiedBadges": ["qa_worker"],
        "defaultBadge": "qa_worker",
        "allowedWorkTypes": ["qa_report"],
        "blockedWorkTypes": [
          {
            "workType": "private_repo_code",
            "reason": "missing_core_contributor_or_orc_badge"
          }
        ],
        "rewardCaps": {
          "qa_report": 5000
        }
      }
    ],
    "enforcement": "executor_required"
  }
}
```

`prompts/hive/board_manager_v1.md` should ask the model to include:

- `payload.network_task.required_badge_id`
- `payload.network_task.operating_badge_id`
- `payload.network_task.task_work_type`
- `payload.network_task.reward_max_pft`
- `decision_basis.source_facts` citing the badge eligibility facts

But the prompt is not the gate.

`server/board-manager-actions.js` or
`server/repositories/network-tasks.js::enqueueNetworkTaskGenerationFromBoardDecision`
must call a deterministic predicate before creating `network_task_intents`,
`network_task_allocations`, or `network_task_generation_jobs`:

```js
assertNetworkTaskBadgeEligibility({
  accountId,
  walletAddress,
  projectId,
  workType,
  requiredBadgeId,
  requestedRewardMaxPft,
});
```

The predicate must:

- require a verified, unexpired, non-revoked badge;
- require scoped capability rows for badges that depend on repo/project access;
- cap the task reward to the badge/work subtype maximum;
- reject unsupported work with a structured reason such as
  `network_task_candidate_missing_badge`;
- return fallback lanes for the Board Manager, such as `repo_access_request`,
  `community_referral`, `product_qa`, or `message_user`.

## Reward Cap Enforcement

Reward caps must be enforced twice:

1. Before task offer generation, by lowering or rejecting
   `payload.network_task.reward_max_pft`.
2. Before reward finality, by capping the scoring result in
   `server/task-review-worker.js` using the task's persisted badge metadata.

Network Task allocation and generation job metadata should persist:

- `required_badge_id`
- `operating_badge_id`
- `task_work_type`
- `badge_reward_cap_pft`
- `discord_evidence_required`
- `badge_eligibility_decision`

This prevents overpayment if a prompt or model returns an invalid reward band.

## Badge NFTs

Badge NFTs are optional public receipts. They should not be the enforcement
source of truth.

Recommended behavior:

- when a badge becomes verified, the user can mint or receive a profile badge
  NFT;
- the NFT metadata references the badge id, account id hash, verifier, and safe
  public scope label;
- revocation or expiry happens in DB state first;
- public profile rendering should prefer DB badge state, then display any linked
  NFT as a decorative credential artifact.

## Current Implementation Status

The current implementation has the first enforcement slice in place:

- `network_badge_definitions`, `account_network_badges`,
  `account_identity_approvals`, and `network_project_badge_requirements` are
  created by migration `072_network_badges_identity_approvals.sql`; the five
  active badge catalog rows are seeded there. Migration
  `074_drop_identity_approval_requests.sql` removes the older self-service badge
  request table from environments that briefly had it.
- The runtime badge catalog in `server/repositories/network-badges.js`
  recognizes the five active badge ids and payout/work-type caps for executor
  gating.
- `server/repositories/network-badges.js` projects pilot badge eligibility from
  existing verified identity/runtime state, prefers durable
  `account_network_badges` rows when present, and exposes the deterministic
  `assertNetworkTaskBadgeEligibility` gate.
- `server/repositories/identity-approvals.js` materializes current pilot badge
  projection state into `account_identity_approvals` and
  `account_network_badges` through the private Profile refresh endpoint without
  touching rows owned by operator/manual approval flows.
- The same identity-approval repository exposes a best-effort automatic refresh
  hook used after successful provider OAuth link/login, successful Expert badge
  evaluation, and credited Ethereum USDC top-up sync. These hooks only
  materialize or revoke runtime-projection-owned badge rows; they do not sign,
  route, pay, ban, or move funds, and they return a skipped result when the
  badge database is not configured.
- `server/repositories/identity-provider-resolvers.js` provides reusable
  objective verifier packets for X User Lookup public metrics and GitHub
  collaborator write permission. `scripts/network-badge-admin.mjs` exposes
  these as `resolve-x` and `resolve-github-collab` so operators can inspect
  bounded evidence before writing approvals. The authorized admin HTTP route
  exposes the same read-only resolver actions as `resolve_x` and
  `resolve_github_collab`; these return evidence packets only and do not write
  badge approvals or change routing.
- Migration `073_network_badge_verifier_jobs.sql` adds
  `network_badge_verifier_jobs`, a durable queue/audit table for badge-specific
  verifier work. `server/repositories/network-badge-verifier-jobs.js` creates
  stable, token-scrubbed verifier jobs, runs one job through the provider
  resolver/backend-state layer, records retry/status metadata, and returns
  approval recommendations without writing badge approvals. Current verifier
  types cover X User Lookup metrics, sanctioned GitHub handle checks, QA Worker
  backend access checks for linked Telegram, linked Discord, and USDC chat
  wallet top-up, and Expert persisted-review checks that verify the saved GLM
  5.2 review is still current for the latest 20 completed Personal tasks. The
  CLI and admin HTTP route expose dry-run-first
  `enqueue_verifier_job` and `run_verifier_job` controls.
  A separate explicit `approve_from_verifier_job` / `approve-from-verifier-job`
  operator action consumes only a succeeded verifier job with a positive
  recommendation and then writes the same durable approval/badge rows as manual
  approval. This keeps automated provider checks out of the badge-write boundary
  until an authorized operator submits the approval step.
- `GET /api/profile/network-badges` and
  `POST /api/profile/network-badges/refresh` expose private durable badge state
  and an auditable sync action for the signed-in account.
- `POST /api/profile/network-badges/default` lets a signed-in user select a
  verified durable badge as the default operating badge. There is no user-side
  self-service badge grant API.
- `scripts/network-badge-admin.mjs` gives GoodAlexander/Nazgul/core operators a
  dry-run-first verifier tool for listing badge state, approving direct manual
  badge grants into durable approval/badge rows, revoking badges, expiring
  badges, and setting a default badge. It can also approve from a previously
  succeeded verifier job with `approve-from-verifier-job --job-id <job>
  --submit`, which rejects missing, failed, or non-recommended verifier results.
  Direct approvals can include `--approval-scope`; Project Leader grants are
  manual backend/core-team state. Mutations require `--submit`; the tool does not sign,
  route, pay, ban, or move PFT.
- `POST /api/profile/network-badges/admin` exposes the same operator approval,
  revocation, expiry, default-selection, and state-read actions behind
  `TASKNODE_NETWORK_BADGE_ADMIN_TOKEN`. Mutating actions are dry-run unless the
  request includes `submit: true`; the route never signs, routes, pays, bans, or
  moves PFT. Its verifier approval action is intentionally separate from
  `run_verifier_job`: running a verifier stores evidence and a recommendation;
  approving from that job is the operator decision point.
- The same admin endpoint can list, dry-run, create, and disable
  `network_project_badge_requirements` rows for project/work-type scoped badge
  requirements. The executor gate already consumes those rows before any Network
  Task allocation or generation job is created.
- The Board Manager source packet includes `badgeEligibility`, and the Secretary
  packet preserves it as executor-enforced routing state.
- The Tasks eligibility panel now receives a deterministic `badgeEligibility`
  block from `getNetworkTaskEligibility`. It shows the current operating lane,
  adds a `Network Task operating badge` gate, marks capacity unavailable when no
  badge projection can be built, and explicitly labels accounts that are only
  eligible for the capped Anon referral/onboarding lane.
- `payload.network_task` now requires explicit badge metadata:
  `required_badge_id`, `operating_badge_id`, `badge_work_type`, badge cap,
  badge evidence requirements, and `discord_evidence_required`.
- `enqueueNetworkTaskGenerationFromBoardDecision` rejects missing badge
  metadata, unsupported required badges, candidates missing the badge, disallowed
  badge work types, and rewards above the badge cap before creating
  `network_task_intents`, `network_task_allocations`, or
  `network_task_generation_jobs`.
- If `network_project_badge_requirements` rows exist for a project/work type,
  the same executor gate rejects mismatched badges, applies any lower payout
  override, and requires matching verified scoped
  `board_manager_capability_profiles` rows when the requirement names a
  capability type and scope digest.
- Network Task request bundles carry the badge decision, badge cap, and Discord
  evidence policy into task generation.
- Reward scoring clamps economic reward to the persisted badge cap when the task
  traces back to a network generation job.
- Public profiles now include a sanitized `identity.networkBadges` array. The
  public renderer shows verified badge symbols, labels, and safe cap metadata
  without exposing raw provider metrics, private repo/channel membership, or
  evidence refs.
- `taskgen_network_v1` requires every generated Network Task to ask for Discord
  announcement proof by message id/link or screenshot.
- `task-review-worker.js` now checks reward-stage Network Task evidence for a
  Discord message link, explicit Discord message id, or Discord-labeled
  screenshot/image artifact when the persisted task policy requires Discord
  evidence. Missing proof causes a deterministic follow-up
  `verification_requested` update instead of reward finality.
- When Discord allowlist env vars are configured, the same review-worker guard
  rejects message links outside approved guild/channel ids. When
  `TASKNODE_DISCORD_BOT_TOKEN` is configured, it resolves Discord message links
  through the Discord API and blocks reward finality if the message cannot be
  verified.

Remaining work:

- Keep badge-specific verifier jobs scoped to the five active lanes: X User
  Lookup, sanctioned GitHub handle checks, QA Worker access, Expert access, and
  Project Leader approval state. Synchronous profile refresh hooks still cover
  provider OAuth changes, fresh Expert GLM evaluation, and USDC top-up sync.
- Exercise provider resolver and verifier-job execution in a configured
  staging/prod environment with X/GitHub tokens. The helper exists and is
  smoke-tested through local helpers, the CLI layer, and authorized admin HTTP
  route with mocked provider responses; live provider calls still need token
  exercise before they should be treated as operationally proven.
- Exercise CLI/API `submit` mutations in a configured staging/prod database and
  add an operator UI if GoodAlexander/Nazgul should manage approvals without
  scripts or direct API calls.
- Add screenshot content OCR/review or Discord attachment ingestion if
  screenshot-only announcements need machine verification. Current screenshot
  evidence remains accepted only when submitted with Discord announcement
  context, but screenshot contents are not machine-verified.
- Add richer UI around operator approval and project requirement management if
  core operators should manage badge state without scripts or direct API calls.

## Implementation Plan

1. Add identity approval and badge-state migrations.
2. Add badge catalog and account badge state migrations.
3. Seed the five active badge definitions.
4. Add `server/repositories/identity-approvals.js` for provider-linked reads,
   operator approval, expiry, and revocation.
5. Add provider resolvers for badge metrics, starting with X User Lookup for
   KOL follower counts. The resolver should request `user.fields=public_metrics`
   and persist follower count snapshots in `account_identity_approvals.metrics_json`.
6. Add GitHub provider resolvers for Core Contributor sanctioned-handle checks.
7. Add `server/repositories/network-badges.js` for catalog reads, account badge
   reads, verifier writes, and eligibility predicates.
8. Add private profile API shape for linked identities, active approvals,
   available badges, missing requirements, and verified badges.
9. Connect `NetworkBadgesPanel` to that API and replace static catalog state
   with backend state.
10. Add public profile badge projection and public rendering.
11. Add project/work badge requirement state and a helper that maps work type to
   required badge/capability.
12. Add `badgeEligibility` to the Board Manager source packet.
13. Update Board Manager and Secretary prompts so the model sees badge routing
   state and emits required badge fields.
14. Add executor enforcement before
    `enqueueNetworkTaskGenerationFromBoardDecision` creates any allocation,
    intent, or generation job.
15. Persist identity approval, badge, and cap metadata on allocation/job/task
    request context.
16. Update Network Task generation prompt to require Discord announcement
    evidence and include badge-specific verification requirements.
17. Update reward scoring/review finality to require Discord evidence and apply
    badge reward caps.
18. Add operator verifier tools for GoodAlexander/Nazgul/core identity and badge
    management.
19. Add optional badge NFT mint/receipt flow after DB verification works.

## Required Tests

- `identity-approval-provider-smoke`: linked X/GitHub/Discord identities project
  as `L1 linked_provider`, but do not satisfy `L3` metrics/access by themselves.
- `kol-x-api-metrics-smoke`: X KOL approval reads User Lookup
  `public_metrics.followers_count`, stores the snapshot, and rejects counts below
  the configured threshold.
- `github-repo-permission-smoke`: Core Contributor approval reads GitHub
  collaborator permissions for a sanctioned repo and accepts only write-capable
  access.
- `identity-approval-revocation-smoke`: expired or revoked approvals stop
  satisfying badge requirements.
- `network-badge-catalog-smoke`: catalog seed and symbol keys are valid.
- `network-badge-profile-smoke`: private profile shows possible, pending, and
  verified badges; public profile shows only public verified badges.
- `network-task-badge-gate-smoke`: a user without `core_contributor` cannot
  receive private repo code work.
- `network-task-badge-cap-smoke`: requested rewards above badge cap are lowered
  or rejected before generation.
- `network-task-discord-evidence-smoke`: every Network Task request context and
  generated task contains Discord message id/link or screenshot requirement.
- `network-task-reward-cap-smoke`: reward scoring cannot exceed the persisted
  badge cap.

## Codebase Touchpoints

- `server/account-identity.js`: provider aliases and public/private identity
  shape currently surfaced to Profile.
- `server/auth-connected-accounts.js`: OAuth-linked provider identity source for
  `L1 linked_provider` approvals.
- `server/profile-routes.js`: private profile badge-state APIs and public badge
  projection route.
- `server/repositories/identity-approvals.js`: new repository for approval
  rows, active badge state, revocation, and verifier writes.
- `server/repositories/identity-provider-resolvers.js`: new repository/helper
  for provider metric and access fetches such as X
  `public_metrics.followers_count`, GitHub collaborator permissions, and GitHub
  PR merged-state checks.
- `server/repositories/network-badges.js`: new repository for badge catalog,
  account badges, badge projection, and eligibility predicates.
- `server/db/migrations/058_board_manager_capability_profiles.sql`: existing
  scoped capability profile model that badge gates should use for repo access.
- `server/repositories/capability-profiles.js`: existing verified capability
  read/write helpers.
- `server/repositories/board-manager.js`: build `badgeEligibility` into the
  Board Manager source packet.
- `server/board-manager-actions.js`: enforce badge gating before executing
  `initiate_network_task`.
- `server/repositories/network-tasks.js`: persist badge metadata on intents,
  allocations, and generation jobs.
- `server/network-task-generation-worker.js`: pass badge and Discord evidence
  policy into the normal task request context.
- `server/task-generation-worker.js`: preserve policy in the generated task
  input block.
- `server/task-review-worker.js`: enforce Discord evidence and reward caps
  before final reward.
- `prompts/hive/board_manager_v1.md`: instruct Board Manager to choose work only
  from deterministic badge eligibility.
- `prompts/hive/board_manager_secretary_v1.md`: preserve badge eligibility in
  compression.
- `prompts/task_engine/taskgen_network_v1.md`: add badge-specific task language
  and mandatory Discord evidence requirement.
- `server/profile-routes.js`, `server/repositories/profile-public.js`,
  `src/features/profile/ProfileView.jsx`, and
  `src/features/profile/PublicProfileView.jsx`: private and public badge UI.

## Critical Invariants

- No verified badge, no badge-gated work.
- No approved identity, no identity-dependent badge.
- No scoped repo capability, no private repo work.
- No Discord announcement evidence, no Network Task reward finality.
- No prompt-only enforcement.
- NFT ownership alone never grants work eligibility.
- Public badge rendering must never leak private repo/channel membership.

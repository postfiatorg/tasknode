# Pseudonymous Identity And Namespace Plan

Status: deprecated partially implemented v1 plan. Hive handle selection, handle availability, provider alias privacy defaults, and explicit alias disclosure are implemented and documented in `Surfaces -> Profile` and `Architecture -> Auth And Connected Accounts`. Public search, mention resolution, and admin impersonation review remain future product work and are not active Plans work.
Source: X login works in local Docker. User concern: public handle collisions and motion detection for large external accounts.

This page is retained as implementation history and future design reference. Do not use it as the current identity contract.

## Objective

Task Node should let members prove external identity without forcing them to expose that identity in Hive. A user who wants full public continuity should be able to choose their external handle as their Hive handle and disclose the verified alias. The product requirement is choice, not mandatory privacy.

The product needs three separate concepts:

1. internal account identity for auth, custody, billing, task ownership, and deletes;
2. public Hive handle for mentions, routing, profile URLs, and task collaboration;
3. verified provider aliases for trust signals, sybil resistance, recovery, and optional disclosure.

Do not make X, GitHub, Telegram, Discord, wallet address, email, or display name the canonical public namespace.

## Threat Model

Some users want privacy from public motion detection:

- a large X account may not want Hive activity correlated to that X account;
- a contributor may want task history public but provider identity private;
- a wallet may need to receive rewards without exposing every linked social identity;
- an operator may need private anti-sybil signals without turning those signals into public labels.

The default UX should protect those users. Public disclosure must be explicit, but it should be a first-class option rather than a hidden advanced setting.

## Naming Model

### Internal Account Id

`account_id` is the immutable internal identity.

Use it for:

- auth sessions;
- provider links;
- wallet links;
- billing;
- task projections;
- grants;
- deletes and reset workflows.

Never expose `account_id` as the primary public identifier.

### Public Hive Handle

The Hive handle is the canonical public namespace.

Rules:

- globally unique inside Task Node;
- user-chosen;
- not automatically copied from a provider handle;
- may intentionally match a provider handle when the user chooses that and the Hive handle is available;
- can be changed under a rate limit;
- has reserved-name and impersonation checks;
- used for mentions, public profile URLs, Hive search, task assignment display, and Board Manager references.

Examples:

```text
@night-operator
@model-carpenter
@goodalexander-pft
```

The route namespace should be based on Hive handle:

```text
/u/night-operator
```

### Display Name

Display name is cosmetic and not unique.

Rules:

- may duplicate other users;
- never used for routing, mentions, payouts, auth, grants, or search disambiguation;
- can be hidden or omitted from compact surfaces.

### Verified Provider Alias

A provider alias is a private or public identity claim.

Examples:

```text
x:provider_user_id=123456789
x:handle=goodalexander
github:provider_user_id=...
wallet:pftl_address=...
```

Rules:

- provider user id is immutable identity evidence where the provider supports it;
- provider handle is mutable metadata and can change;
- alias visibility defaults to private;
- each alias has an independent disclosure toggle;
- private aliases may be used for trust scoring and recovery but not public rendering.

## Default Signup Flow

For provider signup:

1. User signs in with X, GitHub, Telegram, Discord, or email.
2. App creates or resumes the internal `account_id`.
3. If no Hive handle exists, app asks the user to choose one.
4. The handle input is prefilled with a generated pseudonym, not the external handle.
5. User can choose `Use my X handle as my Hive handle` if that Hive handle is available.
6. User can choose `Show verified X alias publicly` if they want public continuity.
7. Provider alias is stored as verified and private unless the user explicitly discloses it.
8. User lands in Task Node as the Hive handle. That handle may be pseudonymous or may intentionally match the provider handle.

Copy direction matters. The product can suggest external handles, but it should not assume them.

## Voluntary Public Continuity

Some users want to be publicly attributable. That should be easy.

The signup and Settings UX should support:

- use provider handle as Hive handle;
- disclose provider handle on public profile;
- show provider-specific verified badge;
- use provider profile photo as public profile image;
- later switch the alias back to private without changing account ownership.

This is not a separate registry. It is the same Hive handle plus alias visibility model. The user is choosing to make the mapping public.

## Collision UX

When a requested Hive handle is taken:

```text
@goodalexander is already taken in Task Node.
Choose a unique Hive handle.
```

Offer suggestions:

```text
@goodalexander-pft
@goodalexander-x
@goodalexander-2
@night-operator
```

Do not say:

```text
Your X username is already taken.
```

That wording confuses external namespace ownership with Task Node namespace ownership.

## Public Profile UX

Public profile should render:

- Hive handle;
- display name when present;
- public profile picture or NFT;
- public skills, reward credibility, and task fit;
- public aliases only when explicitly disclosed.

Private aliases should not leak through:

- profile URL;
- page title;
- metadata tags;
- search snippets;
- badges;
- task rows;
- Hive activity feed;
- Board Manager packets that can become public.

If a user discloses X, render it as an alias:

```text
@night-operator
Verified X: @goodalexander
```

If not disclosed, render only the Hive identity:

```text
@night-operator
Verified identity signals available
```

## Search And Mentions

Search results should prioritize Hive handles.

Result rows should disambiguate with privacy-preserving signals:

```text
@night-operator - verified identity, rewarded contributor
@goodalexander-pft - public X: @goodalexander
@model-carpenter - wallet verified
```

Mention resolution must use Hive handles only:

```text
@night-operator
```

Do not resolve mentions against hidden provider handles.

## Trust Signals

Trust can be public without revealing the underlying identity source.

Recommended public labels:

- `Verified identity`
- `Verified wallet`
- `Rewarded contributor`
- `Established account`
- `Open to network tasks`

Recommended private/admin signals:

- provider count;
- provider types;
- provider verification age;
- wallet age;
- reward history;
- sybil risk flags;
- account deletion and recreation history.

Avoid public labels like `X verified` unless the X alias is disclosed.

## Data Model

Use existing account/provider records where possible, but model visibility explicitly.

Suggested tables or JSON fields:

```text
account_profiles
  account_id
  hive_handle
  display_name
  public_profile_enabled
  discoverable
  handle_changed_at
  created_at
  updated_at

account_identity_aliases
  id
  account_id
  provider
  provider_user_id_hash
  provider_user_id_encrypted
  current_handle
  display_name
  verified_at
  visibility private|public|admin_only
  disclose_handle boolean
  disclose_verified_badge boolean
  created_at
  updated_at
```

Provider user ids should be hashed for uniqueness checks and encrypted or otherwise protected for operational recovery when needed.

The public read model should be separate from private identity records:

```text
public_profile_snapshots
  account_id
  hive_handle
  display_name
  public_aliases[]
  public_trust_badges[]
  skills[]
  reward_summary
  updated_at
```

## API Contracts

### Handle Availability

```text
GET /api/profile/handle/availability?handle=night-operator
```

Returns:

```json
{
  "ok": true,
  "handle": "night-operator",
  "available": true,
  "suggestions": []
}
```

### Set Hive Handle

```text
POST /api/profile/handle
```

Request:

```json
{
  "handle": "night-operator"
}
```

Rules:

- signed-in account required;
- handle normalized server-side;
- reject reserved names;
- reject impersonation-sensitive names without admin override;
- reject taken handles;
- log handle change.

### Alias Visibility

```text
POST /api/profile/aliases/:aliasId/visibility
```

Request:

```json
{
  "visibility": "public",
  "discloseHandle": true,
  "discloseVerifiedBadge": true
}
```

Default for new aliases:

```json
{
  "visibility": "private",
  "discloseHandle": false,
  "discloseVerifiedBadge": false
}
```

## Implementation Phases

### Phase 1: Signup Guardrail

- Require a unique Hive handle before first meaningful Hive participation.
- Do not prefill from X handle by default.
- Store X alias privately after OAuth callback.
- Update Settings with alias visibility toggles.
- Show handle collision suggestions.

### Phase 2: Public Profile Snapshot

- Make public profile snapshots use Hive handle only by default.
- Add public aliases only from explicit visibility settings.
- Add privacy-safe trust badges.
- Ensure metadata and search snippets do not leak hidden aliases.

### Phase 3: Search, Mentions, And Board Manager

- Resolve mentions only by Hive handle.
- Ensure Board Manager packets refer to Hive handles unless admin/private mode explicitly allows account ids.
- Add disambiguation in Hive search and member pickers.

### Phase 4: Recovery And Abuse Controls

- Rate-limit handle changes.
- Keep handle history for moderation and stale link redirects.
- Add reserved-name and impersonation review.
- Add admin-only private identity inspection.

## Failure States

| State | Expected result |
| --- | --- |
| X handle equals another user's Hive handle | Signup continues, user chooses a separate Hive handle |
| User links X but keeps alias private | Public profile does not reveal X handle or X badge |
| User chooses available X handle as Hive handle | Hive handle is set to that value and the alias can be disclosed |
| User discloses X alias | Public profile shows verified X handle |
| X handle changes after linking | Account continuity uses provider user id; public alias updates only after refresh |
| User tries a taken Hive handle | Server rejects with suggestions |
| User mentions hidden X handle | No hidden-account resolution |
| Public snapshot job sees private alias | Snapshot omits provider handle and provider-specific badge |

## Security And Privacy Rules

- Hidden provider aliases must not appear in browser JSON, HTML metadata, logs, public snapshots, or task packets.
- Provider user ids are not handles; store hashes for uniqueness and protect raw ids.
- Do not imply a user is X-verified unless the X alias is public and the X profile status supports that claim.
- Do not use external handles as stable account keys.
- Do not expose "signed in with X" in public activity.

## Future Questions

- Should Hive handles be transferable after a deletion window?
- Should high-risk impersonation handles require wallet age, reward history, or admin approval?
- Should public trust badges distinguish `verified identity` from `verified social` without naming the provider?
- Should a disclosed alias be revocable from old public snapshots immediately or after cache expiry?

## Historical Review Checklist

The v1 implementation covers server-side handle normalization, reserved-name checks, uniqueness, provider-user-id auth linking, explicit alias visibility, and public profile alias filtering. The remaining search, mention, rate-limit, and admin-review items below are future product work, not active Plans work.

### Memory Efficiency
- Implemented: public snapshots are generated from bounded profile inputs and receive only explicit public aliases.
- Future: search and mention indexes should use handle/projection tables when those surfaces exist.

### Code Quality
- Implemented: Hive handle normalization and uniqueness live server-side.
- Implemented: provider auth uses immutable provider user ids, not mutable handles.
- Implemented: alias visibility is explicit in the data model and API.

### Coherence
- Implemented: signup, Settings, public profile, and Board Manager-facing public display use the same identity model.
- Future: Hive search and mentions should use the same Hive handle model when implemented.

### Bloat
- Implemented: public profile renders only necessary identity and explicit trust signals.
- Implemented: advanced admin-only identity fields do not leak into ordinary UX.

### Security
- Implemented: private aliases are not returned in public profile API responses.
- Future: hidden provider handles must stay out of future logs, metadata, snapshots, task packets, and search results.
- Future: handle changes should gain explicit audit and rate-limit controls before broader public namespace use.

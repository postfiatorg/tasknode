# Finance Hub & Information Hive Mind Contracts v1

> **Status:** Frozen Phase 0 Contract (`C3`) for Pillar 9 (Finance Hub) and Pillar 10 (Information Hive Mind).
> **Canonical Schemas:** `schemas/finance-hub/*.v1.schema.json`
> **Verification Suite:** `node --test scripts/finance-hub-contracts.test.mjs`

## 1. Purpose & Scope

This specification freezes the four v1 JSON contracts connecting the private Finance Hub research build pipeline (`navstrategies-company-models`), the Task Node Publish API, the daily Top-30 access snapshot, and the Pillar 10 Information Hive Mind agent/matching loop:

| Contract | Schema File | Index / Surface | Confidentiality Boundary |
|---|---|---|---|
| Coverage Manifest | `schemas/finance-hub/coverage_manifest.v1.schema.json` | `finance-hub-public` (`hub/coverage_manifest.json`) | Public-safe; zero model targets or member claims |
| Public Agent Brief | `schemas/finance-hub/agent_brief_public.v1.schema.json` | `finance-hub-public` (`public/briefs/<model_id>.json`) | Public-safe; strictly separated from gated `ga-models` |
| Signed Publish Payload | `schemas/finance-hub/publish_payload.v1.schema.json` | Task Node Publish API (`POST /api/research/publish`) | Authenticated publisher-to-Task Node control plane |
| Daily Top-30 Snapshot | `schemas/finance-hub/top30_snapshot.v1.schema.json` | Task Node access-control snapshot store | Internal entitlement state (supports private accounts) |

All four contracts use JSON Schema Draft 2020-12 with `"additionalProperties": false` on every object so unexpected fields fail closed at build time and API ingress.

---

## 2. Coverage Manifest (`coverage_manifest.v1`)

Schema: `schemas/finance-hub/coverage_manifest.v1.schema.json` (`schema_version = "finance-hub.coverage-manifest.v1"`).

### Locked Scope Rules
1. **Strict Asset-Class Boundary:** `universe_policy.allowed_asset_classes` is frozen to `["crypto_protocol", "perp_megacap_equity"]` with `exclude_non_perp_equities = true` and `public_safe_only = true`. Random, small-cap, or non-perp equities MUST never appear in the manifest.
2. **Perp-Backed Equity Verification:** Every asset with `asset_class = "perp_megacap_equity"` MUST declare at least one liquid perpetual venue in `perp_venues` (`minItems: 1`) and `perp_liquidity_verified = true`.
3. **Counsel Gate for Paid Equity Interviews:** Any `perp_megacap_equity` asset with `paid_interviews_enabled = true` MUST have `equity_counsel_approved = true` and `interview_mode` in `["public_only", "member_and_public"]`. Until counsel signs off on attestation wording and restricted-relationship rules, equity assets remain `interview_mode = "counsel_pending"` (or `"disabled"`) with `paid_interviews_enabled = false`.
4. **Eligible Information Types:** `eligible_info_types` is restricted to the five Pillar 10 observation roles: `operator`, `builder`, `customer`, `trader`, `public_data_analyst`.
5. **Public Brief Pointer:** Every entry references a public-safe brief under `public/briefs/<model_id>.json` served from the separate `finance-hub-public` index — never from gated `ga-models`.

---

## 3. Public Agent Brief (`agent_brief_public.v1`)

Schema: `schemas/finance-hub/agent_brief_public.v1.schema.json` (`schema_version = "finance-hub.agent-brief-public.v1"`).

### Strict Anti-Leak Isolation Rules
1. **Separate Public Index Only:** `index_scope` MUST be `"public_safe"`. `agent_brief_public.json` MUST be published exclusively to `finance-hub-public` and NEVER co-located with `agent_brief_members.json` inside gated `ga-models`.
2. **Non-Member Interview Boundary:** Pillar 10 interviews for contributors who do not hold `finance_hub` access MUST load ONLY `agent_brief_public.json` and its build-checked `public_questions` (`phase` in `["triangulation", "public_probe"]`, `mnpi_safe_verified = true`). They MUST NEVER read gated model targets, upside percentages, member open model questions, or existing pooled member claims.
3. **Mandatory Redaction Attestation:** Every brief carries `redaction_attestation` asserting:
   - `contains_price_targets = false`
   - `contains_internal_estimates = false`
   - `contains_member_claims = false`
   - `contains_private_memory = false`
   - `leak_scan_passed = true`
4. **Build-Time & Ingest Leak Scanner (Zero Target / Secret Tolerance):**
   - **Forbidden keys** (anywhere in JSON tree): `price_target`, `target_price`, `upside`, `upside_pct`, `downside_pct`, `fair_value`, `dcf_value`, `model_estimate`, `model_estimate_before`, `market_consensus_before`, `eps_estimate`, `revenue_estimate`, `bull_case_target`, `bear_case_target`, `base_case_target`, `member_questions`, `open_model_questions`, `pooled_claims`, `contributor_claims`, `content_key`, `api_key`, `secret`, `private_key`, `mnemonic`, `deep_memory`, `agent_brief_members`.
   - **Forbidden content patterns** (case-insensitive across all string fields): model targets, values and estimates (the patterns listed below), gated index references (`ga-models`, `agent_brief_members`), and credential/secret material (`BEGIN [A-Z ]*PRIVATE KEY`, `sk-[A-Za-z0-9]{16,}`, `ghp_[A-Za-z0-9]{20,}`, `xox[baprs]-`, `AKIA[0-9A-Z]{16}`).
     - Price target, also as shorthand or with an amount: `\b(?:price\s+(?:target|objective)|target\s+price)\b`, `\b(?:PT|TP)\s*(?:of|at|is|:|=)?\s*[$€£¥]?\s?\d|\b(?:PT|TP)\b.{0,20}[$€£¥]\s?\d`, `\btargets?\b.{0,20}[$€£¥]\s?\d`
     - Scenario value: `\b(?:bull|bear|base)[\s-]case\b.{0,40}[$€£¥]\s?\d|[$€£¥]\s?\d[\d,.]*\s*\(?(?:bull|bear|base)[\s-]case\b`
     - Valuation term: `\b(?:fair|intrinsic)[\s-]+value\b|\bDCF\b|\bdiscounted\s+cash[\s-]?flow`
     - Value per share: `\bvalu(?:e|es|ed|ing|ation)\b.{0,40}[$€£¥]\s?\d[\d,.]*\s*(?:per|a|each)\s+(?:share|token|coin|unit)\b`
     - Worth with an amount or percentage: `\bworth\s+(?:\w+\s+){0,3}?(?:[$€£¥]\s?\d|\d+(?:\.\d+)?\s?(?:%|percent|per\s?cent))`
     - Upside or downside with a percentage: `\b(?:upside|downside)\b(?!\s+risks?\b)[\s:=(]*(?:\w+\s+){0,3}?[+-]?\d+(?:\.\d+)?\s?(?:%|percent|per\s?cent|bps|basis\s+points)|\d+(?:\.\d+)?\s?(?:%|percent|per\s?cent|bps|basis\s+points)\s+(?:of\s+)?(?:\w+\s+)?(?:upside|downside)\b(?!\s+risks?\b)`
     - Implied value or upside: `\bimpl(?:y|ies|ied|ying)\b.{0,30}\b(?:upside|downside|valuation|value|price)\b`
     - Percentage above or below the market price or consensus: `\d+(?:\.\d+)?\s?(?:%|percent|per\s?cent)\s+(?:above|below|over|under|higher\s+than|lower\s+than|premium\s+to|discount\s+to)\s+(?:the\s+|its\s+)?(?:(?:current|market|spot|share|stock|token|trading|closing|prevailing)\s+(?:\w+\s+)?(?:price|level|quote)s?|consensus|street|where\s+(?:it|they)\s+trades?)\b`, `\b(?:versus|vs\.?)\s+(?:the\s+)?(?:consensus|street)\b.{0,20}\d`
     - Reference to the model or its estimates: `\bour\s+(?:model|dcf|estimates?|forecasts?|projections?|valuation|numbers|targets?)\b`, `\bwe\s+(?:\w+\s+){0,2}?(?:valu|forecast|estimat|project|expect|target|model|assum|calculat|deriv)\w*\b.{0,80}\d`, `\b(?:the|this)\s+model\s+(?:\w+\s+){0,2}?(?:valu|forecast|estimat|project|expect|target|assum|calculat|deriv|impl|yield|point)\w*\b.{0,80}[$€£¥]\s?\d`
   - **Reported facts stay allowed:** an amount, date or percentage that is a reported public fact and uses none of these phrases passes (`revenue of $35.1 billion`, `revenue grew 12%`, `a dividend of $0.01 per share`). The scanner fails closed: public text that matches a pattern is reworded, never exempted.
   - **No HTML:** String fields MUST NOT contain `<` or `>` (`[<>]`; the six free-text fields of the schema also carry `"pattern": "^[^<>]*$"`), a character reference for either (`&(?:amp;)*(?:lt|gt|#0*6[02]|#x0*3[ce])`), an event-handler attribute (`(?:^|[\s"'/])on[a-z]+\s*=`) or a script URI (`javascript:`).

---

## 4. Signed Publish API (`publish_payload.v1`)

Schema: `schemas/finance-hub/publish_payload.v1.schema.json` (`schema_version = "finance-hub.publish-payload.v1"`).

Replaces unsigned `scp` + direct Postgres writes (`pfrpc` DB credential is retired once M3 lands).

### Decoupled Indices & Access Bases
| `index_id` | Allowed `tier` | Allowed `allowed_bases` | Notes |
|---|---|---|---|
| `ga-models` | `finance_hub` (or legacy `validator` during zero-downtime migration) | subset of `["validator", "top30", "grace"]` | Served from isolated viewer origin (`hub-viewer.postfiat.org`); whole-archive `unlock` and `.../content` routes disabled |
| `goodbrief` | `finance_hub` (or legacy `validator` during migration) | subset of `["validator", "top30", "grace"]` | Decoupled from `ga-models` so model build errors never delay the morning brief; rendered in `<iframe sandbox="allow-scripts">` via `srcdoc` with `connect-src 'none'` |
| `finance-hub-public` | `public_safe` | `["public"]` | Separate public-safe index for `coverage_manifest.json` and `agent_brief_public.json`; requires `render_gate.public_leak_scan_passed = true` |

Every gated request checks `accountMeetsTier("finance_hub")` returning `{ ok, basis, rank, snapshotAt, graceEndsAt }` and verifies `allowed_bases.includes(basis)` per publication. Blacklisted, suspended, or unknown-tier accounts fail closed.

### Endpoint & Authentication Contract
- **Endpoint:** `POST /api/research/publish`
- **Content-Type:** `application/json`
- **Quota & Size Limits:** `total_bytes <= 67,108,864` (64 MiB), `files.length <= 5,000`, safe relative POSIX paths only (no leading `/`, no `..`, no `\`, no NUL bytes, no hidden dotfiles: no path part may be empty or start with `.`).
- **2-Key Rotation Per Index:** Task Node stores up to two active verification keys (`primary` and `next`) per `index_id`, addressed by `signature.key_id`. A key scoped to `goodbrief` MUST NOT be accepted for `ga-models` or `finance-hub-public`.

### Canonical Signing Input (`canonical-json-v1`)
1. Construct the **signing envelope** from the request payload by removing `signature`, removing `files[i].content_base64` (file contents are already cryptographically bound by each entry's `files[i].sha256` and the top-level `manifest_sha256`), and sorting `files` by `path` in byte order (defined below). A request MAY list `files` in any order; the signed form is always the sorted one.
2. Compute `manifest_sha256 = sha256(canonical_json(signing_envelope.files))` as lowercase hex and set `signing_envelope.manifest_sha256` to it.
3. Compute `payload_sha256 = sha256(canonical_json(signing_envelope))` as lowercase hex.
4. Compute the signing message bytes:
   ```text
   postfiat.finance-hub.publish.v1\n<index_id>\n<version>\n<nonce>\n<payload_sha256>
   ```
5. Sign the message bytes with one of the two locked algorithms:
   - `ed25519`: standard Ed25519 signature over the UTF-8 message bytes, encoded as base64url (or standard base64) in `signature.value`.
   - `hmac-sha256`: HMAC-SHA256 over the UTF-8 message bytes using the per-index shared key identified by `signature.key_id`, encoded as lowercase hex (64 chars) or base64, verified strictly with constant-time comparison (`timingSafeEqual`).

`canonical_json(value)` is the UTF-8 byte sequence (no byte order mark, no trailing newline) built by exactly these rules:
- **Byte order:** two strings are compared by their UTF-8 encodings as unsigned bytes, from the first byte on; when one is a prefix of the other, the shorter one comes first. A locale or language collation (`localeCompare`, ICU) MUST NOT be used. The `files` list (step 1) and the keys of every object use this order.
- **Objects and arrays:** an object is `{`, its members in byte order of their keys, each written `<key>:<value>` and separated by `,`, then `}`; a member without a value (JavaScript `undefined`) is left out. An array is `[`, its elements in the given order separated by `,`, then `]`. No whitespace is written outside strings.
- **Strings:** written between two `"`. `"` becomes `\"` and `\` becomes `\\`; U+0008, U+0009, U+000A, U+000C and U+000D become `\b`, `\t`, `\n`, `\f` and `\r`; every other code point below U+0020 becomes `\u00XX` with two lowercase hex digits. Every other code point, including `/`, U+007F and every non-ASCII character, is written as itself in UTF-8, never as a `\u` escape and never normalized. A string with an unpaired surrogate MUST be rejected.
- **Numbers:** integers from `0` to `9007199254740991` (`2^53 - 1`) only, written in base 10 with no sign, leading zero, fraction or exponent. Any other number MUST be rejected; the schema caps `version` and `rollback_target_version` at this maximum. `<version>` in step 4 is written the same way.
- **Literals:** `true`, `false` and `null`.
- **Known-answer vector:** `scripts/fixtures/finance-hub-publish-signing-vector.json` holds one payload with a non-ASCII path (outside the v1 path pattern on purpose, to pin the byte order), title and summary, its two canonical byte sequences as hex, its `manifest_sha256`, its `payload_sha256` and its signing message. Every signer and verifier, in any language, MUST reproduce these values; the verification suite recomputes them.

### Replay Protection & Monotonic Rollback Rules
1. **Strict Monotonic Version:** For a given `index_id`, `version` MUST be strictly greater than the highest previously accepted version (`version > current_version`). Equal or lower versions MUST be rejected (`409 version_not_monotonic`).
2. **Timestamp Freshness:** `issued_at` MUST be within `±300` seconds of server UTC time; `expires_at` MUST satisfy `issued_at < expires_at <= issued_at + 600s` and `now <= expires_at`.
3. **Single-Use Nonce:** `nonce` (`24..128` URL-safe characters) MUST be persisted in a replay-protection table keyed by `(index_id, nonce)` for at least `900` seconds (`max_clock_skew + max_ttl`). Any duplicate nonce MUST be rejected (`409 nonce_replayed`).
4. **Signed Monotonic Rollback:** Rollbacks NEVER decrement `version`. Instead, `operation = "rollback"` publishes a **new monotonically higher `version`** with `rollback_target_version < version` and `rollback_of_manifest_sha256` matching a retained historical manifest hash for that `index_id`. Historical bundle files remain content-addressed so rollbacks restore atomically without weakening replay protection.
5. **Render Gate & Shrink Guard:** `render_gate.passed = true` and `render_gate.shrink_guard_passed = true` are mandatory on every publish; `render_gate.file_count` MUST equal `files.length`.

### Verifier Rejection Rules
A verifier MUST reject a request, and store nothing from it, when any of the following holds:
1. **Schema:** the payload does not validate against `publish_payload.v1.schema.json`.
2. **Key:** no stored key exists for `(index_id, signature.key_id)`, or `signature.algorithm` differs from the algorithm stored with that key. The algorithm is a property of the stored key and is never taken from the request.
3. **Digests:** the recomputed `manifest_sha256` differs from the payload's `manifest_sha256`, or the recomputed `payload_sha256` differs from `signature.payload_sha256`.
4. **Signature:** the signature over the signing message bytes does not verify.
5. **File List:** two `files` entries have the same `path`, or the sum of `files[i].size_bytes` differs from `total_bytes`.
6. **File Content:** for an entry that carries `content_base64`, the base64-decoded bytes are not exactly `size_bytes` long, or their SHA-256 differs from `files[i].sha256`.
7. **Replay, Rollback & Render Gate:** any rule of the section above fails.

The nonce is stored only after the signature has verified, and the nonce and the new `version` are written in one transaction.

---

## 5. Daily Top-30 Snapshot (`top30_snapshot.v1`)

Schema: `schemas/finance-hub/top30_snapshot.v1.schema.json` (`schema_version = "finance-hub.top30-snapshot.v1"`).

### Locked Ranking & Hysteresis Policy
1. **Formula Parity:** Uses the exact `server/repositories/directory-leaderboard.js` formula:
   ```text
   score = round6(3 * network_tasks + 1 * personal_tasks + (rewards_pft / 25000) + 1 * alignment_score)
   ```
2. **Deterministic Tie-Breaking:** `score DESC`, `network_tasks DESC`, `rewards_pft DESC`, `account_id ASC`.
3. **Eligible Population:**
   - Includes **all non-blacklisted, non-suspended Task Node accounts** (`include_private_accounts = true`) so private contributors qualify without listing themselves publicly.
   - **Excludes active validators** (`exclude_active_validators = true`, `is_active_validator = false` on every snapshot entry) so validators do not crowd out the 30 contributor seats.
4. **Seat, Hysteresis & Anti-Bounce Grace State Machine:**
   - **Enter / Seated (`seated_top30`):** Non-validator rank `1..30` -> `access_basis = "top30"`, `grace_started_at = null`, `grace_ends_at = null`.
   - **Keep-Until Hysteresis (`retained_hysteresis_31_35`):** Previously entitled (`top30` in prior snapshot) account currently ranked `31..35` -> retains `access_basis = "top30"` with zero flicker. Accounts newly reaching `31..35` without prior `top30` entitlement are NOT granted access.
   - **7-Day Grace (`grace_7d`):** Previously entitled (`top30`) account dropping to rank `>= 36` enters a **7-day grace window** (`grace_ends_at = grace_started_at + 7 days`, `access_basis = "grace"`), **subject to a 30-day per-account grace cooldown** (`grace_cooldown_until = grace_started_at + 30 days`). If the account is still within an active 30-day cooldown from a prior grace window, bouncing `35 <-> 36` does NOT grant a fresh 7-day grace window.
5. **Fail-Safe Snapshot Retention:** If the daily UTC snapshot job fails, Task Node retains the last good snapshot (`status = "fallback_retained"`) and alerts operators rather than revoking all Top-30 seats.

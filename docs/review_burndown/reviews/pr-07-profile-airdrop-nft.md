# PR-07 Review: Profile, Daily Airdrop, NFT, And Public Profile Data

Date: 2026-05-25
Branch: `review/07-profile-airdrop-nft`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed profile surfaces, daily airdrop worker/scoring/issuance, NFT generation/mint,
and public profile read models across `server/profile-*`, `server/repositories/profile-*`,
`src/features/profile/**`, and `docs/wiki/surfaces/profile.md` /
`docs/wiki/surfaces/daily-airdrop.md`. Server-side airdrop boundaries (one production run
per account/day, issuance dedupe, recipient wallet ranking, alignment math, Hive Mind Agent
audit card) match the spec. Public profile omits Sybil score and reads real metrics/NFT rows.
Private profile still had mock NFT gallery and recommended-connections vapor until this
review branch removed them.

## Findings

### P0

None.

### P1

1. **Private NFT gallery fell back to mock `NFT_DATA` when the account had no rows**
   - **File/line:** `src/features/profile/ProfileView.jsx:1259`, `995-996`
   - **Severity:** P1
   - **Impact:** Empty accounts saw four fabricated NFT tiles with titles, dates, and
     rarity labels, violating PR-07 done criteria ("no profile field claims generation or
     minting unless a real backing row … exists") and
     `docs/wiki/plans/public-profile-real-data-plan.md`.
   - **Verification:** `PrivateProfile` passed `profileNfts.length ? profileNfts : NFT_DATA`;
     public profile already used real rows only (`PublicProfileView.jsx:338-341`).
   - **Fix:** Pass `allowMockFallback={false}` and render the gallery empty state when
     `profileNfts` is empty. **Fixed on this branch.**

2. **Recommended connections section rendered hardcoded mock members**
   - **File/line:** `src/features/profile/ProfileView.jsx:1092-1153` (before fix)
   - **Severity:** P1
   - **Impact:** Private profile showed three fake wallet matches with match percentages and
     tags, contradicting `docs/wiki/surfaces/profile.md` ("should not contain mock
     connections").
   - **Verification:** `CONNECTIONS` constant had no API backing; no `/api/profile/connections`
     route exists.
   - **Fix:** Replace mock list with an honest empty state until a real matcher ships.
     **Fixed on this branch.**

### P2

1. **Worker can create multiple `dry_run` scoring rows per account/day before issuance**
   - **File/line:** `server/profile-daily-airdrop-worker.js:233-241`,
     `server/repositories/profile-daily-airdrop.js:368-375`
   - **Severity:** P2
   - **Impact:** Candidate filtering blocks duplicate production runs and any
     pending/submitted/failed issuance for the day, but zero-amount dry runs do not block
     rescoring on later ticks. Extra LLM cost and audit noise; not a double-pay path because
     issuance is keyed by `run_id` and account/day.
   - **Verification:** Unique index `profile_daily_airdrop_runs_production_day_unique` applies
     only to `run_mode = 'production'`; worker always scores with `runMode: "dry_run"`.
   - **Fix:** Exclude accounts with any completed dry_run row for the run date when amount
     was already scored, or promote worker scoring directly to `production`.

2. **`route-smoke` fails on `#context` before reaching `#profile`**
   - **Severity:** P2 (CI/evidence gap, pre-existing)
   - **Impact:** Required check from the review spec did not complete. Failure is on Context
     labels (`Context document`, `Versions`), not profile copy. Profile route labels
     (`Today's airdrop`, `Profile Studio`, `PFT generation`) were not exercised by this run.
   - **Verification:** `npm run route-smoke` → `Route #context rendered without expected text`.
   - **Fix:** Repair Context route smoke expectations or default landing content; re-run
     route-smoke after fix.

3. **Manual profile screenshots were not captured in this review environment**
   - **Severity:** P2 (evidence gap)
   - **Impact:** Spec asks for private profile tx-status labeling and public profile ability
     summary / alignment / NFT gallery screenshots. Local review had no signed-in session with
     scored airdrop rows or minted NFTs.
   - **Verification:** Review relied on API/read-model code inspection and static smokes.
   - **Fix:** Integration owner should attach screenshots from Fly dev or seeded local wallet
     when merging.

4. **`NFT_DATA` mock constants remain in `ProfileView.jsx` for gallery default fallback**
   - **File/line:** `src/features/profile/ProfileView.jsx:179-184`, `995-996`
   - **Severity:** P2 (maintainability)
   - **Impact:** Private/public callers now disable fallback, but the component still ships
     mock art metadata that could be reintroduced accidentally.
   - **Fix:** Delete `NFT_DATA` once all callers pass `allowMockFallback={false}` or move mocks
     to `mocks/` only.

## Spec Question Checklist

| Question | Result |
| --- | --- |
| One daily airdrop per identity cloud per run date? | **Yes at payout boundary:** one submitted issuance per `(account_id, run_date)`; one production run per account/day; recipient chosen once from identity cloud wallets by all-time task count (`resolveDailyAirdropRecipientWallet`). |
| Recipient wallet = most active linked wallet without double-paying linked identities? | **Yes:** SQL ranks candidate wallets by task count; payout is account-scoped with a single recipient per day. |
| UX claims payment only after real pay? | **Yes:** headline uses `Daily airdrop paid` only when `issuance.status === 'submitted'`; otherwise `Daily airdrop score` (`ProfileView.jsx:446-453`). No live "The network paid you" string in app profile code. |
| Alignment = trailing 7d actual / max possible? | **Yes:** `runDailyAirdropScore` sets `alignmentScore7d = actual / maxPossible` from `recentDailyAirdropRunWindow` (`profile-daily-airdrop.js:362-372`). Public profile surfaces score × 100 (`profile-public.js:210-215`). |
| Task rewards and daily drops separated but summed in charts? | **Yes:** `getProfileRewardHistory` returns `rewardPft`, `airdropPft`, and `total`; chart tooltip labels Drops vs Rewards (`ProfileView.jsx:409-411`, `636-637`). |
| Hive Mind Agent daily airdrop card? | **Yes:** worker writes `daily_airdrop` Board Manager run with summary; smoke asserts feed label/state (`profile-daily-airdrop-worker-smoke.mjs`). |
| Public profile omits vapor; generated text from task summaries? | **Yes:** `PublicProfileView` has no Sybil/member-since/connections; role text comes from `profile_public_snapshots` built from rewarded task packets (`profile-public.js:221-272`, `profile-public-snapshot.js`). |
| NFT prompts private; images persisted and rendered? | **Yes:** prompt loaded from `private_prompts/profile_nft_image.md`; only digest returned to client; image pinned to IPFS and stored on `profile_nfts` (`profile-nft-prompts.js`, `profile-nft-generation.js:201-229`). Gallery tiles resolve IPFS/gateway URLs with SVG fallback only when no image refs exist. |

## What Looks Correct

- Daily airdrop worker claims a `daily_airdrop` lease, lists eligible accounts with active
  sync wallets and no same-day issuance/production run, scores via OpenRouter, optionally
  auto-issues positive amounts, and records a Hive Mind Agent audit card
  (`profile-daily-airdrop-worker.js`).
- Issuance path encrypts payload, pins IPFS, submits PFTL payment, and marks
  `profile_daily_airdrop_issuances.status = 'submitted'` only after chain submit
  (`profile-daily-airdrop-issuance.js`).
- DB constraints: production run uniqueness per account/day; submitted issuance uniqueness
  per account/day; one issuance row per run (`019`, `020` migrations).
- Private airdrop hero separates today's/latest label by UTC date, paid vs score headline, and
  chart totals that include both rewards and drops.
- Public profile metrics split lifetime task rewards vs airdrop PFT; alignment and
  contribution tier show explicit "not scored yet" copy when data is missing.
- Profile NFT mint flow is prepare → wallet sign → submit; minted state requires server
  `status === 'minted'` and optional `txHash`.

## Checks Run

```bash
npm ci
node scripts/profile-daily-airdrop-worker-smoke.mjs
npm run build
npm run route-smoke          # failed on #context — see P2
git diff --check
```

Manual evidence:

- Code review of `profile-daily-airdrop.js`, issuance, worker candidate SQL, and
  `PublicProfileView` / `ProfileView` payment labeling.
- Confirmed no Sybil score rendering in `src/features/profile/**`.

## Fixes Included On This Branch

- Disable private NFT gallery mock fallback; show empty state when no `profile_nfts` rows.
- Replace mock recommended connections with an honest empty state.

## Residual Risks

- Route smoke must be repaired and re-run before merge; profile hash labels were not reached.
- Multiple dry_run scores per account/day possible when payout amount is zero.
- End-to-end airdrop issuance and NFT mint were not exercised live in this pass (requires DB,
  OpenRouter, OpenAI, and wallet seed configuration).

## Merge Recommendation

**Do not merge yet.** Re-run `npm run route-smoke` after Context smoke is repaired, then
`npm run quality` on this branch. Attach signed-in profile screenshots when integrating.
Mock vapor removals on this branch should land with or before merge.

---

```text
Review PR: PR-07
Boundary: Profile, daily airdrop, NFT, public profile data
Branch: review/07-profile-airdrop-nft
Changed files:
  docs/review_burndown/reviews/pr-07-profile-airdrop-nft.md
  docs/review_burndown/burndown.md
  src/features/profile/ProfileView.jsx
Findings:
- P0: none
- P1: private NFT gallery mock fallback; mock recommended connections (fixed on branch)
- P2: duplicate dry_run scores; route-smoke #context failure; no live screenshots; NFT_DATA dead weight
Fixes included: disable NFT mock fallback; remove mock connections list
Checks run: profile-daily-airdrop-worker-smoke, build, route-smoke (failed #context), git diff --check
Manual app evidence: code/read-model review; no signed-in wallet session
Residual risks: route-smoke gap; dry_run rescoring; no live airdrop/NFT path in this pass
Merge recommendation: do not merge until route-smoke/quality re-run and screenshots
```

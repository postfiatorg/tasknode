# Directory Leaderboard — Implementation Spec

**Task:** `task_0df8459d8e20a93e409a2b752b3decd5` — Audit Directory Page And Propose Fixes (Network, `task_node_core_product`, 18,000 PFT).
**Decision (Alex, 2026‑06‑13):** don't just audit — *build* a working Directory page, modeled on **Hive** (UX + backend), with **NFT‑backed profile pictures** linking to **public profile pages where appropriate**, fed by **real data**.

This spec is the orc's build contract. Follow the `tasknodeofficial` skill. Anchors below are real file:line references — use them, don't re‑discover.

---

## 0. Current state (the "audit" half — already done)

Directory is a **dead menu item**, confirmed:
- `src/main.jsx:1578‑1582` — the profile‑menu "Directory" `ToolMenuRow` has **no `onClick`** (every sibling has one) and renders a hardcoded `<span className="menu-count">#16</span>` bound to nothing.
- `src/main.jsx:345` — `"directory"` is **not** in `APP_VIEWS`; `viewFromLocation()` (`main.jsx:361`) silently falls back to `chat`, so even `#/directory` lands on chat.
- No `/api/directory*` route; no `src/features/directory/`. The design mock `mocks/DirectoryLeaderboard.jsx` is unwired.
- Flagged twice in `docs/verification/network-task-feedback-summary-2026-06-11.md` ("Directory was non‑clickable").

The build resolves all of this. The evidence report (§8) maps each original issue → its fix with screenshots.

---

## 1. Design target

`mocks/DirectoryLeaderboard.jsx` is the visual target: a flat, cream/ink leaderboard — header with a live count of operators / tasks rewarded / PFT distributed, then a sortable table with columns **Rank · Operator (avatar + @handle + wallet) · Network · Personal · Rewards · Alignment · Score**. Rank = composite score; clicking a column reorders the view (rank stays the composite). Replace the mock's generated `InkAvatar` with the **real NFT PFP**, and make operator rows link to their **public profile** when one exists.

---

## 2. Frontend scaffold — mirror Hive exactly

| Step | Mirror this (Hive) | Do for Directory |
|---|---|---|
| Register view | `APP_VIEWS` `main.jsx:345` | add `"directory"` to the set |
| Lazy import | `main.jsx:163` (`HiveView`) | `const DirectoryView = lazy(() => import("./features/directory/DirectoryView").then(m => ({default: m.DirectoryView})))` |
| Render switch | `main.jsx:1718‑1722` | `{view === "directory" && <Suspense fallback={<StatusBanner>Loading directory</StatusBanner>}><DirectoryView/></Suspense>}` |
| Nav entry | profile‑menu row `main.jsx:1578` | **wire the existing "Directory" `ToolMenuRow`**: add `onClick={() => { navigateToView("directory"); setProfileMenuOpen(false); }}`. Replace the hardcoded `#16` with the live operator count (or drop the badge). |
| Fetch | `HiveView.jsx:8‑38` (`requestJson`, status `loading|ready|error`) | `requestJson("/api/directory/leaderboard")` on mount; **no fast polling needed** (fetch on mount + a manual refresh control). Render loading / empty / error states the Hive way. |

New files: `src/features/directory/DirectoryView.jsx` (port the mock's markup + CSS), `src/features/directory/directory.css` (or inline `<style>` as the mock does). Reuse helpers from `HiveView.jsx`: `formatPft`, `compactWallet`. Reuse `requestJson` (`src/api.js:1‑5`).

---

## 3. NFT‑backed avatars (reuse, don't build)

- Render each operator's PFP from their **hero NFT** image fields. Build candidates exactly like `profileNftImageCandidates()` (`main.jsx:297‑309`): `imageDataUrl` → `/api/profile/nft/image/{imageCid}` (IPFS proxy, `server/profile-nft-image-proxy.js:225`) → `imageGatewayUrl`. Reuse/adapt `ProfileAvatar` (`main.jsx:3290‑3317`) for the `<img onError=tryNext>` + initials fallback.
- The leaderboard endpoint (§4) must **include each operator's hero‑NFT image fields** (`imageCid`, `imageGatewayUrl`) so the row renders the avatar without an N+1 call. Prior art: Hive's project query already `LEFT JOIN profile_nfts` for contributor avatars (`server/repositories/hive-projects.js`) — copy that join.
- Fallback when an operator has no NFT: initials avatar (same as today).

---

## 4. Backend — `/api/directory/leaderboard`

Mirror the Hive backend triad:
- **Route policy:** `server/route-policies.js` near the hive entries (`:97`): `{ id: "directory_leaderboard", path: "/api/directory/leaderboard", methods: ["GET"], auth: "optional" }`. Public, like `hive_projects`.
- **Handler:** new `server/directory-routes.js` mirroring `server/hive-routes.js:98‑125` (method guard, call repository, `json(res, 200, { ok: true, document })`, observability event).
- **Repository:** new `server/repositories/directory-leaderboard.js`. Reuse the query patterns already in `server/repositories/profile-public.js`:
  - **rewards** (total PFT): `SUM(reward_actual_pft)` — pattern at `profile-public.js:150‑186`.
  - **networkTasks / personalTasks**: `COUNT(*) FILTER (WHERE task_kind = 'network'/'personal' AND reward_actual_pft > 0)` over `task_projections` (`006_task_projections.sql`).
  - **alignment** (0‑100): `alignment_score_7d * 100` from `profile_daily_airdrop_runs` (`019_profile_daily_airdrop.sql:19`) — conversion at `profile-public.js:200‑226`. Unscored operators → `null` → render "—" (PublicProfileView already does "Not scored yet").
  - **identity**: key by `account_id`; resolve `public_handle` via the `user_identity_vectors` view (`056_*`) / `user_observability_events` (`055_*`); display name priority `publicDisplayName → displayName → hiveHandle`. Prior art: `server/repositories/recommended-connections.js:81`.
  - **avatar**: `LEFT JOIN profile_nfts` (selected/hero) for `imageCid`, `imageGatewayUrl`.
- **Response shape** (per operator): `{ accountId, handle, displayName, wallet, networkTasks, personalTasks, rewards, alignment, heroNft: { imageCid, imageGatewayUrl } | null, hasPublicProfile, isYou }`. Plus top‑level `{ totals: { operators, tasksRewarded, pftDistributed }, generatedAt }`.
- **Sorting/limit:** order by composite score desc; sane `LIMIT` (e.g. 200) with a logged note if truncated. Consider a short server cache (the board isn't real‑time).
- **`isYou`:** when the request is authenticated, mark the viewer's own `account_id` row (the mock's "You" highlight).

### Visibility gate (trust‑safe default — see §6)
List **only operators who are public + discoverable**, the same gate `/api/profile/member` uses (`server/profile-routes.js:347‑356`, `getAccountProfileVisibility` `runtime-store.js:659`). Private operators are excluded. Set `hasPublicProfile` accordingly.

---

## 5. Row → public profile link ("where appropriate")

This is the one **new surface**. `/api/profile/member?accountId=X` already returns another operator's public profile (`profile-routes.js:321‑364`), and `PublicProfile` already renders it (`PublicProfileView.jsx:424`, props `{accountId, profilePublic}`) — but there is **no URL to reach it**.

Add a routable member‑profile target and have directory rows link to it **only when `hasPublicProfile` is true**:
- Extend routing to accept a member profile, e.g. hash `#/u/<handle>` or `#/profile?account=<accountId>` (pick one; `viewFromLocation` `main.jsx:361` + `navigateToView` `main.jsx:869` already parse hash + query — extend, don't rewrite).
- On that route, fetch `/api/profile/member?accountId=…` and render the existing `PublicProfile` component. Handle the 404 (not public) gracefully.
- Rows for operators without a public profile render as non‑interactive (no dead link — that's the bug we're fixing).
- The wallet value may link to the PFTL explorer (`pftlExplorerUrl` already exists in the app) — optional.

---

## 6. Decisions reserved for Alex (do NOT finalize — implement configurable)

Task Node is Alex's domain; these are policy, not engineering. Build the mechanism with the stated default and surface the choice — do **not** bake a final policy:
1. **Public exposure.** A public board ranking named operators by PFT earned + alignment. **Default: list only public+discoverable operators** (respects each operator's existing visibility setting). Flag: if Alex wants all operators (anonymized handles for private ones, or by‑wallet), that's his call.
2. **Rank formula.** Mock default = `3×networkTasks + personalTasks + rewards/25000 + alignment`. Implement it as a **single named function/constant** (one place to change), used as the default. Flag: the weighting is reputationally meaningful and is Alex's to sign off.

Leave both as a short "OPEN — Alex's call" note in the PR description / report.

---

## 7. Honesty of the surface

With a real endpoint the mock's green **"Live"** badge is honest. Keep "Live" only when data is real and non‑empty; show a neutral empty state ("No operators yet") otherwise. No fabricated rows. Remove the mock's hardcoded `OPERATORS` array.

---

## 8. Verification & evidence (the task's reward depends on this)

The skill defaults to *no* screenshots — **this task explicitly requires them, so override that default.**
- Run the app at `http://localhost:5174`. Capture **before** (Directory menu item does nothing / chat fallback) and **after** (working Directory page; an operator row; a member profile reached from a row; mobile width).
- Backend: focused `curl`/route smoke for `/api/directory/leaderboard` (use `npm run route-smoke` only if route contracts changed broadly). Frontend: `npm run lint` and `npm run build`. `npm run format-check` + `git diff --check`.
- Produce the task evidence report (in `docs/verification/` or attached to the submission): the ranked original issues (§0) → fix delivered, each referencing the exact page/element, with screenshots; plus changed files, commands run, and anything not verified. Reuse the issue list in §0 as the ranked findings.

---

## 9. Guardrails

- **Branch** `feat/directory-leaderboard` from current HEAD. **Preserve unrelated WIP** already in the tree (`WalletView.jsx`, several `*.css`, `main.jsx`) — never reset/stash/discard it; commit **only** directory files.
- **Do NOT push, open a PR, deploy/Fly, or commit to `main`** without Alex. No secrets, no economic‑policy decisions (§6), no schema changes beyond what the leaderboard needs (prefer querying existing tables/views — no migration if avoidable).
- Update `docs/wiki/` + `src/features/docs/docs-content.js` only because user‑visible behavior changed (a new Directory page).
- Report exact files, commands, and proof; be explicit about anything unverified.

## 10. Done =
Directory is reachable from the profile menu; renders a real, sortable leaderboard with NFT avatars; rows link to public profiles where discoverable and are inert (not dead) otherwise; all four columns show real data; loading/empty/error states handled; lint+build+route‑smoke green; before/after screenshots captured; evidence report written; work on `feat/directory-leaderboard`, nothing pushed.

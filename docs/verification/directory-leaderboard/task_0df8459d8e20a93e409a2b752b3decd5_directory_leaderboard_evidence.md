# Directory Leaderboard Evidence

Task: `task_0df8459d8e20a93e409a2b752b3decd5`
Branch: `feat/directory-leaderboard`

## Ranked Issues -> Fixes

1. Directory menu item was dead.
   - Fixed by registering `directory` in `APP_VIEWS`, adding the lazy `DirectoryView`, and wiring the existing profile-menu `Directory` row to `navigateToView("directory")`.
   - Evidence: `screenshots/before-directory-menu.png`, `screenshots/before-directory-click-noop.png`, `screenshots/after-directory-menu.png`, `screenshots/after-directory-page.png`.

2. `#/directory` fell back to Chat.
   - Fixed by adding the `directory` view and render branch with `Loading directory` suspense fallback.
   - Evidence: `screenshots/before-directory-hash-fallback.png`, `screenshots/after-directory-page.png`.

3. No `/api/directory*` backend existed.
   - Fixed by adding route policy `directory_leaderboard`, `server/directory-routes.js`, and `server/repositories/directory-leaderboard.js`.
   - The endpoint returns real rows from `task_projections`, `profile_daily_airdrop_runs`, `user_identity_vectors`, and `profile_nfts`, gated by public+discoverable runtime identities.

4. Mock Directory data and generated avatars were unwired.
   - Fixed by adding `src/features/directory/DirectoryView.jsx` and `directory.css`, using `/api/directory/leaderboard`, real NFT image candidates, sortable columns, loading/error/empty states, and no hardcoded operator array.

5. Public member profiles had no route.
   - Fixed by supporting `#/profile?account=<accountId>`, fetching `/api/profile/member?accountId=...`, and rendering the existing public profile component in member mode.
   - Rows link only when the backend marks `hasPublicProfile: true`.

## Screenshots

- Before: `docs/verification/directory-leaderboard/screenshots/before-directory-menu.png`
- Before: `docs/verification/directory-leaderboard/screenshots/before-directory-click-noop.png`
- Before: `docs/verification/directory-leaderboard/screenshots/before-directory-hash-fallback.png`
- After: `docs/verification/directory-leaderboard/screenshots/after-directory-menu.png`
- After: `docs/verification/directory-leaderboard/screenshots/after-directory-page.png`
- After: `docs/verification/directory-leaderboard/screenshots/after-member-profile.png`
- After: `docs/verification/directory-leaderboard/screenshots/after-directory-mobile.png`

## Changed Files

Directory implementation files:

- `server/directory-routes.js`
- `server/repositories/directory-leaderboard.js`
- `server/index.js`
- `server/route-policies.js`
- `src/features/directory/DirectoryView.jsx`
- `src/features/directory/directory.css`
- `src/features/hive/HiveView.jsx`
- `src/features/profile/ProfileView.jsx`
- `src/features/profile/PublicProfileView.jsx`
- `src/main.jsx`
- `scripts/route-smoke.mjs`
- `docs/wiki/surfaces/directory.md`
- `src/features/docs/docs-content.js`
- `docs/verification/directory-leaderboard/task_0df8459d8e20a93e409a2b752b3decd5_directory_leaderboard_evidence.md`
- `docs/verification/directory-leaderboard/screenshots/*.png`

Pre-existing unrelated WIP preserved and not reverted: `src/features/context/context.css`, `src/features/docs/docs.css`, `src/features/tasks/network-task-eligibility.css`, `src/features/wallet/WalletView.jsx`, `src/features/wallet/wallet.css`, `src/styles.css`, `mocks/DirectoryLeaderboard.jsx`, and `work_in_progress/directory_leaderboard_spec.md`.

## Commands Run

```bash
git switch -c feat/directory-leaderboard
curl -fsS http://127.0.0.1:8080/api/directory/leaderboard -o /tmp/directory-leaderboard-smoke.json
npm run lint
npm run build
npm run format-check
git diff --check
npm run route-smoke
node --input-type=module # browser screenshot capture scripts through Chrome CDP
```

Verification results:

- `npm run lint`: passed.
- `npm run build`: passed.
- `npm run format-check`: passed.
- `git diff --check`: passed.
- Focused endpoint smoke: passed, `operators=1`, first row `hasPublicProfile=true`.
- `npm run route-smoke`: passed with `#directory` included.
- Browser proof at `http://localhost:5174`: captured before/after menu, desktop Directory, member profile from row link, and mobile Directory screenshots.

Local verification data note: the dev database already had rewarded task rows, alignment rows, and profile NFT image rows for `acct_oauth_3c70e69ab7b8ef1fad3df508`. The local runtime visibility store and recommended-profile index were empty for that account, so local QA metadata was seeded outside the repo to mark that existing rewarded account public/discoverable and route-eligible. No mock rows were added to the product code or endpoint.

Not verified: production deploy, Fly, push, PR, and commit were intentionally not performed. Final rank weighting and public-exposure policy remain open for Alex.

## Open Decisions

- OPEN - Alex's call: final public-exposure policy. Current default lists only public+discoverable operators.
- OPEN - Alex's call: final rank weighting. Current default is configurable in `directoryLeaderboardScore`.

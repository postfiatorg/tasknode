# Automatic NFT names — 2026-09-06

Each new NFT is named by Kimi K3 during the existing image-review call, using the rendered artwork and anonymous image prompt. The name is not hand-authored by the assistant, selected from a fixed list, or generated from private task history in a new call. The existing art-spec and image prompts remain byte-for-byte identical to the approved v717 style.

The structured review response now includes a title. The worker checkpoints the title, naming model and naming-prompt digest beside the image asset, then publishes the title into the NFT row. Existing galleries and mint metadata read that saved title. Retries retain it. An invalid title leaves the approved image intact; the worker obtains a replacement title from the anonymous art spec. This same recovery handles older in-progress checkpoints without names. Previously completed NFTs are not renamed by this change.

Verification passed:
- `node scripts/profile-nft-art-smoke.mjs`: same-call naming, private identifier and placeholder rejection, ZDR model pinning, approved-image retention on invalid names, anonymous-only recovery input, mint title.
- `node scripts/profile-nft-prompt-smoke.mjs` and `node scripts/profile-nft-flow-smoke.mjs`.
- `node scripts/profile-nft-pipeline-smoke.mjs` on isolated `tasknode_nft_20260906`: persisted title, mint metadata, checkpoint retry stability, legacy checkpoint naming without rerendering, existing queue/lease and eligibility checks.
- `npm run lint`, inference no-regex check (231 files), provider egress check and `git diff --check`.
- Live Kimi K3 vision review of the prior anonymous sample: approved and named the image in one call. See `live-title.json`.
- Actual private NFT tile and public profile gallery displayed the returned model title; image alt text used it. See `browser-results.json`. Synthetic fixture data only; no real account NFT was created or renamed for testing.

Production verification passed on **v718** (`registry.fly.io/tasknodeofficial-dev:deployment-01M1W127WE8GB79TQB5S31ED5Y`). All 10 active process groups run the release, deployment worker guards passed, and the web and NFT renderer source/prompt hashes match the tested files. Public `/health` returned HTTP 200. See `deployment.json` and `hashes.json`. Temporary browser/Vite processes were stopped and the isolated fixture database was dropped.

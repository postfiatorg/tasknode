# Techno Mordor NFT verification — 2026-09-06

Implemented Kimi K3 ZDR task-history-to-spec generation, OpenAI image rendering, separate hyperstition/creature axes, three-total-task automatic eligibility, durable preparation/rendering, and consistent PFPs.

## Verification

- `node scripts/profile-nft-art-smoke.mjs`: pinned Kimi model/ZDR, forbidden Ambient fallback, schema bounds, independent axes, privacy/injection rejection, OpenAI field allowlist, strict vision review and mint traits.
- `python3 /mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-nft-refactor-20260906/run.py node scripts/profile-nft-pipeline-smoke.mjs`: dedicated PostgreSQL database; mixed task kinds, three-task boundary, no-wallet eligibility, zero-reward rejection/fixture exclusions, missing-art priority, canonical source, no request-time model call, concurrent deduplication, atomic daily-award linkage, retry spec reuse, selected-image preservation and stale-worker fencing.
- Existing profile flow, selection, prompt, daily-worker and PostgreSQL recovery smokes pass.
- `node scripts/inference-no-regex-check.mjs` covers the complete NFT generation/daily/renderer graph. `node scripts/provider-egress-check.mjs` confirms the isolated OpenAI boundary.
- `node scripts/profile-nft-visual-smoke.mjs`: actual Directory and MemberProfileView components with synthetic API responses. Includes a real anonymous generated image, empty art, broken image fallback, trait display, and desktop/mobile layout. Screenshots and `browser-results.json` are in this directory.

## Live provider evidence

The production renderer machine's existing credentials were used in an isolated temporary module to test the new pipeline before deployment. No real account/task history was used in these tests and no fixture was pinned, minted or inserted in production.

- Kimi K3 spec + independent ZDR review: 85.878 seconds. Synthetic infrastructure contributor: Ogre (level 4), hyperstition 44, rapid momentum.
- OpenAI `gpt-image-2`: 1024×1024 high-quality PNG, 2,555,360 bytes. Kimi K3 ZDR pixel review approved. Complete spec/render/review: 248.656 seconds. See [synthetic artwork](synthetic-ogre.png).
- Prompt-injected basket work: Goblin (1), hyperstition 1; private identifier/email excluded and injected Sauron demand ignored.
- Slow high-value accelerator infrastructure: Ogre (4), hyperstition 65, still momentum. Higher hyperstition did not invent relentless work or an economic network.

See `live-provider-results.json`. These bounded synthetic evaluations support the boundary and prompt behavior; they are not a guarantee that every future model classification is correct.

## Provider and ownership contract

The user confirmed the Vercel account is already on ZDR. Every private NFT call additionally requires `providerOptions.gateway.zeroDataRetention=true`, and no Ambient fallback exists. Only the reviewed anonymous art spec reaches the isolated OpenAI account. Vercel ZDR does not configure that separate account.

Official references: [Vercel ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr), [Kimi K3](https://vercel.com/ai-gateway/models/kimi-k3), [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2).

Automatic generation/display is distinct from chain ownership. The existing mint requires the owner's wallet signature; this refactor does not introduce server custody or pretend a generated PFP is a chain-minted NFT. Existing selected portraits remain selected.

## Deployment

Deployed release **v712**, image `deployment-01M1VRZTC9H66H7B1HEA3EPDRN`, to `tasknodeofficial-dev` with `PATH=/home/pfrpc/.fly/bin:$PATH npm run fly:deploy:prod`. Remote frontend build and runtime-tree packaging passed; `/health` and the new Directory bundle return HTTP 200.

The renderer was idle and was stopped during the rolling deployment so old code could not consume new preparation jobs. Renderer `48ee629a21e748` was then started on the same image as web `8d4930ae156638`; its read-only process guard passed. The scheduler automatically queued three v2 jobs, prioritizing the one eligible account without artwork. Before deployment: 49 eligible accounts, one without usable art.

Operator scripts now include `worker-nft-renderer` in the required restart coverage and post-deploy background guard. Their lint, dry-run and live renderer guard passed. These are operator-side checks; the v712 application behavior is unchanged by this later guard addition. Final artwork results are recorded in `production-results.json`.

At 16:39 UTC, all three real v2 production jobs had completed on their first attempt and their images were pinned. The eligible account previously missing artwork now has `nft_e04e204c-be2a-4d2b-a03f-4f7ff1b63913`. The eligibility scan reports **49 qualifying accounts, zero without an image record**. Existing older images were not regenerated en masse. Public thumbnail delivery is checked separately in `production-results.json`.

The dedicated fixture database was dropped after testing. The temporary browser and Vite server were stopped; build and live-test artifacts remain on the mounted data volume. No Rust build, Corbanu terminal change, new recurring loop or server-signed NFT mint was introduced.

## Cold-thumbnail defect found during live verification

The first delivery check returned HTTP 200 SVG placeholders (265–267 bytes), not the generated portraits. That was not successful artwork delivery. Browsers treated those placeholders as fully loaded images and could keep showing them indefinitely. The repair changes cold misses to HTTP 202 JSON; the shared portrait shows its local PFP, polls with backoff, rejects legacy SVG responses and swaps to the real raster. Offscreen portraits wait until near the viewport, preserving the bounded server warm queue. The regression test exercises 202 → legacy 200 SVG → real PNG without requesting full images. The thumbnail proxy smoke verifies the 202 protocol and bounded warming behavior. Final deployment and raster-delivery proof follow below.

The renderer now persists one 192px WebP in its existing asset checkpoint. The image proxy reads that record by indexed CID on a disk miss, resizes when necessary, and serves it even if the local disk cache cannot be written. This prevents newly earned portraits from waiting behind older gateway downloads. The PostgreSQL pipeline smoke verifies that a real PNG render produces a retrievable 96px WebP through this path. Migration 137 adds the CID lookup index; it introduces no new worker or cache table.

The production cache directory was also root-owned (UID/GID 0, mode 755) while its application volume belongs to UID/GID 1000. Ownership was restored to the application. Root-run cache warmups now preserve the parent volume's owner, and persisted thumbnails can still be served if disk writes fail. No cached images were deleted.

## Final release and delivery proof

Release **v713**, image `deployment-01M1VTFH0QHD566YRJN61VHN38`, completed successfully. All ten active process groups use that image; the deployment's background guard includes the NFT renderer and passed. Migrations 136 and 137 are present in production. The homepage returns HTTP 200 and its deployed CSP permits the portrait's blob image URLs.

At 17:03 UTC the production scheduler had completed **five v2 jobs, all on attempt one**. All 49 qualifying accounts have an image record. This is record coverage, not a claim that every historical IPFS asset has been audited. Each of the five new images was verified separately.

Those five images were rendered before the thumbnail checkpoint release. A bounded backfill derived their 192px WebP thumbnails from the existing approved pixels after verifying each original SHA-256 against its render checkpoint. No image was regenerated and no image CID or public art metadata changed. See `thumbnail-checkpoint-backfill.json`.

At 17:05 UTC all ten public delivery checks (five images, each as 48px PNG and 192px WebP) returned HTTP 200 with the correct decoded raster dimensions. The initial v713 read also demonstrated a cold disk miss served directly from the durable render checkpoint. A real browser fetched and decoded the 192px WebP as a blob under the production CSP. See `production-results.json` and `production-browser-results.json`. Desktop/mobile component screenshots and the 202 → legacy SVG → raster regression remain separate browser-fixture evidence.

## Product name correction

The product/default artwork name is now **Profile Pic NFT**. The art theme remains in the internal prompts. Generation, repository defaults, mint metadata, studio copy, gallery fallbacks and help copy use the product name. Migration 138 renames existing v2 default titles, including active drafts, without regenerating images or modifying pinned/on-chain metadata.

`npm run lint`, `node scripts/profile-nft-art-smoke.mjs`, `node scripts/profile-nft-flow-smoke.mjs` and `git diff --check` passed. A focused browser check rendered the recovering studio draft and gallery tile with the new title. The production deployment built successfully and its background guards passed; `/health` returned HTTP 200. The production migration updated all six existing v2 records, including the user's reported `nft_c2612551…e8f22d` draft. That draft was still generating when checked. See `profile-pic-name-results.json` for the release, rendered title and production row proof.

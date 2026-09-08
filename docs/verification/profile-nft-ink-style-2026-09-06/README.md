# Profile Pic NFT ink style restoration — 2026-09-06

The v2 spec and image guide retained the creature ladder but dropped the historic artist lineage and softened the visual direction to warm-paper fantasy ink. Restored the lineage found in the historical `pftasks/prompts/profile/profile_nft_image_gemini_backup.md`: Virgil Finlay → Moebius / Philippe Druillet → Katsuhiro Otomo → Tsutomu Nihei → Ian Miller. The tracked v1 guide also supplied its stronger industrial linework, purposeful central figure, earned bionic anatomy and clean white background.

The live v2 specification, specification review and OpenAI image guide now agree on that direction. Hyperstition controls visual intensity independently of creature anatomy. The named artists remain fixed public prompt references; Kimi translates those influences into anonymous visual prose. Task history still goes only to Kimi K3 through Vercel ZDR; OpenAI receives only the approved anonymous specification plus the fixed image guide.

Changed files:
- `prompts/profile/techno_mordor_spec_v2.md`
- `prompts/profile/techno_mordor_review_v2.md`
- `prompts/profile/techno_mordor_image_v2.md`
- `docs/wiki/surfaces/profile.md`
- `src/features/docs/docs-content.js`
- `scripts/profile-nft-art-smoke.mjs`

Local verification passed:
- `node scripts/profile-nft-art-smoke.mjs`: pinned Kimi K3/ZDR, no Ambient fallback, independent axes, schema/privacy rejection, OpenAI allowlist, vision review and mint traits.
- `node scripts/profile-nft-prompt-smoke.mjs`: legacy compatibility.
- `npm run lint`.
- `node scripts/inference-no-regex-check.mjs`: 230 files checked.
- `git diff --check`.
- Render prompt length: fixture 3,373 characters; five 1,000-character unescaped visual fields 7,709 characters, below the existing 8,000-character boundary.

Existing images and already prepared jobs keep their saved artwork/prompt. Newly prepared generations and regenerations receive the revised guide. No account tasks, NFT records, scores or mint transactions are created by the synthetic provider check.

Live verification exposed a review-prompt ambiguity: Kimi corrected source wording and returned `approved=true` but retained `source_language` in findings. The strict code correctly rejected that contradictory verdict. The review prompt now explicitly defines findings as unresolved issues in the returned spec, and the smoke test preserves strict rejection of contradictory approval. The final live check reuses the first live Kimi candidate with the identical art-spec prompt, then performs a fresh independent review with the clarified prompt.

Live image verification passed:
- Anonymous synthetic engineering-work packet; no real contributor data.
- Kimi K3 independent review approved the spec with empty findings.
- OpenAI `gpt-image-2`, 1024×1024, high quality: 2,646,042-byte PNG.
- Kimi K3 image review approved privacy and art direction.
- Manual inspection: clean white negative space, strong black ink, red/blue accents, clear masked central figure, industrial machine anatomy and purposeful tool use. The sample is a level-4 Ogre at hyperstition 40; it does not evaluate the entire creature/intensity range.
- See `restored-ink-sample.png`, `approved-synthetic-spec.json` and `live-provider-results.json`. This is a qualitative example, not a controlled same-seed comparison or a guarantee for every generation.

Production verification passed on release **v717** (`registry.fly.io/tasknodeofficial-dev:deployment-01M1VYWP2RDXY5TKJWASXK8J86`). All 10 active process groups run this release and the deployment worker guards passed. The active web and NFT renderer prompt SHA256 values match the tested local files. Public `/health` returned HTTP 200. See `deployment.json` and `prompt-hashes.json`.

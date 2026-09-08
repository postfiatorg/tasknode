# Techno Mordor profile NFT refactor

Implement the user-requested two-axis art system and ensure every profile has a PFP. Users with at least three completed tasks across task kinds qualify for automatic artwork. Retain user-selected portraits. Existing Vercel account ZDR is confirmed by the user.

## Current boundaries

- `server/profile-nft-generation.js` runs privacy LLM calls during the HTTP request and accepts client-provided history. Replace with a durable background job reading canonical account-scoped task history.
- `server/profile-nft-privacy-gateway.js` uses the general GLM/fallback policy. The new art-spec stage must use `moonshotai/kimi-k3` through Vercel with explicit `providerOptions.gateway.zeroDataRetention: true`, without Ambient fallback.
- `server/profile-nft-render-worker.js` and its job repository own rendering. Persist the approved anonymous spec before OpenAI, retain it across retries, and fence job attempts.
- `server/repositories/profile-nft-daily-awards.js` uses more than three personal tasks OR one network task and requires an active wallet. Replace forward eligibility with at least three completed tasks in total; prioritize profiles without art, including accounts awaiting wallet linkage.
- Directory and public profile avatar components show initials/empty marks when no image is available. Give them a consistent illustrated PFP fallback and make directory portraits readable.
- `server/profile-nft-mint.js` requires the owner's signed transaction. Retain automatic PFP generation plus owner-signed minting. No server issuer/custody workflow was introduced.

## Art and privacy contract

Hyperstition is 0–100 usefulness of demonstrated work to the hypothetical future AGI. Bread and Circuses and Hostile AGI are separate supporting lenses, adapted from the checked-in navstrategies reference prompts. Creature form is an independent 0–11 aggression/abstraction ladder, exactly as supplied by the user. Work velocity changes line energy, pose and density; it does not substitute for evidence of abstraction, self replication or network creation.

Kimi receives bounded canonical task history, aggregate completion/velocity evidence and untrusted optional style preferences. No account IDs, wallet addresses, provider identities, chats or context documents are deliberately included. Kimi produces a typed, detailed anonymous art specification. A second ZDR review checks privacy and grounding. OpenAI receives only the allowlisted visual fields, public scores and fixed style guide. No raw task history, evidence, URLs, account identifiers or private rationale reaches OpenAI. No regex is permitted on this path.

## Acceptance and verification

1. Strict two-axis and creature-boundary fixtures, independent-axis examples, forged client history ignored, privacy/instruction rejection and no fallback after a ZDR failure.
2. Queue tests cover immediate HTTP acknowledgement, duplicate starts, persisted spec reuse, retries and stale-worker fencing.
3. Eligibility tests cover 0/2/3 tasks, mixed personal/network kinds, no-wallet accounts, existing art and missing-art priority.
4. Profile/directory browser verification covers art present, no art, failed image and mobile layout. NFT mint metadata includes the public art traits.
5. Verify Kimi ZDR with a synthetic source packet, then render representative anonymous artwork through the configured OpenAI integration. Document provider boundaries honestly; Vercel ZDR does not configure the separate OpenAI account.
6. Update wiki, embedded docs and evidence; deploy the completed repair and verify production coverage and queue outcomes.

## Implementation and release

The requested pipeline, eligibility and PFP changes are implemented and deployed, with the final image-delivery repair in v713. Canonical source reads and private preparation are asynchronous; completed specs and pinned assets survive retries; active worker attempts fence both success and failure publication. The daily award is linked atomically with its queue receipt and accurately stays `rendering` until an image is generated. General chat remains GLM 5.3.

Focused PostgreSQL, provider-boundary, recovery, art/metadata and browser checks passed. Live synthetic Kimi K3 ZDR / OpenAI / Kimi vision review passed, including adversarial score/identity instructions and separate high-value/slow-pace evidence. The production scheduler completed its first five v2 jobs on attempt one. All 49 currently qualifying accounts now have an image record, including the one previously missing artwork. The five new images passed real public PNG/WebP delivery checks. See [verification evidence](../verification/profile-nft-techno-mordor-2026-09-06/README.md) for exact results and the wallet-signature limitation.

A final live asset check exposed a separate cold-thumbnail defect: HTTP 200 SVG warming placeholders could permanently hide real NFTs in the browser. The delivery boundary now uses HTTP 202 JSON and viewport-aware thumbnail polling with backoff. A browser regression proves replacement with real pixels without a page reload or a full-image request burst.

New renders save a small PFP in their durable asset checkpoint for immediate access across machines. The five images generated during the rollout received the same checkpoint after their approved pixel digests were verified. The public image endpoint and browser blob decoding both passed on v713; migrations and all active process versions were verified.

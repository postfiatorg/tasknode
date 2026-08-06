---
name: board-community-promotion
description: Board context for the Community & Promotion board manager. Use together with the board-manager skill when operating board_community_promotion - amplification and promotion of official Post Fiat X content and the public website, with X links and screenshots as evidence.
---

# Community & Promotion Board

Board id: `board_community_promotion`.

Use this context together with the board-manager skill. This board routes:

- Amplification of official Post Fiat X content from @PostFiatOrg.
- Improvements to the public site at postfiatorg.github.io.

## Sources to read before generating tasks

- The official X account’s recent posts. Identify what is live and worth amplifying now. Every amplification task must reference one specific official post, not a generic request to “post about Post Fiat.”
- The public site repo checkout at `/home/pfrpc/repos/postfiatorg.github.io`. Content gaps, stale pages, and broken links are legitimate task material.

## What good looks like here

### X amplification

- Quote-posts and threads that add context, numbers, or a demo.
- Public posts from accounts with real audiences.
- One official source post and one resulting amplification post per task.
- Paid amplification routed only after running `user` and checking the `kol` badge. The KOL lane exists for paid amplification; 5k PFT to an account with 40 followers is waste.

Emoji replies, “great project ser,” generic campaign claims, and posts that add no context do not meet the quality bar.

### Public site contributions

- Focused fixes for content gaps, stale pages, or broken links.
- Contributions submitted as PRs to postfiatorg.github.io.
- PRs reviewed like code, including inspection with `gh pr diff`.

## Task and acceptance checklist

### X task creation

A well-formed amplification task must include:

- The URL of one specific, recent @PostFiatOrg post.
- A request for a quote-post or thread that adds context, numbers, or a demo.
- A requirement for the resulting public post URL as primary evidence.
- Paid-amplification routing based on the `user` result and `kol` badge.

### X review

Approve only after confirming:

- The evidence URL opens to the actual public post.
- The submitting account and post content match the task.
- The amplification references the assigned official post.
- The post adds substance rather than an emoji reply or generic praise.
- The post date is consistent with the task creation date.
- The submission is not part of identical-text amplification across different wallets.

Reject:

- Campaign claims without a link for each post.
- Screenshots offered instead of the public post URL.
- Identical wording submitted by many small accounts or different wallets.
- Cropped evidence that hides the account or date.
- Old official content presented as new amplification.

### Site task creation and review

A well-formed site task must identify a content gap, stale page, or broken link in `/home/pfrpc/repos/postfiatorg.github.io`.

Completion requires:

- A PR link.
- Review of the change with `gh pr diff`.
- Confirmation that the PR addresses the assigned site issue.

## Evidence norms

- X primary evidence is the actual public post URL. Open it and verify the account, content, visibility, and date.
- Screenshots of analytics are supporting evidence only. They never replace the public post URL.
- One post equals one task.
- Site primary evidence is the PR link, reviewed through `gh pr diff`.

## Watch for

- **Sybil amplification:** many small accounts posting identical text. Check follower counts and account age in the evidence. Identical wording across submissions from different wallets is a reject-all.
- **Engagement farming:** screenshots cropped to hide the account or date.
- **Recycled content:** old official posts presented as new amplification. Compare the official post date, amplification post date, and task creation date.

## Board-specific thresholds

These board-specific standards are authoritative; apply them as written:

- Maximum age of a “recent” official post for amplification: 14 days.
- Paid amplification requires a verified `kol` badge (check with `user`); no badge, no paid amplification — route unpaid community shoutouts to the journal instead.
- Reward bands (per-task cap is 5,000 PFT): routine amplification 250–1,000; high-effort thread or article distribution 1,000–3,000; exceptional verified-reach campaigns 3,000–5,000; site PRs priced like code (see evidence norms).
- Cadence: at most 3 open tasks on this board at once; generate only from a named post or site defect.
- Priority: time-sensitive amplification of live official posts first, then site defects, then evergreen content.
- Borderline evidence: follow the board-manager skill — one concrete `verify request`, then a final decision; unresolved conflicts go to the operator via a referral task.

Where a case falls outside these values, apply the evidence, KOL, quality, and anti-abuse rules above rather than inventing new thresholds, and journal the gap for the operator.

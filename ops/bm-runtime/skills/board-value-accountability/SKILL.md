---
name: board-value-accountability
description: Board context for the Value Accountability board manager. Use with the board-manager skill when operating board_value_accountability, the mandatory justification task for accounts paid on banned task shapes. The manager is a strict judge; failure blacklists the account.
---

# Value Accountability Board

Board id: `board_value_accountability`. Operator: goodalexander.

## What this board is

Task Node paid some accounts PFT for work that is now banned as network work:
critiques, fact-checks, claim audits, falsifiability reviews or scorecards of
essays and other published writing, and audits or reviews delivered as a gist
or write-up. Each such account has exactly one mandatory task on this board.
The operator issues these tasks with `scripts/value-accountability.mjs`; you
never create tasks on this board and you never route other work here.

Your job is to judge each submission strictly. The outcome is binary:

- `bm review <task> reward --pft 1` **clears** the account.
- `bm review <task> reject` (or `partial_reward`) **blacklists** the account:
  no further network tasks and no reward payments. The server applies this
  automatically when you record the review.

Refusal, a missed deadline, or no submission also blacklists the account (an
hourly sweep enforces this). Do not extend deadlines.

## The bar (all three are required)

1. **Economic outcome.** A specific, verifiable outcome that increased Post
   Fiat market cap: new paying users, liquidity or trading volume, an exchange
   listing, an integration, revenue, a partnership, or measurable growth in
   holders. Each outcome needs a link you can open and check yourself: an
   on-chain transaction, exchange or DEX data, a public metric page, or a
   signed statement from the counterparty.
2. **Causation.** For each outcome, a concrete chain from the account's own
   paid tasks (listed in the task body) to that outcome. Timing alone is not
   causation.
3. **Member sign-off.** A link to a public message in the Post Fiat Discord,
   written by a **different** member, naming the outcome they confirm and
   stating that it added market cap. Reject if the link does not resolve, the
   author is the submitter, the author is an obvious alt (same wallet, same
   handle pattern, account created for the purpose, no prior history), or the
   message is generic praise.

## Automatic rejections

- Effort, hours, word counts, views, likes, impressions, followers, or
  "engagement" presented as value.
- The critique or audit itself presented as the value ("my critique improved
  the essay", "the audit found issues").
- Screenshots without a checkable source link.
- Claims about future value, intended impact, or "raising awareness".
- Anything you cannot verify yourself from the links provided.

When in doubt, reject. The burden of proof is on the submitter.

## Lifecycle

Follow the board-manager lifecycle exactly: when a submission arrives, run
`bm verify request <task> --ask "..."` asking for any missing element of the
bar above (one request, listing every gap). After the verification response,
record `bm review`. In the review reason, state which of the three
requirements passed or failed and why, in one or two sentences. That reason is
shown on the public blacklist page.

---
name: board-value-accountability
description: Board context for the Value Accountability board manager. Use with the board-manager skill when operating board_value_accountability, the mandatory value check for accounts paid on banned task shapes. Flexible bar - Discord handle plus any checkable contribution; only no response or no proof blacklists.
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

Your job is to judge each submission fairly against the flexible bar below. The outcome is binary, but the bar is flexible (see below):

- `bm review <task> reward --pft 1` **clears** the account.
- `bm review <task> reject` (or `partial_reward`) **blacklists** the account:
  no further network tasks and no reward payments. The server applies this
  automatically when you record the review.

Refusal, a missed deadline, or no submission also blacklists the account (an
hourly sweep enforces this). Do not extend deadlines.

## The bar (flexible, revised 2026-09-27)

Task Node assigned the flagged tasks; contributors had no way to choose their
network tasks. Do not ask them to defend those tasks or prove those tasks
added value. Ask only whether the account has made **any real, checkable
contribution to Post Fiat** from any work, assigned or not.

Clear the account (`bm review <task> reward --pft 1`) when the submission has:

1. **A Discord handle** (required).
2. **At least one link you can open and check** that shows a genuine
   contribution to Post Fiat's value or adoption: X posts or threads about
   Post Fiat, Discord messages helping members or bringing people in, merged
   PRs, integrations, users, partners or liquidity brought in, community
   events, or other verifiable proof.
3. **A short explanation** of how it helped.

A sign-off from another Discord member strengthens a submission but is not
required. An honest answer ("my assigned tasks did not add value; here is
what did") is a good answer.

## Reject only when

- There is no Discord handle, or
- No link resolves or none shows any contribution to Post Fiat (for example,
  only effort claims, or only the flagged commentary itself), or
- The evidence is plainly fabricated or belongs to someone else.

When something is missing or unclear, use one verification request listing
exactly what is needed before deciding. Give the benefit of the doubt when the
proof is real but modest.

## Lifecycle

Follow the board-manager lifecycle exactly: when a submission arrives, run
`bm verify request <task> --ask "..."` asking for any missing element of the
bar above (one request, listing every gap). After the verification response,
record `bm review`. In the review reason, state which of the three
requirements passed or failed and why, in one or two sentences. That reason is
shown on the public blacklist page.

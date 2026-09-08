# Hive chat routing — task evidence draft

Status: implementation deployed; commit/PR evidence is missing. Do not submit this
as satisfying the commit/PR acceptance criterion until the source is committed
and published.

The canonical local repository is `/home/pfrpc/repos/tasknode`;
`/home/pfrpc/repos/tasknodeofficial` is a symlink to it. Its GitHub remote is
`postfiatorg/tasknode`. On 2026-09-07, the deployed Hive group files remained
untracked or modified, with no matching commit or PR found in local history or
GitHub. Fly releases v721, v722 and v723 are deployment versions, not Git commits.

## Before and after description

Before: Hive used an account-scoped conversation via `/api/hive/chat`. It was not
a single conversation shared by all contributors.

After: signed messages enter `/api/hive/group/messages` and a shared Nostr thread.
Other registered contributors receive the same message with the author's handle,
profile picture, mentions and reply references. Posting does not invoke a model.
A periodic GLM 5.3 Flash decision can remain silent or select a GLM 5.3 response;
actionable board issues can enter the existing Kimi K3 board-manager inbox.
Previous private conversations remain private and read-only.

The automatic per-message assistant interaction was replaced with selective
participation. The reply prompt discourages canned praise, repetitive check-ins
and long speeches. The static introduction (“THE NETWORK, IN CONVERSATION”,
“Everyone’s in the same room.” and the following filler paragraph) was removed
from the deployed page in v722. This does not establish a blanket guarantee
against advisory wording in every generated model response.

## Source and recorded verification

- Shared routing: `server/hive-group-routes.js`,
  `server/repositories/hive-group.js`, `shared/hive-group.js`, and
  `src/features/hive/HiveGroupChat.jsx`.
- Selective bot participation: `server/hive-group-worker.js`,
  `server/hive-group-provider.js`, and `prompts/hive/hive_group_*_v1.md`.
- `scripts/hive-group-smoke.mjs` checks that another account reads the same signed
  message, sending does not invoke the model, idle rooms do not trigger model
  calls, and forged/cross-account submissions are rejected.
- `scripts/hive-group-visual-smoke.mjs` exercises the actual React views with two
  synthetic participant identities and a shared feed.
- `backend-results.json`, `browser-results.json` and `model-evaluation.json` record
  the September 6 verification. The live model evaluation includes casual chatter
  returning `respond:false`, a public question selecting a response, and actionable
  blocker paraphrases selecting board escalation. Those historical checks were
  inspected for this evidence draft; they were not rerun today.

## Reproduction

1. Activate Messages for two accounts and open Hive chat in separate browsers.
2. Post from one account; verify both see the same signed message and author.
3. Mention the other participant and reply to the message; check the identity and
   Nostr event links.
4. Verify that sending creates no immediate bot run. The periodic classifier
   decides independently whether a contribution is useful; an idle room stays idle.
5. Verify the removed introduction is absent.

Outstanding acceptance item: a published commit or PR whose diff contains the
implementation and whose description includes this before/after behavior and
verification. No unrelated older Hive commit should be cited as proof of this fix.

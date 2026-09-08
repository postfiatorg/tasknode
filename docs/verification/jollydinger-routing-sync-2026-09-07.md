# Jollydinger task sync and routing investigation

Investigated September 7, 2026 from production records. Identity resolved before account queries: `acct_oauth_192942ec462127d60d77fe2f`, public handle jollydinger; active wallet `rfmdkPTQSXnu3qVW7ib85BE6ixkfeXEgMB`, historical wallet `rP2JRgCCeimwfvN7oSjguwMBhmwHVpHCEh`. Task-history inspection covers June 3–September 7; board-manager journal and generation investigations focus September 4–7. Provider link presence verified without exposing private identifiers.

## Findings

- Reducer row `67570314` failed August 18 with `context_ipfs_fetch_failed` for task `task_492cc751fdbe1a0c7b7cf427b52bb4a4`. Its exact offer transaction `93B4A18EF1378A122EE42D2F6BE4A614641EE7B19AFD36883F7EE6F18FE3ABE3` and CID `QmQHRcsWjBsXjAH2Jq7Kod6apjWkUmdt47uqghfwLpRLGG` already exist in the owned task event store. The projection has six events and is rewarded, with the later reward transaction as its head. The old integrity predicate recognized recovery only when the failed pointer was still the projection head, so later progress reintroduced a stale warning.
- Current account eligibility is true. Both KOL and Project Leader badges are verified and unrevoked; Project Leader is the selected default. These are two different permitted work families; Project Leader permits project_management, special_project_definition and open_source_project_definition. It does not grant code_task eligibility. Task Node Fixes is explicitly restricted to goodalexander.
- Recent network offers are promotion work, but a lifetime/three-month all-KOL claim is false. Task `task_bf58d2242409be34d894e557f3b3430d` (July 4, Define Nostr Integration Spec) and `task_9e84cbe846dcfc56f849b1ddc335556e` (June 29, community messaging scoping) were rewarded; June also contains engineering and QA tasks. The scoped manager user endpoint only sees currently assigned boards, excluding older projects.
- The manager journal conflated generation rejection with a board-wide commit outage. `nettaskjob_6c192f99f85b4ad81697f99e1d469a8a` was rejected as a duplicate of a refused slug-resolution task; three September 6 Task Node Fixes jobs failed `network_task_intent_needs_review:uncertain`. These do not establish a board-wide inability to create work.
- A separate diagnostics defect hid board assignment-validation failures behind HTTP 500 and a generic retry message. Expected assignment-policy failure now returns HTTP 422 with its actionable reason. We did not reproduce the exact historical HTTP failure, whose transaction rolled back; it remains incorrect to attribute it confidently to a board outage.

## Changes and proof

- Generalized stale hydration failure reconciliation to accept a later recorded projection head in the same owned task history. Still requires the exact failed event in the event store, a nonempty projection, matching account/wallet/task, and chronological progress. Historical errors remain untouched.
- PostgreSQL fixture passed: original exact recovery, later recovery, and seven unmatched/invalid cases; all nine audit rows preserved.
- Read-only production evaluation of the new predicate: audit_failures=1, current_failures=0 for the affected account.
- Board packets now expose the last ten failed generation jobs and actual reasons. Idle contributor packets include selected_default_badge. User packets disclose board/history scope and task creation dates.
- Board-agent reliability fixture passed: expected routing-policy error is 422; scoped user history declares its limits; concurrent idempotency, authorization and rollback tests remain passing.
- Lint, production build, and no-regex call-path check passed (238 files).

No badges, access policies, rewards, tasks, or public replies were issued or changed. No paid model calls were used. Production rollout and final checks:

- Release v731 complete: `registry.fly.io/tasknodeofficial-dev:deployment-01M1YVGB9RTBJGCVGTDKKAQ464`, deployed through `npm run fly:deploy:prod`.
- All nine post-deploy worker/board guards passed; production health is ok.
- Deployed `taskReadIntegrityByTaskId` on the affected task returned zero pending, processing, failed, or indexing-lag counts.
- Deployed board packet returned actual generation failure reasons and jollydinger as eligible with one free slot, KOL and Project Leader badges, and selected_default_badge=project_leader.
- Approximately 20 minutes elapsed; no paid inference, bounty, or reward issuance. Existing Fly capacity was used. No source push performed.

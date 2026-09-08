# Production task request, offer and KOL repair

## Confirmed failures

- The browser sent `expectedAccountId` on task requests and `expectedAttemptCount` on retry/dismiss. The handler supported them but the HTTP body schema rejected them before the handler. Both failures were reproduced as `request_body_field_unknown`.
- Two active direct-write offers contained malformed submission criteria: `task_3a8e09c197870ea5d6fa03207c29d9ed` (`:[`) and `task_7e27a8f164b5a71e335e4c0f4713112e` (`verification_policy`). The generator had checked truthiness rather than a typed, usable requirement. Their descriptions/steps contained the evidence to submit.
- At 17:32 UTC the canonical `goodalexander` account was `acct_oauth_3c70e69ab7b8ef1fad3df508`, with verified X `goodalexander` linked at 17:29:11 UTC and 174,859 imported followers. At 17:38 UTC its durable KOL badge `anb_87710d7ee69e8b46bcd3cd7ae98817cc` was verified. The card nevertheless checked stale session providers before durable badge status. This is account-scoped, independent of the active PFT wallet. The identity investigation distinguished active wallets `rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx` and `rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE` from historical wallets.

## Repair and checks

- The task body contract now accepts typed account/attempt guards while retaining rejection of unknown fields and invalid guard values. Real browser request/reload/retry and dismissal tests now validate their outgoing payloads against the actual server schema before returning fixture responses.
- Generation enforces typed text bounds, evidence enums and boolean flags, rejects truncated output, and runs a separate GLM 5.3 Flash structured readiness check. Invalid results use the existing bounded retry queue. Cached unpublished outputs are checked only after looking for an already-published offer, preserving publication recovery.
- Existing malformed offers receive a new audited offer event with criteria restored from their existing steps. Original events remain intact. Projection, request metadata and replay records are kept coherent; task IDs, scope, rewards and proposed status stay unchanged. See `submission-repairs.json`.
- Badge state includes fresh account identity proof. Cards prefer that proof over stale session aliases and refresh on window focus. Only current-account, unexpired verified badges can show Ready. See `badge-browser.json`.

Passed: `request-validation-smoke`, browser request recovery, browser dismissal, `task-generation-reliability-smoke` against a dedicated PostgreSQL fixture database, `taskgen-network-v2-smoke`, `taskgen-replay-smoke`, network badge approval/profile checks, badge freshness browser checks, lint and the inference no-regex guard. The network/replay fixtures' obsolete Ambient/GLM 5.2 default expectations were corrected to the existing production Vercel/GLM 5.3 policy; unsupported model overrides remain rejected.

The request contract hotfix was deployed first and production config/retry/dismiss schema probes passed. Final deployment and live provider evidence are recorded separately below. No task was requested on a real user's behalf for testing.

## Final production evidence

Release **v716**, image `deployment-01M1VXD7A71THRG8HWKRX9E965`, completed successfully. All ten active process groups use the release; the background guards passed and `/health` returns HTTP 200. See `deployment.json`.

At 17:51 UTC `getTaskDetail` returned the corrected submission requirements in both `submissionRequirement.criteria` and `verification.body` for both repaired offers. The current identity-approval response includes goodalexander's verified X link, follower metrics and verified KOL badge. See `production-readback.json`.

A live synthetic task completed generation and readiness review in **19.742 seconds**: Vercel `zai/glm-5.3` generated concrete instructions and Vercel `zai/glm-5.3-flash` approved them. Nothing was published to a real account. The live readiness evaluator also accepted an actionable requirement and rejected both circular placeholder instructions and schema-token text, including examples longer than the structural minimum. See `live-taskgen.json` and `live-readiness-cases.json`.

The dedicated PostgreSQL retry/ownership and replay persistence checks passed. The fixture database was dropped and the temporary browser/Vite processes were stopped. No extra recurring loop was created.

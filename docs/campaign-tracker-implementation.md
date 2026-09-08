# Campaign Tracker implementation

Implementation candidate dated 2026-09-06, deployed to the production Task Node backend on 2026-09-07 for the user-authorized Verglas pilot. Product contract: `../campaign_tracker_spec_20260906.md` in the parent workspace. Deployment and real-model qualification evidence: `CorbanuTerminal/qa/campaign-tracker/2026-09-07-verglas/README.md` in the adjacent checkout.

## Shipped code paths

The Corbanu Task Node menu exposes Campaign Tracker with explicit workspace enrollment, activity totals, own and granted timelines, read-only session replay, authorized search, scrollable full prompts, handle-based grants/revocation, access audit, campaigns, task corrections, and versioned human prompt reviews. A visible recording indicator distinguishes paused recording, pending synchronization, and gaps. No enrollment or sharing is performed on behalf of existing users.

Typed TUI notifications record human and automated input separately, assistant output windows, tool outcomes, goal changes, sub-agent metadata, and turn completion. Records include the authenticated immutable account, handle at execution, profile/account/origin isolation, repository remote/branch/commit/dirty state, goal state, local sequence and unique event ID. Existing transcript replay does not recapture historical events. Known credentials are removed before durable capture.

The local outbox uses a random XChaCha20-Poly1305 key protected by the existing encrypted credential vault. Files have fresh nonces, authenticated origin binding, atomic replacement and fsync. The outbox is capped at 256 MiB; full queues preserve unsynchronized work and expose a capture gap. Prompts larger than 1 MiB become explicit gap records. Assistant output is partitioned into lossless UTF-8 windows of at most 32 KiB and expires locally after 72 hours. Successful summaries remove the local source. No full assistant output is stored by the server.

The server encrypts payloads with AES-256-GCM bound to account/event identity. Activity, annotation and campaign payloads share a 1 GiB account quota. Activity expires 365 days after execution; dependent reviews and summaries are removed on deletion. Audit records and deletion markers expire after 730 days. Retention runs opportunistically on authenticated tracker traffic, at most hourly.

Summary processing uses the subscription gateway route `corbanu/glm-5.3-flash`, accepts only that model or resolved `zai/glm-5.3-flash`, and has no model fallback. It receives bounded output, associated prompts and observed facts, owned task candidates, and the current context revision. Structured validation rejects unknown task IDs and unsupported completion claims. Inferred mappings remain suggestions; owner corrections change canonical links and preserve an annotation. Verified-completion counts come from rewarded Task Node lifecycle records, never model prose. Missing token/cost metrics remain null, and agent execution duration is not represented as employee working hours.

## Server installation boundary

Migration `server/db/migrations/140_campaign_tracker.sql` is discovered by the existing migration runner. Configure a durable secret named `CAMPAIGN_TRACKER_ENCRYPTION_KEY` containing canonical base64 encoding of exactly 32 random bytes. Preserve this key with the deployment secret system; replacing it without re-encryption makes existing data unreadable. Missing/invalid encryption configuration fails closed. The September 7 rollout installed this secret through Fly's deployment secret system and applied migration140. The value is not present in source or QA artifacts.

`CAMPAIGN_TRACKER_GATEWAY_ORIGIN` is optional and defaults to the existing Corbanu subscription gateway. Only HTTPS origins or explicit loopback HTTP origins are accepted. The authenticated terminal sends its subscription credential transiently for entitlement and inference; the tracker does not persist it.

Every tracker route is under `/api/terminal/tasknode/campaign-tracker`, behind the existing terminal-session boundary. Grants require an accepted Task Node relationship and are directional. Existing task-history grants alone provide no tracker prompt access. Capabilities are summary, prompt, replay, review and export; each request rechecks current grants, relationship status, historical interval and workspace scope. Membership in a campaign conveys no prompt authority. Reads, replay, search, exports and mutations produce content-free access records.

## Verification commands

- `npm run campaign-tracker-smoke`: disposable PostgreSQL schema, actual migration and repository checks.
- `npm run campaign-tracker-contract-smoke`: gateway/schema tests and AST guard against regex on tracker LLM paths.
- `node scripts/campaign-tracker-live-model-smoke.mjs`: explicit subscription-backed pinned-model check.
- `node scripts/campaign-tracker-qa-server.mjs`: loopback-only PTY fixture using real PostgreSQL/routes, fixture authentication and assistant/summary responses. SIGTERM/SIGINT drops its own schema.
- `node scripts/campaign-tracker-pty-check.mjs before|after|shared|revoked`: assertions against actions actually performed in the local TUI.

Corbanu candidate evidence and PTY driver live at `CorbanuTerminal/qa/campaign-tracker/2026-09-06/`. Build products and detailed logs remain on `/mnt/HC_Volume_101713660`.

## Remaining rollout and qualification work

This implementation observes the active Corbanu TUI. Headless clients, activity outside enrolled workspaces, complete descendant-agent transcripts, and external editing time are not claimed as complete employee activity. Attachment counts are captured; durable authorized attachment proxies and binary payload storage are not implemented. Output windows are individually summarized; a merged long-session summary is not yet implemented.

The API supports campaign members/tasks, workspace-scoped grants and explicit export capabilities. The initial menu creates personal campaigns and offers summary or prompt/replay/review grants; campaign membership editing, advanced grant filters and export-file management require further UI work. Aggregate scans are bounded and return a partial flag. Historical context content is not snapshotted in each review; context revision and source record revision are recorded where available.

Before expanding the pilot: qualify backup restoration and key rotation for the installed deployment-managed encryption; run deletion-tombstone replay before exposing restored backups; qualify retention scheduling without incoming traffic; calibrate mapping and summary quality on the specified pilot set; measure throughput, p95 latency and storage at the planned account volume; finalize subscription quotas and enrollment policy. No inference-based automatic task acceptance, verified completion, or employee performance decision is enabled.

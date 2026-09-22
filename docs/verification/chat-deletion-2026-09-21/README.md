# Immediate sidebar chat deletion

The sidebar previously waited for DELETE and then a complete app-state refresh before removing a conversation. Confirmation now closes immediately and removes that row locally while the server saves the deletion. No app-state or wallet refresh runs on the delete path.

HTTP errors, network errors and the 15-second request timeout restore the affected row with a dismissible, account-scoped error. A retry that finds the conversation already deleted succeeds. The open conversation clears after server confirmation; selecting a different conversation while the request is pending preserves the newer selection. A mutation revision filters pending deletions and late app-state responses, while fresh server state can still reflect intentionally re-enabled Hive conversations.

## Verification

- `node --test scripts/chat-deletion-state.test.mjs`: four tests pass, covering late snapshots, concurrent failure rollback, account separation and Hive re-enabling.
- `node scripts/chat-deletion-browser-smoke.mjs`: real Chrome and the actual React app, with isolated synthetic HTTP responses. Holds DELETE responses open to verify immediate row removal and modal closure; covers HTTP failure, network failure, retry, active-chat selection, and mobile overflow. No real user's chats are deleted by these tests.
- The original production frontend failed the immediate-removal check; see browser-production-before.log.
- Development UI passed at 6.5–10.1 ms from confirmation to row removal. The production build passed at 1.1–2.4 ms. These are browser fixture measurements with network responses held open, not a network latency benchmark.
- The deployed frontend passed at 1.2–2.4 ms, with zero app-state refreshes during deletion. See browser-production.json.
- `npm run lint`, `npm run format-check`, `git diff --check` and `npm run build -- --outDir <volume scratch>/dist` passed.

## Deployment

Production API machine 8d4930ae156638 is healthy on image registry.fly.io/tasknodeofficial-dev:chat-delete-ui-20260921, digest sha256:329e801911c5f175affb0594cdcf8bd104b2c929e5e77bba03d24edf1495ed1f. The image copies rebuilt browser assets onto the previous live image; server code and workers are retained. Fly health checks and production /api/health passed. All five entry-page JavaScript/CSS assets served in production match the tested build by SHA-256; see live-assets.json.

Rollback image: registry.fly.io/tasknodeofficial-dev:badge-default-api-20260921@sha256:f30c829108359b5ebe3df56afe9ebeb478ead5da60b115fdccabb95e2b5ae43b.

Build, image and deployment logs: /mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-chat-delete-20260921/.

Source changes are in src/app/App.jsx and src/features/chat/chat-deletion-state.js, with a chat wiki update. Existing unrelated working-tree changes were preserved. No Git push or Task Node task request was made for this direct bug report. Already-open pages need one reload to receive the new JavaScript.

# Evidence Bundle: Verified Orc Messaging Bridge

Task: `task_c6a991a7ef8956a53c3b593e93cbc2a1`

This bundle contains the runnable code, fixture inputs, generated JSON delivery log, Discord-ready summary, smoke test, and command outputs needed to verify the bridge behavior.

## Verification artifacts

- Bridge CLI: `scripts/orc-verified-messaging-bridge.mjs`
- Smoke test: `scripts/orc-verified-messaging-bridge-smoke.mjs`
- Fixture messages: `docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/sample_messages.json`
- Fixture contributors: `docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/sample_contributors.json`
- JSON delivery log: `docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/outputs/delivery_log.json`
- Discord summary: `docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/outputs/discord_summary.md`
- Run stdout: `docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/run_output.json`
- Help stdout: `docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/help_output.txt`

## Proof points

- Resolves contributors by account id or wallet address.
- Records conversation lookup HTTP status, response, and timing.
- Records post attempts with HTTP status, response, timing, and scheduled exponential backoff.
- Re-fetches posted messages and verifies visibility/message-id match.
- Emits stage-level diagnostics: `conversation_lookup`, `message_post`, `message_retrieval`, or `none`.
- Covers five contributors, including `@zoz`, and includes success plus conversation-not-found and HTTP-error scenarios.

## Smoke result

```text
orc-verified-messaging-bridge-smoke ok
```

## Run result

```json
{
  "ok": true,
  "schema": "pf.orc.verified_hive_messaging_bridge.v1",
  "totalMessages": 5,
  "deliveredVerified": 2,
  "failed": 3,
  "retriedMessages": 2,
  "byFailureStage": {
    "none": 2,
    "conversation_lookup": 1,
    "message_post": 1,
    "message_retrieval": 1
  }
}
```

No live Hive messages or enforcement actions were executed.

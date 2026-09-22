# Liquiditygooner verification investigation — 2026-09-11

All ten reported tasks were already rewarded before this investigation. Independent PFTL RPC lookups verified ten validated `tesSUCCESS` payments of 4.5 PFT to the linked wallet, totaling **45 PFT**. No retry, new reward, task-state mutation, worker restart, code deployment or public message was performed.

## Identity and source boundary

- Public handle: `liquiditygooner`. Account: `acct_oauth_6f6b1191285875299910c18f`.
- Linked/user wallet: `rPTCS8SJr17SbMVSoro1vHF13iFQAXPN5w`. GitHub, Telegram, X and Discord identities are linked; private provider identifiers are omitted.
- PFTL sync also associates the shared allocation/authority wallet with this account. It is not a second user-owned wallet.
- Queried the production `worker-task-review` machine `6835d0ea464158` in `tasknodeofficial-dev`, using its own database connection. The local cached development-data connection did not contain these tasks and was not used as production evidence.

## What the recorded timeline proves

Initial submissions received follow-up verification requests in 8.569–15.838 seconds. The next verification-response events were recorded 21.875–38.012 hours later. Rewards followed those responses in 25.566–42.240 seconds. Thus the long recorded interval was `verification_requested`, which waits for the contributor response, rather than `verification_response_submitted`, which waits for review.

These records do not establish why the responses were absent during that interval: user understanding, an agent workflow, or an unrecorded client failure cannot be distinguished from lifecycle events alone. Three recorded account action failures were database read timeouts on other task/request IDs; none names one of the ten reported tasks. Do not characterize this as contributor negligence.

| Task | Waiting for response (hours) | Response to reward (seconds) | Reward recorded (UTC) | Transaction |
| --- | ---: | ---: | --- | --- |
| `task_19ec2d5e2331f6d93dcac0398b3a0109` | 26.36 | 33.55 | 2026-09-11T13:46:17.025Z | `8DC9D56446036AF40BEAAA2F7652CA5508A509A2E9335F4176B8935C4CEB5AA6` |
| `task_484adfad14b7070425f62b822a17ab43` | 21.87 | 37.87 | 2026-09-11T13:24:01.017Z | `20754CCC3EAA1CE14DBCE36929CA1C52E6973E596D2A85C05EF280BD180F6093` |
| `task_5dfa3537a65ba33b96da7d93bc9f3e7c` | 27.36 | 33.89 | 2026-09-11T13:28:27.527Z | `AB761529D49BD0F232B65159DC592CA5F2D872F528A593B2842879BB06D4CD94` |
| `task_7cdbc2b9270d3211a971b927d3e17103` | 35.59 | 42.24 | 2026-09-11T13:32:41.638Z | `ED078C4AF14CB2AC62107A1DDD9C81C7E169D82A0E40EF39710762F3CBDD0845` |
| `task_9f9aeae05476625535e64f774c30a2fe` | 29.46 | 31.92 | 2026-09-11T13:47:05.554Z | `24490DFF57559BE3C9F04D9A8DD722315AD138DB1F78520B9AE333F03D25B4DD` |
| `task_a3c9ddc9dba8c063a88c06b6bba647de` | 38.01 | 27.22 | 2026-09-11T13:33:26.701Z | `0054906774584D83FA09DFC3D3F8BC9774F1740219DF941F5A81B2238D49BC2B` |
| `task_b63e8911d29df8bfc5fa0b4562926d1d` | 24.50 | 25.57 | 2026-09-11T13:26:35.935Z | `D0513B6351A5350D92F3BA065B2334D9D8222F4A4213B9E49AD49CB3D28DCD5C` |
| `task_d3136e678c00e7bcb31bcdf78da712c2` | 28.46 | 32.86 | 2026-09-11T13:30:26.884Z | `F57A57F4294DC95BCFE93790DAB5317C2A84A381BD7F3AA6C20F0F7647E61895` |
| `task_effebb32b57f860c074ab3987222731b` | 30.58 | 39.22 | 2026-09-11T16:09:10.604Z | `2CC756B0070BE9762C2B7002877FA71E6FA591EFCE820F32A671B8F3C128470B` |
| `task_fd8fdca2fdd3ea92093cbb16217d7ef2` | 28.64 | 29.72 | 2026-09-11T15:26:35.531Z | `858EB52ECAA9F90EFB66970819C8D1A0A66F9C3024A905A17BA83863BC20B78C` |

## Current next actions

At the investigation snapshot, this account has no tasks in `submitted` or `verification_response_submitted`. Four newer tasks require a verification response from the contributor:

- `task_bd6f4252e12c88e9e2b0ee08eb64c8b4` — `verification_requested` since 2026-09-11T16:01:06.854Z.
- `task_5ac01083c9947bc1f362cc8130719afc` — `verification_requested` since 2026-09-11T17:46:30.123Z.
- `task_becfab7bda705321593895b086d8bbec` — `verification_requested` since 2026-09-11T18:59:10.596Z.
- `task_b18784c1df846a110bc35caf455fe087` — `verification_requested` since 2026-09-11T20:48:25.536Z.

The correct user instruction is to open each task in the Verification tab, read its verification request, and submit the requested response. A second reward should not be issued for the ten settled tasks.

## Support and UI limits

`shared/task-lifecycle.js` labels `verification_requested` as “Verification requested” and `verification_response_submitted` as “Awaiting review”; both appear in the Verification tab. No evidence proves what the contributor actually saw during the reported period.

`server/hive-group-worker.js` builds public bot context from room messages, board summaries and pending escalations. It does not include personal task lifecycle state, so it could not diagnose this queue. Adding personal account data to that public bot would require a separately scoped privacy-aware support interface; this investigation did not expand access.

Three real escalation records exist and remain pending: `hive_escalation_4c03f639-37bd-4b64-9033-1e00baed7f80`, `hive_escalation_48548574-bf48-4275-bdf8-771ca18accfa`, and `hive_escalation_8f654778-46fc-4b15-8ac3-9d6c9f05da8a`. They were not resolved or answered by this investigation. Their “sync-lag ruled out” language is stronger than the evidence supports.

One unrelated global verification-response task from July remains guarded after a validated failed payment to an inactive destination. It is not part of this complaint and was not requeued.

## Evidence

- `database-evidence.json`: production identity, task projections, publications and queue snapshot.
- `timeline-evidence.json`: lifecycle timestamps, account event counts and global queue limits.
- `support-evidence.json`: actual escalation records and recorded action failures.
- `timing-summary.json`: independently calculated stage intervals.
- `ledger-evidence.json`: ten independent read-only transaction lookups, matching destination and delivered amount.

## Suggested reply (draft only; not sent)

> We checked all ten task IDs against the live database and chain. All ten paid 4.5 PFT each today, for 45 PFT total. The long wait was between the follow-up verification request and the recorded response; after the response arrived, each paid within 26–42 seconds. Four newer tasks currently need verification responses. Please open those tasks in the Verification tab and answer the displayed requests. The bot could not see your task states, so its earlier escalation replies did not identify that next step.

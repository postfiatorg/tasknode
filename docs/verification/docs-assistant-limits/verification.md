# Document assistant response limits

User report: Coach produced `collaboration_request_failed` while ODV answered. Live reproduction with a detailed document review returned HTTP 200 from Vercel but `finish_reason: length`, exactly 2,400 completion tokens, and no visible answer. The service rejected this as `inference_response_truncated`; the collaboration route hid the reason.

Both personas now start at 32,768 completion tokens and retry a token-limit failure once at 65,536. The provider budget includes reasoning and visible text. Complete answers are retained through the backend, parent iframe bridge, and encrypted chat. Five-minute provider attempts share a nine-minute deadline; PFDocs bridge and inner-query deadlines are 9.5 and 10 minutes. Fly's [HTTP connection timeout](https://fly.io/docs/reference/configuration/#http_servicehttp_optionsidle_timeout) is ten minutes. Friendly failures preserve a typed diagnostic without logging prompts or upstream error text. Collaboration paths and error-code validation use ordinary typed parsing, covered by the inference regex-ban check.

Checks:

- `node scripts/docs-assistant-limits-smoke.mjs`: both personas and paraphrases, 135K-character full answers, actual inference transport truncation/retry, finite budget, access denial, Ambient fallback, safe provider failures, and typed routes.
- `node scripts/docs-chat-history-smoke.mjs`
- `node scripts/collaboration-contract-smoke.mjs`
- `node scripts/inference-no-regex-check.mjs`
- `npm run lint` and `npm run build`
- PFDocs: 20 protocol/bridge tests and focused runtime ESLint.
- PFDocs browser fixture: Coach response over 100K characters passed encrypted delivery, complete response tail, desktop/mobile layout, collapse/reopen. Local candidate assets were overlaid for this pre-deploy check.

Live candidate uses actual Vercel inference on synthetic documents, with an injected fixture access check. It does not read any user's private document. Production verification is recorded after rollout.

## Deployment

Deployed Task Node release **702** and PFDocs release **61** on 2026-09-05. App health and background process guards passed. All machines use the new releases. Deployed backend hashes and all eight main/sandbox PFDocs module hashes match the working tree. Fly advertises the 600-second idle timeout.

Both deployed personas completed live Vercel GLM 5.3 requests with the 32,768-token budget. Coach completed the detailed review that had exhausted its former 2,400-token cap. Separate live calls verified that both Vercel and Ambient accept `max_tokens: 65536`.

The production Coach browser check used **no source overlays** and delivered a 107,522-character fixture response through the actual encrypted chat, retaining the complete tail on desktop and mobile. Provider output tests and encrypted bridge tests are separate: no user's private document was read or modified.

Evidence: [deployment.json](deployment.json), [before-live.json](before-live.json), [candidate-live.json](candidate-live.json), and [production/pad-results.json](production/pad-results.json).

The production ODV spreadsheet check also passed with a complete 107,522-character encrypted reply and no source overlays: [production/sheet-results.json](production/sheet-results.json).

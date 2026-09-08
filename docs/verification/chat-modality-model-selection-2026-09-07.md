# Saved modalities and model selection

User reported that the only available model button was 5.3 after the selector deployment. Source inspection identified the exact label as the active-modality branch: it disabled the picker, sent Thinking regardless of the saved model, and repeated the override in estimates, product preflight, and streaming/nonstreaming execution.

Removed the modality override at each boundary. Modality prompts, profile requirements, and per-account selection persistence remain active; the selected model now controls execution and billing. Context Refine, Context Rewrite, Deep Research, and Hive group chat retain their separate workflows.

## Verification

- `node scripts/chat-model-picker-composer-smoke.mjs`: real ChatSurface at five desktop/mobile widths; each of eight saved modalities rehydrated from account storage, both Astra and Kimi selected and sent, and captured request payloads retained the correct model and persona. I Ching uses a fixture saved profile. Keyboard Enter, mouse selection, and remount persistence passed.
- `node scripts/chat-modality-model-selection-smoke.mjs`: eight modalities × two API models, including a saved I Ching profile; estimates and send/stream preflights retain the model. Streaming and nonstreaming execution use mocked provider calls to assert the exact model and provider-cost billing. No real user records or paid inference.
- Existing persona routing and API-model billing smoke tests passed.
- Lint, production build, and no-regex inference audit passed (238 reachable files).
- Deployed via `npm run fly:deploy:prod`, release v730 complete; image `registry.fly.io/tasknodeofficial-dev:deployment-01M1YTBTD7ATHDHKBKYW9Y7BQQ`.
- All nine post-deploy background worker/board guards passed; production health returned ok=true.
- Production server SHA256 values matched tested source for chat-router.js, chat-estimate.js, and product-chat-contracts.js.
- Publicly served `/assets/index-ByB04OMw.js` matched the tested build, SHA256 `71d60061f9ebb1ebea16edb67b8dc8b04c680f9b5ee495763a680f880b220780`.

Authenticated rendering used the browser fixture, not the user's live browser session. Existing secrets and previously verified provider connectivity were preserved. No source push performed.

# Review Plan: AI Providers

Source doc: `docs/wiki/architecture/ai-providers.md`
App doc group: Architecture
App doc slug: `ai-providers`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/chat-router.js`
- `server/chat-search-tools.js`
- `server/chat-estimate.js`
- `server/product-contracts.js`
- `prompts/chat/*.md`
- `scripts/runtime-store-smoke.mjs`

## What Could Go Wrong

- Mode labels do not match provider/model/tool behavior.
- Environment overrides affect modes the docs say should be pinned.
- OpenAI and OpenRouter usage accounting diverges from ledger writes.
- Web search policy is inconsistent between estimate, request, and billing.

## Best Practices To Check

- Provider request construction should be deterministic and covered by fixture
  tests.
- Mode-specific model overrides should be explicit and scoped.
- Usage returned by providers should drive final billing.
- External tool use should be opt-in by policy and observable in usage.

## Code Review Plan

1. Review mode matrix and model selection in `chat-router`.
2. Compare OpenAI and OpenRouter request bodies to doc claims.
3. Check web-search selection and tool-cost accounting.
4. Verify estimates include memory/task/tool-relevant inputs.
5. Review failure paths for provider timeout, disabled provider, and missing key.

## Evidence To Capture

- `npm run runtime-smoke`
- Provider request fixtures for all four modes.
- Usage/ledger fixture for web search and non-search responses.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

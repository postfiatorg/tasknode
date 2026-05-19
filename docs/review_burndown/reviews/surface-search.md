# Review Plan: Search

Source doc: `docs/wiki/surfaces/search.md`
App doc group: Surfaces
App doc slug: `search`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `docs/wiki/surfaces/search.md`
- `src/main.jsx` tool navigation and "More" menu entries
- `server/chat-search-tools.js`
- `server/chat-router.js` OpenAI tool configuration
- Future cache/search repository, if implemented

## What Could Go Wrong

- Search is visible as a surface but only web-search routing exists, not an app
  search product.
- Private modes accidentally get external search behavior when the doc says they
  should not.
- Current-information signals are too broad or too narrow and surprise users.
- Search cost is not reflected in usage or visible billing.

## Best Practices To Check

- Distinguish app data search from provider web search.
- Search mode and provider behavior should be deterministic and testable.
- Tool costs should be included in usage records when the provider reports them.
- Empty or unavailable search should have visible UX states.

## Code Review Plan

1. Verify whether the Search doc describes shipped app search or future product.
2. Check the prompt-governed Frontier web-search tool behavior against the doc's intended behavior.
3. Confirm OpenRouter/private modes cannot accidentally receive web search.
4. Confirm web-search calls and costs flow into usage and ledger records.
5. Identify missing app-search implementation or update docs/status accordingly.

## Evidence To Capture

- Unit or smoke cases for search-triggering and non-triggering messages.
- Provider request fixtures for private and frontier modes.
- Usage record showing search call accounting.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

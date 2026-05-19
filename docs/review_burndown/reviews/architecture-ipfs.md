# Review Plan: IPFS Standards

Source doc: `docs/wiki/architecture/ipfs.md`
App doc group: Architecture
App doc slug: `ipfs`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/context-ipfs.js`
- `server/context-publish.js`
- `server/context-history-rpc.js`
- `reference_clients/python/tasknode_pftl/ipfs.py`
- Task/context publish and hydration flows

## What Could Go Wrong

- CID fetch or pin failures are not surfaced clearly to the user.
- Payload class/schema is missing or inconsistent between app and Python client.
- Raw unbounded payloads are stored or sent where the doc expects encrypted
  bounded objects.
- Gateway errors collapse into generic provider failures.

## Best Practices To Check

- IPFS payloads should be schema-tagged, size-bounded, encrypted when private,
  and digestable.
- Gateway/pin failures should be retryable and distinguish fetch, parse, and
  decrypt failures.
- CID normalization should be shared and tested.
- Pointer metadata should be enough to retry without plaintext.

## Code Review Plan

1. Review context IPFS pin/fetch helpers and CID normalization.
2. Compare payload schemas used by context and task clients.
3. Check error handling for gateway unavailable, invalid JSON, and oversized
   payloads.
4. Verify private payloads are encrypted before pinning.
5. Capture missing task IPFS integration separately if not implemented.

## Evidence To Capture

- Context publish/hydrate fixture.
- Python IPFS/pointer tests.
- Negative case for invalid CID or invalid payload.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

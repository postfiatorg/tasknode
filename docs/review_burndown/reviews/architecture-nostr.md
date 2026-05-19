# Review Plan: Nostr Integration

Source doc: `docs/wiki/architecture/nostr.md`
App doc group: Architecture
App doc slug: `nostr`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `docs/wiki/architecture/nostr.md`
- Future Nostr relay/client code, if implemented
- PFTL pointer and public broadcast boundaries
- App Help rendering for TBD architecture

## What Could Go Wrong

- A TBD architecture page looks like shipped integration.
- Public broadcast semantics conflict with encrypted/private PFTL payload rules.
- Relay dependencies get added without ownership, moderation, or retention policy.

## Best Practices To Check

- TBD pages should be clearly labeled as design questions.
- Public broadcast data must be explicitly separated from private encrypted data.
- Relay writes should have retry, dedupe, and moderation/abuse boundaries before
  production.

## Code Review Plan

1. Confirm whether any Nostr runtime code exists.
2. Review the Help page language for shipped versus future status.
3. If code exists, review event signing, relay configuration, and data exposure.
4. Capture open decisions as product/design blockers, not implementation bugs.

## Evidence To Capture

- `rg` output for Nostr runtime references.
- Help page screenshot/note showing TBD status.
- Relay fixture only if implementation exists.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

# Review Plan: Encryption And MessageKey

Source doc: `docs/wiki/architecture/encryption.md`
App doc group: Architecture
App doc slug: `encryption`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/wallet-core.js`
- `server/context-publish.js`
- `server/context-ipfs.js`
- `server/pftl-pointer.js`
- `reference_clients/python/tasknode_pftl/encryption.py`
- `reference_clients/python/tasknode_pftl/scenarios/encryption_pubkey_demo.py`
- `reference_clients/python/tests/test_encryption_recipients.py`

## What Could Go Wrong

- Payloads are encrypted to the wrong recipients or omit required service keys.
- Client and Python encryption formats drift.
- Decryption failure is treated as missing data instead of a recoverable state.
- Published metadata exposes more than the doc allows.

## Best Practices To Check

- Encryption envelopes should include schema, recipients, algorithm, and digest
  metadata.
- Cross-client fixtures should prove browser and Python compatibility.
- Recipient derivation should be deterministic and tested.
- Decryption failures should preserve pointer metadata for retry.

## Code Review Plan

1. Compare the doc's envelope standard to browser and Python implementations.
2. Review context publish recipient selection and TaskNode sharing rules.
3. Check PFTL pointer metadata for exposed fields.
4. Run recipient and pointer codec tests.
5. Review error handling for missing keys, wrong wallet, and corrupt payload.

## Evidence To Capture

- Python encryption tests.
- Context publish smoke or fixture.
- A recipient list fixture for current-context publish.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

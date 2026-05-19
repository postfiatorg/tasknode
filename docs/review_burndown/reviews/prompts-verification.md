# Review Plan: Verification Prompts

Source docs: `prompts/task_engine/verification_request_v1.md`, `prompts/task_engine/evidence_screenshot_read_v1.md`
App doc group: Prompts
App doc slug: `prompts-verification`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `reference_clients/python/tasknode_pftl/verification.py`
- `reference_clients/python/tasknode_pftl/taskgen.py`
- `reference_clients/python/scenarios/verification_evidence_examples.py`
- `reference_clients/python/tests/test_verification_readers.py`
- Future web submission/evidence UI

## What Could Go Wrong

- Verification asks become broad or repeated instead of a single focused follow-up.
- Evidence readers claim facts not visible in the submitted evidence.
- Screenshot/PDF/DOCX/public URL extraction behavior differs from prompt policy.
- Web UI accepts evidence types the verifier cannot process.

## Best Practices To Check

- Evidence readers should separate extracted observations from judgments.
- Verification request generation should be deterministic or tightly bounded.
- Accepted evidence types should match reader support and user-facing validation.
- Prompt outputs used in task lifecycle should be recorded with version/digest.

## Code Review Plan

1. Review verification prompt files against Python verifier implementation.
2. Run verification reader tests for screenshots, PDFs, DOCX, and URLs.
3. Check evidence type validation in any web/app submission path.
4. Verify lifecycle integration records evidence CIDs and request IDs.

## Evidence To Capture

- Python verification reader tests.
- Example evidence receipt with extracted observations.
- Negative case for unsupported evidence.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.

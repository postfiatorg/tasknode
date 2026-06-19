# Verification Request Inspector Evidence

Task: `task_de9f8f03ae7b003903c148a70c6755a1`
Title: Build Verification Request Inspector CLI Tool

## Changed Files

- `reference_clients/python/orc_tooling/orcctl.py`
- `reference_clients/python/orc_tooling/__init__.py`
- `reference_clients/python/tests/test_orc_tooling.py`

## What Changed

Added `orcctl task verification-request <task_id>`, backed by `inspect_verification_request()`. The command compares:

- authenticated `/api/tasks/detail`
- public `/api/hive/task-detail`

It returns:

- selected verification request text
- source selected (`authenticated` or `public_hive`)
- authenticated status and verification prompt
- public Hive verification request/response
- public Hive outcome decision, reward PFT, and reason
- warnings when authenticated detail is generic but public Hive has a specific evaluator follow-up

## Focused Test

```bash
uv run python -m unittest tests.test_orc_tooling.OrcToolingTests.test_inspect_verification_request_warns_when_hive_has_specific_followup
```

Result:

```text
.
----------------------------------------------------------------------
Ran 1 test in 0.000s

OK
```

## Broader Test

```bash
uv run python -m unittest tests.test_orc_tooling
```

Result:

```text
................................................................
----------------------------------------------------------------------
Ran 64 tests in 0.027s

OK
```

## Live Command Example

```bash
uv run orcctl --agent grashnuk \
  --wallet-address raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW \
  --base-url https://tasknode.postfiat.org \
  task verification-request task_78bc0498dfcc292ed909b1da6743a1ba
```

Representative output:

```json
{
  "selectedSource": "public_hive",
  "selectedVerificationRequest": "From the generated file `docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json`, provide the full JSON entry for wallet `rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7` (including its component metrics/scores, composite score, priority score, band, and role) exactly as written in the output file.",
  "warnings": [
    "authenticated_detail_generic_public_hive_specific",
    "verification_request_sources_differ"
  ],
  "publicHive": {
    "state": "rewarded",
    "outcome": {
      "decision": "partial_reward",
      "rewardPft": 18000,
      "reason": "The submission describes a runnable aggregation script, sample inputs, generated risk-matrix output, commands, and a Discord-ready summary that align with the task requirements. However, the evidence is entirely self-attested and the follow-up verification request was not answered: the requested full JSON entry for the specified wallet was not provided. This leaves a key part of the generated output unverified."
    }
  }
}
```

## Boundary

This is read-only tooling. It does not submit evidence, respond to verification, mutate Task Node state, sign XRPL transactions, or move funds.

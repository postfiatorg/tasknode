# Artifact Resolution Packet: PR #169 artifact resolution

Schema: `pf.orc.evidence_artifact_resolution_packet.v1`
Generated at: 2026-06-20T10:30:00.000Z

## Public Links

- PR: https://github.com/postfiatorg/tasknodeofficial/pull/169
- Commit: https://github.com/postfiatorg/tasknodeofficial/commit/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a

## Artifact Checks

### docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/status_dashboard.json

- Blob URL: https://github.com/postfiatorg/tasknodeofficial/blob/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/status_dashboard.json
- Raw URL: https://raw.githubusercontent.com/postfiatorg/tasknodeofficial/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/status_dashboard.json
- Local exists: true
- Commit object exists: true
- Changed in commit: true
- SHA-256: `49aae9888cde8b1b3df20b24c45a0151558628df79333dfb120fe9b35b7f724a`

Excerpt:

```json
{
  "available": true,
  "type": "json",
  "byteLength": 9453,
  "excerpt": {
    "type": "json_object",
    "topLevelKeys": [
      "schema",
      "generatedAt",
      "generatedBy",
      "ledgerSchema",
      "run",
      "summary",
      "records"
    ],
    "schema": "pf.orc.submission_ingestion_dashboard.v1",
    "summary": {
      "totalRecords": 10,
      "supportedStates": [
        "pending",
        "in_review",
        "reviewed",
        "accounted_for",
        "failed"
      ],
      "byState": {
        "accounted_for": 10
      },
      "processedThisRun": 10,
      "skippedTerminalThisRun": 0,
      "failedThisRun": 0,
      "feedbackPayloadsReady": 10,
      "secretaryUpdatesReady": 10,
      "accountedRewardPft": 113000,
      "stageCounts": {
        "ingest": {
          "completed": 10
        },
        "review": {
          "completed": 10
        },
        "ledger": {
          "completed": 10
        },
        "feedback": {
          "completed": 10
        },
        "delivery": {
          "completed": 10
        },
        "secretary_update": {
          "completed": 10
        }
      }
    },
    "run": {
      "runId": "ingestion_run_cc9e93bf316637e3",
      "command": "run",
      "generatedAt": "2026-06-20T07:30:00.000Z",
      "generatedBy": "grashnuk",
      "sourceSubmissionCount": 10,
      "processedCount": 10,
      "skippedTerminalCount": 0,
      "failedCount": 0
    },
    "recordsCount": 10,
    "firstRecord": {
      "recordId": "ingest_5f0467b8e1f035cd",
      "submissionId": "sub_ingest_001",
      "taskId": "task_mock_001",
      "title": "Document Task Acceptance Workflow",
      "contributor": {
        "handle": "gmoney",
        "accountId": "acct_gmoney",
        "walletAddress": "rKTbxKmockGmoneyWallet001"
      },
      "state": "accounted_for",
      "rewardPft": 10500,
      "reviewDisposition": "reviewed_follow_up",
      "actionOwner": "product_engineering_triage",
      "lastRunId": "ingestion_run_cc9e93bf316637e3",
      "updatedAt": "2026-06-20T07:30:00.000Z",
      "stageStatus": {
        "ingest": "completed",
        "review": "completed",
        "ledger": "completed",
        "feedback": "completed",
        "delivery": "completed",
        "secretary_update": "completed"
      }
    }
  }
}
```

### docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/accounting_ledger.json

- Blob URL: https://github.com/postfiatorg/tasknodeofficial/blob/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/accounting_ledger.json
- Raw URL: https://raw.githubusercontent.com/postfiatorg/tasknodeofficial/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/docs/verification/submission_ingestion_accounting_tracker_task_9bbe896c161e52fd23a14556e68b82f2/outputs/accounting_ledger.json
- Local exists: true
- Commit object exists: true
- Changed in commit: true
- SHA-256: `0a4a025066bd8822fa48d4d24979096762b5a9f675785ca28a0ce8f0f15022f7`

Excerpt:

```json
{
  "available": true,
  "type": "json",
  "byteLength": 72425,
  "excerpt": {
    "type": "json_object",
    "topLevelKeys": [
      "schema",
      "createdAt",
      "updatedAt",
      "records",
      "runs"
    ],
    "schema": "pf.orc.submission_ingestion_accounting_ledger.v1",
    "recordsCount": 10,
    "firstRecord": {
      "schema": "pf.orc.submission_ingestion_accounting_ledger.v1",
      "recordId": "ingest_5f0467b8e1f035cd",
      "submissionId": "sub_ingest_001",
      "taskId": "task_mock_001",
      "title": "Document Task Acceptance Workflow",
      "project": "task_node_core_product",
      "state": "accounted_for",
      "previousState": "",
      "createdAt": "2026-06-20T07:30:00.000Z",
      "updatedAt": "2026-06-20T07:30:00.000Z",
      "lastRunId": "ingestion_run_cc9e93bf316637e3",
      "contributor": {
        "handle": "gmoney",
        "accountId": "acct_gmoney",
        "walletAddress": "rKTbxKmockGmoneyWallet001"
      },
      "evidence": {
        "cid": "QmMockAcceptanceWorkflow001",
        "txHash": "AAAABBBBCCCC0001",
        "summary": "Concrete acceptance-flow notes grounded in observed proposed and accepted task states.",
        "artifacts": [
          "docs/task_acceptance_workflow.md"
        ]
      },
      "review": {
        "status": "verified",
        "disposition": "reviewed_follow_up",
        "category": "operator_workflow",
        "score": 82,
        "actionOwner": "product_engineering_triage",
        "recommendedAction": "Fold the missing verification-step affordance into the task detail UX backlog.",
        "integritySignals": [],
        "reviewer": "grashnuk"
      },
      "accounting": {
        "rewardPft": 10500,
        "accountedAt": "2026-06-20T07:30:00.000Z",
        "ledgerRecordKey": "acct_fd5b5365e1322d33",
        "accountedBy": "grashnuk",
        "outcome": "reviewed_follow_up"
      },
      "stateHistory": [
        {
          "state": "pending",
          "at": "2026-06-20T07:30:00.000Z",
          "reason": "submission_ingested"
        },
        {
          "state": "in_review",
          "at": "2026-06-20T07:30:00.000Z",
          "reason": "review_packet_attached"
        },
        {
          "state": "reviewed",
          "at": "2026-06-20T07:30:00.000Z",
          "reason": "review_outcome_normalized"
        },
        {
          "state": "accounted_for",
          "at": "2026-06-20T07:30:00.000Z",
          "reason": "feedback_and_secretary_payloads_prepared"
        }
      ],
      "stages": {
        "ingest": {
          "status": "completed",
          "startedAt": "2026-06-20T07:30:00.000Z",
          "completedAt": "2026-06-20T07:30:00.000Z",
          "details": {
            "sourceSubmissionId": "sub_ingest_001",
            "evidenceReferencePresent": true
          }
        },
        "review": {
          "status": "completed",
          "startedAt": "2026-06-20T07:30:00.000Z",
          "completedAt": "2026-06-20T07:30:00.000Z",
          "details": {
            "reviewer": "grashnuk",
            "status": "verified",
            "disposition": "reviewed_follow_up",
            "score": 82
          }
        },
        "ledger": {
          "status": "completed",
          "startedAt": "2026-06-20T07:30:00.000Z",
          "completedAt": "2026-06-20T07:30:00.000Z",
          "details": {
            "ledgerRecordKey": "acct_fd5b5365e1322d33",
            "rewardPft": 10500,
            "state": "accounted_for"
          }
        },
        "feedback": {
          "status": "completed",
          "startedAt": "2026-06-20T07:30:00.000Z",
          "completedAt": "2026-06-20T07:30:00.000Z",
          "details": {
            "payloadId": "feedback_9dddf277981d1699",
            "channel": "hive_followup"
          }
        },
        "delivery": {
          "status": "completed",
          "startedAt": "2026-06-20T07:30:00.000Z",
          "completedAt": "2026-06-20T07:30:00.000Z",
          "details": {
            "deliveryMode": "mock",
            "deliveredLive": false,
            "payloadId": "feedback_9dddf277981d1699"
          }
        },
        "secretary_update": {
          "status": "completed",
          "startedAt": "2026-06-20T07:30:00.000Z",
          "completedAt": "2026-06-20T07:30:00.000Z",
          "details": {
            "updateId": "hivesecretary_3db9ae5d84f06aa6",
            "channel": "submission_ingestion_follow_up"
          }
        }
      },
      "feedbackPayload": {
        "schema": "pf.orc.review_feedback_delivery_payload.v1",
        "payloadId": "feedback_9dddf277981d1699",
        "generatedAt": "2026-06-20T07:30:00.000Z",
        "deliveryMode": "mock",
        "target": {
          "channel": "hive_followup",
          "recipientHandle": "gmoney",
          "recipientAccountId": "acct_gmoney",
          "recipientWalletAddress": "rKTbxKmockGmoneyWallet001"
        },
        "message": {
          "subject": "Review accounting for task_mock_001",
          "body": "Your rewarded task task_mock_001 was reviewed and routed for follow-up: Fold the missing verification-step affordance into the task detail UX backlog."
        },
        "source": {
          "taskId": "task_mock_001",
          "submissionId": "sub_ingest_001",
          "evidenceCid": "QmMockAcceptanceWorkflow001",
          "evidenceTxHash": "AAAABBBBCCCC0001"
        },
        "safety": {
          "signed": false,
          "deliveredLive": false,
          "enforcementAllowed": false
        }
      },
      "secretaryUpdatePayload": {
        "schema": "pf.hive_secretary.context_update.v1",
        "updateId": "hivesecretary_3db9ae5d84f06aa6",
        "generatedAt": "2026-06-20T07:30:00.000Z",
        "generatedBy": "grashnuk",
        "target": {
          "service": "hive_secretary",
          "operation": "append_context_update",
          "channel": "submission_ingestion_follow_up"
        },
        "source": {
          "trackerSchema": "pf.orc.submission_ingestion_accounting_ledger.v1",
          "taskId": "task_mock_001",
          "submissionId": "sub_ingest_001",
          "evidenceCid": "QmMockAcceptanceWorkflow001",
          "evidenceTxHash": "AAAABBBBCCCC0001"
        },
        "subject": {
          "contributor": {
            "handle": "gmoney",
            "accountId": "acct_gmoney",
            "walletAddress": "rKTbxKmockGmoneyWallet001"
          },
          "taskTitle": "Document Task Acceptance Workflow",
          "rewardPft": 10500
        },
        "review": {
          "status": "verified",
          "disposition": "reviewed_follow_up",
          "category": "operator_workflow",
          "score": 82,
          "integritySignals": []
        },
        "action": {
          "required": true,
          "owner": "product_engineering_triage",
          "recommendedAction": "Fold the missing verification-step affordance into the task detail UX backlog.",
          "enforcementAllowed": false
        },
        "contextUpdate": {
          "title": "Submission accounted: task_mock_001",
          "body": "Submission sub_ingest_001 for task task_mock_001 reached accounted_for.\nContributor: gmoney.\nReview disposition: reviewed_follow_up.\nRecommended action: Fold the missing verification-step affordance into the task detail UX backlog.",
          "tags": [
            "orc_submission_ingestion",
            "reviewed_follow_up",
            "operator_workflow"
          ],
          "visibility": "operator_internal",
          "status": "ready_for_hive_secretary"
        }
      }
    }
  }
}
```

### scripts/orc-submission-ingestion-tracker.mjs

- Blob URL: https://github.com/postfiatorg/tasknodeofficial/blob/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/scripts/orc-submission-ingestion-tracker.mjs
- Raw URL: https://raw.githubusercontent.com/postfiatorg/tasknodeofficial/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a/scripts/orc-submission-ingestion-tracker.mjs
- Local exists: true
- Commit object exists: true
- Changed in commit: true
- SHA-256: `644411e723bee4e621f2814772ab359907900d924755b592a7be267fe81c662b`

Excerpt:

```json
{
  "available": true,
  "type": "text",
  "byteLength": 23706,
  "text": "#!/usr/bin/env node\n\nimport { createHash } from \"node:crypto\";\nimport { existsSync } from \"node:fs\";\nimport { mkdir, readFile, writeFile } from \"node:fs/promises\";\nimport path from \"node:path\";\n\nconst LEDGER_SCHEMA = \"pf.orc.submission_ingestion_accounting_ledger.v1\";\nconst DASHBOARD_SCHEMA = \"pf.orc.submission_ingestion_dashboard.v1\";\nconst FEEDBACK_SCHEMA = \"pf.orc.review_feedback_delivery_payload.v1\";\nconst SECRETARY_SCHEMA = \"pf.hive_secretary.context_update.v1\";\nconst STATES = [\"pending\", \"in_review\", \"reviewed\", \"accounted_for\", \"failed\"];\nconst STAGES = [\"ingest\", \"review\", \"ledger\", \"feedback\", \"delivery\", \"secretary_update\"];\nconst TERMINAL_STATES = new Set([\"accounted_for\", \"failed\"]);\n\nfunction usage() {\n  return `Usage:\n  node scripts/orc-submission-ingestion-tracker.mjs run --submissions <file> --ledger <file> --out <dir> [--generated-by grashnuk] [--generated-at ISO]\n  node scripts/orc-submission-ingestion-tracker.mjs catch-up --submissions <file> --ledger <file> --out <dir> [--generated-by grashnuk] [--generated-at ISO]\n  node scripts/orc-submission-ingestion-tracker.mjs dashboard --ledger <file> --out <dir> [--generated-by grashnuk] [--generated-at ISO]\n\nCommands:\n "
}
```

## Reviewer Checklist

- [x] Public PR URL is GitHub-shaped: https://github.com/postfiatorg/tasknodeofficial/pull/169
- [x] Commit URL is direct and inspectable: https://github.com/postfiatorg/tasknodeofficial/commit/ba3b732669c7d98c0dd9dac67b3faeb6ec32e05a
- [x] Commit changed-file list resolved: 10 changed files
- [x] Every expected artifact exists locally: 3/3
- [x] Every expected artifact exists in the commit object: 3/3
- [x] Every expected artifact was changed by the commit: 3/3
- [x] Every expected artifact has a compact excerpt: 3/3

## Safety

This packet is generated offline from git metadata and local/committed artifact content. It does not sign transactions, submit live API changes, send messages, move funds, or execute enforcement.

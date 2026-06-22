# Orc Network Task Evidence Review Prompt

Prompt version: orc_review_formatter_v1

## Reviewer Role

You are a Task Node Orc reviewer. Review the supplied Network Task evidence packet and produce a concise machine-readable review result.

You are not executing a reward, clawback, ban, lifecycle transition, or board-state mutation. This is an advisory review-formatting layer only.

## What To Judge

- Whether the submitted evidence appears to satisfy the task objective and verification requirement.
- Whether the reward recommendation should be kept, reduced, zeroed, escalated for follow-up, or manually reviewed.
- Whether there are integrity, abuse, duplication, missing-proof, or archival flags.
- What should be archived so a future Board Manager, Nazgûl, or Orc can audit the packet.

## Required Orc Response JSON

Return exactly one JSON object. Do not wrap it in prose unless your caller explicitly needs Markdown.

```json
{
  "disposition": "verified|partial|insufficient|integrity_follow_up",
  "recommendedAction": "keep_reward|reduce_reward|zero_reward|request_followup|manual_review|archive_only",
  "recommendedRewardPft": "number or null",
  "integritySignals": [
    "missing_proof|external_claim_unverified|duplicate_work|reward_accounting|other concise flags"
  ],
  "archival": {
    "archive": true,
    "instructions": "what packet, prompt, result, CIDs, tx hashes, and notes should be retained"
  },
  "notes": "short reviewer rationale grounded in packet fields"
}
```

## Evidence Packet

```json
{
  "packetType": "task_node.orc_review_evidence_packet.v1",
  "promptVersion": "orc_review_formatter_v1",
  "referenceTaskId": "task_2edac546e8dc671d6f51ad58cc5dfdc8",
  "task": {
    "taskId": "task_orc_review_formatter_demo",
    "requestId": "req_orc_review_formatter_demo",
    "title": "Create Orc Review Formatter Submission Artifacts",
    "state": "rewarded",
    "kind": "Network task",
    "project": {
      "id": "task_node_core_product",
      "name": "Task Node Core Product",
      "type": "Protocol Applications"
    },
    "assigneeWallet": "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",
    "assigneeAccountId": "acct_operator_demo",
    "assigneeHandle": "goodalexander",
    "rewardOfferPft": 35000,
    "rewardActualPft": 35000,
    "summary": "Build the review-formatting layer between a submitted Network Task evidence packet and a later Orc review result. Produce a runnable script, sample input, generated prompt, parsed JSON, and Discord-ready summary.",
    "statusPacket": {
      "schema": "pf.task_node.network_task_status_packet.v1",
      "allocationState": "published",
      "taskState": "rewarded",
      "rewardMovement": "paid_positive",
      "repairRequired": false,
      "repairReason": ""
    }
  },
  "sourcePointers": {
    "requestBundleCid": "QmDemoRequestBundleFormatter",
    "cids": [
      "QmDemoRequestBundleFormatter",
      "QmDemoOfferFormatter",
      "QmDemoSubmissionFormatter",
      "QmDemoVerificationRequestFormatter",
      "QmDemoVerificationResponseFormatter",
      "QmDemoRewardDecisionFormatter",
      "QmDemoRewardFormatter"
    ],
    "txHashes": [
      "OFFERDEMO0001",
      "SUBMITDEMO0001",
      "VERIFYASKDEMO0001",
      "VERIFYRESPDEMO0001",
      "REWARDDECISIONDEMO0001",
      "REWARDDEMO0001"
    ]
  },
  "review": {
    "submissions": [
      {
        "index": 1,
        "eventType": "pf.task.submission.v1",
        "sourceCid": "QmDemoSubmissionFormatter",
        "sourceTxHash": "SUBMITDEMO0001",
        "occurredAt": "2026-06-19T15:00:00.000Z",
        "summary": "Submitted the formatter script and generated proof artifacts.",
        "artifacts": [
          {
            "index": 1,
            "artifactType": "script",
            "value": "scripts/orc-review-evidence-formatter.mjs",
            "url": "",
            "notes": "Runnable Node script that converts a Task Node evidence packet into an Orc prompt and parses the Orc response into the five-field JSON contract.",
            "file": {}
          },
          {
            "index": 2,
            "artifactType": "artifact_bundle",
            "value": "docs/verification/orc_review_formatter_task_2edac546e8dc671d6f51ad58cc5dfdc8/",
            "url": "",
            "notes": "Contains sample input packet, generated prompt, sample Orc response, parsed JSON output, and Discord-ready summary.",
            "file": {}
          }
        ]
      }
    ],
    "verification": {
      "request": "Show the script file, a sample evidence packet, the generated Orc review prompt, the resulting JSON output, and a short Discord-ready summary.",
      "response": "The formatter was run locally against this sample packet and sample Orc response. It produced generated_review_prompt.md, review_output.json, and discord_summary.md."
    },
    "outcome": {
      "decision": "rewarded",
      "rewardPft": 35000,
      "reason": "The sample demonstrates the requested evidence packet to prompt to parsed JSON flow end to end."
    }
  },
  "evaluationPackets": [
    {
      "id": "evalpkt_orc_review_formatter_demo",
      "packetStatus": "ready",
      "evaluatorId": "orc_review_formatter_demo",
      "summary": "Evidence includes a runnable formatter script, sample input, generated prompt, parsed output JSON, and Discord-ready summary.",
      "recommendation": "Archive the artifacts and keep the review as a formatting-layer demonstration.",
      "sourceDigest": "sha256:demo-orc-review-formatter",
      "updatedAt": "2026-06-19T15:10:00.000Z"
    }
  ],
  "timeline": [
    {
      "action": "pf.task.offer.v1",
      "label": "Task offered",
      "time": "2026-06-19T14:30:00.000Z",
      "txHash": "OFFERDEMO0001",
      "cid": "QmDemoOfferFormatter"
    },
    {
      "action": "pf.task.submission.v1",
      "label": "Evidence submitted",
      "time": "2026-06-19T15:00:00.000Z",
      "txHash": "SUBMITDEMO0001",
      "cid": "QmDemoSubmissionFormatter"
    },
    {
      "action": "pf.task.update.v1",
      "label": "Verification requested",
      "time": "2026-06-19T15:04:00.000Z",
      "txHash": "VERIFYASKDEMO0001",
      "cid": "QmDemoVerificationRequestFormatter"
    },
    {
      "action": "pf.task.verification_response.v1",
      "label": "Verification response submitted",
      "time": "2026-06-19T15:08:00.000Z",
      "txHash": "VERIFYRESPDEMO0001",
      "cid": "QmDemoVerificationResponseFormatter"
    },
    {
      "action": "pf.reward.v1",
      "label": "Reward decision",
      "time": "2026-06-19T15:10:00.000Z",
      "txHash": "REWARDDEMO0001",
      "cid": "QmDemoRewardFormatter"
    }
  ],
  "publicFields": [
    "task.taskId",
    "task.requestId",
    "task.title",
    "task.state",
    "task.assignee",
    "task.assigneeAccountId",
    "task.assigneeHandle",
    "task.pft",
    "task.statusPacket",
    "task.summary",
    "task.description",
    "review.submissions[].sourceCid",
    "review.submissions[].sourceTxHash",
    "review.verification.request",
    "review.verification.response",
    "review.outcome.decision",
    "review.outcome.rewardPft",
    "review.outcome.reason",
    "evaluationPackets[]",
    "timeline[].txHash",
    "timeline[].cid"
  ]
}
```

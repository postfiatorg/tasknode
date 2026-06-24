import assert from "node:assert/strict";

import {
  getPublicHiveTaskDetail,
  hiveProjectsDocumentForTests,
  publicHiveTaskDetailFields,
} from "../server/repositories/hive-projects.js";

const wallet = "rHiveClickableSmokeWallet000001";
const accountId = "acct_hive_clickable_smoke";
const document = hiveProjectsDocumentForTests({
  projectRows: [
    {
      id: "project_hive_clickable_smoke",
      title: "Hive Clickable Smoke",
      type: "network_validation",
      summary: "Verify Hive identity link metadata and task pop-out seeds.",
      objective: "Keep public Hive profile links and public task pop-outs explicit.",
      status: "active",
      priority: 1,
    },
  ],
  contributorRows: [
    {
      project_id: "project_hive_clickable_smoke",
      wallet_address: wallet,
      codename: "stale-label",
      archetype: "Network contributor",
      status: "active",
      cap: 2,
      load: 1,
      task_count: 1,
      pft_earned: 120,
    },
  ],
  taskRows: [
    {
      project_id: "project_hive_clickable_smoke",
      id: "task_ref_hive_clickable_smoke",
      task_id: "task_hive_clickable_network",
      title: "Prove Hive task pop-out opens",
      state: "verification_requested",
      assignee_wallet: wallet,
      reward_pft: 120,
      updated_at: "2026-06-15T10:00:00.000Z",
      created_at: "2026-06-15T09:00:00.000Z",
    },
  ],
  activityRows: [
    {
      id: "activity_hive_clickable_smoke",
      project_id: "project_hive_clickable_smoke",
      wallet_address: wallet,
      task_id: "task_hive_clickable_network",
      action: "verification_requested",
      task_title: "Prove Hive task pop-out opens",
      time_label: "now",
      pft_amount: null,
      updated_at: "2026-06-15T10:00:00.000Z",
      created_at: "2026-06-15T09:00:00.000Z",
    },
  ],
  walletIdentities: [
    {
      accountId,
      walletAddress: wallet,
      displayName: "Clickable Operator",
      hiveHandle: "clickable-operator",
    },
  ],
  publicProfileIds: new Set([accountId]),
  operatorDisclosures: {
    [accountId]: {
      isMachineOperator: true,
      label: "Orc operator",
      kind: "evidence_evaluation_orc",
      capabilities: [{
        capabilityType: "evidence_evaluation_orc",
        scopeLabel: "Task Node Core Product",
        status: "verified",
        evidenceTaskId: "task_capability_orc",
      }],
    },
  },
});

const project = document.projects.project_hive_clickable_smoke;
assert.equal(project.contributors[0].accountId, accountId);
assert.equal(project.contributors[0].hasPublicProfile, true);
assert.equal(document.operators[wallet].accountId, accountId);
assert.equal(document.operators[wallet].hasPublicProfile, true);
assert.equal(document.operators[wallet].operatorDisclosure.isMachineOperator, true);
assert.equal(project.tasks[0].assigneeAccountId, accountId);
assert.equal(project.tasks[0].assigneeHasPublicProfile, true);
assert.equal(project.tasks[0].assigneeOperatorDisclosure.isMachineOperator, true);
assert.equal(project.activity[0].accountId, accountId);
assert.equal(project.activity[0].hasPublicProfile, true);
assert.equal(project.activity[0].operatorDisclosure.isMachineOperator, true);
assert.equal(project.nextTask.assigneeAccountId, accountId);
assert.equal(project.nextTask.assigneeHasPublicProfile, true);
assert.equal(Object.hasOwn(document, "orcOperations"), false);

function publicPayloadPaths(value, path = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item) => publicPayloadPaths(item, `${path}[]`));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => key !== "publicFields");
    if (!entries.length) return path ? [path] : [];
    return entries.flatMap(([key, child]) => publicPayloadPaths(child, path ? `${path}.${key}` : key));
  }
  return path ? [path] : [];
}

let eventQueryCount = 0;
let packetQueryCount = 0;
const networkDetail = await getPublicHiveTaskDetail({
  taskId: "task_hive_clickable_network",
  databaseReady: true,
  queryImpl: async (sql, params) => {
    if (sql.includes("to_regclass('public.board_manager_evidence_evaluation_packets')")) {
      return { rows: [{ name: "board_manager_evidence_evaluation_packets" }] };
    }
    if (sql.includes("FROM board_manager_evidence_evaluation_packets")) {
      packetQueryCount += 1;
      return {
        rows: [{
          id: "evalpkt_hive_clickable",
          task_id: "task_hive_clickable_network",
          project_id: "project_hive_clickable_smoke",
          packet_status: "ready",
          evaluator_id: "evidence_evaluation_orc",
          summary: "1 verified artifact(s), 0 self-attested claim(s), 0 unverified artifact(s).",
          recommendation: "Evidence includes independently resolvable public artifacts.",
          source_digest: "packet_digest",
          packet_json: {
            counts: { verified: 1, self_attested: 0, unverified: 0 },
            artifact_verdicts: [{
              artifact_type: "github_pr",
              resolver: "github_pr",
              status: "verified",
              label: "postfiatorg/tasknodeofficial#1",
              reason: "Public GitHub artifact resolved.",
              event_cid: "bafybeihiveclickablesubmission",
              event_tx_hash: "ABC123SUBMIT",
            }],
          },
          created_at: "2026-06-15T09:45:00.000Z",
          updated_at: "2026-06-15T09:46:00.000Z",
        }],
      };
    }
    assert.equal(params[0], "task_hive_clickable_network");
    if (sql.includes("FROM network_project_task_refs")) {
      return {
        rows: [{
          id: "projection_hive_clickable_network",
          task_id: "task_hive_clickable_network",
          request_id: "taskreq_hive_clickable",
          title: "Prove Hive task pop-out opens",
          status: "rewarded",
          subject_wallet: wallet,
          reward_offer_pft: 120,
          reward_actual_pft: 120,
          source: "task_projections",
          description: "Demonstrate the public read-only Hive task pop-out.",
          submission_requirement_text: "Submit a concise proof.",
          metadata_json: {
            submissionSummaries: [{
              type: "Proof",
              summary: "Submitted a concise proof that the read-only Hive pop-out opens.",
            }],
          },
          created_at: "2026-06-15T09:00:00.000Z",
          updated_at: "2026-06-15T10:00:00.000Z",
          project_id: "project_hive_clickable_smoke",
          project_title: "Hive Clickable Smoke",
          project_type: "network_validation",
        }],
      };
    }
    if (sql.includes("FROM task_events")) {
      eventQueryCount += 1;
      return {
        rows: [
          {
            id: "event_submission",
            event_type: "pf.task.submission.v1",
            task_id: "task_hive_clickable_network",
            source_tx_hash: "ABC123SUBMIT",
            source_cid: "bafybeihiveclickablesubmission",
            occurred_at: "2026-06-15T09:20:00.000Z",
            payload_json: {
              schema: "pf.task.submission.v1",
              task_id: "task_hive_clickable_network",
              evidence_count: 1,
              public_summary: "Submitted a public GitHub proof and a compact execution note.",
              description: "raw submission description should stay private",
              notes: "raw submission notes should stay private",
              encrypted_payload: "private-ciphertext-redacted",
              evidence_items: [{
                artifact_type: "github_pr",
                label: "postfiatorg/tasknodeofficial#1",
                url: "https://github.com/postfiatorg/tasknodeofficial/pull/1",
                cid: "bafybeihiveclickableartifact",
              }],
            },
          },
          {
            id: "event_verification_request",
            event_type: "pf.task.verification_request.v1",
            task_id: "task_hive_clickable_network",
            source_tx_hash: "ABC123VERIFYASK",
            source_cid: "bafybeihiveclickableverifyask",
            occurred_at: "2026-06-15T09:30:00.000Z",
            payload_json: {
              schema: "pf.task.verification_request.v1",
              task_id: "task_hive_clickable_network",
              verification_ask: "Confirm the exact component opened.",
            },
          },
          {
            id: "event_verification_response",
            event_type: "pf.task.verification_response.v1",
            task_id: "task_hive_clickable_network",
            source_tx_hash: "ABC123VERIFYRESPONSE",
            source_cid: "bafybeihiveclickableverifyresponse",
            occurred_at: "2026-06-15T09:40:00.000Z",
            payload_json: {
              schema: "pf.task.verification_response.v1",
              task_id: "task_hive_clickable_network",
              response: "Raw verification response should not become an evidence excerpt.",
              response_summary: "The HiveTaskPopout opened read-only.",
              evidence_items: [{
                artifact_type: "text",
                label: "verification excerpt",
              }],
            },
          },
          {
            id: "event_reward",
            event_type: "pf.reward.v1",
            task_id: "task_hive_clickable_network",
            source_tx_hash: "ABC123REWARD",
            source_cid: "bafybeihiveclickablereward",
            occurred_at: "2026-06-15T10:00:00.000Z",
            payload_json: {
              schema: "pf.reward.v1",
              task_id: "task_hive_clickable_network",
              reward_pft: 120,
              score: {
                decision: "full_reward",
                reason: "The proof satisfied the public Hive pop-out check.",
                user_feedback: "Complete.",
              },
            },
          },
        ],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});

assert.equal(networkDetail.ok, true);
assert.equal(eventQueryCount, 1);
assert.equal(packetQueryCount, 1);
assert.equal(networkDetail.task.taskId, "task_hive_clickable_network");
assert.equal(networkDetail.review.submissions[0].summary, "Submitted a concise proof that the read-only Hive pop-out opens.");
assert.equal(networkDetail.review.evidence.length, 2);
assert.equal(networkDetail.review.evidence[0].type, "Submission");
assert.equal(networkDetail.review.evidence[0].excerpt, "Submitted a public GitHub proof and a compact execution note.");
assert.equal(networkDetail.review.evidence[0].artifactRefs[0].url, "https://github.com/postfiatorg/tasknodeofficial/pull/1");
assert.equal(networkDetail.review.evidence[0].artifactRefs[0].cid, "bafybeihiveclickableartifact");
assert.equal(networkDetail.review.evidence[0].artifactRefs.at(-1).txHash, "ABC123SUBMIT");
assert.equal(networkDetail.review.evidence[0].privateContentHidden, true);
assert.equal(JSON.stringify(networkDetail.review.evidence).includes("private-ciphertext-redacted"), false);
assert.equal(JSON.stringify(networkDetail.review.evidence).includes("raw submission description should stay private"), false);
assert.equal(JSON.stringify(networkDetail.review.evidence).includes("raw submission notes should stay private"), false);
assert.equal(networkDetail.review.evidence[1].type, "Verification response");
assert.equal(networkDetail.review.evidence[1].excerpt, "The HiveTaskPopout opened read-only.");
assert.equal(JSON.stringify(networkDetail.review.evidence).includes("Raw verification response should not become an evidence excerpt."), false);
assert.equal(networkDetail.review.evidence[1].artifactRefs.at(-1).cid, "bafybeihiveclickableverifyresponse");
assert.equal(networkDetail.review.verification.request, "Confirm the exact component opened.");
assert.equal(networkDetail.review.verification.response, "Verification response submitted.");
assert.equal(networkDetail.review.outcome.reason, "The proof satisfied the public Hive pop-out check.");
assert.equal(networkDetail.evaluationPackets[0].id, "evalpkt_hive_clickable");
assert.equal(networkDetail.evaluationPackets[0].artifactVerdicts[0].status, "verified");
assert.equal(networkDetail.timeline.at(-1).txHash, "ABC123REWARD");
assert.equal(networkDetail.timeline.at(-1).cid, "bafybeihiveclickablereward");
assert.deepEqual(
  [...new Set(publicPayloadPaths(networkDetail))].sort(),
  [...publicHiveTaskDetailFields].sort()
);
assert.deepEqual(networkDetail.publicFields, publicHiveTaskDetailFields);

let nonNetworkEventQueries = 0;
const nonNetworkDetail = await getPublicHiveTaskDetail({
  taskId: "task_personal_private",
  databaseReady: true,
  queryImpl: async (sql, params) => {
    assert.equal(params[0], "task_personal_private");
    if (sql.includes("FROM network_project_task_refs")) return { rows: [] };
    nonNetworkEventQueries += 1;
    return { rows: [] };
  },
});
assert.equal(nonNetworkDetail.ok, false);
assert.equal(nonNetworkDetail.status, 404);
assert.equal(nonNetworkDetail.error, "hive_task_not_found");
assert.equal(nonNetworkEventQueries, 0, "non-network task ids must be rejected before reading task_events");

console.log("hive-clickable-smoke ok");

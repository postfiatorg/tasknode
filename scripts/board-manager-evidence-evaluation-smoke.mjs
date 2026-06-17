import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  buildEvidenceEvaluationPacket,
  createEvidenceEvaluationPacketForTask,
  listEvidenceEvaluationPackets,
} = await import("../server/repositories/evidence-evaluation-packets.js");

const task = {
  task_id: "task_evidence_orc_smoke",
  project_id: "project_evidence_orc_smoke",
};

const eventRows = [
  {
    id: "evt_submission",
    event_type: "pf.task.submission.v1",
    task_id: task.task_id,
    source_tx_hash: "ABC123SUBMIT",
    source_cid: "bafybeievidence",
    payload_json: {
      schema: "pf.task.submission.v1",
      evidence_items: [
        {
          artifact_type: "url",
          value: "https://github.com/postfiatorg/tasknodeofficial/pull/123",
        },
        {
          artifact_type: "url",
          value: "https://gist.github.com/goodalexander/abcdef1234567890",
        },
        {
          artifact_type: "url",
          value: "https://discord.com/channels/1/2/3",
        },
        {
          artifact_type: "text",
          value: "I sent the message to Alex but this sentence has no resolvable artifact.",
        },
      ],
    },
  },
  {
    id: "evt_verification_response",
    event_type: "pf.task.verification_response.v1",
    task_id: task.task_id,
    source_tx_hash: "ABC123VERIFY",
    source_cid: "bafybeiverify",
    payload_json: {
      schema: "pf.task.verification_response.v1",
      response: {
        artifact_type: "url",
        value: "https://example.invalid/fail",
      },
    },
  },
];

const fetchedUrls = [];
async function fetchUrlExcerptImpl(url) {
  fetchedUrls.push(url);
  if (url.includes("example.invalid")) return { ok: false, error: "dns_lookup_failed" };
  return {
    ok: true,
    title: url.includes("gist.github.com") ? "GitHub Gist raw content" : "GitHub Pull Request",
    excerpt: "Clean public artifact excerpt from the shared task-review URL resolver.",
    url,
  };
}

const packet = await buildEvidenceEvaluationPacket({
  task,
  eventRows,
  fetchUrlExcerptImpl,
});

assert.equal(packet.taskId, task.task_id);
assert.equal(packet.projectId, task.project_id);
assert.equal(packet.packet.lifecycle_boundary, "context_only_no_task_state_or_reward_mutation");
assert.equal(packet.packet.counts.verified, 2);
assert.equal(packet.packet.counts.self_attested, 2);
assert.equal(packet.packet.counts.unverified, 1);
assert.equal(packet.packet.packet_status, "needs_review");
assert.ok(packet.packet.artifact_verdicts.some((item) => item.resolver === "github_pr" && item.status === "verified"));
assert.ok(packet.packet.artifact_verdicts.some((item) => item.resolver === "safe_url" && item.status === "verified" && /Gist/.test(item.title)));
assert.ok(packet.packet.artifact_verdicts.some((item) => item.resolver === "discord_message_link" && item.status === "self_attested"));
assert.ok(packet.packet.artifact_verdicts.some((item) => item.resolver === "text_claim" && item.status === "self_attested"));
assert.ok(packet.packet.artifact_verdicts.some((item) => item.status === "unverified" && item.reason === "dns_lookup_failed"));
assert.equal(fetchedUrls.includes("https://discord.com/channels/1/2/3"), false, "Discord links should not be fetched without channel policy");
assert.equal(JSON.stringify(packet).includes("I sent the message to Alex"), false, "raw text evidence must not be persisted in packets");

let taskQueryCount = 0;
let eventQueryCount = 0;
const created = await createEvidenceEvaluationPacketForTask({
  taskId: task.task_id,
  fetchUrlExcerptImpl,
  persist: false,
  queryImpl: async (sql, params) => {
    assert.equal(params[0], task.task_id);
    if (sql.includes("FROM network_project_task_refs")) {
      taskQueryCount += 1;
      return { rows: [task] };
    }
    if (sql.includes("FROM task_events")) {
      eventQueryCount += 1;
      return { rows: eventRows };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});
assert.equal(created.ok, true);
assert.equal(taskQueryCount, 1);
assert.equal(eventQueryCount, 1);
assert.equal(created.packet.packetStatus, "needs_review");

let packetQueryCount = 0;
const listed = await listEvidenceEvaluationPackets({
  taskIds: [task.task_id],
  databaseReady: true,
  queryImpl: async (sql) => {
    if (sql.includes("to_regclass('public.board_manager_evidence_evaluation_packets')")) {
      return { rows: [{ name: "board_manager_evidence_evaluation_packets" }] };
    }
    if (sql.includes("FROM board_manager_evidence_evaluation_packets")) {
      packetQueryCount += 1;
      return {
        rows: [{
          id: packet.id,
          task_id: task.task_id,
          project_id: task.project_id,
          packet_status: packet.packetStatus,
          evaluator_id: packet.evaluatorId,
          summary: packet.summary,
          recommendation: packet.recommendation,
          source_digest: packet.sourceDigest,
          packet_json: packet.packet,
          created_at: "2026-06-17T00:00:00.000Z",
          updated_at: "2026-06-17T00:00:00.000Z",
        }],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});
assert.equal(packetQueryCount, 1);
assert.equal(listed[0].artifactVerdicts[0].status, "verified");

console.log("board-manager-evidence-evaluation-smoke ok");

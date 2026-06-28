#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.TASKNODE_HIVE_BOARD_SECRETARY_PROVIDER_MOCK = "true";

const { fetchHiveBoardSecretaryMemo } = await import("../server/hive-board-secretary-provider.js");
const { publicHiveBoardSecretaryMemo } = await import("../server/repositories/hive-board-secretary.js");

const sourcePacket = {
  schema: "pf.hive.board_secretary.source.v1",
  version: "glm_board_secretary_status_memo_v1",
  projectId: "project_smoke",
  generatedAt: "2026-06-28T00:00:00.000Z",
  sourcePacketDigest: "abc123smokedigest",
  project: {
    id: "project_smoke",
    title: "Smoke Project",
    summary: "A compact smoke board for Project Status memo generation.",
  },
  taskState: {
    activeTasks: [{
      taskId: "task_active",
      title: "Active task",
      status: "accepted",
      proposalSummary: "Active task proposal summary.",
    }],
    terminalTasks: [{
      taskId: "task_rewarded",
      title: "Rewarded task",
      status: "rewarded",
      proposalSummary: "Rewarded task proposal summary.",
      reward: {
        pft: 1500,
        txHash: "A".repeat(64),
        cid: "QmSmoke",
        summary: "Rewarded for concise evidence.",
      },
    }],
    omitted: { activeTasks: 0, terminalTasks: 0 },
  },
  boardComments: [],
  eligibleContributors: [],
  projectLeaderContext: [],
  counts: {
    activeTaskCount: 1,
    terminalTaskCount: 1,
  },
};

const result = await fetchHiveBoardSecretaryMemo({ sourcePacket });
assert.equal(result.provider, "mock");
assert.match(result.memoMarkdown, /^# Project Status: Smoke Project/m);
assert.match(result.memoMarkdown, /## Why This Advances PFT Value/);
assert.match(result.memoMarkdown, /## Recommendation For Task Management Agent/);

const publicMemo = publicHiveBoardSecretaryMemo({
  id: "hiveboardmemo_smoke",
  project_id: "project_smoke",
  status: "current",
  memo_markdown: result.memoMarkdown,
  source_packet_digest: sourcePacket.sourcePacketDigest,
  source_counts_json: sourcePacket.counts,
  provider: result.provider,
  model: result.model,
  prompt_version: result.promptVersion,
  prompt_digest: result.promptDigest,
  usage_json: result.usage,
  generated_at: new Date("2026-06-28T00:01:00.000Z"),
  created_at: new Date("2026-06-28T00:01:00.000Z"),
});
assert.equal(publicMemo.projectId, "project_smoke");
assert.equal(publicMemo.sourceCounts.activeTaskCount, 1);
assert.equal(publicMemo.model, "mock-glm-board-secretary");

console.log("hive board secretary smoke ok");

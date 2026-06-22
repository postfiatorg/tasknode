import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TASKNODE_STORE_PATH = path.join(
  await mkdtemp(path.join(os.tmpdir(), "tasknode-expert-badge-")),
  "runtime-store.json"
);
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_AUTH_SECRET = "expert-badge-smoke-secret";
process.env.TASKNODE_EMAIL_DEV_DELIVERY = "true";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";
process.env.OPENROUTER_API_KEY = "expert-badge-openrouter-test-key";

const {
  evaluateExpertBadge,
  expertAccessFromTaskState,
  expertRequiredPersonalTaskCount,
} = await import("../server/expert-badge.js");
const { getOrCreateEmailAccount } = await import("../server/runtime-store.js");

function personalTask(index) {
  const day = String(index + 1).padStart(2, "0");
  return {
    taskId: `task_personal_${day}`,
    fullId: `task_personal_${day}`,
    kind: "Personal",
    isNetworkTask: false,
    status: "Rewarded",
    statusKey: "rewarded",
    title: `Completed research task ${day}`,
    description: `Original analysis and concrete output for market structure topic ${day}.`,
    pft: 100,
    updatedAt: `2026-06-${day}T12:00:00.000Z`,
    steps: ["Analyze primary evidence", "Produce original findings"],
    verification: { body: "Evidence was reviewed and rewarded." },
  };
}

function taskState(count = 20) {
  return {
    rewarded: Array.from({ length: count }, (_, index) => personalTask(index)),
    outstanding: [],
    verification: [],
    refused: [],
  };
}

const account = getOrCreateEmailAccount({
  email: "expert-badge@example.test",
  canonicalEmail: "expert-badge@example.test",
});
assert.ok(account?.id, "account should be created");

let fetchCalls = 0;
const underGate = await evaluateExpertBadge({
  accountId: account.id,
  walletAddress: "rExpertWallet",
  topic: "market structure",
  taskState: taskState(expertRequiredPersonalTaskCount - 1),
  fetchImpl: async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called before the task-count gate passes");
  },
});
assert.equal(underGate.ok, false, "under-gate result should not be ok");
assert.equal(underGate.error, "expert_badge_personal_task_count_required");
assert.equal(fetchCalls, 0, "under-gate evaluation should not call OpenRouter");

let requestBody = null;
const passed = await evaluateExpertBadge({
  accountId: account.id,
  walletAddress: "rExpertWallet",
  topic: "market structure",
  taskState: taskState(expertRequiredPersonalTaskCount),
  fetchImpl: async (url, options = {}) => {
    fetchCalls += 1;
    requestBody = JSON.parse(String(options.body || "{}"));
    assert.equal(String(url).endsWith("/chat/completions"), true);
    return new Response(JSON.stringify({
      id: "orchatcmpl_expert_badge_smoke",
      model: "z-ai/glm-5.2",
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 86,
              recommended_expert_label: "Market structure analyst",
              summary: "The latest Personal tasks show repeated concrete analysis in market structure.",
              strengths: ["Repeated domain-specific analysis", "Concrete task outputs"],
              weaknesses: ["Some task descriptions are compact"],
              disqualifying_concerns: [],
              evidence_task_ids: ["task_personal_20", "task_personal_19"],
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 240,
        total_tokens: 1440,
        cost: 0.001,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

assert.equal(passed.ok, true, "passing evaluation should succeed");
assert.equal(passed.expertAccess.eligible, true, "passing evaluation should mark Expert eligible");
assert.equal(passed.expertAccess.score, 86);
assert.equal(requestBody.model, "z-ai/glm-5.2");
assert.equal(requestBody.provider.data_collection, "deny");
assert.deepEqual(requestBody.provider.order, ["z-ai", "wafer", "fireworks", "novita"]);
assert.match(JSON.stringify(requestBody.messages), /market structure/);
assert.match(JSON.stringify(requestBody.messages), /task_personal_20/);

const currentAccess = expertAccessFromTaskState({
  accountId: account.id,
  taskState: taskState(expertRequiredPersonalTaskCount),
});
assert.equal(currentAccess.status, "verified");
assert.equal(currentAccess.reviewCurrent, true);

const staleAccess = expertAccessFromTaskState({
  accountId: account.id,
  taskState: {
    ...taskState(expertRequiredPersonalTaskCount),
    rewarded: [
      {
        ...personalTask(99),
        taskId: "task_personal_new",
        fullId: "task_personal_new",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      ...taskState(expertRequiredPersonalTaskCount).rewarded,
    ],
  },
});
assert.equal(staleAccess.status, "stale_review");
assert.equal(staleAccess.eligible, false);

console.log("expert_badge_evaluation_smoke ok");

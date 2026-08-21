import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { taskReviewWorkerInternalsForTests } from "../server/task-review-worker.js";

const boardManagerPrompt = await readFile("prompts/hive/board_manager_v1.md", "utf8");
const taskgenPrompt = await readFile("prompts/task_engine/taskgen_network_v1.md", "utf8");
const rewardPrompt = await readFile("prompts/task_engine/reward_scoring_v1.md", "utf8");

assert.match(boardManagerPrompt, /Private Task Node repository work requires a verified durable capability profile/);
assert.match(boardManagerPrompt, /capability-gating task that asks the contributor to prove PR\/repo access/);
assert.match(boardManagerPrompt, /External action claims need reviewable proof/);

assert.match(taskgenPrompt, /If the project requires private Task Node repository access/);
assert.match(taskgenPrompt, /capability-gating assignment or a public-artifact assignment/);
assert.match(taskgenPrompt, /verified private-repo capability/);
assert.match(taskgenPrompt, /reviewable engineering evidence such as a PR URL/);
assert.match(taskgenPrompt, /verified, self-attested, or unverified/);

assert.match(rewardPrompt, /`evidence_evaluation`/);
assert.match(rewardPrompt, /verified public artifacts from self-attested or unverified claims/);
assert.match(rewardPrompt, /unverified external-action claims/);

const { buildRewardEvidenceEvaluationContext } = taskReviewWorkerInternalsForTests;
const context = buildRewardEvidenceEvaluationContext({
  initial: {
    schema: "tasknode.processed_evidence.v1",
    artifacts: [
      {
        artifact_type: "url",
        status: "provided",
        source: { url: "https://github.com/postfiatorg/tasknode/pull/123" },
        excerpt: "https://github.com/postfiatorg/tasknode/pull/123",
      },
      {
        artifact_type: "url",
        status: "extracted",
        url: "https://github.com/postfiatorg/tasknode/pull/123",
        title: "Pull request 123",
        excerpt: "Public PR excerpt.",
      },
      {
        artifact_type: "text",
        status: "provided",
        excerpt: "I sent the Discord message to the operator.",
      },
    ],
  },
  verification: {
    schema: "tasknode.processed_evidence.v1",
    artifacts: [
      {
        artifact_type: "url",
        status: "blocked",
        url: "http://127.0.0.1/internal",
        error: "private_ip_not_allowed",
      },
    ],
  },
});

assert.equal(context.schema, "tasknode.reward_evidence_evaluation_context.v1");
assert.equal(context.lifecycle_boundary, "advisory_context_only_no_reward_rule_change");
assert.equal(context.counts.verified, 1);
assert.equal(context.counts.self_attested, 1);
assert.equal(context.counts.unverified, 1);
assert.equal(
  context.artifact_verdicts.some((verdict) => verdict.status === "verified" && verdict.resolver === "safe_url"),
  true
);
assert.equal(
  context.artifact_verdicts.some((verdict) => verdict.status === "self_attested" && verdict.resolver === "text_or_file_claim"),
  true
);
assert.equal(
  context.artifact_verdicts.some((verdict) => verdict.status === "unverified" && verdict.reason.includes("private_ip_not_allowed")),
  true
);
assert.equal(JSON.stringify(context).includes("I sent the Discord message"), false);

console.log("board-manager-phase-d-prompt-taskgen-smoke ok");

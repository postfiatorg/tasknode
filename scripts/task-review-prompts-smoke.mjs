import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const verificationPrompt = await readFile("prompts/task_engine/verification_request_v1.md", "utf8");
const rewardPrompt = await readFile("prompts/task_engine/reward_scoring_v1.md", "utf8");
const combined = `${verificationPrompt}\n${rewardPrompt}`;

function mustInclude(text, needle, label) {
  assert.ok(text.includes(needle), `${label} should include: ${needle}`);
}

mustInclude(
  verificationPrompt,
  "Ask for the missing proof that would most help a future user, reviewer, or agent understand the work.",
  "verification prompt"
);
mustInclude(
  verificationPrompt,
  "Avoid asking for evidence that would force the user to recreate a transient bug after the bug has already been fixed.",
  "verification prompt"
);
mustInclude(
  verificationPrompt,
  "Do not optimize for rigid checklist compliance when a different evidence type would better prove the same work.",
  "verification prompt"
);

mustInclude(
  rewardPrompt,
  "Reward concrete work that improves the product, artifact, decision, or reviewability",
  "reward prompt"
);
mustInclude(
  rewardPrompt,
  "If the submission is incomplete but useful, prefer `partial_reward` over `reject`.",
  "reward prompt"
);
mustInclude(
  rewardPrompt,
  "When the task asks for a transient visual artifact, do not require the user to recreate a fixed bug",
  "reward prompt"
);

assert.equal(combined.includes("task_f66b995c3c047d7a35df42d916b38914"), false);
assert.equal(combined.includes("Create Flicker Bug Evidence Packet"), false);

console.log("task-review-prompts-smoke ok");

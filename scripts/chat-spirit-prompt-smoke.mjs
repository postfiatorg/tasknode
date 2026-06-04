import assert from "node:assert/strict";

process.env.TASKNODE_CHAT_SPIRIT_ENABLED = "true";
delete process.env.TASKNODE_CHAT_SPIRIT_PROMPT;

const { deepSeekChatRequest, openAiResponseRequest, openRouterChatRequest } = await import("../server/chat-router.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const { chatSpiritMetadata } = await import("../server/chat-spirit-context.js");

const userSentinel = "USER_SENTINEL_SHOULD_NOT_BE_DUPLICATED_IN_SYSTEM";
const contextDocument = {
  title: "Smoke Context",
  revision: 12,
  updatedAt: "2026-05-19T18:00:00.000Z",
  body: "<p>The current operating proof is houston 1421.</p>",
};
const memoryContext = {
  deepMemories: [
    {
      conversationTitle: "Deep product memory",
      createdAt: "2026-05-19T17:00:00.000Z",
      userRequestSummary: "The user asked for direct product judgment.",
      systemResponseSummary: "The assistant pushed toward one working product loop.",
      memoryText: "Deep memory should carry forward into Jobs chat.",
    },
  ],
  memories: [
    {
      createdAt: "2026-05-19T17:30:00.000Z",
      memoryText: "Recent memory should carry forward without exposing prompt plumbing.",
    },
  ],
};
const taskContext = {
  sync: {
    status: "ok",
    source: "task_projections",
    projectionCount: 4,
    lastSyncedAt: "2026-05-19T18:15:00.000Z",
  },
  outstanding: [
    {
      title: "Finish the visible task loop",
      kind: "Engineering",
      status: "Accepted",
      pft: 3,
      due: "May 20",
      taskId: "task_jobs_prompt_smoke",
      description: "Keep active task state visible to chat.",
      verification: { body: "Submit a short proof." },
    },
  ],
  verification: [
    {
      title: "Respond to verification",
      kind: "Engineering",
      status: "Verification requested",
      pft: 2,
      due: "May 20",
      taskId: "task_jobs_verification_smoke",
      verification: { body: "Provide the exact follow-up evidence." },
    },
  ],
  refused: [{ title: "Refused example", status: "Refused", pft: 0 }],
  rewarded: [{ title: "Rewarded example", status: "Rewarded", pft: 1.5 }],
};
const jobsEssence = [
  "<jobs_retrieval_context count=\"1\">",
  "  <chunk rank=\"1\" chunk_id=\"jobs_chunk_smoke\" source_sha256=\"jobs_source_smoke\" similarity=\"0.91\" title=\"Focus\">",
  "<![CDATA[",
  "Jobs retrieval should enter the Markdown retrieval slot exactly once.",
  "]]>",
  "  </chunk>",
  "</jobs_retrieval_context>",
].join("\n");

function count(haystack, needle) {
  return String(haystack || "").split(needle).length - 1;
}

function assertJobsInstructions(instructions, label) {
  assert.equal(count(instructions, "## Experience Promise"), 1, `${label} should include Jobs Markdown prompt once`);
  assert.equal(count(instructions, "## Response Length Calibration"), 1, `${label} should include response length calibration once`);
  assert.ok(
    instructions.includes("A short current turn after a long thread is still a short turn."),
    `${label} should instruct short turns to stay compact`
  );
  assert.ok(
    instructions.includes("Context awareness means selecting the right small answer"),
    `${label} should define context-aware brevity`
  );
  assert.ok(
    instructions.includes("Do not write a 30-paragraph response unless the user clearly asks"),
    `${label} should forbid long-form responses unless clearly requested`
  );
  assert.ok(
    instructions.includes("## Rendered Runtime Blocks"),
    `${label} should include rendered runtime block boundary`
  );
  assert.ok(instructions.includes("houston 1421"), `${label} should include context document text`);
  assert.ok(instructions.includes("<account_tasks_context>"), `${label} should include task context`);
  assert.ok(instructions.includes("<deep_memory>"), `${label} should include deep memory`);
  assert.ok(instructions.includes("Recent memory should carry forward"), `${label} should include recent memory`);
  assert.ok(
    instructions.includes("Jobs retrieval should enter the Markdown retrieval slot exactly once"),
    `${label} should include pgvector Jobs retrieval context`
  );
  assert.equal(count(instructions, "<jobs_retrieval_context count=\"1\">"), 1, `${label} should include retrieval once`);
  assert.equal(
    instructions.includes(userSentinel),
    false,
    `${label} should not duplicate the current user message into system instructions`
  );
}

const metadata = chatSpiritMetadata();
assert.equal(metadata.enabled, true, "Jobs chat spirit should be enabled in smoke");
assert.equal(metadata.path, "chat/jobs_standard_chat_codex_style_draft.md", "Jobs chat spirit should load the Markdown prompt");
assert.match(metadata.digest, /^[a-f0-9]{64}$/);

for (const [mode, model] of [
  ["Frontier Instant", "chat-latest"],
  ["Frontier Thinking", "gpt-5.5"],
]) {
  const request = openAiResponseRequest({
    mode,
    model,
    message: userSentinel,
    conversationId: `jobs-smoke-${mode}`,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
  });
  assertJobsInstructions(request.instructions, mode);
  assert.equal(request.input.at(-1)?.content?.[0]?.text?.includes(userSentinel), true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(request, "max_output_tokens"),
    false,
    `${mode} should not send a hard OpenAI output cap`
  );
}

for (const [mode, model] of [
  ["Private Instant", "deepseek/deepseek-v4-flash"],
  ["Private Thinking", "deepseek/deepseek-v4-pro"],
]) {
  const request = openRouterChatRequest({
    mode,
    model,
    message: userSentinel,
    conversationId: `jobs-smoke-${mode}`,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
  });
  const instructions = request.messages?.[0]?.content || "";
  assertJobsInstructions(instructions, mode);
  assert.equal(request.messages?.at(-1)?.content, userSentinel);
  assert.equal(request.tools, undefined, `${mode} should not enable private-mode web search`);
}

const deepSeekRequest = deepSeekChatRequest({
  mode: "Discount Thinking",
  model: "deepseek-v4-pro",
  message: userSentinel,
  conversationId: "jobs-smoke-Discount Thinking",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
});
const deepSeekInstructions = deepSeekRequest.messages?.[0]?.content || "";
assertJobsInstructions(deepSeekInstructions, "Discount Thinking");
assert.equal(deepSeekRequest.messages?.at(-1)?.content, userSentinel);
assert.equal(deepSeekRequest.reasoning_effort, "high");

const estimate = chatEstimate(
  {
    mode: "Frontier Instant",
    message: "Estimate the prompt.",
  },
  { contextDocument, memoryContext, taskContext }
);
assert.ok(estimate.instructionInputTokens > 2500, `estimate must count Jobs instructions: ${JSON.stringify(estimate)}`);
assert.ok(
  estimate.baseInstructionInputTokens > estimate.contextDocumentInputTokens + estimate.memoryInputTokens,
  `estimate should expose base instruction cost separately: ${JSON.stringify(estimate)}`
);

process.env.TASKNODE_CHAT_SPIRIT_ENABLED = "false";
const disabledRequest = openAiResponseRequest({
  mode: "Frontier Instant",
  model: "chat-latest",
  message: userSentinel,
  conversationId: "jobs-smoke-disabled",
  contextDocument,
  memoryContext,
  taskContext,
});
assert.equal(disabledRequest.instructions.includes("## Experience Promise"), false);
assert.ok(disabledRequest.instructions.includes("<account_context_document>"));
assert.ok(disabledRequest.instructions.includes("<account_tasks_context>"));
assert.ok(disabledRequest.instructions.includes("<deep_memory>"));

console.log("chat spirit prompt smoke ok");

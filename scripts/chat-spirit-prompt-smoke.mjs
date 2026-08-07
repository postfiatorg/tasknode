import assert from "node:assert/strict";

process.env.TASKNODE_CHAT_SPIRIT_ENABLED = "true";
delete process.env.TASKNODE_CHAT_SPIRIT_PROMPT;

const {
  deepSeekChatRequest,
  frontierInstantResponseGateInstructionBlock,
  frontierInstantResponseGateResponseFormat,
  openAiResponseRequest,
  openRouterChatRequest,
  selectFrontierInstantResponseText,
} = await import("../server/chat-router.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const { chatSpiritMetadata } = await import("../server/chat-spirit-context.js");
const { helpModeInstructions } = await import("../server/chat-help-mode.js");

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
  networkTasks: {
    status: "badge_required",
    label: "Network Task badge required",
    summary: "Network Task routing needs a linked wallet, active wallet sync, a completed Network Diagnostic Report, a verified operating badge, and free Network Task capacity.",
    nextAction: "Open Profile and qualify at least one routing badge.",
    manualRequestCopy: "Request task creates personal task proposals. Network Tasks are routed by Hive Board Manager when an active project needs a candidate.",
    policy: {
      requiresNetworkTaskOperatingBadge: true,
    },
    badgeEligibility: {
      status: "missing",
      verifiedBadgeIds: [],
      verifiedBadges: [],
      allowedWorkTypes: [],
      summary: "No verified Network Task operating badge was found.",
    },
    gates: [
      {
        id: "operating_badge",
        label: "Network Task operating badge",
        status: "action_required",
        detail: "No verified Network Task operating badge was found.",
        action: "Open Profile and qualify a routing badge",
      },
    ],
    capacity: {
      blockers: [],
    },
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
  assert.ok(
    count(instructions, "## Product Surface Boundary") >= 1,
    `${label} should include product surface boundary language`
  );
  assert.equal(count(instructions, "## Response Length Calibration"), 1, `${label} should include response length calibration once`);
  assert.ok(
    instructions.includes("Ordinary chat can draft the note, sharpen the decision, explain the consequence, or tell the User which surface to use."),
    `${label} should describe ordinary chat as advisory`
  );
  assert.ok(
    instructions.includes("The Tasks panel is where the User accepts or refuses tasks and submits evidence."),
    `${label} should route task mutations to the Tasks panel`
  );
  assert.ok(
    instructions.includes("The Hive panel is where the User views network work and contributes to the network."),
    `${label} should route Hive work to the Hive panel`
  );
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
  assert.ok(instructions.includes("<network_task_eligibility>"), `${label} should include Network Task eligibility context`);
  assert.ok(instructions.includes("Status: badge_required"), `${label} should include badge-required routing state`);
  assert.ok(instructions.includes("Requires verified operating badge: yes"), `${label} should include badge gate`);
  assert.ok(instructions.includes("Network Task operating badge"), `${label} should include operating badge gate`);
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

  // Persona anchoring regression: the rendered context blocks are the largest
  // and most recent text in the window, so a binding response contract must
  // trail them. Without it, models mirror the context document's structured
  // format instead of the contract voice (consultant-mode collapse).
  assert.equal(count(instructions, "## Final Standard"), 1, `${label} should include one trailing Final Standard`);
  const finalStandardAt = instructions.lastIndexOf("## Final Standard");
  for (const marker of ["houston 1421", "Deep memory should carry forward", "<jobs_retrieval_context"]) {
    const markerAt = instructions.lastIndexOf(marker);
    assert.ok(markerAt !== -1 && markerAt < finalStandardAt, `${label} should render "${marker}" before the trailing Final Standard`);
  }
  assert.ok(
    instructions.indexOf("Refuse the\npull.") > finalStandardAt || instructions.includes("Refuse the"),
    `${label} Final Standard should restate the binding contract after the context blocks`
  );
  for (const clause of [
    "Never mirror their formatting",
    "Do not reproduce the context blocks' formatting",
    "not to prove you read it",
    "A short user turn gets a short answer",
  ]) {
    assert.ok(instructions.includes(clause), `${label} should include anti-mirroring clause: ${clause}`);
  }
}

const metadata = chatSpiritMetadata();
assert.equal(metadata.enabled, true, "Jobs chat spirit should be enabled in smoke");
assert.equal(metadata.path, "chat/jobs_standard_chat_codex_style_draft.md", "Jobs chat spirit should load the Markdown prompt");
assert.match(metadata.digest, /^[a-f0-9]{64}$/);

for (const [mode, model] of [
  ["Frontier Instant", "chat-latest"],
  ["Frontier Thinking", "gpt-5.6-sol"],
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

const gatedFrontierRequest = openAiResponseRequest({
  mode: "Frontier Instant",
  model: "chat-latest",
  message: "what do you think?",
  conversationId: "jobs-smoke-frontier-gate",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
  responseInstructionBlock: frontierInstantResponseGateInstructionBlock(),
  responseFormat: frontierInstantResponseGateResponseFormat(),
});
assert.equal(count(gatedFrontierRequest.instructions, "## Frontier Instant Response Gate"), 1);
assert.match(gatedFrontierRequest.instructions, /fully thought-out, elaborate, complex/);
assert.match(gatedFrontierRequest.instructions, /thinking something through in full/);
assert.match(gatedFrontierRequest.instructions, /preserve the decision-critical details/);
assert.match(gatedFrontierRequest.instructions, /stay under 10 sentences/);
assert.equal(gatedFrontierRequest.text.format.type, "json_schema");
assert.equal(gatedFrontierRequest.text.format.name, "frontier_instant_response_gate");
assert.equal(gatedFrontierRequest.text.format.strict, true);
assert.deepEqual(gatedFrontierRequest.text.format.schema.required, [
  "user_prompted_inquiry",
  "full_response",
  "conformant_response",
]);

const gatedConformant = selectFrontierInstantResponseText(JSON.stringify({
  user_prompted_inquiry: false,
  full_response: "This is the long version that should not be shown.",
  conformant_response: "No. This should stay short.",
}));
assert.equal(gatedConformant.text, "No. This should stay short.");
assert.equal(gatedConformant.responseGate.selectedField, "conformant_response");
assert.deepEqual(gatedConformant.responseGate.auditJson, {
  user_prompted_inquiry: false,
  full_response: "This is the long version that should not be shown.",
  conformant_response: "No. This should stay short.",
});

const gatedFull = selectFrontierInstantResponseText(JSON.stringify({
  user_prompted_inquiry: true,
  full_response: "This is the detailed analysis requested by the user.",
  conformant_response: "Short version.",
}));
assert.equal(gatedFull.text, "This is the detailed analysis requested by the user.");
assert.equal(gatedFull.responseGate.selectedField, "full_response");
assert.deepEqual(gatedFull.responseGate.auditJson, {
  user_prompted_inquiry: true,
  full_response: "This is the detailed analysis requested by the user.",
  conformant_response: "Short version.",
});

for (const [mode, model] of [
  ["Private Instant", "deepseek/deepseek-v4-flash"],
  ["Private Thinking", "z-ai/glm-5.2"],
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

const helpInstructions = helpModeInstructions({
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
});
assert.ok(helpInstructions.includes("## Task Node Help Mode"));
assert.ok(helpInstructions.includes("# User Guide"));
assert.ok(helpInstructions.includes("## First Session Checklist"));
assert.ok(helpInstructions.includes("Use Tasks to accept tasks, refuse tasks, submit evidence, and respond to verification."));
assert.ok(helpInstructions.includes("Task Node is an AI-assisted work app"));
assert.ok(helpInstructions.includes("Do not imply a human operator, reviewer, or \"someone\" performed an action"));
assert.ok(helpInstructions.includes("not \"someone verified it.\""));
assert.ok(helpInstructions.includes("When the user asks about Hive, Hive Chat, Network Tasks"));
assert.ok(helpInstructions.includes("Open the pinned `Hive Chat` conversation in Chat."));
assert.ok(helpInstructions.includes("no task is created just because the user sent a Hive Chat message"));
assert.ok(helpInstructions.includes("Do not include this Hive quickstart in unrelated Help answers."));
assert.ok(helpInstructions.includes("### Hive Chat First-Run Path"));
assert.ok(helpInstructions.includes("The Network Diagnostic Report is generated automatically"));
assert.ok(helpInstructions.includes("Contributor badges are Network Task routing permissions"));
assert.ok(helpInstructions.includes("KOL`, `Core Contributor`, `QA Worker`, `Expert`, and `Project Leader"));
assert.ok(helpInstructions.includes("If the runtime context says `badge_required`"));
assert.ok(helpInstructions.includes("Never tell the user to find, request, or apply for a Network Diagnostic Report; there is no request flow."));
assert.ok(helpInstructions.includes("opening the Memory page also queues it immediately when none exists"));
assert.ok(helpInstructions.includes("there is no way to request it from Hive, Board Manager, or a person"));
assertJobsInstructions(helpInstructions, "Help");
assert.equal(
  helpInstructions.includes(userSentinel),
  false,
  "Help instructions should not duplicate the current user message"
);

const helpRequest = deepSeekChatRequest({
  mode: "Help",
  model: "deepseek-v4-pro",
  message: userSentinel,
  conversationId: "jobs-smoke-Help",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
  instructionsOverride: helpInstructions,
});
const requestHelpInstructions = helpRequest.messages?.[0]?.content || "";
assert.equal(requestHelpInstructions, helpInstructions);
assert.equal(helpRequest.messages?.at(-1)?.content, userSentinel);
assert.equal(helpRequest.thinking?.type, "disabled");
assert.equal(helpRequest.reasoning_effort, undefined);
assert.equal(Object.prototype.hasOwnProperty.call(helpRequest, "max_tokens"), false);

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

const helpEstimate = chatEstimate(
  {
    mode: "Help",
    message: "How should I use this app?",
  },
  { contextDocument, memoryContext, taskContext }
);
assert.ok(
  helpEstimate.instructionInputTokens > estimate.instructionInputTokens,
  `Help estimate must count the embedded guide: ${JSON.stringify(helpEstimate)}`
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

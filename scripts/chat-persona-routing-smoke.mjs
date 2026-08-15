import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.TASKNODE_CHAT_SPIRIT_ENABLED = "true";
process.env.AMBIENT_API_KEY = process.env.AMBIENT_API_KEY || "ambient-test-key";

const { taskNodeInstructions } = await import("../server/chat-memory-context.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const { ambientChatRequest, chatProviderTimeoutMs, resolveChatJobsContext } = await import("../server/chat-router.js");
const { generateIChingCast } = await import("../server/i-ching-cast.js");
const { chatEstimateStart, chatSend } = await import("../server/product-contracts.js");
const {
  CHAT_PERSONAS,
  CHAT_MODALITIES,
  chatPersonaDefinition,
  chatPersonaIsModality,
  normalizeChatPersona,
} = await import("../shared/chat-personas.js");

const contextDocument = { body: "PERSONA_CONTEXT_SENTINEL" };
const memoryContext = { memories: [{ memoryText: "PERSONA_MEMORY_SENTINEL" }] };
const taskContext = { outstanding: [{ title: "PERSONA_TASK_SENTINEL", status: "Accepted" }] };
const jobsEssence = "JOBS_VECTOR_SENTINEL";
const iChingProfile = {
  input: { birth_date: "1988-03-15", true_solar_time: "14:20:01", timezone: "America/New_York" },
  bazi: { day_master: "己", four_pillars: { year: "戊辰", month: "乙卯", day: "己巳", hour: "辛未" } },
  ziwei: { chart: { palaces: [{ name: "命宫" }] } },
  warnings: [],
};

const timeoutEnvNames = [
  "CHAT_PROVIDER_AMBIENT_THINKING_TIMEOUT_MS",
  "CHAT_PROVIDER_THINKING_TIMEOUT_MS",
  "CHAT_PROVIDER_TIMEOUT_MS",
];
const previousTimeoutEnv = Object.fromEntries(timeoutEnvNames.map((name) => [name, process.env[name]]));
for (const name of timeoutEnvNames) delete process.env[name];
assert.equal(chatProviderTimeoutMs({ mode: "Thinking", provider: "ambient" }), 300_000);
process.env.CHAT_PROVIDER_AMBIENT_THINKING_TIMEOUT_MS = "90000";
assert.equal(chatProviderTimeoutMs({ mode: "Thinking", provider: "ambient" }), 90_000);
for (const name of timeoutEnvNames) {
  if (previousTimeoutEnv[name] === undefined) delete process.env[name];
  else process.env[name] = previousTimeoutEnv[name];
}

const jobsInstructions = taskNodeInstructions({
  persona: "jobs",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
});
assert.match(jobsInstructions, /JOBS_VECTOR_SENTINEL/);
assert.match(jobsInstructions, /## Experience Promise/);

const odvInstructions = taskNodeInstructions({
  persona: "odv",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
});
assert.match(odvInstructions, /You are ODV/);
assert.match(odvInstructions, /PERSONA_CONTEXT_SENTINEL/);
assert.match(odvInstructions, /PERSONA_MEMORY_SENTINEL/);
assert.match(odvInstructions, /PERSONA_TASK_SENTINEL/);
assert.doesNotMatch(odvInstructions, /JOBS_VECTOR_SENTINEL/);
assert.doesNotMatch(odvInstructions, /## Experience Promise/);

const coachInstructions = taskNodeInstructions({
  persona: "trading-coach",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
});
assert.match(coachInstructions, /WORLD CLASS SPECULATOR/);
assert.match(coachInstructions, /PERSONA_CONTEXT_SENTINEL/);
assert.match(coachInstructions, /PERSONA_MEMORY_SENTINEL/);
assert.match(coachInstructions, /PERSONA_TASK_SENTINEL/);
assert.doesNotMatch(coachInstructions, /JOBS_VECTOR_SENTINEL/);
assert.doesNotMatch(coachInstructions, /## Experience Promise/);

const kravisInstructions = taskNodeInstructions({
  persona: "kravis",
  contextDocument,
  memoryContext,
  taskContext,
  jobsEssence,
});
assert.match(kravisInstructions, /## 0 · PRIME DIRECTIVE/);
assert.match(kravisInstructions, /## 3 · THE SEQUENCE/);
assert.match(kravisInstructions, /PERSONA_CONTEXT_SENTINEL/);
assert.match(kravisInstructions, /PERSONA_MEMORY_SENTINEL/);
assert.match(kravisInstructions, /PERSONA_TASK_SENTINEL/);
assert.doesNotMatch(kravisInstructions, /JOBS_VECTOR_SENTINEL/);
assert.doesNotMatch(kravisInstructions, /## Experience Promise/);
assert.doesNotMatch(kravisInstructions, /How to use:/);
assert.doesNotMatch(kravisInstructions, /APPENDIX — Design Notes/);

let retrievalCalls = 0;
const retrieve = async () => {
  retrievalCalls += 1;
  return { ok: true, text: jobsEssence, chunks: [{ title: "Jobs" }] };
};
for (const persona of ["odv", "trading-coach", "kravis"]) {
  const result = await resolveChatJobsContext({ persona, retrieve, jobsEssence });
  assert.equal(result.skipped, true);
  assert.equal(result.text, "");
}

assert.deepEqual(
  CHAT_MODALITIES.map((modality) => modality.id),
  [
    "brainstorming",
    "motivation",
    "five-mirrors",
    "i-ching",
    "odv-lindy",
    "sprint-planner",
    "validator",
    "post-fiat-qa",
  ]
);
for (const modality of CHAT_MODALITIES) {
  const instructions = taskNodeInstructions({
    message: "MODALITY_QUESTION_SENTINEL",
    persona: modality.id,
    contextDocument,
    memoryContext,
    taskContext,
    jobsEssence,
    iChingProfile: modality.id === "i-ching" ? iChingProfile : null,
  });
  assert.equal(chatPersonaIsModality(modality.id), true);
  assert.match(instructions, /PERSONA_CONTEXT_SENTINEL/);
  assert.match(instructions, /PERSONA_TASK_SENTINEL/);
  assert.doesNotMatch(instructions, /JOBS_VECTOR_SENTINEL/);
  assert.doesNotMatch(instructions, /___[A-Z0-9_]+___/, `${modality.id} left a legacy runtime placeholder unresolved`);
  const estimate = chatEstimate({
    message: "Estimate this modality turn",
    mode: "Instant",
    persona: modality.id,
  });
  assert.equal(estimate.mode, "Thinking", `${modality.id} must be forced through GLM 5.2 Thinking mode`);
}

const modalityRequest = ambientChatRequest({
  mode: "Thinking",
  model: "z-ai/glm-5.2",
  message: "Current modality question",
  conversationId: "conversation-modality-smoke",
  historyMessages: [
    { role: "user", body: "PRIOR_USER_TURN_SENTINEL" },
    { role: "assistant", body: "PRIOR_ASSISTANT_TURN_SENTINEL" },
  ],
  contextDocument,
  memoryContext,
  taskContext,
  persona: "five-mirrors",
});
assert.equal(modalityRequest.model, "z-ai/glm-5.2");
assert.ok(modalityRequest.messages.some((message) => message.content === "PRIOR_USER_TURN_SENTINEL"));
assert.ok(modalityRequest.messages.some((message) => message.content === "PRIOR_ASSISTANT_TURN_SENTINEL"));

const deterministicCast = generateIChingCast({
  question: "Should I proceed?",
  coin: () => 2,
});
assert.deepEqual(deterministicCast.lineValues, [6, 6, 6, 6, 6, 6]);
assert.deepEqual(deterministicCast.changingLines, [1, 2, 3, 4, 5, 6]);
assert.equal(deterministicCast.primary.number, 2);
assert.equal(deterministicCast.relating.number, 1);
assert.throws(() => generateIChingCast({ question: " " }), /i_ching_question_required/);
assert.equal(retrievalCalls, 0, "non-Jobs personas must not invoke Jobs retrieval");
const jobsResult = await resolveChatJobsContext({ persona: "jobs", retrieve });
assert.equal(retrievalCalls, 1, "Jobs should invoke Jobs retrieval");
assert.equal(jobsResult.text, jobsEssence);

for (const persona of ["odv", "trading-coach", "kravis"]) {
  const estimate = chatEstimate(
    { message: "Give me a useful next step", mode: "Instant", persona },
    { contextDocument, memoryContext, taskContext }
  );
  assert.equal(estimate.persona, persona);
  assert.equal(estimate.jobsRetrievalInputTokens, 0);
}
assert.ok(chatEstimate({ message: "Help with product", mode: "Instant", persona: "jobs" }).jobsRetrievalInputTokens > 0);

assert.equal(normalizeChatPersona("coach"), "trading-coach");
assert.equal(normalizeChatPersona("steve-jobs"), "jobs");
assert.equal(normalizeChatPersona("henry-kravis"), "kravis");
assert.equal(normalizeChatPersona("brainstorm"), "brainstorming");
assert.equal(normalizeChatPersona("five_mirrors"), "five-mirrors");
assert.equal(normalizeChatPersona("i_ching"), "i-ching");
assert.equal(normalizeChatPersona("post-fiat-clarity"), "post-fiat-qa");
assert.equal(normalizeChatPersona("app-clarity"), "");
assert.equal(normalizeChatPersona("app-help"), "");
assert.equal(chatPersonaDefinition("kravis").name, "Kravis");
assert.ok(CHAT_PERSONAS.some((persona) => persona.id === "kravis"));
const invalid = await chatEstimateStart({ message: "Hello", mode: "Instant", persona: "not-real" });
assert.equal(invalid.status, 400);
assert.equal(invalid.body.error, "unknown_chat_persona");
const anonymousPersona = await chatSend(
  { message: "Hello", mode: "Help", persona: "odv", dryRun: true },
  "POST"
);
assert.equal(anonymousPersona.status, 401);
assert.equal(anonymousPersona.body.error, "chat_login_required");
const iChingWithoutQuestion = await chatSend(
  {
    message: "",
    mode: "Instant",
    persona: "i-ching",
    attachments: [{ name: "question.txt", mimeType: "text/plain", kind: "text", textContent: "attachment only" }],
    dryRun: true,
  },
  "POST"
);
assert.equal(iChingWithoutQuestion.status, 400);
assert.equal(iChingWithoutQuestion.body.error, "i_ching_question_required");
const iChingWithoutProfile = await chatSend(
  {
    accountId: "i-ching-profile-gate-smoke",
    message: "What should I prioritize next?",
    mode: "Instant",
    persona: "i-ching",
    dryRun: true,
  },
  "POST"
);
assert.equal(iChingWithoutProfile.status, 409);
assert.equal(iChingWithoutProfile.body.error, "i_ching_profile_required");
assert.equal(iChingWithoutProfile.body.setupPath, "/api/i-ching/profile");

const frontendSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(frontendSource, /label="Personality"/);
assert.match(frontendSource, /persona: isContextEdit \? DEFAULT_CHAT_PERSONA : selectedPersona/);
assert.match(frontendSource, /CHAT_PERSONAS\.map/);
assert.match(frontendSource, /CHAT_MODALITIES\.map/);
assert.match(frontendSource, /mode: isContextEdit \|\| activeModality \? "Thinking"/);
assert.match(frontendSource, /Ask a specific question before casting the I Ching/);
assert.match(frontendSource, /IChingSetupDialog/);
assert.match(frontendSource, /kravis: Landmark/);

console.log("chat persona routing smoke ok");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.TASKNODE_CHAT_SPIRIT_ENABLED = "true";
process.env.AMBIENT_API_KEY = process.env.AMBIENT_API_KEY || "ambient-test-key";

const { taskNodeInstructions } = await import("../server/chat-memory-context.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const { resolveChatJobsContext } = await import("../server/chat-router.js");
const { chatEstimateStart, chatSend } = await import("../server/product-contracts.js");
const {
  CHAT_PERSONAS,
  chatPersonaDefinition,
  normalizeChatPersona,
} = await import("../shared/chat-personas.js");

const contextDocument = { body: "PERSONA_CONTEXT_SENTINEL" };
const memoryContext = { memories: [{ memoryText: "PERSONA_MEMORY_SENTINEL" }] };
const taskContext = { outstanding: [{ title: "PERSONA_TASK_SENTINEL", status: "Accepted" }] };
const jobsEssence = "JOBS_VECTOR_SENTINEL";

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

const frontendSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(frontendSource, /label="Personality"/);
assert.match(frontendSource, /persona: isContextEdit \? DEFAULT_CHAT_PERSONA : selectedPersona/);
assert.match(frontendSource, /CHAT_PERSONAS\.map/);
assert.match(frontendSource, /kravis: Landmark/);

console.log("chat persona routing smoke ok");

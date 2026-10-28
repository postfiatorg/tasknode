import assert from "node:assert/strict";
import { pendingDeepResearchTurns, replaceDeepResearchAssistant } from "../src/features/chat/deep-research-turns.js";

const metadata = { deepResearch: { jobId: "job-a", status: "running" } };
const question = { id: "question", role: "user", metadata, text: "What changed?" };
const pending = { id: "optimistic", role: "assistant", metadata };
const saved = { id: "saved", role: "assistant", metadata };
const finished = { ...saved, metadata: { deepResearch: { jobId: "job-a", status: "completed" } }, text: "The answer" };
const other = { id: "other", role: "assistant", metadata: { deepResearch: { jobId: "job-b", status: "running" } } };
assert.deepEqual(pendingDeepResearchTurns([question, pending]), [pending], "never poll a research question as an answer");
assert.deepEqual(replaceDeepResearchAssistant([question, pending], "job-a", "optimistic", finished), [question, finished]);
assert.deepEqual(replaceDeepResearchAssistant([question, saved], "job-a", "optimistic", finished), [question, finished], "hydration can change message IDs while a poll is in flight");
assert.deepEqual(replaceDeepResearchAssistant([question, pending, saved, other], "job-a", "optimistic", finished), [question, finished, other], "one answer per job without changing another job");
assert.deepEqual(replaceDeepResearchAssistant([other], "job-a", "optimistic", finished), [other], "late completion cannot insert into another conversation");
assert.deepEqual(pendingDeepResearchTurns([question, finished, other]), [other]);
console.log("deep-research-chat-smoke ok: question preserved, single assistant, hydrated IDs, terminal jobs, conversation isolation");

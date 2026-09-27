import { createHash } from "node:crypto";

const hash = text => createHash("sha256").update(text).digest("hex");

export function buildDecisionContext({ input, document = null, memory = null }) {
  const body = String(document?.body || "").trim();
  const deep = (memory?.deepMemories || []).map(entry => ({
    id: entry.id, kind: entry.kind, created_at: entry.createdAt,
    user_summary: entry.userRequestSummary, assistant_summary: entry.systemResponseSummary,
    memory: entry.memoryText,
  }));
  const recent = (memory?.memories || []).map(entry => ({
    id: entry.id, kind: entry.kind, created_at: entry.createdAt, memory: entry.memoryText,
  }));
  const memories = [...deep, ...recent];
  const blocks = [];
  if (body) blocks.push(`# Task Node context document\n\n${body}`);
  if (memories.length) blocks.push([
    "# Task Node conversation memory",
    "Dated account memory is background context. The current question and latest explicit user corrections take precedence. Distinguish user facts from earlier assistant advice; a past recommendation does not establish a user commitment or a verified external fact.",
    JSON.stringify({ deep_memories: deep, recent_memories: recent }),
  ].join("\n\n"));
  const combined = blocks.length ? [`# User proposed decision\n\n${input}`, ...blocks].join("\n\n") : input;
  if (combined.length > 60_000) throw Object.assign(new Error("The question, saved context and chat memories exceed 60,000 characters. Shorten the input or turn off context and memory."), { status: 400 });
  return {
    input: combined,
    included: blocks.length > 0,
    snapshot: {
      version: 1,
      document: body ? { id: document.id || "", revision: document.revision || 0, updatedAt: document.updatedAt || null, sha256: hash(body) } : null,
      deepMemoryCount: deep.length, recentMemoryCount: recent.length,
      memoryIds: memories.map(entry => entry.id),
      inputSha256: hash(combined),
    },
  };
}

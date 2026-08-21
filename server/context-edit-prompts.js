import { promptDigest, loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { contextDocumentPacket } from "./context-line-map.js";
import { formatChatMemoryContext } from "./chat-memory-context.js";
import { formatChatTaskContext } from "./chat-task-context.js";
import { MODEL_CONTEXT_MAX_CHARS } from "../shared/context-budget.js";

export const contextEditPromptPath = "context/context_edit_jobs_v1.xml";
export const contextEditPromptText = loadPrompt(contextEditPromptPath);
export const contextEditPromptVersion = "context_edit_jobs_v1";
export const contextEditPromptSha256 = promptDigest(contextEditPromptText);

function clip(value = "", max = 12000) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()} [truncated]`;
}

function formatRecentChat(historyMessages = []) {
  return (historyMessages || [])
    .slice(-12)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${clip(message.body || message.text, 1600)}`)
    .filter((line) => line.trim().length > 11)
    .join("\n\n");
}

function formatActiveProposal(proposal = null) {
  if (!proposal) return "No active context edit proposal.";
  return [
    `Proposal ID: ${proposal.id}`,
    `State: ${proposal.state}`,
    `Operation: ${proposal.operation}`,
    proposal.lineStart ? `Lines: ${proposal.lineStart}-${proposal.lineEnd || proposal.lineStart}` : "",
    proposal.targetHeading ? `Target heading: ${proposal.targetHeading}` : "",
    proposal.rationale ? `Rationale: ${proposal.rationale}` : "",
    "Target before:",
    clip(proposal.targetBefore, 3000) || "(empty)",
    "Target after:",
    clip(proposal.targetAfter, 3000) || "(empty)",
  ].filter(Boolean).join("\n");
}

export function renderContextEditPrompt({
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  historyMessages = [],
  activeProposal = null,
  userRequest = "",
} = {}) {
  const packet = contextDocumentPacket(contextDocument || {});
  return renderPromptTemplate(contextEditPromptText, {
    CONTEXT_DOCUMENT: clip(packet.bodyText, MODEL_CONTEXT_MAX_CHARS) || "(empty)",
    CONTEXT_DOCUMENT_WITH_LINE_NUMBERS: clip(packet.lineNumberedText, MODEL_CONTEXT_MAX_CHARS + 15_000) || "1 |",
    CURRENT_CONTEXT_REVISION: [
      `Title: ${packet.title}`,
      `Revision: ${packet.revision}`,
      `Body SHA-256: ${packet.bodySha256}`,
      packet.updatedAt ? `Updated at: ${packet.updatedAt}` : "",
    ].filter(Boolean).join("\n"),
    ACTIVE_CONTEXT_EDIT_STATE: formatActiveProposal(activeProposal),
    MEMORY: formatChatMemoryContext(memoryContext) || "(no memory records available)",
    TASK_STATE: formatChatTaskContext(taskContext) || "(no task state available)",
    RECENT_CHAT: formatRecentChat(historyMessages) || "(no prior chat in this conversation)",
    USER_REQUEST: clip(userRequest, 8000),
  });
}

export function contextEditResponseFormat() {
  return {
    type: "json_schema",
    name: "context_edit_response",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["response", "state", "proposal"],
      properties: {
        response: { type: "string" },
        state: { type: "string", enum: ["needs_calibration", "proposal"] },
        proposal: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: [
                "operation",
                "anchor_type",
                "line_start",
                "line_end",
                "target_heading",
                "target_before",
                "target_after",
                "rationale",
                "risk",
              ],
              properties: {
                operation: {
                  type: "string",
                  enum: [
                    "replace_block",
                    "replace_section",
                    "append_to_section",
                    "replace_document",
                    "append_document",
                  ],
                },
                anchor_type: {
                  type: "string",
                  enum: ["line_range", "heading", "excerpt", "document"],
                },
                line_start: { type: ["integer", "null"] },
                line_end: { type: ["integer", "null"] },
                target_heading: { type: "string" },
                target_before: { type: "string" },
                target_after: { type: "string" },
                rationale: { type: "string" },
                risk: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          ],
        },
      },
    },
  };
}

import React, { useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Paperclip,
  Pencil,
  X,
} from "lucide-react";
import { formatFileSize } from "../../chat-attachments";
import { plainTextFromBlocks } from "./chat-markdown";
import { ContextEditProposalCard } from "../context/ContextEditProposalCard.jsx";

export async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to a temporary textarea for browsers that block Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function UserMessage({
  attachments = [],
  draft,
  isEditing,
  onCancelEdit,
  onDraftChange,
  onSaveEdit,
  onStartEdit,
  text,
}) {
  if (isEditing) {
    return (
      <article className="user-message editing">
        <div className="user-edit-card">
          <textarea
            autoFocus
            onChange={(event) => onDraftChange(event.target.value)}
            value={draft}
          />
          <div className="user-edit-actions">
            <button onClick={onCancelEdit} type="button">
              Cancel
            </button>
            <button className="dark" onClick={onSaveEdit} type="button">
              Send
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="user-message">
      {attachments.length > 0 && <MessageAttachmentList attachments={attachments} />}
      <div className="user-bubble">{text}</div>
      <div className="user-message-tools">
        <ToolbarButton
          doneLabel="Copied"
          icon={Copy}
          label="Copy message"
          onClick={() => copyText(text)}
        />
        <ToolbarButton icon={Pencil} label="Edit" onClick={onStartEdit} />
      </div>
    </article>
  );
}

export function AgentMessage({
  attachments = [],
  agentClient = "",
  agentLabel = "Orc agent",
  text,
}) {
  return (
    <article className="agent-message">
      <div className="agent-source-row">
        <span className="agent-source-label">{agentLabel || "Orc agent"}</span>
        <span className="agent-source-meta">{agentClient || "machine agent"}</span>
      </div>
      {attachments.length > 0 && <MessageAttachmentList attachments={attachments} />}
      <div className="agent-bubble">{text}</div>
      <div className="agent-message-tools">
        <ToolbarButton
          doneLabel="Copied"
          icon={Copy}
          label="Copy agent message"
          onClick={() => copyText(text)}
        />
      </div>
    </article>
  );
}

export function AttachmentTray({ attachments = [], onRemove, onShowInText }) {
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-tray">
      {attachments.map((attachment) => (
        <div className="attachment-chip" key={attachment.id || attachment.name}>
          <span className={attachment.source === "paste" ? "attachment-icon paste" : "attachment-icon"}>
            {attachment.source === "paste" ? (
              <FileText size={18} strokeWidth={1.8} />
            ) : (
              <Paperclip size={15} strokeWidth={1.8} />
            )}
          </span>
          <span className="attachment-label">
            <strong>{attachment.name}</strong>
            {attachment.source === "paste" ? (
              <button
                className="attachment-action"
                onClick={() => onShowInText?.(attachment)}
                type="button"
              >
                Show in text field <ChevronRight size={12} strokeWidth={1.9} />
              </button>
            ) : (
              <small>{formatFileSize(attachment.size)}</small>
            )}
          </span>
          <button
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove?.(attachment.id)}
            type="button"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

function MessageAttachmentList({ attachments = [] }) {
  if (attachments.length === 0) return null;

  return (
    <div className="message-attachment-list">
      {attachments.map((attachment) => (
        <span className="message-attachment-chip" key={attachment.id || attachment.name}>
          <Paperclip size={12} strokeWidth={1.8} />
          {attachment.name}
        </span>
      ))}
    </div>
  );
}

export function AssistantMessage({
  contextEditSavingId = "",
  message,
  onContextEditApply,
  onContextEditReject,
  onContextEditRevise,
  onShare,
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const body = plainTextFromBlocks(message.blocks);
  const hasThinking = Boolean(message.thinking);
  const isHiveInputAck = message.metadata?.kind === "hive_input_ack";
  const isHiveContextStatus = message.metadata?.kind === "hive_context_status";
  const sourceLabel = assistantSourceLabel(message.metadata);
  const showToolbar = !message.pending && !message.error && !isHiveInputAck && !isHiveContextStatus;
  const proposal = message.metadata?.contextEdit?.proposal || null;

  if (isHiveInputAck) return null;

  if (isHiveContextStatus) {
    return (
      <article className="hive-context-status-message">
        <em>{body}</em>
      </article>
    );
  }

  return (
    <article
      className={[
        "assistant-message",
        message.pending ? "pending" : "",
        message.error ? "error" : "",
        isHiveInputAck ? "is-hive-input-ack" : "",
        sourceLabel ? `is-${sourceLabel.kind}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasThinking && (
        <div className="thinking-toggle-wrap">
          <button
            className={message.pending ? "thinking-row pending" : "thinking-row"}
            onClick={() => setThinkingOpen((open) => !open)}
            type="button"
          >
            {message.pending && <span className="thinking-pulse" aria-hidden="true" />}
            {thinkingLabel(message.thinking)}
            {thinkingOpen ? (
              <ChevronDown size={13} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} />
            )}
          </button>
          {thinkingOpen && (
            <ThinkingDetails message={message} />
          )}
        </div>
      )}
      {sourceLabel && (
        <div className="assistant-source-row" title={sourceLabel.title}>
          <span className="assistant-source-label">{sourceLabel.label}</span>
          {sourceLabel.meta && <span className="assistant-source-meta">{sourceLabel.meta}</span>}
        </div>
      )}
      <div className="assistant-body">
        {(message.blocks || []).map((block, index) => (
          <BlockRenderer block={block} key={index} />
        ))}
      </div>
      <ContextEditProposalCard
        error={message.metadata?.contextEdit?.error || proposal?.error || ""}
        onApply={onContextEditApply}
        onReject={onContextEditReject}
        onRevise={onContextEditRevise}
        proposal={proposal}
        saving={contextEditSavingId === proposal?.id}
      />
      {message.error && <div className="assistant-error">Response failed</div>}
      {showToolbar && (
        <MessageToolbar
          onCopy={() => copyText(body)}
          onShare={onShare}
        />
      )}
    </article>
  );
}

function ThinkingDetails({ message }) {
  const retrieval = message.thinking?.jobsRetrieval || null;
  const responseGate = responseGateForMessage(message);
  const sourceText = readableJobsRetrievalText(retrieval);
  const responseGateJson = readableResponseGateJson(responseGate);

  return (
    <div className="thinking-details">
      <div className="thinking-step-list">
        {thinkingSteps(message).map((step) => (
          <span key={step}>{step}</span>
        ))}
      </div>
      {retrieval && (
        <div className="thinking-vector-panel">
          <div className="thinking-vector-header">
            <strong>Jobs source text</strong>
            <span>{thinkingRetrievalSummary(retrieval)}</span>
          </div>
          {sourceText ? (
            <pre className="thinking-source-block">{sourceText}</pre>
          ) : (
            <span className="thinking-vector-empty">
              No Jobs source text was passed{retrieval.reason ? `: ${retrieval.reason}` : "."}
            </span>
          )}
        </div>
      )}
      {responseGate && (
        <div className="thinking-vector-panel thinking-response-gate-panel">
          <div className="thinking-vector-header">
            <strong>Frontier response JSON</strong>
            <span>{thinkingResponseGateSummary(responseGate)}</span>
          </div>
          {responseGateJson ? (
            <pre className="thinking-source-block thinking-json-block">{responseGateJson}</pre>
          ) : (
            <span className="thinking-vector-empty">
              No Frontier response JSON was stored for this message.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function responseGateForMessage(message = {}) {
  return message.thinking?.responseGate || message.metadata?.responseGate || null;
}

function readableResponseGateJson(responseGate = null) {
  const auditJson = responseGate?.auditJson;
  if (auditJson && typeof auditJson === "object" && !Array.isArray(auditJson)) {
    return JSON.stringify(auditJson, null, 2);
  }
  return "";
}

function readableJobsRetrievalText(retrieval = null) {
  const chunks = Array.isArray(retrieval?.chunks) ? retrieval.chunks : [];
  const readable = chunks
    .map((chunk) => String(chunk.content || "").trim())
    .filter(Boolean);
  if (readable.length > 0) return readable.join("\n\n---\n\n");

  const renderedContext = String(retrieval?.renderedContext || "").trim();
  if (!renderedContext) return "";
  const matches = [...renderedContext.matchAll(/<!\[CDATA\[\n?([\s\S]*?)\n?\]\]>/g)];
  return matches
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function thinkingRetrievalSummary(retrieval = {}) {
  const state = retrieval.state || "unknown";
  const count = Number(retrieval.chunkCount || 0);
  return `${state} · ${count} ${count === 1 ? "excerpt" : "excerpts"}`;
}

function thinkingResponseGateSummary(responseGate = {}) {
  const selectedField = responseGate.selectedField || "unknown field";
  const mode = responseGate.userPromptedInquiry === true ? "full response" : "conformant response";
  return `${mode}; selected ${selectedField}`;
}

function assistantSourceLabel(metadata = {}) {
  if (metadata?.kind === "hive_manager_response") {
    return {
      kind: "board-manager",
      label: "Board Manager",
      meta: metadata.boardManagerRunId ? `Run ${shortMetaId(metadata.boardManagerRunId)}` : "",
      title: metadata.boardManagerRunId ? `Board Manager run ${metadata.boardManagerRunId}` : "Automated Board Manager message",
    };
  }
  if (metadata?.kind === "hive_immediate_response") {
    return {
      kind: "hive-chat",
      label: "Hive Chat",
      title: metadata.accountLiveStateDigest
        ? `Hive response with account live state ${metadata.accountLiveStateDigest.slice(0, 12)}`
        : "Immediate Hive Chat response",
    };
  }
  if (metadata?.kind === "orc_hive_signal") {
    const origin = metadata.agentOrigin && typeof metadata.agentOrigin === "object" ? metadata.agentOrigin : {};
    const reviewer = String(origin.agentHandle || metadata.reviewerHandle || metadata.agentHandle || "").trim().replace(/^@+/, "");
    return {
      kind: "orc-agent",
      label: reviewer ? `@${reviewer}` : "Orc agent",
      meta: metadata.taskId ? `Task ${shortMetaId(metadata.taskId)}` : "",
      title: metadata.taskId ? `Orc signal for ${metadata.taskId}` : "Orc agent Hive signal",
    };
  }
  return null;
}

function shortMetaId(value = "") {
  const normalized = String(value || "").trim();
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 10)}...${normalized.slice(-6)}`;
}

function thinkingLabel(thinking) {
  if (thinking?.state === "running") return "Thinking";
  if (thinking?.state === "stopped") return "Stopped thinking";
  return `Thought for ${thinking?.duration || "1s"}`;
}

function thinkingSteps(message) {
  if (message.pending && message.metadata?.kind === "task_request_intent") {
    return ["Capturing request details", "Preparing the task bundle", "Waiting for PFTL signing"];
  }
  if (message.pending && message.metadata?.kind === "context_edit") {
    return ["Reading your context document", "Locating the edit", "Preparing a proposal"];
  }
  if (message.pending) {
    return ["Reading context", "Selecting the execution route", "Drafting response"];
  }
  if (message.error) {
    return ["Request started", "Provider did not complete", "Kept your message in the thread"];
  }
  return ["Read the prompt", "Checked available context", "Composed the response"];
}

function BlockRenderer({ block }) {
  if (!block) return null;

  switch (block.type) {
    case "p":
      return (
        <p>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </p>
      );
    case "h2":
      return (
        <h2>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </h2>
      );
    case "h3":
      return (
        <h3>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </h3>
      );
    case "quote":
      return (
        <blockquote>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </blockquote>
      );
    case "ul":
      return (
        <ul>
          {(block.items || []).map((item, index) => (
            <li key={index}>
              <Inline parts={Array.isArray(item) ? item : [{ text: item }]} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol start={Number(block.start) > 1 ? Number(block.start) : undefined}>
          {(block.items || []).map((item, index) => (
            <li key={index}>
              <Inline parts={Array.isArray(item) ? item : [{ text: item }]} />
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="assistant-table-wrap">
          <table className="assistant-table">
            <thead>
              <tr>
                {(block.headers || []).map((cell, index) => (
                  <th className={`align-${block.alignments?.[index] || "left"}`} key={index} scope="col">
                    <Inline parts={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(block.rows || []).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td className={`align-${block.alignments?.[cellIndex] || "left"}`} key={cellIndex}>
                      <Inline parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr />;
    default:
      return null;
  }
}

function Inline({ parts }) {
  return (
    <>
      {(parts || []).map((part, index) => {
        if (part.bold) return <strong key={index}>{part.bold}</strong>;
        if (part.italic) return <em key={index}>{part.italic}</em>;
        if (part.code) return <code key={index}>{part.code}</code>;
        if (part.link) {
          return (
            <a href={part.href} key={index} rel="noreferrer" target="_blank">
              {part.link}
            </a>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

function MessageToolbar({ onCopy, onShare }) {
  return (
    <div className="message-toolbar">
      <ToolbarButton doneLabel="Copied" icon={Copy} label="Copy response" onClick={onCopy} />
      <ToolbarButton icon={ArrowUp} label="Share" onClick={onShare} />
    </div>
  );
}

function ToolbarButton({ doneLabel = "", icon: Icon, label, onClick }) {
  const [hover, setHover] = useState(false);
  const [done, setDone] = useState(false);

  async function handleClick() {
    const result = await onClick?.();
    if (!doneLabel || result === false) return;
    setDone(true);
    window.setTimeout(() => setDone(false), 1200);
  }

  return (
    <span className="toolbar-button-wrap">
      <button
        aria-label={done ? doneLabel : label}
        className="toolbar-button"
        onClick={handleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        type="button"
      >
        <Icon size={14} strokeWidth={1.75} />
      </button>
      {(hover || done) && <span className="toolbar-tip">{done ? doneLabel : label}</span>}
    </span>
  );
}

import { requestJson } from "../../api";
import { contextWordCount, stripContextHtml, truncateCid } from "./context-view-utils.jsx";
import { escapeContextHtml, looksLikeContextHtml, sanitizeContextHtml } from "../../../shared/context-html";
import { CONTEXT_DOCUMENT_MAX_CHARS } from "../../../shared/context-budget.js";

export function pickContextText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => pickContextText(entry)).filter(Boolean).join("\n\n");
  }
  if (typeof value !== "object") return "";

  const directFields = [
    "body",
    "content",
    "context",
    "contextDocument",
    "context_doc",
    "markdown",
    "text",
    "plaintext",
  ];
  for (const field of directFields) {
    const text = pickContextText(value[field]);
    if (text) return text;
  }

  return "";
}

export function pickContextTitle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Historical PFT Context";
  const title = value.title || value.name || value.contextTitle || value.context_title;
  return String(title || "Historical PFT Context").trim().slice(0, 120) || "Historical PFT Context";
}

export function extractHydratedContext(payload, plaintext) {
  const parsedPlaintext = (() => {
    if (typeof plaintext !== "string") return null;
    try {
      return JSON.parse(plaintext);
    } catch {
      return null;
    }
  })();
  const source = parsedPlaintext || payload;
  const text = (pickContextText(source) || (typeof plaintext === "string" ? plaintext : "")).trim();
  return {
    title: pickContextTitle(source),
    text: text.slice(0, CONTEXT_DOCUMENT_MAX_CHARS),
    rawPayload: source,
  };
}

export function contextPreviewText(value, maxLength = 220) {
  return stripContextHtml(contextBodyToHtml(value)).slice(0, maxLength);
}

export function formatContextTimestamp(value) {
  if (!value) return "Not saved yet";

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "Not saved yet";
  }
}

export function formatRelativeShort(value, now = Date.now()) {
  if (!value) return "not saved";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "not saved";
  const diff = Math.max(0, now - then);
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function contextTextToHtml(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listType = "";

  function closeList() {
    if (!listType) return;
    html += `</${listType}>`;
    listType = "";
  }

  function openList(nextType) {
    if (listType === nextType) return;
    closeList();
    listType = nextType;
    html += `<${listType}>`;
  }

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      return;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      html += `<h${level}>${escapeContextHtml(heading[2])}</h${level}>`;
      return;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      openList("ul");
      html += `<li>${escapeContextHtml(unordered[1])}</li>`;
      return;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (ordered) {
      openList("ol");
      html += `<li>${escapeContextHtml(ordered[1])}</li>`;
      return;
    }

    closeList();
    html += `<p>${escapeContextHtml(trimmed)}</p>`;
  });

  closeList();
  return html || "<p><br></p>";
}

export function contextBodyToHtml(value) {
  const text = String(value || "");
  return looksLikeContextHtml(text) ? sanitizeContextHtml(text) : contextTextToHtml(text);
}

export function contextEditorLineRows(editor) {
  if (!editor) return [];
  const editorTop = editor.getBoundingClientRect().top;
  const rows = [];
  const blockTags = new Set(["H1", "H2", "H3", "P", "LI", "BLOCKQUOTE", "PRE", "TR"]);
  const collect = (node) => {
    for (const child of Array.from(node.children || [])) {
      if (blockTags.has(child.tagName) && child.textContent.trim()) rows.push(child);
      if (!blockTags.has(child.tagName) || ["UL", "OL", "TABLE", "TBODY", "THEAD"].includes(child.tagName)) collect(child);
    }
  };
  collect(editor);
  return (rows.length ? rows : [editor]).map((node, index) => ({
    number: index + 1,
    top: Math.max(0, Math.round(node.getBoundingClientRect().top - editorTop)),
  }));
}

export function nodeBelongsToEditor(editor, node) {
  if (!editor || !node) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  return node === editor || element === editor || editor.contains(element);
}

export function editorSelectionRange(editor) {
  const selection = window.getSelection?.();
  if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!nodeBelongsToEditor(editor, range.startContainer) || !nodeBelongsToEditor(editor, range.endContainer)) {
    return null;
  }
  return range;
}

export function buildContextVersions(documentState = {}, history = {}) {
  const versions = [];
  const currentHtml = contextBodyToHtml(documentState.body || "");
  versions.push({
    key: `current-${documentState.revision || 0}`,
    type: "current",
    rev: documentState.revision || 0,
    cid: "",
    at: documentState.updatedAt || documentState.createdAt,
    words: contextWordCount(currentHtml),
    preview: stripContextHtml(currentHtml).slice(0, 220),
    current: true,
  });

  (history.contextUpdates || []).forEach((pointer, index) => {
    versions.push({
      key: pointer.cid || `pointer-${index}`,
      type: "pointer",
      rev: pointer.version || Math.max((history.contextUpdateCount || 0) - index, 1),
      cid: pointer.cid || "",
      at: pointer.createdAt,
      words: Number(pointer.wordCount || 0),
      preview: pointer.cid
        ? `Historical context pointer ${truncateCid(pointer.cid)}`
        : "Historical context pointer",
      current: false,
      pointer,
    });
  });

  return versions;
}

export async function refreshContextStateAfterSave(onContextChange) {
  if (typeof onContextChange !== "function") return null;

  let timeoutId = 0;
  try {
    return await Promise.race([
      onContextChange(),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          const error = new Error("context_app_state_refresh_timeout");
          error.code = "context_app_state_refresh_timeout";
          reject(error);
        }, 4000);
      }),
    ]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

export async function requestContextSaveJson(path, payload) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId = 0;
  try {
    if (controller) {
      timeoutId = window.setTimeout(() => controller.abort(), 10000);
    }
    return await requestJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        body: { message: "Context save timed out. Try again." },
      };
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

import React, { useEffect, useRef, useState, useCallback } from "react";

/**
 * Redesigned Context page.
 *
 * Fits the ChatGPT-clone shell (cream surface, near-black ink, pill buttons,
 * 760px centered column). Replaces the markdown textarea with a quiet
 * WYSIWYG editor. The historical PFT section is collapsed into a thin row.
 */

const INITIAL_HTML = `
  <h2>Stable operating context</h2>
  <ul>
    <li>Prioritize production Task Node work over old PFTasks UI cleanup.</li>
    <li>Keep normal app access account-based. Wallet unlock is only for wallet-bound actions.</li>
    <li>Prefer concrete execution tasks and concise status notes.</li>
  </ul>
  <h2>Active projects</h2>
  <ul>
    <li>Production chat runtime.</li>
    <li>Account credit and usage ledger.</li>
    <li>Seed-wallet proof, local vault unlock, and historical PFTasks context hydration.</li>
  </ul>
  <h2>Constraints</h2>
  <ul>
    <li>Do not store plaintext seed phrases server-side.</li>
    <li>Do not hydrate encrypted historical context until the local vault is unlocked.</li>
    <li>Avoid rebuilding old PFTasks surfaces wholesale.</li>
  </ul>
`;

const INITIAL_VERSIONS = [
  {
    rev: 12,
    cid: "bafybeiczzx6h3dq8nlmurzwk2pl7vncw8t9hjsbxlpqv1ctxnow",
    at: "2026-05-16T10:32:00.000Z",
    note: null,
    preview:
      "Stable operating context. Prioritize production Task Node work over old PFTasks UI cleanup; keep normal app access account-based.",
    words: 487,
  },
  {
    rev: 11,
    cid: "bafybeigdyrztm3j5qwerasdfzxcvqwerasdfctxlatest001",
    at: "2026-05-15T23:18:00.000Z",
    note: "Reorganized constraints; clarified wallet boundary",
    preview:
      "Reorganized constraints. Wallet unlock is only for wallet-bound actions; do not hydrate encrypted historical context until the local vault is unlocked.",
    words: 462,
  },
  {
    rev: 9,
    cid: "bafybeih7p4ksvk2lcqwerasdfzxcvqweradfctxprev002a",
    at: "2026-05-14T16:02:00.000Z",
    note: "Added active projects section",
    preview:
      "Active projects: production chat runtime, account credit and usage ledger, seed-wallet proof, local vault unlock, historical PFTasks context hydration.",
    words: 398,
  },
  {
    rev: 6,
    cid: "bafybeibcde7uxgnk5qwerzxcvasdfqwerasdfctxearly03",
    at: "2026-05-12T09:41:00.000Z",
    note: null,
    preview:
      "Stable operating context preferences. Prefer concrete execution tasks and concise status notes over long planning loops.",
    words: 312,
  },
  {
    rev: 3,
    cid: "bafybeiabc1zzn8plqwerzxcvasdfqwerasdfctxearly04xx",
    at: "2026-05-09T11:14:00.000Z",
    note: "Initial published context",
    preview:
      "Initial published context. Prioritize production Task Node work over old PFTasks UI cleanup; demote secondary product work.",
    words: 184,
  },
];

function formatTimestamp(value) {
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

function truncateCid(cid) {
  if (!cid) return "";
  if (cid.length <= 18) return cid;
  return `${cid.slice(0, 10)}…${cid.slice(-6)}`;
}

function formatRelativeShort(value, now) {
  if (!value) return "";
  const then = new Date(value).getTime();
  const diff = Math.max(0, now - then);
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/* ---------------- Icons ---------------- */

const IconBold = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
    <path
      d="M6 4h5.2a3.2 3.2 0 0 1 2 5.7A3.5 3.5 0 0 1 11.6 16H6V4Zm2.2 2v3.3h2.7a1.6 1.6 0 0 0 0-3.3H8.2Zm0 5.2V14h3a1.4 1.4 0 0 0 0-2.8h-3Z"
      fill="currentColor"
    />
  </svg>
);

const IconItalic = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
    <path
      d="M8 4h7v1.6h-2.5l-2.1 8.8H13V16H6v-1.6h2.5l2.1-8.8H8V4Z"
      fill="currentColor"
    />
  </svg>
);

const IconH2 = () => (
  <svg viewBox="0 0 22 16" width="18" height="14" aria-hidden="true">
    <text x="0" y="13" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="700" fill="currentColor">H</text>
    <text x="10" y="13" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fontWeight="700" fill="currentColor">2</text>
  </svg>
);

const IconH3 = () => (
  <svg viewBox="0 0 22 16" width="18" height="14" aria-hidden="true">
    <text x="0" y="13" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="700" fill="currentColor">H</text>
    <text x="10" y="13" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fontWeight="700" fill="currentColor">3</text>
  </svg>
);

const IconUL = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
    <circle cx="4" cy="6" r="1.2" fill="currentColor" />
    <circle cx="4" cy="10" r="1.2" fill="currentColor" />
    <circle cx="4" cy="14" r="1.2" fill="currentColor" />
    <rect x="8" y="5.2" width="9" height="1.6" rx="0.6" fill="currentColor" />
    <rect x="8" y="9.2" width="9" height="1.6" rx="0.6" fill="currentColor" />
    <rect x="8" y="13.2" width="9" height="1.6" rx="0.6" fill="currentColor" />
  </svg>
);

const IconOL = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
    <text x="0.5" y="7.5" fontFamily="Inter, system-ui, sans-serif" fontSize="5" fontWeight="700" fill="currentColor">1.</text>
    <text x="0.5" y="11.5" fontFamily="Inter, system-ui, sans-serif" fontSize="5" fontWeight="700" fill="currentColor">2.</text>
    <text x="0.5" y="15.5" fontFamily="Inter, system-ui, sans-serif" fontSize="5" fontWeight="700" fill="currentColor">3.</text>
    <rect x="7.5" y="5.2" width="9.5" height="1.6" rx="0.6" fill="currentColor" />
    <rect x="7.5" y="9.2" width="9.5" height="1.6" rx="0.6" fill="currentColor" />
    <rect x="7.5" y="13.2" width="9.5" height="1.6" rx="0.6" fill="currentColor" />
  </svg>
);

const IconTable = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <line x1="2" y1="6.7" x2="14" y2="6.7" stroke="currentColor" strokeWidth="1.4" />
    <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const IconCaret = () => (
  <svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true">
    <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconCopy = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="4.5" y="4.5" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const IconCheck = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconChevron = ({ open }) => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    aria-hidden="true"
    style={{ transition: "transform 160ms ease", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
  >
    <path d="M5.5 3.5L10 8l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ---------------- Toolbar ---------------- */

function ToolButton({ active, onMouseDown, title, children }) {
  return (
    <button
      type="button"
      className={`tool-btn${active ? " is-active" : ""}`}
      onMouseDown={(e) => {
        // prevent the editor from losing selection
        e.preventDefault();
        onMouseDown?.(e);
      }}
      title={title}
      aria-label={title}
      aria-pressed={active ? "true" : "false"}
    >
      {children}
    </button>
  );
}

/* ---------------- Page ---------------- */

export default function ContextPage() {
  const [title, setTitle] = useState("Task Node Context");
  const [savedTitle, setSavedTitle] = useState("Task Node Context");
  const [savedAt, setSavedAt] = useState("2026-05-16T10:32:00.000Z");
  const [revision, setRevision] = useState(12);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCid, setCopiedCid] = useState(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState(INITIAL_VERSIONS);
  const [publishing, setPublishing] = useState(false);
  const [publishedFlash, setPublishedFlash] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    h2: false,
    h3: false,
    ul: false,
    ol: false,
  });
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ r: 0, c: 0 });

  const editorRef = useRef(null);
  const initializedRef = useRef(false);
  const lastSavedHtmlRef = useRef("");
  const savedRangeRef = useRef(null);
  const tableWrapRef = useRef(null);

  // Initialize editor HTML once
  useEffect(() => {
    if (initializedRef.current) return;
    if (editorRef.current) {
      editorRef.current.innerHTML = INITIAL_HTML;
      lastSavedHtmlRef.current = editorRef.current.innerHTML;
      initializedRef.current = true;
    }
  }, []);

  const updateActiveFormats = useCallback(() => {
    if (typeof document === "undefined") return;
    try {
      const block = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      setActiveFormats({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        h2: block === "h2" || block === "<h2>",
        h3: block === "h3" || block === "<h3>",
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const handler = () => {
      if (!editorRef.current) return;
      if (document.activeElement === editorRef.current) {
        updateActiveFormats();
      }
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [updateActiveFormats]);

  const recomputeDirty = useCallback(() => {
    if (!editorRef.current) return;
    const currentHtml = editorRef.current.innerHTML;
    const isDirty = currentHtml !== lastSavedHtmlRef.current || title !== savedTitle;
    setDirty(isDirty);
  }, [title, savedTitle]);

  useEffect(() => {
    recomputeDirty();
  }, [title, recomputeDirty]);

  const saveSelection = useCallback(() => {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Only save if the selection lives inside our editor
    if (editorRef.current && editorRef.current.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const range = savedRangeRef.current;
    if (!range || !editorRef.current) return false;
    const sel = window.getSelection?.();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }, []);

  const insertTable = useCallback(
    (rows, cols) => {
      if (!editorRef.current || rows < 1 || cols < 1) return;
      editorRef.current.focus();
      const restored = restoreSelection();

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headTr = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const th = document.createElement("th");
        th.innerHTML = "<br>";
        headTr.appendChild(th);
      }
      thead.appendChild(headTr);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (let r = 1; r < rows; r++) {
        const tr = document.createElement("tr");
        for (let c = 0; c < cols; c++) {
          const td = document.createElement("td");
          td.innerHTML = "<br>";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      // Trailing paragraph so the cursor has somewhere to go after the table
      const trailing = document.createElement("p");
      trailing.innerHTML = "<br>";

      if (restored && savedRangeRef.current) {
        const range = savedRangeRef.current;
        range.deleteContents();
        range.insertNode(trailing);
        range.insertNode(table);
        // Move cursor into the first header cell
        const firstCell = table.querySelector("th, td");
        if (firstCell) {
          const newRange = document.createRange();
          newRange.selectNodeContents(firstCell);
          newRange.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
      } else {
        editorRef.current.appendChild(table);
        editorRef.current.appendChild(trailing);
      }
      recomputeDirty();
    },
    [restoreSelection, recomputeDirty]
  );

  // Close the picker on outside click or Escape
  useEffect(() => {
    if (!tablePickerOpen) return;
    const onDown = (e) => {
      if (!tableWrapRef.current) return;
      if (!tableWrapRef.current.contains(e.target)) {
        setTablePickerOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setTablePickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tablePickerOpen]);

  const focusEditor = () => {
    editorRef.current?.focus();
  };

  const exec = (cmd, value = null) => {
    focusEditor();
    document.execCommand(cmd, false, value);
    updateActiveFormats();
    recomputeDirty();
  };

  const toggleHeading = (level) => {
    focusEditor();
    const block = (document.queryCommandValue("formatBlock") || "").toLowerCase();
    const target = `h${level}`;
    if (block === target || block === `<${target}>`) {
      // toggle off → revert to paragraph
      document.execCommand("formatBlock", false, "<p>");
    } else {
      document.execCommand("formatBlock", false, `<${target}>`);
    }
    updateActiveFormats();
    recomputeDirty();
  };

  const handleEditorInput = () => {
    recomputeDirty();
  };

  const handleEditorKeyDown = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      exec("bold");
    } else if (k === "i") {
      e.preventDefault();
      exec("italic");
    }
  };

  const handleEditorPaste = (e) => {
    // Force plain-text paste so we don't import alien styles
    const text = e.clipboardData?.getData("text/plain");
    if (text != null) {
      e.preventDefault();
      document.execCommand("insertText", false, text);
      recomputeDirty();
    }
  };

  const handleSave = useCallback(async () => {
    if (saving) return;
    if (!dirty) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 380));
    lastSavedHtmlRef.current = editorRef.current?.innerHTML || "";
    setSavedTitle(title);
    setSavedAt(new Date().toISOString());
    setRevision((r) => r + 1);
    setDirty(false);
    setSaving(false);
  }, [saving, dirty, title]);

  // Autosave: debounce 900ms after the last edit
  useEffect(() => {
    if (!dirty || saving) return;
    const t = setTimeout(() => {
      handleSave();
    }, 900);
    return () => clearTimeout(t);
  }, [dirty, saving, handleSave]);

  // Relative-time ticker for the "saved Xs ago" indicator
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  const handleCopy = async () => {
    if (!editorRef.current) return;
    const text = editorRef.current.innerText.trim();
    const composed = `${title}\n\n${text}`;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(composed);
      } else {
        const ta = document.createElement("textarea");
        ta.value = composed;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const handleCopyCid = async (cid) => {
    if (!cid) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(cid);
      } else {
        const ta = document.createElement("textarea");
        ta.value = cid;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedCid(cid);
      setTimeout(() => {
        setCopiedCid((c) => (c === cid ? null : c));
      }, 1600);
    } catch {
      /* ignore */
    }
  };

  const handlePublish = async () => {
    if (publishing) return;
    if (dirty) await handleSave();
    setPublishing(true);
    await new Promise((r) => setTimeout(r, 720));

    const text = editorRef.current?.innerText?.trim() || "";
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const preview = text.replace(/\s+/g, " ").slice(0, 220);

    const newCid =
      "bafybei" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10) +
      "pubnew";
    setVersions((vs) => [
      {
        rev: revision,
        cid: newCid,
        at: new Date().toISOString(),
        note: "Published from editor",
        preview,
        words,
      },
      ...vs,
    ]);
    setPublishing(false);
    setPublishedFlash(true);
    setTimeout(() => setPublishedFlash(false), 2200);
  };

  const handleRestoreVersion = (v) => {
    if (!editorRef.current) return;
    // Mock: just append a marker block so the user sees an effect; real impl
    // would fetch + decrypt the CID and replace the doc body.
    const note = document.createElement("div");
    note.innerHTML = `<h2>Restored from Rev ${v.rev}</h2><p><em>(${truncateCid(v.cid)})</em></p>`;
    editorRef.current.insertBefore(note, editorRef.current.firstChild);
    recomputeDirty();
    setVersionsOpen(false);
  };

  const statusText = (() => {
    if (publishing) return "Publishing to PFT…";
    if (publishedFlash) return "Published to PFT";
    if (saving) return "Saving…";
    if (dirty) return "Editing…";
    return `Saved ${formatRelativeShort(savedAt, now)}`;
  })();

  return (
    <main className="ctx-shell">
      <style>{styles}</style>

      {/* Faux ChatGPT-clone toolbar (kept minimal for context) */}
      <div className="ctx-topbar">
        <span className="ctx-topbar-title">Context</span>
      </div>

      <div className="ctx-scroll">
        <div className="ctx-page">
          {/* Document card — fills available height */}
          <section className="ctx-card" aria-label="Context document">
            <div className="ctx-toolbar" role="toolbar" aria-label="Formatting">
              <div className="ctx-toolbar-group">
                <ToolButton active={activeFormats.h2} onMouseDown={() => toggleHeading(2)} title="Heading">
                  <IconH2 />
                </ToolButton>
                <ToolButton active={activeFormats.h3} onMouseDown={() => toggleHeading(3)} title="Subheading">
                  <IconH3 />
                </ToolButton>
              </div>
              <span className="ctx-toolbar-sep" />
              <div className="ctx-toolbar-group">
                <ToolButton active={activeFormats.bold} onMouseDown={() => exec("bold")} title="Bold (⌘B)">
                  <IconBold />
                </ToolButton>
                <ToolButton active={activeFormats.italic} onMouseDown={() => exec("italic")} title="Italic (⌘I)">
                  <IconItalic />
                </ToolButton>
              </div>
              <span className="ctx-toolbar-sep" />
              <div className="ctx-toolbar-group">
                <ToolButton active={activeFormats.ul} onMouseDown={() => exec("insertUnorderedList")} title="Bulleted list">
                  <IconUL />
                </ToolButton>
                <ToolButton active={activeFormats.ol} onMouseDown={() => exec("insertOrderedList")} title="Numbered list">
                  <IconOL />
                </ToolButton>
              </div>
              <span className="ctx-toolbar-sep" />
              <div className="ctx-toolbar-group ctx-table-wrap" ref={tableWrapRef}>
                <button
                  type="button"
                  className={`tool-btn tool-btn-combo${tablePickerOpen ? " is-active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!tablePickerOpen) saveSelection();
                    setTablePickerOpen((v) => !v);
                    setTableHover({ r: 0, c: 0 });
                  }}
                  title="Insert table"
                  aria-label="Insert table"
                  aria-haspopup="dialog"
                  aria-expanded={tablePickerOpen ? "true" : "false"}
                >
                  <IconTable />
                  <IconCaret />
                </button>
                {tablePickerOpen && (
                  <div className="ctx-table-picker" role="dialog" aria-label="Insert table">
                    <div
                      className="ctx-table-grid"
                      onMouseLeave={() => setTableHover({ r: 0, c: 0 })}
                    >
                      {Array.from({ length: 8 }).map((_, r) => (
                        <div key={r} className="ctx-table-row">
                          {Array.from({ length: 8 }).map((__, c) => {
                            const active = r < tableHover.r && c < tableHover.c;
                            return (
                              <button
                                key={c}
                                type="button"
                                className={`ctx-table-cell${active ? " is-active" : ""}`}
                                onMouseEnter={() => setTableHover({ r: r + 1, c: c + 1 })}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  insertTable(r + 1, c + 1);
                                  setTablePickerOpen(false);
                                  setTableHover({ r: 0, c: 0 });
                                }}
                                aria-label={`Insert ${r + 1} by ${c + 1} table`}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    <div className="ctx-table-readout">
                      {tableHover.r > 0
                        ? `${tableHover.r} × ${tableHover.c}`
                        : "Insert table"}
                    </div>
                  </div>
                )}
              </div>

              <div className="ctx-toolbar-spacer" />

              <button type="button" className="ctx-tool-text" onClick={handleCopy}>
                {copied ? <IconCheck /> : <IconCopy />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>

            <div className="ctx-writing-surface">
              <input
                type="text"
                className="ctx-title-input"
                value={title}
                maxLength={120}
                placeholder="Untitled context"
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Document title"
              />

              <div
                ref={editorRef}
                className="ctx-editor"
                contentEditable
                suppressContentEditableWarning
                spellCheck
                role="textbox"
                aria-multiline="true"
                aria-label="Context document body"
                onInput={handleEditorInput}
                onKeyDown={handleEditorKeyDown}
                onPaste={handleEditorPaste}
                onFocus={updateActiveFormats}
                onClick={updateActiveFormats}
                onKeyUp={updateActiveFormats}
              />
            </div>

            <footer className="ctx-card-foot">
              <span
                className={`ctx-status${dirty ? " is-dirty" : ""}${
                  saving || publishing ? " is-saving" : ""
                }${publishedFlash ? " is-published" : ""}`}
              >
                <span className="ctx-status-dot" aria-hidden="true" />
                {statusText}
              </span>

              <div className="ctx-foot-actions">
                <button
                  type="button"
                  className={`ctx-ghost${versionsOpen ? " is-active" : ""}`}
                  onClick={() => setVersionsOpen((v) => !v)}
                  aria-expanded={versionsOpen ? "true" : "false"}
                >
                  Versions
                  <span className="ctx-ghost-count">{versions.length}</span>
                </button>
                <span className="ctx-tip">
                  <button
                    type="button"
                    className="ctx-ghost ctx-ghost-accent"
                    onClick={handlePublish}
                    disabled={publishing}
                    aria-describedby="ctx-publish-tip"
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path d="M8 13V3M8 3L4 7M8 3l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {publishing ? "Publishing…" : "Publish to PFT"}
                  </button>
                  <span className="ctx-tip-card" role="tooltip" id="ctx-publish-tip">
                    <span className="ctx-tip-line">
                      Burns a small amount of <strong>PFT</strong> and pins this context to <strong>IPFS</strong>.
                    </span>
                    <span className="ctx-tip-sub">
                      Lets you read or sync the doc from any device using its CID.
                    </span>
                  </span>
                </span>
              </div>
            </footer>
          </section>

          {/* Versions panel — inline, only when opened */}
          {versionsOpen && (
            <section className="ctx-versions" aria-label="Published versions">
              <header className="ctx-versions-head">
                <div>
                  <span className="ctx-versions-title">Revision history</span>
                  <span className="ctx-versions-sub">Each publish writes an immutable snapshot to IPFS.</span>
                </div>
                <span className="ctx-versions-count">{versions.length} versions</span>
              </header>
              <ol className="ctx-versions-list">
                {versions.map((v, i) => {
                  const isCurrent = i === 0;
                  const isCidCopied = copiedCid === v.cid;
                  return (
                    <li key={v.cid} className={`ctx-version${isCurrent ? " is-current" : ""}`}>
                      <div className="ctx-version-marker" aria-hidden="true">
                        <span className="ctx-version-dot" />
                        {i < versions.length - 1 && <span className="ctx-version-line" />}
                      </div>
                      <div className="ctx-version-body">
                        <div className="ctx-version-top">
                          <span className="ctx-version-rev">Rev {v.rev}</span>
                          <span className="ctx-version-meta">{formatTimestamp(v.at)}</span>
                          <span className="ctx-version-meta ctx-version-words">{v.words} words</span>
                          <span className="ctx-version-spacer" />
                          {isCurrent ? (
                            <span className="ctx-version-current">
                              <span className="ctx-version-current-dot" aria-hidden="true" />
                              Current
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="ctx-version-restore"
                              onClick={() => handleRestoreVersion(v)}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                        {v.preview && <p className="ctx-version-preview">{v.preview}</p>}
                        <div className="ctx-version-foot">
                          <code className="ctx-version-cid" title={v.cid}>{truncateCid(v.cid)}</code>
                          <button
                            type="button"
                            className="ctx-version-copy"
                            onClick={() => handleCopyCid(v.cid)}
                            aria-label={isCidCopied ? "Copied CID" : "Copy CID"}
                            title={isCidCopied ? "Copied" : "Copy CID"}
                          >
                            {isCidCopied ? <IconCheck /> : <IconCopy />}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

const styles = `
  :root {
    --bg: #f7f5ee;
    --surface: #ffffff;
    --surface-2: #faf9f6;
    --surface-3: #f4f3ee;
    --border: #e8e6df;
    --border-strong: #d9d6cc;
    --ink: #0d0d0d;
    --ink-2: #4b4b46;
    --ink-3: #6b6b66;
    --accent: #0d0d0d;
    --ok: #047857;
    --warn: #b45309;
    --shadow: 0 1px 0 rgba(13,13,13,0.03), 0 8px 24px -16px rgba(13,13,13,0.08);
    --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  button, input, textarea {
    font: inherit;
    color: inherit;
  }

  .ctx-shell {
    min-height: 100vh;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }

  .ctx-topbar {
    height: 52px;
    display: flex;
    align-items: center;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: rgba(247, 245, 238, 0.85);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .ctx-topbar-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.005em;
  }

  .ctx-scroll {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .ctx-page {
    width: min(820px, 100%);
    margin: 0 auto;
    padding: 16px 28px 28px;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Card fills available height; editor expands inside it */

  .ctx-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .ctx-title-row { display: none; } /* legacy, kept harmless */

  .ctx-writing-surface {
    background: var(--surface);
    padding: 28px 36px 36px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .ctx-title-input {
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--ink);
    padding: 0 0 6px;
    margin: 0 0 14px;
    display: block;
  }
  .ctx-title-input::placeholder {
    color: #b5b1a4;
    font-weight: 600;
  }
  .ctx-title-input:focus { outline: 0; }

  /* Toolbar — sits at the top of the card as its chrome */

  .ctx-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .ctx-toolbar-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .ctx-toolbar-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 6px;
  }

  .ctx-toolbar-spacer {
    flex: 1;
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    padding: 0;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .tool-btn:hover {
    background: rgba(13, 13, 13, 0.05);
    color: var(--ink);
  }
  .tool-btn.is-active {
    background: var(--surface);
    color: var(--ink);
    border-color: var(--border);
    box-shadow: 0 1px 0 rgba(13,13,13,0.03);
  }
  .tool-btn:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  .tool-btn-combo {
    width: auto;
    padding: 0 7px;
    gap: 4px;
  }
  .tool-btn-combo svg + svg { opacity: 0.55; }

  /* Table picker dropdown */

  .ctx-table-wrap { position: relative; }

  .ctx-table-picker {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 30;
    padding: 10px 10px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 16px 32px -18px rgba(0,0,0,0.30), 0 2px 6px rgba(0,0,0,0.04);
    animation: slideDown 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .ctx-table-grid {
    display: grid;
    gap: 3px;
  }
  .ctx-table-row {
    display: grid;
    grid-template-columns: repeat(8, 16px);
    gap: 3px;
  }
  .ctx-table-cell {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--surface);
    cursor: pointer;
    transition: background 80ms ease, border-color 80ms ease, transform 80ms ease;
  }
  .ctx-table-cell:hover { border-color: var(--border-strong); }
  .ctx-table-cell.is-active {
    background: var(--ink);
    border-color: var(--ink);
  }
  .ctx-table-readout {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: 11.5px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  /* In-editor table styling */

  .ctx-editor table {
    border-collapse: collapse;
    width: 100%;
    margin: 14px 0 16px;
    font-size: 13.5px;
    table-layout: fixed;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .ctx-editor th,
  .ctx-editor td {
    border: 1px solid var(--border);
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
    min-width: 60px;
    line-height: 1.5;
    word-break: break-word;
  }
  .ctx-editor th {
    background: var(--surface-2);
    font-weight: 600;
    color: var(--ink);
    font-size: 12.5px;
    letter-spacing: -0.005em;
  }
  .ctx-editor td:focus,
  .ctx-editor th:focus {
    outline: 2px solid rgba(13, 13, 13, 0.16);
    outline-offset: -2px;
  }

  .ctx-tool-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--ink-2);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .ctx-tool-text:hover {
    color: var(--ink);
    border-color: var(--border-strong);
  }

  /* Editor */

  .ctx-editor {
    min-height: 0;
    flex: 1;
    padding: 0;
    outline: 0;
    font-size: 14.5px;
    line-height: 1.62;
    color: var(--ink);
    caret-color: var(--ink);
  }
  .ctx-editor:focus { outline: 0; }
  .ctx-editor[contenteditable="true"]:empty::before {
    content: attr(data-placeholder);
    color: #b5b1a4;
  }

  .ctx-editor h1,
  .ctx-editor h2,
  .ctx-editor h3 {
    color: var(--ink);
    margin: 22px 0 8px;
    line-height: 1.25;
    letter-spacing: -0.012em;
  }
  .ctx-editor h1 { font-size: 22px; font-weight: 600; }
  .ctx-editor h2 { font-size: 16.5px; font-weight: 600; }
  .ctx-editor h3 { font-size: 14px; font-weight: 600; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.04em; }
  .ctx-editor h2:first-child,
  .ctx-editor h3:first-child,
  .ctx-editor h1:first-child { margin-top: 0; }

  .ctx-editor p { margin: 0 0 12px; }
  .ctx-editor p:last-child { margin-bottom: 0; }

  .ctx-editor ul,
  .ctx-editor ol {
    margin: 8px 0 14px;
    padding-left: 22px;
  }
  .ctx-editor li {
    margin: 4px 0;
  }
  .ctx-editor li::marker {
    color: var(--ink-3);
  }

  .ctx-editor strong { font-weight: 600; color: var(--ink); }
  .ctx-editor em { font-style: italic; }

  .ctx-editor a {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
  }

  /* Card footer */

  .ctx-card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }

  .ctx-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--ink-3);
  }
  .ctx-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #c9c7bd;
    transition: background 160ms ease;
  }
  .ctx-status.is-dirty .ctx-status-dot { background: #d4a437; }
  .ctx-status.is-saving .ctx-status-dot { background: var(--ink); animation: pulse 1.1s ease-in-out infinite; }
  .ctx-status.is-published { color: var(--ok); }
  .ctx-status.is-published .ctx-status-dot { background: var(--ok); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* Footer ghost actions (Versions, Publish) */

  .ctx-foot-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .ctx-ghost {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ink-2);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .ctx-ghost:hover:not(:disabled) {
    background: rgba(13,13,13,0.05);
    color: var(--ink);
  }
  .ctx-ghost.is-active {
    background: var(--surface);
    color: var(--ink);
    border-color: var(--border);
  }
  .ctx-ghost:disabled { opacity: 0.45; cursor: default; }

  .ctx-ghost-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: rgba(13,13,13,0.06);
    color: var(--ink-3);
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
  }

  .ctx-ghost-accent {
    color: var(--ink);
  }
  .ctx-ghost-accent:hover:not(:disabled) {
    background: var(--ink);
    color: #fff;
    border-color: var(--ink);
  }
  .ctx-ghost-accent svg { transition: transform 200ms ease; }
  .ctx-ghost-accent:hover:not(:disabled) svg { transform: translateY(-1px); }

  /* Tooltip (CSS-only, hover/focus reveal) */

  .ctx-tip {
    position: relative;
    display: inline-flex;
  }
  .ctx-tip-card {
    position: absolute;
    bottom: calc(100% + 10px);
    right: 0;
    width: max-content;
    max-width: 280px;
    padding: 10px 12px;
    background: #1c1c1a;
    color: #efece3;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    box-shadow: 0 12px 28px -14px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.08);
    font-size: 12px;
    line-height: 1.5;
    text-align: left;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transform: translateY(3px);
    transition: opacity 140ms ease, transform 140ms ease, visibility 140ms ease;
    z-index: 20;
  }
  .ctx-tip-card::after {
    content: "";
    position: absolute;
    bottom: -4px;
    right: 22px;
    width: 8px;
    height: 8px;
    background: #1c1c1a;
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    transform: rotate(45deg);
  }
  .ctx-tip:hover .ctx-tip-card,
  .ctx-tip:focus-within .ctx-tip-card {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
    transition-delay: 180ms;
  }
  .ctx-tip-line {
    display: block;
    color: #efece3;
  }
  .ctx-tip-line strong {
    color: #ffffff;
    font-weight: 600;
  }
  .ctx-tip-sub {
    display: block;
    margin-top: 4px;
    color: rgba(239, 236, 227, 0.62);
    font-size: 11.5px;
    line-height: 1.45;
  }

  /* Versions timeline (inline below the card when toggled) */

  .ctx-versions {
    margin-top: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    animation: slideDown 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .ctx-versions-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .ctx-versions-head > div {
    display: grid;
    gap: 3px;
  }
  .ctx-versions-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.005em;
  }
  .ctx-versions-sub {
    font-size: 12px;
    color: var(--ink-3);
    line-height: 1.4;
  }
  .ctx-versions-count {
    font-size: 11.5px;
    color: var(--ink-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 10px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .ctx-versions-list {
    list-style: none;
    margin: 0;
    padding: 4px 20px 16px;
  }

  .ctx-version {
    display: grid;
    grid-template-columns: 14px 1fr;
    gap: 12px;
    padding: 14px 0;
  }
  .ctx-version + .ctx-version {
    border-top: 1px solid var(--border);
  }
  .ctx-version-marker {
    position: relative;
    padding-top: 6px;
    display: flex;
    justify-content: center;
  }
  .ctx-version-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--border-strong);
    z-index: 1;
  }
  .ctx-version.is-current .ctx-version-dot {
    background: var(--ok);
    box-shadow: 0 0 0 3px rgba(4, 120, 87, 0.12);
  }
  .ctx-version-line {
    position: absolute;
    top: 16px;
    bottom: -14px;
    left: 50%;
    width: 1px;
    background: var(--border);
    transform: translateX(-50%);
  }
  .ctx-version-body {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .ctx-version-top {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ctx-version-rev {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.005em;
  }
  .ctx-version-meta {
    font-size: 12.5px;
    color: var(--ink-3);
    line-height: 1;
  }
  .ctx-version-meta + .ctx-version-meta::before {
    content: "·";
    margin-right: 8px;
    color: #c9c7bd;
  }
  .ctx-version-rev + .ctx-version-meta::before {
    content: "·";
    margin-right: 8px;
    color: #c9c7bd;
  }
  .ctx-version-words {
    font-variant-numeric: tabular-nums;
  }
  .ctx-version-spacer { flex: 1; }

  .ctx-version-current {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 10px;
    border-radius: 999px;
    background: rgba(4, 120, 87, 0.08);
    color: var(--ok);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .ctx-version-current-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--ok);
  }

  .ctx-version-restore {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--ink-2);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .ctx-version-restore:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
    color: var(--ink);
  }

  .ctx-version-preview {
    margin: 0;
    font-size: 13px;
    color: var(--ink-2);
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
  }

  .ctx-version-foot {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ctx-version-cid {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--ink-3);
    background: var(--surface-2);
    padding: 3px 8px;
    border-radius: 6px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctx-version-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    border-radius: 6px;
    color: var(--ink-3);
    cursor: pointer;
    transition: background 100ms ease, color 100ms ease;
  }
  .ctx-version-copy:hover {
    background: rgba(13, 13, 13, 0.06);
    color: var(--ink);
  }
  .ctx-version-copy:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  /* Selection */
  .ctx-editor ::selection {
    background: rgba(13, 13, 13, 0.10);
  }

  /* Responsive */

  @media (max-width: 700px) {
    .ctx-page { padding: 12px 16px 16px; }
    .ctx-writing-surface { padding: 22px 22px 28px; }
    .ctx-card-foot {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }
    .ctx-foot-actions {
      width: 100%;
      justify-content: space-between;
    }
    .ctx-version-cid { max-width: 160px; }
  }
`;
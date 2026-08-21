import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Bold, Check, ChevronDown, Copy, Database, Hash, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Lock, Table, Unlock, X } from "lucide-react";
import { ContextToolButton, contextWordCount, stripContextHtml, truncateCid } from "./context-view-utils.jsx";
import { sanitizeContextHtml } from "../../../shared/context-html";
import { contextBodyText, contextLineCount as countContextLines } from "../../../shared/context-line-map.js";
import { CONTEXT_DOCUMENT_MAX_CHARS, contextBudgetMetrics, TASKGEN_CONTEXT_MAX_CHARS } from "../../../shared/context-budget.js";
import { walletVaultDisplayState } from "../wallet/wallet-state";
import { buildContextVersions, contextBodyToHtml, contextEditorLineRows, contextPreviewText, editorSelectionRange, formatContextTimestamp, formatRelativeShort, refreshContextStateAfterSave, requestContextSaveJson } from "./context-view-state.js";

export function ContextView({ context, linkedWalletAddress = "", onContextChange, onHydrateContext, onPublishContext, walletVault }) {
  const initialDocument = context?.document || {};
  const savePath = context?.savePath || initialDocument.savePath || "/api/context/edit/save";
  const history = useMemo(() => context?.history || {}, [context?.history]);
  const [documentState, setDocumentState] = useState(initialDocument);
  const [title, setTitle] = useState(initialDocument.title || "Task Node Context");
  const [savedTitle, setSavedTitle] = useState(initialDocument.title || "Task Node Context");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [contextBudgetHtml, setContextBudgetHtml] = useState(() =>
    contextBodyToHtml(initialDocument.body || "")
  );
  const [contextLineCount, setContextLineCount] = useState(() =>
    countContextLines(contextBodyToHtml(initialDocument.body || ""))
  );
  const [contextLineRows, setContextLineRows] = useState([]);
  const [copied, setCopied] = useState(false);
  const [copiedCid, setCopiedCid] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    h1: false,
    h2: false,
    h3: false,
    ul: false,
    ol: false,
  });
  const [lineNumbersVisible, setLineNumbersVisible] = useState(() => {
    try {
      return window.localStorage?.getItem("tasknode.context.lineNumbers") !== "hidden";
    } catch {
      return true;
    }
  });
  const [contextBudgetOpen, setContextBudgetOpen] = useState(() => {
    try {
      return window.localStorage?.getItem("tasknode.context.taskgenBudget") === "open";
    } catch {
      return false;
    }
  });
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ rows: 0, cols: 0 });
  const [tablePickerPosition, setTablePickerPosition] = useState({ top: 0, left: 0 });
  const [hydratedContext, setHydratedContext] = useState(null);
  const [hydratedPreviewByCid, setHydratedPreviewByCid] = useState({});
  const [previewStateByCid, setPreviewStateByCid] = useState({});
  const [restoringVersionKey, setRestoringVersionKey] = useState("");
  const [previewHydration, setPreviewHydration] = useState({
    active: false,
    loaded: 0,
    total: 0,
    error: "",
  });
  const [hydrateMessage, setHydrateMessage] = useState("");
  const editorRef = useRef(null);
  const savedRangeRef = useRef(null);
  const tableWrapRef = useRef(null);
  const previewHydrationRunRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveContextRef = useRef(async () => false);
  const titleRef = useRef(initialDocument.title || "Task Node Context");
  const lastSavedHtmlRef = useRef(contextBodyToHtml(initialDocument.body || ""));
  const latestContextDocumentRef = useRef({
    id: initialDocument.id || "",
    revision: Number(initialDocument.revision || 0),
  });

  const refreshContextLineRows = useCallback((fallbackLineCount = 1) => {
    window.requestAnimationFrame(() => {
      const rows = contextEditorLineRows(editorRef.current);
      const lineCount = Math.max(1, Number(fallbackLineCount) || 1);
      setContextLineRows(rows.length ? rows : Array.from({ length: lineCount }, (_, index) => ({
        number: index + 1,
        top: index * 24,
      })));
    });
  }, []);

  useEffect(() => {
    const nextDocument = context?.document || {};
    const nextDocumentId = nextDocument.id || "";
    const nextRevision = Number(nextDocument.revision || 0);
    const latestDocument = latestContextDocumentRef.current || {};
    if (
      nextDocumentId &&
      latestDocument.id === nextDocumentId &&
      nextRevision < Number(latestDocument.revision || 0)
    ) {
      return;
    }

    const nextTitle = nextDocument.title || "Task Node Context";
    const nextHtml = contextBodyToHtml(nextDocument.body || "");
    const preserveLocalDraft = dirtyRef.current;
    latestContextDocumentRef.current = { id: nextDocumentId, revision: nextRevision };
    setDocumentState(nextDocument);
    setSavedTitle(nextTitle);
    lastSavedHtmlRef.current = nextHtml;
    if (!preserveLocalDraft) {
      setTitle(nextTitle);
      titleRef.current = nextTitle;
      if (editorRef.current) editorRef.current.innerHTML = nextHtml;
      setContextBudgetHtml(nextHtml);
      const nextLineCount = countContextLines(nextHtml);
      setContextLineCount(nextLineCount);
      refreshContextLineRows(nextLineCount);
      setDirty(false);
      setSaveMessage("");
    }
  }, [context?.document, refreshContextLineRows]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    setHydratedContext(null);
    setHydrateMessage("");
    setRestoringVersionKey("");
    setHydratedPreviewByCid({});
    setPreviewStateByCid({});
  }, [history?.revision, history?.latestContextPointer?.cid, linkedWalletAddress]);

  const canEdit = Boolean(documentState.canEdit);
  const activeWalletAddress = String(linkedWalletAddress || "").trim();
  const historyWalletAddress = String(history?.walletAddress || "").trim();
  const walletHistoryActive = Boolean(activeWalletAddress && historyWalletAddress && historyWalletAddress === activeWalletAddress);
  const visibleHistory = useMemo(() => walletHistoryActive ? history : {}, [history, walletHistoryActive]);
  const versions = useMemo(() => buildContextVersions(documentState, visibleHistory), [documentState, visibleHistory]);
  const historyPreviewTargets = useMemo(() => versions
    .filter((version) => version.pointer?.cid)
    .map((version) => ({
      key: version.key,
      cid: String(version.pointer.cid || "").trim(),
      pointer: version.pointer,
    }))
    .filter((version) => version.cid), [versions]);
  const historyPreviewTargetKey = historyPreviewTargets.map((version) => `${version.key}:${version.cid}`).join("|");
  const manifestAction = (context?.actions || []).find((action) => action.id === "ink_manifest");
  const vaultDisplay = walletVaultDisplayState(walletVault, linkedWalletAddress);
  const restoringAnyVersion = Boolean(restoringVersionKey);
  const previewedHistoryCount = historyPreviewTargets.filter((version) => hydratedPreviewByCid[version.cid]?.text).length;
  const historyPreviewTotal = historyPreviewTargets.length;
  const historyPointerCount = walletHistoryActive ? Number(history?.pointerCount || 0) : 0;
  const historySync = walletHistoryActive ? history?.sync || {} : {};
  const historySyncLabel = !activeWalletAddress
    ? ""
    : historySync.status === "error"
      ? "Sync issue"
      : historySync.archiveComplete
        ? "Archive synced"
        : historySync.status === "ready"
          ? "Cache synced"
          : "Syncing history";
  const historySubtitle = !activeWalletAddress
    ? "Current account context is available without a wallet. Wallet history appears after linking."
    : historyPointerCount
      ? `${historyPointerCount} cached wallet pointer${historyPointerCount === 1 ? "" : "s"} available.`
      : "No cached PFTL context pointers for the linked wallet yet.";
  const contextBudget = contextBudgetMetrics(contextBodyText(contextBudgetHtml), {
    maxChars: TASKGEN_CONTEXT_MAX_CHARS,
  });
  const contextBudgetTone = contextBudget.clipped
    ? "danger"
    : contextBudget.usagePercent >= 90
      ? "warn"
      : "ok";
  const contextBudgetPercentLabel = `${contextBudget.usagePercent.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}%`;
  const contextBudgetIncludedLabel = contextBudget.includedChars.toLocaleString();
  const contextBudgetMaxLabel = contextBudget.maxChars.toLocaleString();
  const contextBudgetRemainingLabel = Math.max(0, contextBudget.maxChars - contextBudget.sourceChars).toLocaleString();
  const contextBudgetOmittedLabel = contextBudget.omittedChars.toLocaleString();

  const recomputeDirty = useCallback(() => {
    const currentHtml = editorRef.current?.innerHTML || "";
    setDirty(currentHtml !== lastSavedHtmlRef.current || title !== savedTitle);
  }, [title, savedTitle]);

  useEffect(() => {
    recomputeDirty();
  }, [recomputeDirty]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, []);

  const updateActiveFormats = useCallback(() => {
    try {
      const block = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      setActiveFormats({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        h1: block === "h1" || block === "<h1>",
        h2: block === "h2" || block === "<h2>",
        h3: block === "h3" || block === "<h3>",
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      });
    } catch {
      // Selection state is best-effort editor chrome.
    }
  }, []);

  useEffect(() => {
    function handleSelectionChange() {
      if (document.activeElement === editorRef.current) updateActiveFormats();
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [updateActiveFormats]);

  useEffect(() => {
    try {
      window.localStorage?.setItem("tasknode.context.lineNumbers", lineNumbersVisible ? "visible" : "hidden");
    } catch {
      // Local display preference only.
    }
  }, [lineNumbersVisible]);

  useEffect(() => {
    try {
      window.localStorage?.setItem("tasknode.context.taskgenBudget", contextBudgetOpen ? "open" : "closed");
    } catch {
      // Local display preference only.
    }
  }, [contextBudgetOpen]);

  const updateTablePickerPosition = useCallback(() => {
    const anchor = tableWrapRef.current;
    if (!anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const pickerWidth = 182;
    const margin = 8;
    setTablePickerPosition({
      top: Math.round(rect.bottom + 8),
      left: Math.max(margin, Math.min(Math.round(rect.left), Math.max(margin, viewportWidth - pickerWidth - margin))),
    });
  }, []);

  useEffect(() => {
    if (!tablePickerOpen) return undefined;
    updateTablePickerPosition();

    function handleMouseDown(event) {
      if (tableWrapRef.current && !tableWrapRef.current.contains(event.target)) {
        setTablePickerOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setTablePickerOpen(false);
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateTablePickerPosition);
    window.addEventListener("scroll", updateTablePickerPosition, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateTablePickerPosition);
      window.removeEventListener("scroll", updateTablePickerPosition, true);
    };
  }, [tablePickerOpen, updateTablePickerPosition]);

  const saveSelection = useCallback(() => {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || !editorRef.current) return;
    const range = selection.getRangeAt(0);
    if (editorRef.current.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const range = savedRangeRef.current;
    const selection = window.getSelection?.();
    if (!range || !selection || !editorRef.current) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  const exec = useCallback(
    (command, value = null) => {
      if (!canEdit) return;
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      updateActiveFormats();
      recomputeDirty();
    },
    [canEdit, recomputeDirty, updateActiveFormats]
  );

  const toggleHeading = useCallback(
    (level) => {
      if (!canEdit) return;
      editorRef.current?.focus();
      const block = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      const target = `h${level}`;
      document.execCommand(
        "formatBlock",
        false,
        block === target || block === `<${target}>` ? "<p>" : `<${target}>`
      );
      updateActiveFormats();
      recomputeDirty();
    },
    [canEdit, recomputeDirty, updateActiveFormats]
  );

  const insertTable = useCallback(
    (rows, cols) => {
      if (!canEdit || !editorRef.current || rows < 1 || cols < 1) return;
      editorRef.current.focus();
      const restored = restoreSelection();
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");

      for (let col = 0; col < cols; col += 1) {
        const th = document.createElement("th");
        th.innerHTML = "<br>";
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (let row = 1; row < rows; row += 1) {
        const tr = document.createElement("tr");
        for (let col = 0; col < cols; col += 1) {
          const td = document.createElement("td");
          td.innerHTML = "<br>";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      const trailing = document.createElement("p");
      trailing.innerHTML = "<br>";

      if (restored && savedRangeRef.current) {
        const range = savedRangeRef.current;
        range.deleteContents();
        range.insertNode(trailing);
        range.insertNode(table);
      } else {
        editorRef.current.appendChild(table);
        editorRef.current.appendChild(trailing);
      }
      setContextBudgetHtml(editorRef.current.innerHTML || "");
      recomputeDirty();
    },
    [canEdit, recomputeDirty, restoreSelection]
  );

  const saveContext = useCallback(async () => {
    if (!canEdit || savingRef.current || !editorRef.current) return false;

    savingRef.current = true;
    setSaving(true);
    setSaveMessage("");
    const body = sanitizeContextHtml(editorRef.current.innerHTML);
    const requestTitle = titleRef.current;

    let result;
    try {
      result = await requestContextSaveJson(savePath, { title: requestTitle, body });
    } catch {
      setSaveMessage("Context could not be saved.");
      savingRef.current = false;
      setSaving(false);
      return false;
    }

    if (!result.ok || !result.body?.document) {
      setSaveMessage(result.body?.message || "Context could not be saved.");
      savingRef.current = false;
      setSaving(false);
      return false;
    }

    const savedDocument = result.body.document;
    let refreshedState = null;
    try {
      refreshedState = await refreshContextStateAfterSave(onContextChange);
    } catch {
      refreshedState = null;
    }
    const refreshedDocument = refreshedState?.context?.document;
    const durableDocument =
      refreshedDocument?.id === savedDocument.id &&
      Number(refreshedDocument.revision || 0) >= Number(savedDocument.revision || 0)
        ? refreshedDocument
        : savedDocument;
    const currentBody = sanitizeContextHtml(editorRef.current?.innerHTML || "");
    const currentTitle = titleRef.current;
    const continuedEditing = currentBody !== body || currentTitle !== requestTitle;
    setContextBudgetHtml(currentBody || contextBodyToHtml(durableDocument.body || ""));

    setDocumentState(durableDocument);
    latestContextDocumentRef.current = {
      id: durableDocument.id || "",
      revision: Number(durableDocument.revision || 0),
    };
    setSavedTitle(durableDocument.title || "Task Node Context");
    lastSavedHtmlRef.current = contextBodyToHtml(durableDocument.body || "");
    if (continuedEditing) {
      dirtyRef.current = true;
      setDirty(true);
    } else {
      setTitle(durableDocument.title || "Task Node Context");
      titleRef.current = durableDocument.title || "Task Node Context";
      setSaveMessage("Saved just now");
      dirtyRef.current = false;
      setDirty(false);
    }
    savingRef.current = false;
    setSaving(false);
    return true;
  }, [canEdit, onContextChange, savePath]);

  useEffect(() => {
    saveContextRef.current = saveContext;
  }, [saveContext]);

  useEffect(() => {
    if (!dirty || saving || !canEdit) return undefined;
    const timeout = window.setTimeout(() => {
      saveContext();
    }, 900);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [canEdit, dirty, saveContext, saving]);

  const handleEditorInput = () => {
    setSaveMessage("");
    const currentHtml = editorRef.current?.innerHTML || "";
    setContextBudgetHtml(currentHtml);
    const nextLineCount = countContextLines(currentHtml);
    setContextLineCount(nextLineCount);
    refreshContextLineRows(nextLineCount);
    recomputeDirty();
  };

  const flushPendingContextSave = useCallback(() => {
    if (!dirty || saving || !canEdit) return;
    saveContext();
  }, [canEdit, dirty, saveContext, saving]);

  const handleEditorKeyDown = (event) => {
    const selectedRange = editorSelectionRange(editorRef.current);
    if (canEdit && (event.key === "Backspace" || event.key === "Delete") && selectedRange) {
      event.preventDefault();
      selectedRange.deleteContents();
      const selection = window.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(selectedRange);
      if (editorRef.current && !stripContextHtml(editorRef.current.innerHTML)) {
        editorRef.current.innerHTML = "<p><br></p>";
      }
      handleEditorInput();
      updateActiveFormats();
      return;
    }

    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "b") {
      event.preventDefault();
      exec("bold");
    }
    if (key === "i") {
      event.preventDefault();
      exec("italic");
    }
  };

  const handleEditorPaste = (event) => {
    if (!canEdit) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined || text === null) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
    handleEditorInput();
    recomputeDirty();
  };

  const cacheHydratedPreview = useCallback((cid, contextResult) => {
    const normalizedCid = String(cid || contextResult?.cid || "").trim();
    if (!normalizedCid || !contextResult?.text) return;

    setHydratedPreviewByCid((current) => ({
      ...current,
      [normalizedCid]: {
        title: contextResult.title,
        text: contextResult.text,
        preview: contextPreviewText(contextResult.text),
        wordCount: contextWordCount(contextBodyToHtml(contextResult.text)),
        decrypted: contextResult.decrypted,
        fetchedAt: contextResult.fetchedAt || new Date().toISOString(),
      },
    }));
    setPreviewStateByCid((current) => ({
      ...current,
      [normalizedCid]: {
        status: "loaded",
        message: "",
      },
    }));
  }, []);

  const setPreviewState = useCallback((cid, nextState) => {
    const normalizedCid = String(cid || "").trim();
    if (!normalizedCid) return;
    setPreviewStateByCid((current) => ({
      ...current,
      [normalizedCid]: {
        ...current[normalizedCid],
        ...nextState,
      },
    }));
  }, []);

  const hydrateContextPointer = async (pointer, versionKey) => {
    const cid = String(pointer?.cid || "").trim();
    if (!cid || restoringAnyVersion) return false;
    if (!walletVault?.unlocked) {
      setHydrateMessage("Unlock the local seed vault before restoring a historical version.");
      setVersionsOpen(true);
      return false;
    }

    const nextRestoringKey = versionKey || cid;
    setRestoringVersionKey(nextRestoringKey);
    setHydrateMessage("");
    setPreviewState(cid, { status: "loading", message: "" });
    try {
      const result = await onHydrateContext?.(pointer);
      if (!result?.text) {
        setHydrateMessage("Context CID was fetched, but no readable context text was found.");
        setHydratedContext(null);
        setPreviewState(cid, {
          status: "error",
          message: "No readable context text was found. Click Restore to retry.",
        });
      } else {
        const nextHydratedContext = { ...result, cid: result.cid || cid };
        setHydratedContext(nextHydratedContext);
        cacheHydratedPreview(cid, nextHydratedContext);
        setHydrateMessage(result.decrypted ? "Historical context decrypted." : "Historical context fetched.");
        setVersionsOpen(true);
      }
      return Boolean(result?.text);
    } catch (error) {
      const message = error?.message || "Context could not be hydrated.";
      setHydrateMessage(message);
      setPreviewState(cid, {
        status: "error",
        message,
      });
      setHydratedContext(null);
      return false;
    } finally {
      setRestoringVersionKey("");
    }
  };

  useEffect(() => {
    if (!versionsOpen || !walletVault?.unlocked || !historyPreviewTargetKey) {
      previewHydrationRunRef.current += 1;
      setPreviewHydration((current) =>
        current.active
          ? { active: false, loaded: 0, total: 0, error: "" }
          : current
      );
      return undefined;
    }

    const targets = historyPreviewTargets.filter((version) => !hydratedPreviewByCid[version.cid]?.text);
    if (targets.length === 0) {
      setPreviewHydration({
        active: false,
        loaded: historyPreviewTargets.length,
        total: historyPreviewTargets.length,
        error: "",
      });
      return undefined;
    }

    const runId = previewHydrationRunRef.current + 1;
    previewHydrationRunRef.current = runId;
    let cancelled = false;
    setPreviewHydration({ active: true, loaded: 0, total: targets.length, error: "" });
    setPreviewStateByCid((current) => {
      const next = { ...current };
      for (const target of targets) {
        next[target.cid] = next[target.cid]?.status === "loaded"
          ? next[target.cid]
          : { status: "queued", message: "" };
      }
      return next;
    });

    async function hydratePreviewRows() {
      let loaded = 0;
      let firstError = "";

      for (const version of targets) {
        if (cancelled || previewHydrationRunRef.current !== runId) return;

        try {
          setPreviewState(version.cid, { status: "loading", message: "" });
          const result = await onHydrateContext?.(version.pointer);
          if (result?.text) {
            cacheHydratedPreview(version.cid, { ...result, cid: result.cid || version.cid });
          } else {
            setPreviewState(version.cid, {
              status: "error",
              message: "No readable context text was found. Click Restore to retry.",
            });
          }
        } catch (error) {
          firstError ||= error?.message || "Some previews could not be loaded.";
          setPreviewState(version.cid, {
            status: "error",
            message: error?.message || "Preview could not be loaded. Click Restore to retry.",
          });
          if (error?.code === "wallet_vault_locked" || error?.code === "context_wallet_required") break;
        } finally {
          loaded += 1;
          if (!cancelled && previewHydrationRunRef.current === runId) {
            setPreviewHydration({
              active: true,
              loaded,
              total: targets.length,
              error: firstError,
            });
          }
        }
      }

      if (!cancelled && previewHydrationRunRef.current === runId) {
        setPreviewHydration({
          active: false,
          loaded,
          total: targets.length,
          error: firstError,
        });
      }
    }

    hydratePreviewRows();
    return () => {
      cancelled = true;
    };
  }, [cacheHydratedPreview, historyPreviewTargetKey, historyPreviewTargets, hydratedPreviewByCid, onHydrateContext, setPreviewState, versionsOpen, walletVault?.unlocked]);

  const applyHydratedContext = useCallback(() => {
    if (!hydratedContext?.text) return;
    setTitle(hydratedContext.title || "Historical PFT Context");
    const hydratedHtml = contextBodyToHtml(hydratedContext.text);
    if (editorRef.current) editorRef.current.innerHTML = hydratedHtml;
    setContextBudgetHtml(hydratedHtml);
    const nextLineCount = countContextLines(hydratedHtml);
    setContextLineCount(nextLineCount);
    refreshContextLineRows(nextLineCount);
    setHydratedContext(null);
    setHydrateMessage("Historical version loaded into the editor. It will autosave as the current context document.");
    setVersionsOpen(true);
    setSaveMessage("Historical version loaded");
    setDirty(true);
  }, [hydratedContext, refreshContextLineRows]);

  const closeHydratedPreview = useCallback(() => {
    setHydratedContext(null);
    setHydrateMessage("");
    setVersionsOpen(true);
  }, []);

  useEffect(() => {
    if (!hydratedContext?.text) return undefined;

    function handleHydratedPreviewKeyDown(event) {
      if (event.key === "Escape") closeHydratedPreview();
    }

    document.addEventListener("keydown", handleHydratedPreviewKeyDown);
    return () => document.removeEventListener("keydown", handleHydratedPreviewKeyDown);
  }, [closeHydratedPreview, hydratedContext?.text]);

  const copyEditorText = async () => {
    const text = editorRef.current?.innerText?.trim() || "";
    const composed = `${title}\n\n${text}`.trim();
    if (!composed) return;

    try {
      await navigator.clipboard?.writeText(composed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setSaveMessage("Copy failed.");
    }
  };

  const copyCid = async (cid) => {
    if (!cid) return;
    try {
      await navigator.clipboard?.writeText(cid);
      setCopiedCid(cid);
      window.setTimeout(() => setCopiedCid((current) => (current === cid ? "" : current)), 1600);
    } catch {
      setSaveMessage("CID copy failed.");
    }
  };

  const restoreVersion = async (version) => {
    if (restoringAnyVersion) return;
    if (version.type === "current") {
      setTitle(savedTitle);
      if (editorRef.current) editorRef.current.innerHTML = lastSavedHtmlRef.current;
      setContextBudgetHtml(lastSavedHtmlRef.current);
      const nextLineCount = countContextLines(lastSavedHtmlRef.current);
      setContextLineCount(nextLineCount);
      refreshContextLineRows(nextLineCount);
      setDirty(false);
      setHydratedContext(null);
      setHydrateMessage("");
      setVersionsOpen(true);
      setSaveMessage("Restored current saved draft");
      return;
    }

    if (version.pointer) {
      await hydrateContextPointer(version.pointer, version.key);
    }
  };

  const publishContext = async () => {
    if (publishing) return;
    if (dirty) {
      const saved = await saveContext();
      if (!saved) return;
    }
    if (!walletVault?.unlocked) {
      setSaveMessage("Unlock wallet vault to publish.");
      return;
    }
    if (!linkedWalletAddress) {
      setSaveMessage("Link a PFT wallet before publishing.");
      return;
    }
    if (typeof onPublishContext !== "function") {
      setSaveMessage("Publishing is unavailable.");
      return;
    }

    setPublishing(true);
    try {
      const body = sanitizeContextHtml(editorRef.current?.innerHTML || documentState.body || "");
      const result = await onPublishContext({
        title,
        body,
        revision: documentState.revision || 0,
        wordCount: contextWordCount(body),
        path: manifestAction?.path || "/api/context/manifest/ink",
      });
      setSaveMessage(result?.message || "Published to PFT.");
      await onContextChange?.();
    } catch (error) {
      setSaveMessage(error?.message || "Publishing is unavailable.");
    } finally {
      setPublishing(false);
    }
  };

  const statusText = (() => {
    if (!canEdit) return "Sign in to save context";
    if (publishing) return "Publishing";
    if (saving) return "Saving";
    if (dirty) return "Editing";
    if (saveMessage) return saveMessage;
    return `Saved ${formatRelativeShort(documentState.updatedAt, now)}`;
  })();

  return (
    <div className="route-scroll">
      <div className="context-view context-wireframe">
        <section className="ctx-card" aria-label="Context document">
          <div
            className="ctx-toolbar"
            role="toolbar"
            aria-label="Formatting"
            onScroll={tablePickerOpen ? updateTablePickerPosition : undefined}
          >
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.h1} disabled={!canEdit} onMouseDown={() => toggleHeading(1)} title="Heading 1">
                <Heading1 size={16} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.h2} disabled={!canEdit} onMouseDown={() => toggleHeading(2)} title="Heading 2">
                <Heading2 size={16} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.h3} disabled={!canEdit} onMouseDown={() => toggleHeading(3)} title="Heading 3">
                <Heading3 size={16} strokeWidth={2} />
              </ContextToolButton>
            </div>
            <span className="ctx-toolbar-sep" />
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.bold} disabled={!canEdit} onMouseDown={() => exec("bold")} title="Bold">
                <Bold size={15} strokeWidth={2.2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.italic} disabled={!canEdit} onMouseDown={() => exec("italic")} title="Italic">
                <Italic size={15} strokeWidth={2.2} />
              </ContextToolButton>
            </div>
            <span className="ctx-toolbar-sep" />
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.ul} disabled={!canEdit} onMouseDown={() => exec("insertUnorderedList")} title="Bulleted list">
                <List size={15} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.ol} disabled={!canEdit} onMouseDown={() => exec("insertOrderedList")} title="Numbered list">
                <ListOrdered size={15} strokeWidth={2} />
              </ContextToolButton>
            </div>
            <span className="ctx-toolbar-sep" />
            <div className="ctx-toolbar-group ctx-table-wrap" ref={tableWrapRef}>
              <button
                aria-expanded={tablePickerOpen ? "true" : "false"}
                aria-haspopup="dialog"
                aria-label="Insert table"
                className={`ctx-tool-btn ctx-tool-combo${tablePickerOpen ? " is-active" : ""}`}
                disabled={!canEdit}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!canEdit) return;
                  if (!tablePickerOpen) {
                    saveSelection();
                    updateTablePickerPosition();
                  }
                  setTablePickerOpen((open) => !open);
                  setTableHover({ rows: 0, cols: 0 });
                }}
                title="Insert table"
                type="button"
              >
                <Table size={15} strokeWidth={2} />
                <ChevronDown size={12} strokeWidth={2} />
              </button>
              {tablePickerOpen && (
                <div
                  className="ctx-table-picker"
                  role="dialog"
                  aria-label="Insert table"
                  style={{
                    top: `${tablePickerPosition.top}px`,
                    left: `${tablePickerPosition.left}px`,
                  }}
                >
                  <div className="ctx-table-grid" onMouseLeave={() => setTableHover({ rows: 0, cols: 0 })}>
                    {Array.from({ length: 8 }).map((_, rowIndex) => (
                      <div className="ctx-table-row" key={rowIndex}>
                        {Array.from({ length: 8 }).map((__, colIndex) => {
                          const active = rowIndex < tableHover.rows && colIndex < tableHover.cols;
                          return (
                            <button
                              aria-label={`Insert ${rowIndex + 1} by ${colIndex + 1} table`}
                              className={`ctx-table-cell${active ? " is-active" : ""}`}
                              key={colIndex}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                insertTable(rowIndex + 1, colIndex + 1);
                                setTablePickerOpen(false);
                              }}
                              onMouseEnter={() => setTableHover({ rows: rowIndex + 1, cols: colIndex + 1 })}
                              type="button"
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className="ctx-table-readout">
                    {tableHover.rows > 0 ? `${tableHover.rows} x ${tableHover.cols}` : "Insert table"}
                  </div>
                </div>
              )}
            </div>
            <div className="ctx-toolbar-spacer" />
            <button
              aria-label={lineNumbersVisible ? "Hide line numbers" : "Show line numbers"}
              aria-pressed={lineNumbersVisible ? "true" : "false"}
              className={`ctx-tool-btn${lineNumbersVisible ? " is-active" : ""}`}
              onClick={() => setLineNumbersVisible((visible) => !visible)}
              title={lineNumbersVisible ? "Hide line numbers" : "Show line numbers"}
              type="button"
            >
              <Hash size={15} strokeWidth={2} />
            </button>
            <button className="ctx-tool-text" onClick={copyEditorText} type="button">
              {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>

          <div className="ctx-writing-surface">
            <input
              aria-label="Document title"
              className="ctx-title-input"
              disabled={!canEdit}
              maxLength={120}
              onBlur={flushPendingContextSave}
              onChange={(event) => {
                titleRef.current = event.target.value;
                setTitle(event.target.value);
                setSaveMessage("");
              }}
              placeholder="Untitled context"
              value={title}
            />
            <div className={`ctx-editor-shell${lineNumbersVisible ? "" : " is-line-numbers-hidden"}`}>
              {lineNumbersVisible && (
                <div className="ctx-line-gutter" aria-hidden="true">
                  {(contextLineRows.length ? contextLineRows : Array.from({ length: contextLineCount }, (_, index) => ({
                    number: index + 1,
                    top: index * 24,
                  }))).map((row) => (
                    <span key={row.number} style={{ transform: `translateY(${row.top}px)` }}>{row.number}</span>
                  ))}
                </div>
              )}
              <div
                aria-disabled={!canEdit}
                aria-label="Context document body"
                aria-multiline="true"
                className="ctx-editor"
                contentEditable={canEdit}
                data-placeholder="Add stable preferences, active projects, constraints, and working notes."
                onBlur={flushPendingContextSave}
                onClick={updateActiveFormats}
                onFocus={updateActiveFormats}
                onInput={handleEditorInput}
                onKeyDown={handleEditorKeyDown}
                onKeyUp={updateActiveFormats}
                onPaste={handleEditorPaste}
                ref={editorRef}
                role="textbox"
                spellCheck
                suppressContentEditableWarning
              />
            </div>
          </div>

          {contextBudgetOpen && (
            <div className={`ctx-budget-panel is-${contextBudgetTone}`} aria-label="Task generation context budget">
              <div className="ctx-budget-panel-head">
                <strong>Task generation context</strong>
                <span>{contextBudgetIncludedLabel} / {contextBudgetMaxLabel} chars</span>
              </div>
              <div className="ctx-budget-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, contextBudget.usagePercent)}%` }} />
              </div>
              <p>
                {contextBudget.clipped
                  ? `Task generation uses the first ${contextBudgetMaxLabel} readable characters. ${contextBudgetOmittedLabel} characters are outside the generation packet.`
                  : `Task generation can use this full document. ${contextBudgetRemainingLabel} characters remain before clipping.`}
              </p>
            </div>
          )}

          <footer className="ctx-card-foot">
            <span className={`ctx-status${dirty ? " is-dirty" : ""}${saving || publishing ? " is-saving" : ""}`} role="status">
              <span className="ctx-status-dot" aria-hidden="true" />
              {statusText}
            </span>
            <div className="ctx-foot-actions">
              <button
                aria-expanded={contextBudgetOpen ? "true" : "false"}
                aria-pressed={contextBudgetOpen ? "true" : "false"}
                className={`ctx-budget-toggle is-${contextBudgetTone}${contextBudgetOpen ? " is-active" : ""}`}
                onClick={() => setContextBudgetOpen((open) => !open)}
                title="Task generation context budget"
                type="button"
              >
                <Database size={13} strokeWidth={2} />
                <span>{contextBudgetPercentLabel} task context</span>
              </button>
              <button
                aria-expanded={versionsOpen ? "true" : "false"}
                className={`ctx-ghost${versionsOpen ? " is-active" : ""}`}
                onClick={() => setVersionsOpen((open) => !open)}
                type="button"
              >
                Versions
                <span className="ctx-ghost-count">{versions.length}</span>
              </button>
              <span className="ctx-tip">
                <button
                  className="ctx-ghost ctx-ghost-accent"
                  disabled={publishing}
                  onClick={publishContext}
                  type="button"
                >
                  <ArrowUp size={13} strokeWidth={2} />
                  {publishing ? "Publishing" : "Publish to PFT"}
                </button>
                <span className="ctx-tip-card" role="tooltip">
                  Encrypts the document, pins it to IPFS, and writes an immutable PFT context pointer.
                </span>
              </span>
            </div>
          </footer>
        </section>

        {versionsOpen && (
          <section className="ctx-versions" aria-label="Context versions">
            <header className="ctx-versions-head">
              <div>
                <span className="ctx-versions-title">Revision history</span>
                <span className="ctx-versions-sub">{historySubtitle}</span>
              </div>
              <div className="ctx-versions-actions">
                {activeWalletAddress && historyPreviewTotal > 0 && (
                  <>
                    <span className={`ctx-vault-state is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                      {vaultDisplay.tone === "unlocked" ? <Unlock size={12} strokeWidth={2} /> : <Lock size={12} strokeWidth={2} />}
                      {vaultDisplay.label}
                    </span>
                    <span className={`ctx-preview-state${previewHydration.active ? " is-active" : ""}`}>
                      {previewHydration.active
                        ? `Loading previews ${previewHydration.loaded}/${previewHydration.total}`
                        : walletVault?.unlocked
                          ? `${previewedHistoryCount}/${historyPreviewTotal} previews`
                          : "Unlock for previews"}
                    </span>
                  </>
                )}
                {activeWalletAddress && (
                  <span className={`ctx-preview-state${historySync.status === "syncing" ? " is-active" : ""}`}>
                    {historySyncLabel}
                  </span>
                )}
                {!activeWalletAddress && (
                  <span className="ctx-preview-state">
                    Account context only
                  </span>
                )}
                <span className="ctx-versions-count">{versions.length} versions</span>
              </div>
            </header>
            {historySync?.lastError && (
              <div className="ctx-discover-message">{historySync.lastError}</div>
            )}
            {previewHydration.error && !previewHydration.active && (
              <div className="ctx-discover-message">{previewHydration.error}</div>
            )}
            {hydrateMessage && !hydratedContext?.text && <div className="ctx-discover-message">{hydrateMessage}</div>}
            <ol className="ctx-versions-list">
              {versions.map((version, index) => {
                const isCidCopied = copiedCid === version.cid;
                const cachedPreview = version.cid ? hydratedPreviewByCid[version.cid] : null;
                const previewState = version.cid ? previewStateByCid[version.cid] : null;
                const isPreviewing = Boolean(hydratedContext?.cid && version.cid && hydratedContext.cid === version.cid);
                const isRestoring = restoringVersionKey === version.key;
                const previewText =
                  cachedPreview?.preview ||
                  (version.type === "pointer"
                    ? walletVault?.unlocked
                      ? previewState?.status === "loading"
                        ? "Encrypted historical context preview is loading."
                        : previewState?.status === "queued"
                          ? "Encrypted historical context preview is queued."
                          : previewState?.status === "error"
                            ? previewState.message || "Preview could not be loaded. Click Restore to retry."
                            : "Click Restore to load this encrypted context preview."
                      : "Unlock the local seed vault to load this encrypted context preview."
                    : version.preview);
                const wordCount = cachedPreview?.wordCount || version.words || 0;
                return (
                  <li className={`ctx-version${version.current ? " is-current" : ""}${isPreviewing ? " is-previewing" : ""}`} key={version.key}>
                    <div className="ctx-version-marker" aria-hidden="true">
                      <span className="ctx-version-dot" />
                      {index < versions.length - 1 && <span className="ctx-version-line" />}
                    </div>
                    <div className="ctx-version-body">
                      <div className="ctx-version-top">
                        <span className="ctx-version-rev">Rev {version.rev}</span>
                        <span className="ctx-version-meta">{formatContextTimestamp(version.at)}</span>
                        <span className="ctx-version-meta ctx-version-words">{wordCount} words</span>
                        <span className="ctx-version-spacer" />
                        {version.current ? (
                          <span className="ctx-version-current">
                            <span className="ctx-version-current-dot" aria-hidden="true" />
                            Current
                          </span>
                        ) : (
                          <button
                            aria-busy={isRestoring ? "true" : undefined}
                            className={`ctx-version-restore${isRestoring ? " is-restoring" : ""}${isPreviewing ? " is-selected" : ""}`}
                            disabled={restoringAnyVersion || isPreviewing}
                            onClick={() => restoreVersion(version)}
                            type="button"
                          >
                            {isRestoring ? "Loading preview" : isPreviewing ? "Previewing" : "Restore"}
                          </button>
                        )}
                      </div>
                      {previewText && <p className="ctx-version-preview">{previewText}</p>}
                      {version.cid && (
                        <div className="ctx-version-foot">
                          <code className="ctx-version-cid" title={version.cid}>
                            {truncateCid(version.cid)}
                          </code>
                          <button
                            aria-label={isCidCopied ? "Copied CID" : "Copy CID"}
                            className="ctx-version-copy"
                            onClick={() => copyCid(version.cid)}
                            title={isCidCopied ? "Copied" : "Copy CID"}
                            type="button"
                          >
                            {isCidCopied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {!canEdit && (
          <div className="context-note">
            Sign in to edit and save the native context document.
          </div>
        )}
      </div>

      {hydratedContext?.text && (
        <div
          className="ctx-restore-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeHydratedPreview();
          }}
          role="presentation"
        >
          <section
            aria-labelledby="ctx-restore-title"
            aria-modal="true"
            className="ctx-restore-dialog"
            role="dialog"
          >
            <header className="ctx-restore-head">
              <div className="ctx-restore-heading">
                <span>Historical context preview</span>
                <strong id="ctx-restore-title">{hydratedContext.title}</strong>
                {hydratedContext.cid && <code>{truncateCid(hydratedContext.cid)}</code>}
              </div>
              <div className="ctx-restore-actions">
                <button className="dark-pill" disabled={!canEdit} onClick={applyHydratedContext} type="button">
                  Use as draft
                </button>
                <button
                  aria-label="Close historical context preview"
                  className="icon-button"
                  onClick={closeHydratedPreview}
                  type="button"
                >
                  <X size={18} strokeWidth={1.8} />
                </button>
              </div>
            </header>
            <div className="ctx-restore-warning">
              <AlertTriangle size={15} strokeWidth={2} />
              <span>
                Use as draft replaces the editor contents with this historical version. The editor autosaves it as the current context document.
              </span>
            </div>
            {hydrateMessage && <div className="ctx-restore-state">{hydrateMessage}</div>}
            <pre className="ctx-restore-preview">{contextPreviewText(hydratedContext.text, CONTEXT_DOCUMENT_MAX_CHARS)}</pre>
            <footer className="ctx-restore-foot">
              <span>{hydratedContext.decrypted ? "Decrypted locally from your unlocked vault." : "Fetched historical context."}</span>
              <button className="ctx-version-restore" onClick={closeHydratedPreview} type="button">
                Keep browsing versions
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

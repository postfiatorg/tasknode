import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronDown, Download, Eye, FileText, FileUp, History, LockKeyhole, MessageSquare, Pencil, Share2 } from "lucide-react";
import { requestJson } from "../../api";
import {
  decryptFromTaskNodeWallet,
  encryptForTaskNodeWallet,
  newUuid,
  ownEncryptionPublicKey,
  signedCollaborationProof,
} from "../collaboration/collaboration-client";
import { createDocsRootKey, decryptDocsMetadata, encryptDocsMetadata } from "./docs-crypto";
import {
  docsActiveTaskOptions,
  filterDocsTaskOptions,
  pfdocsShareUrl,
  shareTargetInput,
  validSelectedShareTarget,
} from "./docs-library-options";
import { DocsLibraryBrowser } from "./DocsLibraryBrowser";
import { changeDocsLibrary, emptyDocsLibrary, readDocsLibrary } from "./docs-folders";
import "./docs-library.css";

function errorText(result, fallback) {
  return result?.body?.message || result?.body?.error || fallback;
}

function pfdocsBridgeUrl({ action, documentType = "pad", href = "", origin, bridgePath, requestId }) {
  const target = new URL(bridgePath || "/tasknode/", origin);
  target.searchParams.set("action", action);
  target.searchParams.set("documentType", documentType === "sheet" ? "sheet" : "pad");
  target.searchParams.set("requestId", requestId);
  target.searchParams.set("returnOrigin", window.location.origin);
  if (href) target.hash = new URL(href, origin).hash;
  return target.toString();
}

function docsChatIdentity(identity = {}) {
  const rawHandle = String(identity.hiveHandle || "").trim();
  const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
  const walletAddress = String(identity.walletAddress || "").trim();
  return {
    accountId: String(identity.accountId || "").trim(),
    displayName: handle ? `@${handle}` : walletAddress || String(identity.displayName || "Task Node member").trim(),
    hiveHandle: handle,
    walletAddress,
  };
}

const PFDOCS_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const PFDOCS_IMPORT_ACCEPT = ".md,.txt,.html,.htm,text/markdown,text/plain,text/html";

function supportedPfdocsImport(file) {
  const name = String(file?.name || "").toLowerCase();
  return [".md", ".txt", ".html", ".htm"].some((extension) => name.endsWith(extension));
}

export function DocsLibraryView({ collaboration = {}, onLogin, onWalletUnlock, signedIn = false, tasks = {}, walletSecret, walletVault }) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  const [decryption, setDecryption] = useState({ failures: {}, loading: false });
  const [busy, setBusy] = useState("");
  const [library, setLibrary] = useState(emptyDocsLibrary);
  const [folderId, setFolderId] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [hydratedData, setHydratedData] = useState(null);
  const [decrypted, setDecrypted] = useState({});
  const [share, setShare] = useState(null);
  const [shareTarget, setShareTarget] = useState("");
  const [shareTargetError, setShareTargetError] = useState("");
  const [shareSuggestions, setShareSuggestions] = useState([]);
  const [shareSuggestionsLoading, setShareSuggestionsLoading] = useState(false);
  const [selectedShareTarget, setSelectedShareTarget] = useState(null);
  const [shareRole, setShareRole] = useState("viewer");
  const [shareLinkState, setShareLinkState] = useState({ copied: "", error: "" });
  const [taskLinkDocument, setTaskLinkDocument] = useState(null);
  const [taskQuery, setTaskQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [editor, setEditor] = useState(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorMenu, setEditorMenu] = useState("");
  const [editorTitleDraft, setEditorTitleDraft] = useState("");
  const [editorFullContext, setEditorFullContext] = useState(false);
  const [editorImport, setEditorImport] = useState({ message: "", tone: "" });
  const editorFrameRef = useRef(null);
  const editorImportRef = useRef(null);
  const editorRef = useRef(null);
  const docsStateRef = useRef(null);
  const decryptedRef = useRef({});
  const pendingCreateRef = useRef(null);
  const rootKeyRef = useRef("");
  const editorReady = Boolean(collaboration.pfdocsEditorEnabled && collaboration.pfdocsOrigin);
  const activeTaskOptions = useMemo(() => docsActiveTaskOptions(tasks), [tasks]);
  const filteredTaskOptions = useMemo(
    () => filterDocsTaskOptions(activeTaskOptions, taskQuery),
    [activeTaskOptions, taskQuery]
  );
  const validShareTarget = validSelectedShareTarget(selectedShareTarget, shareTarget);

  useEffect(() => { editorRef.current = editor; }, [editor]);
  useEffect(() => { docsStateRef.current = state.data; }, [state.data]);
  useEffect(() => { decryptedRef.current = decrypted; }, [decrypted]);

  useEffect(() => {
    if (!share) return undefined;
    let active = true;
    const timer = window.setTimeout(async () => {
      setShareSuggestionsLoading(true);
      const result = await requestJson(
        `/api/collaboration/suggestions?q=${encodeURIComponent(shareTarget)}&limit=8`
      ).catch(() => null);
      if (!active) return;
      const suggestions = result?.ok && Array.isArray(result.body?.suggestions)
        ? result.body.suggestions
        : [];
      setShareSuggestions(suggestions);
      setShareSuggestionsLoading(false);
      if (!shareTarget.trim() && !selectedShareTarget && suggestions[0]?.recentlyShared) {
        setSelectedShareTarget(suggestions[0]);
        setShareTarget(shareTargetInput(suggestions[0]));
      }
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [selectedShareTarget, share, shareTarget]);

  useEffect(() => {
    if (!editor?.documentId) {
      setEditorTitleDraft("");
      return;
    }
    const metadata = decrypted[editor.documentId];
    setEditorTitleDraft(metadata?.title || editor.title || "Untitled document");
  }, [decrypted, editor?.documentId, editor?.title]);

  useEffect(() => {
    if (!editor?.requestId || !editorLoading) return undefined;
    const timer = window.setTimeout(() => {
      setEditorLoading(false);
      setState((current) => ({
        ...current,
        error: "PFDocs is taking longer than expected to open. You can return to Docs and try again.",
      }));
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [editor?.requestId, editorLoading]);

  const postEditorContext = useCallback((targetWindow = editorFrameRef.current?.contentWindow) => {
    const activeEditor = editorRef.current;
    const data = docsStateRef.current;
    if (!targetWindow || !activeEditor?.channelHash || !data) return;
    const metadata = decryptedRef.current[activeEditor.documentId] || {};
    const document = data.documents?.find((entry) => entry.documentId === activeEditor.documentId);
    targetWindow.postMessage({
      type: "tasknode.pfdocs.context",
      requestId: activeEditor.requestId,
      channelHash: activeEditor.channelHash,
      documentId: activeEditor.documentId,
      documentOwned: document?.owned === true,
      title: String(metadata.title || activeEditor.title || "Untitled document").trim().slice(0, 180),
      identity: docsChatIdentity(data.identity),
      odv: { enabled: collaboration.docsOdvEnabled === true, mention: "@ODV", model: "zai/glm-5.3", provider: "vercel" },
      agents: collaboration.docsOdvEnabled === true ? [
        { persona: "odv", mention: "@ODV", label: "ODV" },
        { persona: "coach", mention: "@coach", label: "Trading Coach" },
      ] : [],
    }, new URL(collaboration.pfdocsOrigin).origin);
  }, [collaboration.docsOdvEnabled, collaboration.pfdocsOrigin]);

  const load = useCallback(async () => {
    if (!signedIn) {
      setState({ loading: false, data: null, error: "" });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    const result = await requestJson("/api/docs");
    if (!result.ok) {
      setState({ loading: false, data: null, error: errorText(result, "Could not load documents.") });
      return;
    }
    setState({ loading: false, data: result.body, error: "" });
  }, [signedIn]);

  useEffect(() => { load(); }, [load]);

  const syncDocumentTitle = useCallback(async (channelHash, title) => {
    const normalizedTitle = String(title || "").trim().slice(0, 180);
    const document = state.data?.documents?.find((entry) => entry.owned && entry.channelHash === channelHash);
    const current = document && decrypted[document.documentId];
    if (!document || !current || !normalizedTitle || current.title === normalizedTitle || !rootKeyRef.current) return;
    try {
      const encryptedMetadata = await encryptDocsMetadata({ ...current, title: normalizedTitle }, rootKeyRef.current);
      const result = await requestJson(`/api/docs/documents/${document.documentId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ encryptedMetadata }),
      });
      if (!result.ok) throw new Error(errorText(result, "Could not synchronize the PFDocs title."));
      setDecrypted((entries) => ({ ...entries, [document.documentId]: { ...current, title: normalizedTitle } }));
    } catch (error) {
      setState((currentState) => ({ ...currentState, error: error.message }));
    }
  }, [decrypted, state.data]);

  useEffect(() => {
    if (!editorReady) return undefined;
    const pfdocsOrigin = new URL(collaboration.pfdocsOrigin).origin;
    function onMessage(event) {
      if (event.origin !== pfdocsOrigin || event.source !== editorFrameRef.current?.contentWindow) return;
      const data = event.data || {};
      if (data.type === "pfdocs.tasknode.document-created") {
        const pending = pendingCreateRef.current;
        if (!pending || data.requestId !== pending.requestId) return;
        window.clearTimeout(pending.timeout);
        pendingCreateRef.current = null;
        if (!/^[0-9a-f]{32}$/i.test(String(data.channelHash || ""))) {
          pending.reject(new Error("PFDocs returned an invalid document channel."));
          return;
        }
        pending.resolve(data);
        return;
      }
      if (data.type === "pfdocs.tasknode.ready") {
        const activeEditor = editorRef.current;
        if (!activeEditor || data.requestId !== activeEditor.requestId) return;
        if (activeEditor.channelHash && data.channelHash !== activeEditor.channelHash) return;
        setEditorLoading(false);
        postEditorContext(event.source);
        return;
      }
      if (data.type === "pfdocs.tasknode.document-title" && /^[0-9a-f]{32}$/i.test(String(data.channelHash || ""))) {
        void syncDocumentTitle(data.channelHash, data.title);
        return;
      }
      if (data.type === "pfdocs.tasknode.import-result") {
        const activeEditor = editorRef.current;
        if (!activeEditor || data.requestId !== activeEditor.requestId || data.channelHash !== activeEditor.channelHash) return;
        setEditorImport({
          message: data.ok === true
            ? `${String(data.fileName || "Document").slice(0, 180)} imported.`
            : String(data.error || "PFDocs could not import that file."),
          tone: data.ok === true ? "success" : "error",
        });
        return;
      }
      if (["pfdocs.tasknode.assistant-request", "pfdocs.tasknode.odv-request"].includes(data.type)) {
        const activeEditor = editorRef.current;
        if (!activeEditor?.documentId || data.requestId !== activeEditor.requestId || data.channelHash !== activeEditor.channelHash) return;
        const responseTarget = event.source;
        const legacyOdv = data.type === "pfdocs.tasknode.odv-request";
        const responseType = legacyOdv ? "tasknode.pfdocs.odv-response" : "tasknode.pfdocs.assistant-response";
        void requestJson(`/api/docs/documents/${activeEditor.documentId}/${legacyOdv ? "odv" : "assistant"}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelHash: data.channelHash,
            persona: data.persona || "odv",
            includeFullContext: editorFullContext === true,
            prompt: data.prompt,
            documentTitle: data.documentTitle,
            documentContent: data.documentContent,
            recentMessages: data.recentMessages,
          }),
        }).then((result) => {
          responseTarget.postMessage({
            type: responseType,
            requestId: data.requestId,
            assistantRequestId: data.assistantRequestId,
            odvRequestId: data.odvRequestId,
            channelHash: data.channelHash,
            ok: result.ok,
            response: result.body?.response || "",
            persona: result.body?.persona || data.persona || "odv",
            label: result.body?.label || (data.persona === "coach" ? "Trading Coach" : "ODV"),
            model: result.body?.model || "zai/glm-5.3",
            error: result.ok ? "" : errorText(result, "The mentioned document assistant could not answer this request."),
          }, pfdocsOrigin);
        }).catch(() => {
          responseTarget.postMessage({
            type: responseType,
            requestId: data.requestId,
            assistantRequestId: data.assistantRequestId,
            odvRequestId: data.odvRequestId,
            channelHash: data.channelHash,
            ok: false,
            response: "",
            persona: data.persona || "odv",
            label: data.persona === "coach" ? "Trading Coach" : "ODV",
            model: "zai/glm-5.3",
            error: "The mentioned document assistant could not answer this request.",
          }, pfdocsOrigin);
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [collaboration.pfdocsOrigin, editorFullContext, editorReady, postEditorContext, syncDocumentTitle]);

  useEffect(() => {
    if (!editor?.channelHash || !editorReady) return;
    postEditorContext();
  }, [decrypted, editor, editorReady, postEditorContext, state.data?.identity]);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      if (!signedIn || !walletSecret?.mnemonic || !state.data) {
        rootKeyRef.current = "";
        setDecrypted({});
        setLibrary(emptyDocsLibrary());
        setHydratedData(null);
        setEditor(null);
        editorRef.current = null;
        decryptedRef.current = {};
        setShare(null);
        setTaskLinkDocument(null);
        const pending = pendingCreateRef.current;
        if (pending) {
          window.clearTimeout(pending.timeout);
          pendingCreateRef.current = null;
          pending.reject(new Error("Unlock Docs before creating a document."));
        }
        setDecryption({ failures: {}, loading: false });
        return;
      }
      rootKeyRef.current = "";
      setDecryption({ failures: {}, loading: true });
      setLibraryError("");
      try {
        let rootKey = "";
        if (state.data.account?.encryptedRootKeyEnvelope) {
          const root = await decryptFromTaskNodeWallet(state.data.account.encryptedRootKeyEnvelope, walletSecret);
          rootKey = root.rootKey || "";
          if (cancelled) return;
          rootKeyRef.current = rootKey;
        }
        let nextLibrary = emptyDocsLibrary();
        let folderError = "";
        if (state.data.account?.encryptedLibraryMetadata) {
          try { nextLibrary = readDocsLibrary(await decryptDocsMetadata(state.data.account.encryptedLibraryMetadata, rootKey)); }
          catch { folderError = "Your folders could not be unlocked. Refresh to try again; your documents are still available."; }
        }
        const settled = await Promise.all((state.data.documents || []).map(async (document) => {
          try {
            const metadata = document.owned
              ? await decryptDocsMetadata(document.encryptedMetadata, rootKey)
              : await decryptFromTaskNodeWallet(document.encryptedCapabilityEnvelope, walletSecret);
            return { documentId: document.documentId, metadata };
          } catch (error) {
            return { documentId: document.documentId, error: error?.message || "decryption_failed" };
          }
        }));
        if (!cancelled) {
          setLibrary(nextLibrary);
          setLibraryError(folderError);
          setFolderId((current) => nextLibrary.folders.some((folder) => folder.id === current) ? current : "");
          setHydratedData(state.data);
          setDecrypted(Object.fromEntries(
            settled.filter((entry) => entry.metadata).map((entry) => [entry.documentId, entry.metadata])
          ));
          setDecryption({
            failures: Object.fromEntries(
              settled.filter((entry) => entry.error).map((entry) => [entry.documentId, entry.error])
            ),
            loading: false,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setHydratedData(state.data);
          setLibraryError("Your library could not be unlocked with this wallet. Check your linked wallet and try again.");
          setDecryption({
          failures: Object.fromEntries(
            (state.data.documents || []).map((document) => [document.documentId, error?.message || "decryption_failed"])
          ),
          loading: false,
        });
        }
      }
    }
    hydrate();
    return () => { cancelled = true; };
  }, [signedIn, state.data, walletSecret]);

  async function setupLibrary() {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    setBusy("setup");
    try {
      const rootKey = createDocsRootKey();
      const ownKey = await ownEncryptionPublicKey(walletSecret);
      const encryptedRootKeyEnvelope = await encryptForTaskNodeWallet({ rootKey }, [ownKey], walletSecret);
      const payload = { encryptedRootKeyEnvelope };
      const proof = await signedCollaborationProof({ action: "docs_setup", payload, walletSecret });
      const result = await requestJson("/api/docs/setup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, proof }),
      });
      if (!result.ok) throw new Error(errorText(result, "Could not initialize Docs."));
      rootKeyRef.current = rootKey;
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally { setBusy(""); }
  }

  async function saveLibrary(nextLibrary) {
    if (!walletSecret?.mnemonic || !rootKeyRef.current || libraryError) throw new Error(libraryError || "Unlock your library first.");
    setBusy("folders");
    try {
      const encryptedLibraryMetadata = await encryptDocsMetadata(nextLibrary, rootKeyRef.current);
      const result = await requestJson("/api/docs/library", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ encryptedLibraryMetadata, expectedVersion: state.data.account.libraryMetadataVersion || 0 }),
      });
      if (!result.ok) {
        if (result.status === 409 || result.body?.error === "docs_library_conflict") {
          await load();
          throw new Error("Your folders changed in another tab. The latest version is loaded; try again.");
        }
        throw new Error("Could not save your folders. Please try again.");
      }
      setLibrary(nextLibrary);
      setState((current) => ({ ...current, data: { ...current.data, account: {
        ...current.data.account, encryptedLibraryMetadata, libraryMetadataVersion: result.body.version,
      } } }));
    } finally { setBusy(""); }
  }

  async function createDocument(documentType = "pad", destinationFolder = folderId) {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    if (!editorReady) {
      setState((current) => ({ ...current, error: "The encrypted PFDocs editor is temporarily unavailable. Your Task Node Docs library remains available." }));
      return;
    }
    setBusy("create");
    setState((current) => ({ ...current, error: "" }));
    try {
      const documentId = newUuid();
      const requestId = newUuid();
      const url = pfdocsBridgeUrl({
        action: "create",
        documentType,
        origin: collaboration.pfdocsOrigin,
        bridgePath: collaboration.pfdocsBridgePath,
        requestId,
      });
      const capabilityPromise = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingCreateRef.current = null;
          reject(new Error("PFDocs did not return a document capability in time."));
        }, 30_000);
        pendingCreateRef.current = { reject, requestId, resolve, timeout };
      });
      setEditorFullContext(false);
      setEditorLoading(true);
      setEditor({
        documentId,
        documentType,
        requestId,
        title: documentType === "sheet" ? "Creating encrypted spreadsheet…" : "Creating encrypted document…",
        url,
      });
      const capability = await capabilityPromise;
      const title = `${documentType === "sheet" ? "Untitled spreadsheet" : "Untitled document"} ${new Date().toLocaleDateString()}`;
      const metadata = { title, documentType, editHref: capability.editHref, viewHref: capability.viewHref, createdAt: new Date().toISOString() };
      const encryptedMetadata = await encryptDocsMetadata(metadata, rootKeyRef.current);
      const payload = { documentId, channelHash: capability.channelHash, encryptedMetadata };
      const proof = await signedCollaborationProof({ action: "docs_create", resourceId: documentId, payload, walletSecret });
      const result = await requestJson("/api/docs/documents", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, proof }),
      });
      if (!result.ok) throw new Error(errorText(result, "Could not save document metadata."));
      let placementError = "";
      if (destinationFolder) {
        try { await saveLibrary(changeDocsLibrary(library, { action: "move", kind: "document", id: documentId, parentId: destinationFolder })); }
        catch (error) { placementError = `Document created in My docs. ${error.message}`; }
      }
      setEditor((current) => current?.requestId === requestId ? { ...current, channelHash: capability.channelHash, documentType, title } : current);
      await load();
      if (placementError) setState((current) => ({ ...current, error: placementError }));
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally { setBusy(""); }
  }

  function openDocument(document) {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    if (!editorReady) {
      setState((current) => ({ ...current, error: "The encrypted PFDocs editor is temporarily unavailable. Your document metadata remains safely stored." }));
      return;
    }
    const metadata = decrypted[document.documentId];
    const href = document.accessRole === "viewer" ? metadata?.viewHref : metadata?.editHref || metadata?.viewHref;
    if (!href) return setState((current) => ({ ...current, error: "This document capability could not be decrypted." }));
    const capabilityUrl = new URL(href, collaboration.pfdocsOrigin);
    if (capabilityUrl.origin !== new URL(collaboration.pfdocsOrigin).origin || !/^\/(pad|sheet|code|slide)\//.test(capabilityUrl.pathname)) {
      return setState((current) => ({ ...current, error: "Blocked an invalid PFDocs capability URL." }));
    }
    const requestId = newUuid();
    const documentType = capabilityUrl.pathname === "/sheet/" ? "sheet" : "pad";
    setState((current) => ({ ...current, error: "" }));
    setEditorFullContext(false);
    setEditorLoading(true);
    setEditor({
      channelHash: document.channelHash,
      documentId: document.documentId,
      documentType,
      requestId,
      title: metadata?.title || "Encrypted document",
      url: pfdocsBridgeUrl({
        action: "open",
        documentType,
        href: capabilityUrl.toString(),
        origin: collaboration.pfdocsOrigin,
        bridgePath: collaboration.pfdocsBridgePath,
        requestId,
      }),
    });
  }

  function closeEditor() {
    const pending = pendingCreateRef.current;
    if (pending) {
      window.clearTimeout(pending.timeout);
      pendingCreateRef.current = null;
      pending.reject(new Error("Document creation was cancelled."));
    }
    setEditor(null);
    setEditorLoading(false);
    setEditorMenu("");
    setEditorFullContext(false);
    setEditorImport({ message: "", tone: "" });
  }

  function sendEditorCommand(command, payload = {}) {
    if (!editor?.channelHash || !editorFrameRef.current?.contentWindow || !collaboration.pfdocsOrigin) return;
    editorFrameRef.current.contentWindow.postMessage({
      type: "tasknode.pfdocs.command",
      requestId: editor.requestId,
      channelHash: editor.channelHash,
      command,
      ...payload,
    }, new URL(collaboration.pfdocsOrigin).origin);
    setEditorMenu("");
  }

  function chooseEditorImportFile() {
    editorImportRef.current?.click();
    setEditorMenu("");
  }

  async function importEditorFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!supportedPfdocsImport(file)) {
      setEditorImport({ message: "Choose a Markdown, text, or HTML file.", tone: "error" });
      return;
    }
    if (file.size > PFDOCS_IMPORT_MAX_BYTES) {
      setEditorImport({ message: "Document imports must be 8 MB or smaller.", tone: "error" });
      return;
    }
    try {
      const content = await file.text();
      if (!content.trim()) throw new Error("That file is empty.");
      setEditorImport({ message: `Importing ${file.name}…`, tone: "pending" });
      sendEditorCommand("import-content", {
        file: {
          name: file.name,
          mimeType: file.type || "text/plain",
          content,
        },
      });
    } catch (error) {
      setEditorImport({ message: error?.message || "Could not read that file.", tone: "error" });
    }
  }

  async function saveDocumentTitle(document, requestedTitle) {
    if (!document?.owned || !walletSecret?.mnemonic || !rootKeyRef.current) return;
    const current = decrypted[document.documentId];
    const title = String(requestedTitle || "").trim().slice(0, 180);
    if (!current || !title || title === current.title) {
      setEditorTitleDraft(current?.title || title || "Untitled document");
      return;
    }
    setBusy("editor-title");
    try {
      const nextMetadata = { ...current, title };
      const encryptedMetadata = await encryptDocsMetadata(nextMetadata, rootKeyRef.current);
      const result = await requestJson(`/api/docs/documents/${document.documentId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ encryptedMetadata }),
      });
      if (!result.ok) throw new Error(errorText(result, "Could not rename document."));
      setDecrypted((entries) => ({ ...entries, [document.documentId]: nextMetadata }));
      setEditor((currentEditor) => currentEditor?.documentId === document.documentId ? { ...currentEditor, title } : currentEditor);
      setEditorTitleDraft(title);
      sendEditorCommand("set-title", { title });
    } catch (error) {
      setState((currentState) => ({ ...currentState, error: error.message }));
      setEditorTitleDraft(current.title || "Untitled document");
    } finally { setBusy(""); }
  }

  async function archiveDocument(document) {
    setBusy(document.documentId);
    const result = await requestJson(`/api/docs/documents/${document.documentId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: document.status === "archived" ? "active" : "archived" }),
    });
    if (!result.ok) setState((current) => ({ ...current, error: errorText(result, "Could not update document.") }));
    await load();
    setBusy("");
  }

  async function renameDocument(document, title) {
    if (!title.trim()) throw new Error("Enter a document name.");
    await saveDocumentTitle(document, title);
  }

  function exportRecoveryPackage() {
    const packageBody = {
      schema: "tasknode.docs.recovery.v1",
      exportedAt: new Date().toISOString(),
      account: state.data.account,
      documents: state.data.documents,
      note: "Capabilities and metadata remain encrypted to the wallet used by this Docs library.",
    };
    const blob = new Blob([JSON.stringify(packageBody, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `tasknode-docs-recovery-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function openShareDialog(document) {
    setShare(document);
    setShareTarget("");
    setSelectedShareTarget(null);
    setShareTargetError("");
    setShareSuggestions([]);
    setShareRole("viewer");
    setShareLinkState({ copied: "", error: "" });
  }

  function closeShareDialog() {
    setShare(null);
    setShareTarget("");
    setSelectedShareTarget(null);
    setShareTargetError("");
    setShareSuggestions([]);
    setShareLinkState({ copied: "", error: "" });
  }

  async function copyDocumentShareLink(access) {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    const href = access === "edit"
      ? decrypted[share?.documentId]?.editHref
      : decrypted[share?.documentId]?.viewHref;
    const shareUrl = pfdocsShareUrl({
      access,
      href,
      origin: collaboration.pfdocsOrigin,
    });
    if (!shareUrl) {
      setShareLinkState({ copied: "", error: `This document does not have a valid ${access} link.` });
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setShareLinkState({ copied: "", error: "Clipboard access is unavailable in this browser." });
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareLinkState({ copied: access, error: "" });
      window.setTimeout(() => {
        setShareLinkState((current) => current.copied === access ? { copied: "", error: "" } : current);
      }, 1800);
    } catch {
      setShareLinkState({ copied: "", error: "Could not copy the link. Check this browser's clipboard permission." });
    }
  }

  function chooseShareTarget(identity) {
    setSelectedShareTarget(identity);
    setShareTarget(shareTargetInput(identity));
    setShareTargetError("");
  }

  function openTaskLinkDialog(document) {
    setTaskLinkDocument(document);
    setTaskQuery("");
    setSelectedTaskId("");
  }

  async function updateTaskLink(document, action, taskId = "") {
    if (!taskId) return;
    setBusy(document.documentId);
    const result = await requestJson(`/api/docs/documents/${document.documentId}/tasks`, {
      method: action === "unlink" ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    if (!result.ok) {
      setState((current) => ({ ...current, error: errorText(result, "Could not update task link.") }));
    } else if (action === "unlink") {
      setTaskLinkDocument((current) => current?.documentId === document.documentId ? { ...current, taskIds: current.taskIds.filter((id) => id !== taskId) } : current);
    } else if (action === "link") {
      setTaskLinkDocument(null);
      setTaskQuery("");
      setSelectedTaskId("");
    }
    await load();
    setBusy("");
  }

  async function sendShare() {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    if (!validShareTarget) {
      setShareTargetError("Select a valid Task Node member from the suggestions.");
      return;
    }
    setBusy("share");
    try {
      const identityResult = await requestJson(
        `/api/collaboration/encryption-identity?q=${encodeURIComponent(shareTargetInput(selectedShareTarget))}`
      );
      if (!identityResult.ok) throw new Error(errorText(identityResult, "Member not found or has no encryption key."));
      const recipient = identityResult.body;
      if (recipient.accountId !== selectedShareTarget.accountId) {
        throw new Error("That member changed. Select them again before sharing.");
      }
      const metadata = decrypted[share.documentId];
      const capability = {
        title: metadata.title,
        viewHref: metadata.viewHref,
        editHref: shareRole === "editor" ? metadata.editHref : undefined,
        ownerAccountId: share.ownerAccountId,
      };
      const encryptedCapabilityEnvelope = await encryptForTaskNodeWallet(
        capability,
        [recipient.encryptionPublicKey],
        walletSecret
      );
      const payload = {
        recipientAccountId: recipient.accountId,
        recipientWalletAddress: recipient.walletAddress,
        accessRole: shareRole,
        encryptedCapabilityEnvelope,
      };
      const signedPayload = { documentId: share.documentId, ...payload };
      const proof = await signedCollaborationProof({ action: "docs_share", resourceId: share.documentId, payload: signedPayload, walletSecret });
      const result = await requestJson(`/api/docs/documents/${share.documentId}/share`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, proof }),
      });
      if (!result.ok) throw new Error(errorText(result, "Could not share document."));
      closeShareDialog();
      await load();
    } catch (error) { setShareTargetError(error.message); }
    finally { setBusy(""); }
  }

  async function actOnShare(grantId, action) {
    setBusy(grantId);
    const result = await requestJson(`/api/docs/shares/${grantId}/action`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    });
    if (!result.ok) setState((current) => ({ ...current, error: errorText(result, "Could not update share." ) }));
    await load();
    setBusy("");
  }

  const activeMetadata = editor?.documentId ? decrypted[editor.documentId] : null;
  const activeDocument = editor?.documentId ? state.data?.documents?.find((document) => document.documentId === editor.documentId) : null;
  const shareDialog = share && (
    <div className="collab-dialog-backdrop" onMouseDown={closeShareDialog}>
      <section className="collab-dialog docs-share-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Share document</h2>
        <p>Choose link access or share securely with a Task Node member.</p>
        <section aria-labelledby="docs-link-access-title" className="docs-link-share">
          <header className="docs-link-share-heading">
            <div>
              <h3 id="docs-link-access-title">Link access</h3>
              <p>For people outside Task Node</p>
            </div>
          </header>
          <div aria-label="Document link access" className="docs-link-actions" role="group">
            <button onClick={() => copyDocumentShareLink("view")} type="button">
              {shareLinkState.copied === "view" ? <CheckCircle2 aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
              <span><strong>{shareLinkState.copied === "view" ? "View link copied" : "Copy view link"}</strong><small>Can read</small></span>
            </button>
            <button onClick={() => copyDocumentShareLink("edit")} type="button">
              {shareLinkState.copied === "edit" ? <CheckCircle2 aria-hidden="true" size={16} /> : <Pencil aria-hidden="true" size={16} />}
              <span><strong>{shareLinkState.copied === "edit" ? "Edit link copied" : "Copy edit link"}</strong><small>Can make changes</small></span>
            </button>
          </div>
          <p className="docs-capability-note" role="note">
            <LockKeyhole aria-hidden="true" size={14} />
            <span><strong>Links include the document’s decryption key.</strong> Anyone with a link can keep or forward its access, and Task Node cannot revoke it.</span>
          </p>
          <span aria-live="polite" className="docs-share-link-feedback">
            {shareLinkState.error}
          </span>
        </section>
        <h3 className="docs-member-share-title">Task Node access</h3>
        {(share.shares || []).length > 0 && (
          <section className="docs-current-access">
            <h3>People with access</h3>
            {(share.shares || []).map((grant) => (
              <div key={grant.grantId}>
                <span><strong>{grant.recipient.displayName}</strong><small>{grant.recipient.hiveHandle ? `@${grant.recipient.hiveHandle}` : grant.recipient.walletAddress}</small></span>
                <span className={`docs-share-status ${grant.status}`}>{grant.accessRole} · {grant.status}</span>
              </div>
            ))}
          </section>
        )}
        <label>
          Task Node member
          <div className="docs-combobox">
            <input
              aria-autocomplete="list"
              aria-controls="docs-share-suggestions"
              aria-expanded={shareSuggestions.length > 0}
              autoComplete="off"
              autoFocus
              onChange={(event) => {
                setShareTarget(event.target.value);
                setSelectedShareTarget(null);
                setShareTargetError("");
              }}
              placeholder="Type @ to find a teammate"
              role="combobox"
              value={shareTarget}
            />
            <div className="docs-combobox-menu" id="docs-share-suggestions" role="listbox">
              {shareSuggestions.map((identity) => (
                <button
                  aria-selected={selectedShareTarget?.accountId === identity.accountId}
                  key={identity.accountId}
                  onClick={() => chooseShareTarget(identity)}
                  role="option"
                  type="button"
                >
                  <span><strong>{identity.displayName}</strong><small>{identity.hiveHandle ? `@${identity.hiveHandle}` : identity.walletAddress}</small></span>
                  {identity.recentlyShared && <em>Recent</em>}
                </button>
              ))}
              {shareSuggestionsLoading && <small className="docs-combobox-state">Finding teammates…</small>}
              {!shareSuggestionsLoading && shareTarget.trim() && !shareSuggestions.length && <small className="docs-combobox-state">No valid Task Node member found.</small>}
            </div>
          </div>
        </label>
        {shareTargetError && <small className="collab-error docs-field-error">{shareTargetError}</small>}
        <label>Access<select onChange={(event) => setShareRole(event.target.value)} value={shareRole}><option value="viewer">Can view</option><option value="editor">Can edit</option></select></label>
        <div className="docs-dialog-actions"><button onClick={closeShareDialog} type="button">Cancel</button><button className="collab-primary" disabled={!validShareTarget || busy === "share"} onClick={sendShare} type="button">{busy === "share" ? "Sharing…" : "Share securely"}</button></div>
      </section>
    </div>
  );
  const taskLinkDialog = taskLinkDocument && (
    <div className="collab-dialog-backdrop" onMouseDown={() => setTaskLinkDocument(null)}>
      <section className="collab-dialog docs-task-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Link an active task</h2>
        <p>Select from your current outstanding and verification tasks.</p>
        <label>
          Search tasks
          <input autoComplete="off" autoFocus onChange={(event) => setTaskQuery(event.target.value)} placeholder="Search by title or task ID" value={taskQuery} />
        </label>
        {taskLinkDocument.taskIds?.length > 0 && <section className="docs-current-access"><h3>Linked tasks</h3>{taskLinkDocument.taskIds.map((taskId) => <div key={taskId}><span><small>{taskId}</small></span><button disabled={Boolean(busy)} onClick={() => updateTaskLink(taskLinkDocument, "unlink", taskId)} type="button">Remove link</button></div>)}</section>}
        <div className="docs-task-options" role="listbox">
          {filteredTaskOptions.map((task) => (
            <button aria-selected={selectedTaskId === task.taskId} key={task.taskId} onClick={() => setSelectedTaskId(task.taskId)} role="option" type="button">
              <span><strong>{task.title}</strong><small>{task.taskId}</small></span><em>{task.status}</em>
            </button>
          ))}
          {!filteredTaskOptions.length && <small>{activeTaskOptions.length ? "No active task matches that search." : "You have no active tasks to link."}</small>}
        </div>
        <div className="docs-dialog-actions"><button onClick={() => setTaskLinkDocument(null)} type="button">Cancel</button><button className="collab-primary" disabled={!selectedTaskId || busy === taskLinkDocument.documentId} onClick={() => updateTaskLink(taskLinkDocument, "link", selectedTaskId)} type="button">{busy === taskLinkDocument.documentId ? "Linking…" : "Link task"}</button></div>
      </section>
    </div>
  );

  if (!signedIn) return (
    <div className="collab-route-state docs-onboarding">
      <LockKeyhole size={30} />
      <h1>Docs</h1>
      <p>Sign in to access your wallet-bound encrypted document library and documents shared with your Task Node identity.</p>
      <button onClick={onLogin} type="button">Sign in to use Docs</button>
    </div>
  );

  if (!walletSecret?.mnemonic) return (
    <div className="docs-browser docs-locked-page">
      <header className="docs-library-heading"><div><h1>Docs</h1><p>Your private workspace for documents and spreadsheets.</p></div></header>
      <section className="docs-unlock-panel">
        <div className="docs-unlock-icon"><LockKeyhole size={26} /></div>
        <h2>Unlock your Docs</h2>
        <p>Unlock your wallet to open your documents, spreadsheets, and folders.</p>
        <button className="docs-solid-button" onClick={onWalletUnlock} type="button"><LockKeyhole size={15} />Unlock</button>
        <small>End-to-end encrypted. Only you hold the key.</small>
      </section>
    </div>
  );

  if (state.loading && !state.data) return <div className="collab-route-state">Loading Docs…</div>;
  if (!state.data?.account) return (
    <div className="collab-route-state docs-onboarding">
      <LockKeyhole size={30} />
      <h1>Docs</h1>
      <p>Keep documents and spreadsheets together in a private, encrypted workspace.</p>
      <button disabled={busy === "setup"} onClick={setupLibrary} type="button">{busy === "setup" ? "Creating…" : walletVault?.unlocked ? "Create Docs library" : "Unlock wallet to continue"}</button>
      {!editorReady && <small className="collab-degraded">The Docs library is available. New document editing is temporarily unavailable while the encrypted PFDocs connection is brought online.</small>}
      {state.error && <small className="collab-error">{state.error}</small>}
    </div>
  );

  if (state.data?.account && (!hydratedData || hydratedData.account?.accountId !== state.data.account?.accountId) && !editor) return <div className="docs-browser docs-library-loading" role="status">Opening your library…</div>;

  if (editor) return (
    <div className="docs-editor-workspace">
      <input
        ref={editorImportRef}
        accept={PFDOCS_IMPORT_ACCEPT}
        className="docs-editor-import-input"
        onChange={importEditorFile}
        type="file"
      />
      <header className="docs-editor-header">
        <div className="docs-editor-header-main">
          <button className="docs-editor-back" onClick={closeEditor} type="button"><ArrowLeft size={15} />Docs</button>
          <div className="docs-editor-title-block">
            <input
              aria-label="Document title"
              disabled={!activeDocument?.owned || busy === "editor-title"}
              maxLength={180}
              onBlur={() => void saveDocumentTitle(activeDocument, editorTitleDraft)}
              onChange={(event) => setEditorTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setEditorTitleDraft(activeMetadata?.title || editor.title);
                  event.currentTarget.blur();
                }
              }}
              value={editorTitleDraft}
            />
            <div className="docs-editor-meta"><span><i />End-to-end encrypted</span><b>·</b><span><CheckCircle2 size={12} />{busy === "editor-title" ? "Saving…" : "Saved"}</span></div>
          </div>
        </div>
        <div className="docs-editor-actions">
          {editor.documentType !== "sheet" && <div className="docs-editor-menu">
            <button aria-expanded={editorMenu === "file"} onClick={() => setEditorMenu((current) => current === "file" ? "" : "file")} type="button"><FileText size={14} />File<ChevronDown size={12} /></button>
            {editorMenu === "file" && <div className="docs-editor-menu-popover">
              <button onClick={chooseEditorImportFile} type="button"><FileUp size={15} /><span>Import</span><small>.md, .txt, .html</small></button>
              <button onClick={() => sendEditorCommand("export")} type="button"><Download size={15} /><span>Export</span></button>
              <button onClick={() => sendEditorCommand("history")} type="button"><History size={15} /><span>Version history</span></button>
            </div>}
          </div>}
          {activeDocument?.owned && <button className="docs-editor-access" onClick={() => openShareDialog(activeDocument)} type="button"><LockKeyhole size={14} />Access</button>}
          {activeDocument?.owned && <button className="docs-editor-share" onClick={() => openShareDialog(activeDocument)} type="button"><Share2 size={14} />Share</button>}
          <span className="docs-editor-divider" />
          {<label className="docs-editor-context-toggle" title="Include your Task Node context, memory, and recent tasks in @ODV and @coach requests">
            <input aria-label="Include full Task Node context" checked={editorFullContext} onChange={(event) => setEditorFullContext(event.target.checked)} type="checkbox" />
            <span>Full context</span>
          </label>}
          {<button className="docs-editor-chat" disabled={editorLoading || !editor.channelHash} onClick={() => sendEditorCommand("chat-toggle")} type="button"><MessageSquare size={14} />Chat</button>}
        </div>
      </header>
      {state.error && <p className="collab-error docs-editor-error">{state.error}</p>}
      {editorImport.message && <p className={`docs-editor-import-status ${editorImport.tone}`} role="status">{editorImport.message}</p>}
      <iframe
        allow="clipboard-read; clipboard-write"
        ref={editorFrameRef}
        referrerPolicy="no-referrer"
        src={editor.url}
        title={activeMetadata?.title || editor.title}
      />
      {editorLoading && <div className="docs-editor-loading" role="status"><span /><strong>Opening encrypted document…</strong></div>}
      {shareDialog}
    </div>
  );

  return (
    <>
      <DocsLibraryBrowser
        documents={state.data.documents || []} decrypted={decrypted} library={library}
        folderId={folderId} onFolderChange={setFolderId} onLibraryChange={saveLibrary}
        busy={busy || (decryption.loading ? "unlocking" : "")} editorReady={editorReady} onCreate={createDocument} onOpen={openDocument}
        onRename={renameDocument} onArchive={archiveDocument} onShare={openShareDialog}
        onTaskLink={openTaskLinkDialog} onRefresh={load} onExport={exportRecoveryPackage}
      >
        {!editorReady && <p className="docs-library-notice">The editor is temporarily unavailable. Your files and folders are still here.</p>}
        {state.error && <p className="docs-library-notice error" role="alert">{state.error}</p>}
        {libraryError && <p className="docs-library-notice error" role="alert">{libraryError}</p>}
        {!decryption.loading && Object.keys(decryption.failures).length > 0 && <p className="docs-library-notice error">Some documents could not be unlocked with this wallet.</p>}
        {(state.data.pendingShares || []).length > 0 && <section className="collab-pending docs-pending-shares"><h2>Shared with you</h2>{state.data.pendingShares.map((grant) => <div key={grant.grantId}><span><strong>{grant.owner.displayName}</strong> shared a document · {grant.accessRole}</span><span><button disabled={Boolean(busy)} onClick={() => actOnShare(grant.grantId, "decline")} type="button">Decline</button><button disabled={Boolean(busy)} onClick={() => actOnShare(grant.grantId, "accept")} type="button">Accept</button></span></div>)}</section>}
      </DocsLibraryBrowser>
      {shareDialog}
      {taskLinkDialog}
    </>
  );
}

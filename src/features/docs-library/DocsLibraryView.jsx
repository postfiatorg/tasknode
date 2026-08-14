import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Download, FilePlus2, FileText, FileUp, History, Link2, LockKeyhole, MessageSquare, Pencil, RefreshCw, Share2, Users } from "lucide-react";
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
  shareTargetInput,
  validSelectedShareTarget,
} from "./docs-library-options";
import "./docs-library.css";

function errorText(result, fallback) {
  return result?.body?.error || fallback;
}

function pfdocsBridgeUrl({ action, href = "", origin, bridgePath, requestId }) {
  const target = new URL(bridgePath || "/tasknode/", origin);
  target.searchParams.set("action", action);
  target.searchParams.set("requestId", requestId);
  target.searchParams.set("returnOrigin", window.location.origin);
  if (href) target.hash = new URL(href, origin).hash;
  return target.toString();
}

function docsChatIdentity(identity = {}) {
  const handle = String(identity.hiveHandle || "").trim().replace(/^@/, "");
  const walletAddress = String(identity.walletAddress || "").trim();
  return {
    accountId: String(identity.accountId || "").trim(),
    displayName: handle ? `@${handle}` : walletAddress || String(identity.displayName || "Task Node member").trim(),
    hiveHandle: handle,
    walletAddress,
  };
}

export function DocsLibraryView({ collaboration = {}, onLogin, onWalletUnlock, signedIn = false, tasks = {}, walletSecret, walletVault }) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  const [decryption, setDecryption] = useState({ failures: {}, loading: false });
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState("all");
  const [decrypted, setDecrypted] = useState({});
  const [share, setShare] = useState(null);
  const [shareTarget, setShareTarget] = useState("");
  const [shareTargetError, setShareTargetError] = useState("");
  const [shareSuggestions, setShareSuggestions] = useState([]);
  const [shareSuggestionsLoading, setShareSuggestionsLoading] = useState(false);
  const [selectedShareTarget, setSelectedShareTarget] = useState(null);
  const [shareRole, setShareRole] = useState("viewer");
  const [taskLinkDocument, setTaskLinkDocument] = useState(null);
  const [taskQuery, setTaskQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [editor, setEditor] = useState(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorMenu, setEditorMenu] = useState("");
  const [editorTitleDraft, setEditorTitleDraft] = useState("");
  const [editorFullContext, setEditorFullContext] = useState(false);
  const editorFrameRef = useRef(null);
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
      odv: { enabled: collaboration.docsOdvEnabled === true, mention: "@ODV", model: "z-ai/glm-5.2", provider: "ambient" },
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
            model: result.body?.model || "z-ai/glm-5.2",
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
            model: "z-ai/glm-5.2",
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
      if (!walletSecret?.mnemonic || !state.data) {
        rootKeyRef.current = "";
        setDecrypted({});
        setDecryption({ failures: {}, loading: false });
        return;
      }
      rootKeyRef.current = "";
      setDecryption({ failures: {}, loading: true });
      try {
        let rootKey = "";
        if (state.data.account?.encryptedRootKeyEnvelope) {
          const root = await decryptFromTaskNodeWallet(state.data.account.encryptedRootKeyEnvelope, walletSecret);
          rootKey = root.rootKey || "";
          rootKeyRef.current = rootKey;
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
        if (!cancelled) setDecryption({
          failures: Object.fromEntries(
            (state.data.documents || []).map((document) => [document.documentId, error?.message || "decryption_failed"])
          ),
          loading: false,
        });
      }
    }
    hydrate();
    return () => { cancelled = true; };
  }, [state.data, walletSecret]);

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

  async function createDocument() {
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
      setEditor({ documentId, requestId, title: "Creating encrypted document…", url });
      const capability = await capabilityPromise;
      const title = `Untitled document ${new Date().toLocaleDateString()}`;
      const metadata = { title, editHref: capability.editHref, viewHref: capability.viewHref, createdAt: new Date().toISOString() };
      const encryptedMetadata = await encryptDocsMetadata(metadata, rootKeyRef.current);
      const payload = { documentId, channelHash: capability.channelHash, encryptedMetadata };
      const proof = await signedCollaborationProof({ action: "docs_create", resourceId: documentId, payload, walletSecret });
      const result = await requestJson("/api/docs/documents", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, proof }),
      });
      if (!result.ok) throw new Error(errorText(result, "Could not save document metadata."));
      setEditor((current) => current?.requestId === requestId ? { ...current, channelHash: capability.channelHash, title } : current);
      await load();
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
    setState((current) => ({ ...current, error: "" }));
    setEditorFullContext(false);
    setEditorLoading(true);
    setEditor({
      channelHash: document.channelHash,
      documentId: document.documentId,
      requestId,
      title: metadata?.title || "Encrypted document",
      url: pfdocsBridgeUrl({
        action: "open",
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

  async function renameDocument(document) {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    const current = decrypted[document.documentId];
    const title = window.prompt("Document title", current?.title || "Untitled document")?.trim();
    if (!title || title === current?.title) return;
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
  }

  function closeShareDialog() {
    setShare(null);
    setShareTarget("");
    setSelectedShareTarget(null);
    setShareTargetError("");
    setShareSuggestions([]);
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

  const documents = useMemo(() => (state.data?.documents || []).filter((document) => {
    if (filter === "shared") return !document.owned || document.collaboratorCount > 0;
    if (filter === "archived") return document.status === "archived";
    return document.status !== "archived";
  }), [filter, state.data]);
  const activeMetadata = editor?.documentId ? decrypted[editor.documentId] : null;
  const activeDocument = editor?.documentId ? state.data?.documents?.find((document) => document.documentId === editor.documentId) : null;
  const shareDialog = share && (
    <div className="collab-dialog-backdrop" onMouseDown={closeShareDialog}>
      <section className="collab-dialog docs-share-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Share document</h2>
        <p>Send an encrypted capability through Task Node. The server never receives the PFDocs link in plaintext.</p>
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

  if (state.loading && !state.data) return <div className="collab-route-state">Loading Docs…</div>;
  if (!state.data?.account) return (
    <div className="collab-route-state docs-onboarding">
      <LockKeyhole size={30} />
      <h1>Docs</h1>
      <p>Create a wallet-bound library. Task Node stores encrypted capabilities; PFDocs stores the encrypted document.</p>
      <button disabled={busy === "setup"} onClick={setupLibrary} type="button">{busy === "setup" ? "Creating…" : walletVault?.unlocked ? "Create Docs library" : "Unlock wallet to continue"}</button>
      {!editorReady && <small className="collab-degraded">The Docs library is available. New document editing is temporarily unavailable while the encrypted PFDocs connection is brought online.</small>}
      {state.error && <small className="collab-error">{state.error}</small>}
    </div>
  );

  if (editor) return (
    <div className="docs-editor-workspace">
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
          <div className="docs-editor-menu">
            <button aria-expanded={editorMenu === "file"} onClick={() => setEditorMenu((current) => current === "file" ? "" : "file")} type="button"><FileText size={14} />File<ChevronDown size={12} /></button>
            {editorMenu === "file" && <div className="docs-editor-menu-popover">
              <button onClick={() => sendEditorCommand("import")} type="button"><FileUp size={15} /><span>Import</span><small>.md, .docx</small></button>
              <button onClick={() => sendEditorCommand("export")} type="button"><Download size={15} /><span>Export</span></button>
              <button onClick={() => sendEditorCommand("history")} type="button"><History size={15} /><span>Version history</span></button>
            </div>}
          </div>
          {activeDocument?.owned && <button className="docs-editor-access" onClick={() => openShareDialog(activeDocument)} type="button"><LockKeyhole size={14} />Access</button>}
          {activeDocument?.owned && <button className="docs-editor-share" onClick={() => openShareDialog(activeDocument)} type="button"><Share2 size={14} />Share</button>}
          <span className="docs-editor-divider" />
          <label className="docs-editor-context-toggle" title="Include your Task Node context, memory, and recent tasks in @ODV and @coach requests">
            <input checked={editorFullContext} onChange={(event) => setEditorFullContext(event.target.checked)} type="checkbox" />
            <span>Full context</span>
          </label>
          <button className="docs-editor-chat" onClick={() => sendEditorCommand("chat-toggle")} type="button"><MessageSquare size={14} />Chat</button>
        </div>
      </header>
      {state.error && <p className="collab-error docs-editor-error">{state.error}</p>}
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
    <div className="collab-page docs-library-page">
      <header className="collab-page-header">
        <div><span>{editorReady ? "PFDocs · end-to-end encrypted" : "Task Node Docs · encrypted library"}</span><h1>Docs</h1><p>Your documents and capabilities are linked to your Task Node wallet.</p></div>
        <div className="docs-header-actions"><button onClick={exportRecoveryPackage} type="button"><Download size={16} />Export recovery</button><button className="collab-primary" disabled={Boolean(busy) || !editorReady} onClick={createDocument} title={editorReady ? "Create an encrypted document" : "Encrypted editor temporarily unavailable"} type="button"><FilePlus2 size={16} />New document</button></div>
      </header>
      {!editorReady && <section className="collab-degraded"><strong>Encrypted editor temporarily unavailable</strong><span>You can access the native Docs screen and wallet-bound library now. Creating and opening document bodies will activate when the isolated PFDocs editor connection is healthy.</span></section>}
      <div className="collab-toolbar">
        {[["all", "My docs"], ["shared", "Shared"], ["archived", "Archived"]].map(([key, label]) => <button className={filter === key ? "active" : ""} key={key} onClick={() => setFilter(key)} type="button">{label}</button>)}
        <button aria-label="Refresh" className="collab-refresh" onClick={load} type="button"><RefreshCw size={15} /></button>
      </div>
      {state.error && <p className="collab-error">{state.error}</p>}
      {!decryption.loading && Object.keys(decryption.failures).length > 0 && <p className="collab-error">Some encrypted document capabilities could not be unlocked with the current wallet.</p>}
      {(state.data.pendingShares || []).length > 0 && <section className="collab-pending"><h2>Shared with you</h2>{state.data.pendingShares.map((grant) => <div key={grant.grantId}><span><strong>{grant.owner.displayName}</strong> shared a {grant.accessRole} capability</span><span><button onClick={() => actOnShare(grant.grantId, "decline")} type="button">Decline</button><button onClick={() => actOnShare(grant.grantId, "accept")} type="button">Accept</button></span></div>)}</section>}
      <section className="docs-grid">
        {documents.map((document) => {
          const metadata = decrypted[document.documentId];
          return <article className="doc-card" key={document.documentId}>
            <button className="doc-card-open" disabled={Boolean(decryption.failures[document.documentId])} onClick={() => openDocument(document)} type="button"><FileText size={22} /><span><strong>{metadata?.title || (decryption.loading ? "Unlocking document…" : walletSecret?.mnemonic ? "Encrypted document" : "Unlock to decrypt")}</strong><small>{document.owned ? "Owned by you" : `Shared by ${document.owner.displayName}`} · {document.accessRole}</small></span><ChevronRight size={15} /></button>
            {document.owned && document.shares?.length > 0 && <div className="doc-shared-with"><span>Shared with</span>{document.shares.map((grant) => <button key={grant.grantId} onClick={() => openShareDialog(document)} title={`${grant.recipient.displayName} · ${grant.accessRole} · ${grant.status}`} type="button">{grant.recipient.displayName}<small>{grant.status === "pending" ? "Pending" : grant.accessRole}</small></button>)}</div>}
            {document.taskIds?.length > 0 && <div className="doc-task-links">{document.taskIds.map((taskId) => <button key={taskId} onClick={() => document.owned && updateTaskLink(document, "unlink", taskId)} title={document.owned ? "Remove task link" : taskId} type="button"><Link2 size={11} />{taskId}</button>)}</div>}
            <footer><span><Users size={13} />{document.collaboratorCount || (document.owned ? 0 : 1)}</span>{document.owned && <span><button onClick={() => openTaskLinkDialog(document)} type="button"><Link2 size={13} />Task</button><button onClick={() => renameDocument(document)} type="button"><Pencil size={13} />Rename</button><button onClick={() => openShareDialog(document)} type="button"><Share2 size={13} />Share</button><button disabled={busy === document.documentId} onClick={() => archiveDocument(document)} type="button"><Archive size={13} />{document.status === "archived" ? "Restore" : "Archive"}</button></span>}</footer>
          </article>;
        })}
        {!documents.length && <div className="collab-empty">No documents in this view.</div>}
      </section>
      {shareDialog}
      {taskLinkDialog}
    </div>
  );
}

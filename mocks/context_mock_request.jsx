import React, { useEffect, useState } from "react";

/**
 * Current Task Node Official Context page.
 *
 * This is a design request artifact: it intentionally captures the current
 * production Context page shape so design can replace it. Do not treat this as
 * the target experience.
 */

const MOCK_CONTEXT = {
  document: {
    id: "ctx_current_request",
    revision: 12,
    title: "Task Node Context",
    canEdit: true,
    updatedAt: "2026-05-16T10:32:00.000Z",
    body:
      "Stable operating context:\n\n" +
      "- Prioritize production Task Node Official work over old PFTasks UI cleanup.\n" +
      "- Keep normal app access account-based. Wallet unlock is only for wallet-bound actions.\n" +
      "- Prefer concrete execution tasks and concise status notes.\n\n" +
      "Active projects:\n\n" +
      "- Production chat runtime.\n" +
      "- Account credit and usage ledger.\n" +
      "- Seed-wallet proof, local vault unlock, and historical PFTasks context hydration.\n\n" +
      "Constraints:\n\n" +
      "- Do not store plaintext seed phrases server-side.\n" +
      "- Do not hydrate encrypted historical context until the local vault is unlocked.\n" +
      "- Avoid rebuilding old PFTasks surfaces wholesale.",
  },
  savePath: "/api/context/edit/save",
  history: {
    revision: 4,
    canHydrate: true,
    pointerCount: 18,
    contextUpdateCount: 9,
    taskEventCount: 41,
    latestContextPointer: {
      cid: "bafybeigdyrztm3j5qwerasdfzxcvqwerasdfctxlatest001",
      createdAt: "2026-05-15T23:18:00.000Z",
    },
  },
};

const MOCK_WALLET_VAULT = {
  unlocked: false,
};

const MOCK_HYDRATED_CONTEXT = {
  title: "Historical PFT Context",
  decrypted: true,
  text:
    "Historical context imported from PFTasks:\n\n" +
    "- User prefers direct execution over long planning loops.\n" +
    "- When a concrete bug example is provided, repair the general boundary, not the literal case.\n" +
    "- Context payloads can be large and noisy, so the product needs clear review and merge controls.",
};

function requestJsonMock(_path, options = {}) {
  const parsed = options.body ? JSON.parse(options.body) : {};
  return Promise.resolve({
    ok: true,
    body: {
      document: {
        ...MOCK_CONTEXT.document,
        ...parsed,
        revision: MOCK_CONTEXT.document.revision + 1,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

function pickContextText(value) {
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

function pickContextTitle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Historical PFT Context";
  const title = value.title || value.name || value.contextTitle || value.context_title;
  return String(title || "Historical PFT Context").trim().slice(0, 120) || "Historical PFT Context";
}

function extractHydratedContext(payload, plaintext) {
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
    text: text.slice(0, 50000),
    rawPayload: source,
  };
}

function formatContextTimestamp(value) {
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

function ContextView({ context, onHydrateContext, walletVault }) {
  const initialDocument = context?.document || {};
  const savePath = context?.savePath || initialDocument.savePath || "/api/context/edit/save";
  const history = context?.history || {};
  const [documentState, setDocumentState] = useState(initialDocument);
  const [title, setTitle] = useState(initialDocument.title || "Task Node Context");
  const [body, setBody] = useState(initialDocument.body || "");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [hydratedContext, setHydratedContext] = useState(null);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateMessage, setHydrateMessage] = useState("");

  useEffect(() => {
    const nextDocument = context?.document || {};
    setDocumentState(nextDocument);
    setTitle(nextDocument.title || "Task Node Context");
    setBody(nextDocument.body || "");
    setSaveMessage("");
  }, [context?.document?.id, context?.document?.revision, context?.document?.updatedAt]);

  useEffect(() => {
    setHydratedContext(null);
    setHydrateMessage("");
  }, [history?.revision, history?.latestContextPointer?.cid]);

  const canEdit = Boolean(documentState.canEdit);
  const dirty = title !== (documentState.title || "Task Node Context") || body !== (documentState.body || "");
  const lastSaved = formatContextTimestamp(documentState.updatedAt);
  const latestContextPointer = history.latestContextPointer || null;
  const canHydrateLatest = Boolean(latestContextPointer?.cid && walletVault?.unlocked);

  const saveContext = async () => {
    if (!canEdit || saving) return;

    setSaving(true);
    setSaveMessage("");

    let result;
    try {
      result = await requestJsonMock(savePath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
    } catch {
      setSaveMessage("Context could not be saved.");
      setSaving(false);
      return;
    }

    if (!result.ok || !result.body?.document) {
      setSaveMessage(result.body?.message || "Context could not be saved.");
      setSaving(false);
      return;
    }

    setDocumentState(result.body.document);
    setTitle(result.body.document.title || "Task Node Context");
    setBody(result.body.document.body || "");
    setSaveMessage("Saved");
    setSaving(false);
  };

  const hydrateLatestContext = async () => {
    if (!latestContextPointer?.cid || hydrating) return;
    if (!walletVault?.unlocked) {
      setHydrateMessage("Unlock the local seed vault first.");
      return;
    }

    setHydrating(true);
    setHydrateMessage("");
    try {
      const result = await onHydrateContext?.(latestContextPointer);
      if (!result?.text) {
        setHydrateMessage("Context CID was fetched, but no readable context text was found.");
        setHydratedContext(null);
      } else {
        setHydratedContext(result);
        setHydrateMessage(result.decrypted ? "Context decrypted." : "Context fetched.");
      }
    } catch (error) {
      setHydrateMessage(error?.message || "Context could not be hydrated.");
      setHydratedContext(null);
    } finally {
      setHydrating(false);
    }
  };

  const applyHydratedContext = () => {
    if (!hydratedContext?.text) return;
    setTitle(hydratedContext.title || "Historical PFT Context");
    setBody(hydratedContext.text);
    setSaveMessage("Hydrated draft not saved");
  };

  return (
    <div className="route-scroll">
      <div className="context-view">
        <div className="route-heading context-heading">
          <div>
            <h1>Context</h1>
            <p>Keep the working instructions and preferences the assistant should remember.</p>
          </div>
          <div className="context-meta">
            <span>Revision {documentState.revision || 0}</span>
            <span>{lastSaved}</span>
          </div>
        </div>

        <section className="context-document" aria-label="Context document">
          <label className="context-field">
            <span>Title</span>
            <input
              className="context-title-input"
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Task Node Context"
              value={title}
            />
          </label>
          <label className="context-field">
            <span>Context document</span>
            <textarea
              className="context-body-input"
              maxLength={50000}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Add stable preferences, active projects, constraints, and working notes."
              value={body}
            />
          </label>
          <div className="context-actions">
            <div className="context-save-status" role="status">
              {!canEdit ? "Sign in to save context." : saveMessage || (dirty ? "Unsaved changes" : "All changes saved")}
            </div>
            <button
              className="dark-pill"
              disabled={!canEdit || !dirty || saving}
              onClick={saveContext}
              type="button"
            >
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </section>

        <section className="context-history" aria-label="Historical PFT context">
          <div>
            <h2>Historical PFT Context</h2>
            <p>
              {history.pointerCount
                ? `${history.pointerCount} indexed pointer${history.pointerCount === 1 ? "" : "s"} imported.`
                : history.canHydrate
                  ? "No indexed PFTasks history imported yet."
                  : "Sign in to import indexed PFTasks history."}
            </p>
          </div>
          <div className="context-history-grid">
            <span>
              <strong>{history.contextUpdateCount || 0}</strong>
              Context updates
            </span>
            <span>
              <strong>{history.taskEventCount || 0}</strong>
              Task events
            </span>
            <span>
              <strong>{history.latestContextPointer?.cid ? "Ready" : "Pending"}</strong>
              Latest pointer
            </span>
          </div>
          {history.latestContextPointer?.cid && (
            <div className="context-pointer-row">
              <span>{history.latestContextPointer.cid}</span>
              <small>{formatContextTimestamp(history.latestContextPointer.createdAt)}</small>
            </div>
          )}
          {latestContextPointer?.cid && (
            <div className="context-hydration-actions">
              <button
                className="dark-pill"
                disabled={!canHydrateLatest || hydrating}
                onClick={hydrateLatestContext}
                type="button"
              >
                {hydrating ? "Hydrating" : "Hydrate latest"}
              </button>
              <span>{walletVault?.unlocked ? "Local vault unlocked" : "Unlock wallet first"}</span>
            </div>
          )}
          {hydrateMessage && <div className="inline-message">{hydrateMessage}</div>}
          {hydratedContext?.text && (
            <div className="context-hydrated-preview">
              <div>
                <strong>{hydratedContext.title}</strong>
                <small>{hydratedContext.decrypted ? "Decrypted locally" : "Fetched"}</small>
              </div>
              <pre>{hydratedContext.text}</pre>
              <button className="light-pill" disabled={!canEdit} onClick={applyHydratedContext} type="button">
                Use as draft
              </button>
            </div>
          )}
          <div className="context-note context-history-note">
            Indexed PFTasks rows are normalized before live RPC fallback. Encrypted CID plaintext is decrypted only after wallet unlock.{" "}
            {walletVault?.unlocked ? "Your seed vault is unlocked for this session." : "Encrypted history stays pointer-only until the local vault is unlocked."}
          </div>
        </section>

        <div className="context-note">
          Context saves to your Task Node account first. Wallet signing is only for optional portable PFTL manifests.
        </div>
      </div>
    </div>
  );
}

export default function ContextMockRequest() {
  const [walletVault, setWalletVault] = useState(MOCK_WALLET_VAULT);

  const hydrateContextPointer = async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return {
      ...extractHydratedContext({ title: MOCK_HYDRATED_CONTEXT.title, body: MOCK_HYDRATED_CONTEXT.text }),
      decrypted: true,
    };
  };

  return (
    <main className="context-mock-shell">
      <style>{contextMockStyles}</style>
      <div className="context-mock-toolbar">
        <strong>Current Context Page Mock Request</strong>
        <button
          className="light-pill"
          onClick={() => setWalletVault((current) => ({ unlocked: !current.unlocked }))}
          type="button"
        >
          {walletVault.unlocked ? "Lock vault fixture" : "Unlock vault fixture"}
        </button>
      </div>
      <ContextView context={MOCK_CONTEXT} onHydrateContext={hydrateContextPointer} walletVault={walletVault} />
    </main>
  );
}

const contextMockStyles = `
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f7f5ee;
  color: #0d0d0d;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input,
textarea {
  font: inherit;
}

.context-mock-shell {
  min-height: 100vh;
  background: #f7f5ee;
}

.context-mock-toolbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid #e8e6df;
  background: rgba(247, 245, 238, 0.94);
  backdrop-filter: blur(14px);
}

.context-mock-toolbar strong {
  font-size: 13px;
  font-weight: 600;
}

.route-scroll {
  width: 100%;
  overflow-y: auto;
}

.context-view {
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 40px 32px 56px;
}

.route-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.route-heading h1 {
  margin: 0;
  color: #0d0d0d;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: 0;
}

.route-heading p {
  margin: 4px 0 0;
  color: #6b6b66;
  font-size: 13.5px;
}

.dark-pill,
.light-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
  border-radius: 999px;
  font-weight: 500;
  white-space: nowrap;
}

.dark-pill {
  padding: 0 16px;
  border: 0;
  background: #0d0d0d;
  color: #ffffff;
  font-size: 13.5px;
}

.light-pill {
  padding: 0 16px;
  border: 1px solid #e8e6df;
  background: #ffffff;
  color: #0d0d0d;
  font-size: 13.5px;
}

.context-heading {
  align-items: center;
}

.context-meta {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  color: #6b6b66;
  font-size: 12px;
}

.context-meta span {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid #e8e6df;
  border-radius: 999px;
  background: #ffffff;
}

.context-document {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid #e8e6df;
  border-radius: 12px;
  background: #ffffff;
}

.context-field {
  display: grid;
  gap: 8px;
}

.context-field span {
  color: #6b6b66;
  font-size: 12px;
  font-weight: 600;
}

.context-title-input,
.context-body-input {
  width: 100%;
  border: 1px solid #e8e6df;
  border-radius: 10px;
  background: #ffffff;
  color: #0d0d0d;
  font: inherit;
  outline: none;
}

.context-title-input:focus,
.context-body-input:focus {
  border-color: #0d0d0d;
  box-shadow: 0 0 0 3px rgba(13, 13, 13, 0.06);
}

.context-title-input {
  min-height: 44px;
  padding: 0 12px;
  font-size: 15px;
  font-weight: 600;
}

.context-body-input {
  min-height: clamp(220px, 32vh, 280px);
  padding: 14px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 13px;
  line-height: 1.55;
}

.context-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dark-pill:disabled,
.light-pill:disabled,
.context-actions .dark-pill:disabled,
.context-hydration-actions .dark-pill:disabled {
  cursor: default;
  opacity: 0.45;
}

.context-save-status {
  color: #6b6b66;
  font-size: 12.5px;
}

.context-note {
  margin-top: 24px;
  padding: 14px 16px;
  border: 1px solid #e8e6df;
  border-radius: 12px;
  background: #f4f3ee;
  color: #6b6b66;
  font-size: 12px;
  line-height: 1.5;
}

.context-history {
  display: grid;
  gap: 14px;
  margin-top: 24px;
  padding: 18px;
  border: 1px solid #e8e6df;
  border-radius: 12px;
  background: #ffffff;
}

.context-history h2 {
  margin: 0;
  color: #0d0d0d;
  font-size: 16px;
  font-weight: 600;
}

.context-history p {
  margin: 4px 0 0;
  color: #6b6b66;
  font-size: 12.5px;
  line-height: 1.45;
}

.context-history-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.context-history-grid span {
  display: grid;
  gap: 3px;
  min-height: 62px;
  padding: 10px 12px;
  border: 1px solid #e8e6df;
  border-radius: 10px;
  background: #faf9f6;
  color: #6b6b66;
  font-size: 12px;
}

.context-history-grid strong {
  color: #0d0d0d;
  font-size: 15px;
  font-weight: 600;
}

.context-pointer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e8e6df;
  border-radius: 10px;
  background: #faf9f6;
  color: #0d0d0d;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
}

.context-pointer-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-pointer-row small {
  flex: 0 0 auto;
  color: #6b6b66;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.context-hydration-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.context-hydration-actions span {
  color: #6b6b66;
  font-size: 12.5px;
}

.inline-message {
  padding: 10px 12px;
  border: 1px solid #e8e6df;
  border-radius: 10px;
  background: #faf9f6;
  color: #6b6b66;
  font-size: 12.5px;
}

.context-hydrated-preview {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid #d7eee5;
  border-radius: 12px;
  background: #f2fbf7;
}

.context-hydrated-preview > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.context-hydrated-preview strong {
  min-width: 0;
  overflow: hidden;
  color: #0d0d0d;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-hydrated-preview small {
  flex: 0 0 auto;
  color: #047857;
  font-size: 12px;
  font-weight: 600;
}

.context-hydrated-preview pre {
  max-height: 220px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  color: #0d0d0d;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12.5px;
  line-height: 1.55;
}

.context-hydrated-preview .light-pill {
  justify-self: start;
}

.context-history-note {
  margin-top: 0;
}

@media (max-width: 700px) {
  .context-mock-toolbar,
  .route-heading,
  .context-actions,
  .context-hydration-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .context-view {
    padding: 28px 16px 44px;
  }

  .context-history-grid {
    grid-template-columns: 1fr;
  }

  .context-meta {
    flex-wrap: wrap;
  }
}
`;

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, X } from "lucide-react";
import { newClientConversationId, newClientCorrelationId } from "../chat/chat-turns";
import { publishTaskRequest, taskRequestCanonicalText } from "./task-request-actions.js";
import { evaluateTaskRequestUnlockPolicy, TASK_REQUEST_UNLOCK_STATES } from "./task-request-unlock-policy.js";
import "./task-request.css";

export function TaskRequestModal({
  accountId = "",
  linkedWalletAddress = "",
  onClose,
  onRecorded,
  onWalletUnlock,
  walletSecret = null,
  walletUnlockPending = false,
  walletVault = {},
}) {
  const [detailText, setDetailText] = useState("");
  const [status, setStatus] = useState({ error: "", pending: false, pendingLabel: "", success: "" });
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef(null);
  const unlockPolicy = evaluateTaskRequestUnlockPolicy({
    accountId,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const walletReady = unlockPolicy.allowed;
  const canSubmit = Boolean(detailText.trim()) && !status.pending && walletReady;
  const walletLocked = unlockPolicy.state === TASK_REQUEST_UNLOCK_STATES.LOCKED;
  const vaultMissing = unlockPolicy.state === TASK_REQUEST_UNLOCK_STATES.NEEDS_LOCAL_VAULT;
  const unlockPending = unlockPolicy.state === TASK_REQUEST_UNLOCK_STATES.UNLOCK_PENDING;

  useEffect(() => {
    if (walletReady) textareaRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, walletReady]);

  async function submitTaskRequest(event) {
    event.preventDefault();
    const userDetailText = detailText.trim();
    if (!userDetailText || status.pending) return;
    if (!walletReady) {
      if (["unlock", "open_wallet"].includes(unlockPolicy.action)) onWalletUnlock?.();
      setStatus({
        error: unlockPolicy.message,
        pending: false,
        pendingLabel: "",
        success: "",
      });
      return;
    }

    setStatus({ error: "", pending: true, pendingLabel: "Configuring request", success: "" });
    const requestId = newClientCorrelationId("req");
    const bundleId = newClientCorrelationId("bundle");
    const conversationId = newClientConversationId();

    try {
      const result = await publishTaskRequest({
        accountId,
        linkedWalletAddress,
        walletSecret,
        requestId,
        bundleId,
        conversationId,
        requestText: taskRequestCanonicalText,
        userDetailText,
        requestedTaskKind: "personal",
        source: "task_interface",
        sourceConversationTitle: "Tasks",
        onProgress: (label) => {
          setStatus({ error: "", pending: true, pendingLabel: label, success: "" });
        },
      });

      setStatus({
        error: "",
        pending: false,
        pendingLabel: "",
        success: `Task request published to PFT. Transaction ${String(result.txHash || "").slice(0, 12)}...`,
      });
      setDetailText("");
      await onRecorded?.(result);
    } catch (error) {
      setStatus({
        error: error?.message || "Task request could not be published.",
        pending: false,
        pendingLabel: "",
        success: "",
      });
    }
  }

  const openUnlock = () => {
    if (status.pending) return;
    onWalletUnlock?.();
  };

  const primaryAction = unlockPending ? (
    <button className="task-request-primary" disabled type="button">
      Unlock pending
    </button>
  ) : walletLocked ? (
    <button className="task-request-primary" disabled={status.pending} onClick={openUnlock} type="button">
      Unlock wallet
    </button>
  ) : vaultMissing || !linkedWalletAddress ? (
    <button className="task-request-primary" disabled={status.pending} onClick={openUnlock} type="button">
      Open wallet
    </button>
  ) : (
    <button className="task-request-primary" disabled={!canSubmit} type="submit">
      {status.pending ? status.pendingLabel || "Publishing" : "Request task"}
      {!status.pending && <ArrowRight size={14} strokeWidth={2} />}
    </button>
  );

  return (
    <div className="modal-backdrop task-request-backdrop" onClick={onClose} role="presentation">
      <section
        aria-labelledby="task-request-title"
        aria-modal="true"
        className="task-request-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2 id="task-request-title">Request task</h2>
            <p>Describe the kind of work you want generated.</p>
            {!linkedWalletAddress && <p className="task-request-wallet-note">A linked PFT wallet is required.</p>}
            {vaultMissing && (
              <p className="task-request-wallet-note">Restore the local vault to sign the request.</p>
            )}
            {walletLocked && (
              <p className="task-request-wallet-note">Unlock your wallet to sign the request.</p>
            )}
            {unlockPending && (
              <p className="task-request-wallet-note">Finish the wallet unlock modal to continue.</p>
            )}
          </div>
          <button aria-label="Close" className="task-request-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.8} />
          </button>
        </header>

        <form onSubmit={submitTaskRequest}>
          <div className="task-request-body">
            <label htmlFor="task-request-details">Task details</label>
            <div className={`task-request-textarea-shell${focused ? " is-focused" : ""}`}>
              <textarea
                id="task-request-details"
                ref={textareaRef}
                disabled={status.pending}
                onChange={(event) => {
                  setDetailText(event.target.value);
                  if (status.error || status.success) {
                    setStatus({ error: "", pending: false, pendingLabel: "", success: "" });
                  }
                }}
                onBlur={() => setFocused(false)}
                onFocus={() => setFocused(true)}
                placeholder="Example: Give me a 2-4 hour engineering task that advances the PFTL task engine and has concrete verification evidence."
                rows={5}
                value={detailText}
              />
            </div>

            {status.error && (
              <p className="task-request-message is-error">
                <AlertTriangle size={14} strokeWidth={1.8} />
                {status.error}
              </p>
            )}
            {status.success && (
              <p className="task-request-message">
                <Check size={14} strokeWidth={2.2} />
                {status.success}
              </p>
            )}
            {status.pending && (
              <p className="task-request-message">
                <Check size={14} strokeWidth={2.2} />
                {status.pendingLabel || "Publishing to PFTL"}
              </p>
            )}
          </div>

          <footer>
            <button className="task-request-text-button" onClick={onClose} type="button">
              Close
            </button>
            {primaryAction}
          </footer>
        </form>
      </section>
    </div>
  );
}

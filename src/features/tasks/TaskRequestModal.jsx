import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Send, X } from "lucide-react";
import { newClientConversationId, newClientCorrelationId } from "../chat/chat-turns";
import { publishTaskRequest, taskRequestCanonicalText } from "./task-request-actions.js";
import "./task-request.css";

export function TaskRequestModal({
  accountId = "",
  linkedWalletAddress = "",
  onClose,
  onRecorded,
  onWalletUnlock,
  walletSecret = null,
  walletVault = {},
}) {
  const [detailText, setDetailText] = useState("");
  const [status, setStatus] = useState({ error: "", pending: false, success: "" });
  const textareaRef = useRef(null);
  const vaultUnlocked = Boolean(
    walletVault?.unlocked &&
      walletVault?.address &&
      linkedWalletAddress &&
      walletVault.address === linkedWalletAddress
  );
  const walletReady = Boolean(accountId && linkedWalletAddress && walletSecret?.mnemonic && vaultUnlocked);
  const canSubmit = Boolean(detailText.trim()) && !status.pending && walletReady;

  useEffect(() => {
    textareaRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function submitTaskRequest(event) {
    event.preventDefault();
    const userDetailText = detailText.trim();
    if (!userDetailText || status.pending) return;
    if (!accountId || !linkedWalletAddress) {
      setStatus({
        error: "Link a PFT wallet before requesting a task.",
        pending: false,
        success: "",
      });
      return;
    }
    if (!walletReady) {
      onWalletUnlock?.();
      setStatus({
        error: "Unlock the linked wallet, then publish the request.",
        pending: false,
        success: "",
      });
      return;
    }

    setStatus({ error: "", pending: true, success: "" });
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
      });

      setStatus({
        error: "",
        pending: false,
        success: `Task request published to PFT. Transaction ${String(result.txHash || "").slice(0, 12)}...`,
      });
      setDetailText("");
      await onRecorded?.(result);
    } catch (error) {
      setStatus({
        error: error?.message || "Task request could not be published.",
        pending: false,
        success: "",
      });
    }
  }

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
            {linkedWalletAddress && !vaultUnlocked && (
              <p className="task-request-wallet-note">Unlock your wallet to sign the request.</p>
            )}
          </div>
          <button aria-label="Close" className="task-request-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.8} />
          </button>
        </header>

        <form onSubmit={submitTaskRequest}>
          <label>
            Task details
            <textarea
              ref={textareaRef}
              disabled={status.pending}
              onChange={(event) => {
                setDetailText(event.target.value);
                if (status.error || status.success) setStatus({ error: "", pending: false, success: "" });
              }}
              placeholder="Example: Give me a 2-4 hour engineering task that advances the PFTL task engine and has concrete verification evidence."
              rows={7}
              value={detailText}
            />
          </label>

          {status.error && (
            <p className="task-request-message is-error">
              <AlertTriangle size={15} strokeWidth={1.8} />
              {status.error}
            </p>
          )}
          {status.success && (
            <p className="task-request-message">
              <Check size={15} strokeWidth={1.8} />
              {status.success}
            </p>
          )}

          <footer>
            <button className="ghost-button" onClick={onClose} type="button">
              Close
            </button>
            {linkedWalletAddress && !walletReady ? (
              <button className="solid-button" disabled={status.pending} onClick={onWalletUnlock} type="button">
                Unlock wallet
              </button>
            ) : (
              <button className="solid-button" disabled={!canSubmit} type="submit">
                {status.pending ? "Publishing" : "Request task"}
                <Send size={14} strokeWidth={1.9} />
              </button>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}

import React, { useState, useRef, useEffect } from "react";
import { X, Check, AlertTriangle, ArrowRight } from "lucide-react";

// ─── Theme tokens (matches the app palette) ──────────────────────────────────
const C = {
  bgPage: "#F7F3EA",
  bgCard: "#FFFFFF",
  bgSoft: "#F1ECE0",
  text1: "#1A1714",
  text2: "#6B665C",
  text3: "#A8A299",
  border1: "rgba(0,0,0,0.07)",
  border2: "rgba(0,0,0,0.12)",
  border3: "rgba(0,0,0,0.20)",
  // Dusty forest — for the success line
  greenText: "#4A5F38",
  // Muted danger — for the wallet-locked notice and inline warning
  dangerText: "#7A2F1F",
};

const FONT_SANS =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO =
  "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

// ─── Reusable button primitives ──────────────────────────────────────────────
function PrimaryButton({ children, onClick, disabled, icon: Icon }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: disabled ? "rgba(0,0,0,0.22)" : C.text1,
        color: "white",
        border: 0,
        padding: Icon ? "9px 16px 9px 18px" : "9px 20px",
        fontSize: 14,
        fontWeight: 500,
        borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s, transform 0.05s",
        opacity: disabled ? 0.95 : 1,
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "#000";
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.background = C.text1;
      }}
      onMouseDown={(e) => {
        if (!disabled) e.currentTarget.style.transform = "scale(0.98)";
      }}
      onMouseUp={(e) => {
        if (!disabled) e.currentTarget.style.transform = "scale(1)";
      }}
    >
      {children}
      {Icon && <Icon size={14} strokeWidth={2} />}
    </button>
  );
}

function SecondaryButton({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: `1px solid ${C.border3}`,
        padding: "8px 16px",
        fontSize: 14,
        fontWeight: 500,
        borderRadius: 999,
        color: C.text1,
        cursor: "pointer",
        transition: "background 0.15s",
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "rgba(0,0,0,0.03)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
    >
      {children}
    </button>
  );
}

function TextButton({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: 0,
        padding: "8px 14px",
        fontSize: 14,
        color: C.text2,
        fontWeight: 500,
        cursor: "pointer",
        borderRadius: 8,
        transition: "color 0.15s, background 0.15s",
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = C.text1;
        e.currentTarget.style.background = "rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = C.text2;
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function CloseIcon({ onClose }) {
  return (
    <button
      onClick={onClose}
      aria-label="Close"
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: "transparent",
        border: 0,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: C.text2,
        flex: "0 0 auto",
        marginTop: 2,
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(0,0,0,0.05)";
        e.currentTarget.style.color = C.text1;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = C.text2;
      }}
    >
      <X size={16} strokeWidth={1.75} />
    </button>
  );
}

// ─── Modal shell ─────────────────────────────────────────────────────────────
function ModalShell({ open, onClose, maxWidth, children }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 18, 14, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 100,
        fontFamily: FONT_SANS,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.bgCard,
          borderRadius: 16,
          width: "100%",
          maxWidth,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow:
            "0 20px 50px -10px rgba(0,0,0,0.20), 0 8px 20px -8px rgba(0,0,0,0.10)",
          color: C.text1,
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ─── UnlockWalletModal ───────────────────────────────────────────────────────
export function UnlockWalletModal({
  open = true,
  onClose = () => {},
  linkedWallet = "rhwiJxki…yw2TaE",
  onUnlock = () => {},
  onForget = () => {},
}) {
  const [password, setPassword] = useState("");
  const [focused, setFocused] = useState(false);
  const passwordRef = useRef(null);

  useEffect(() => {
    if (open && passwordRef.current) passwordRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (open) setPassword("");
  }, [open]);

  const canUnlock = password.length > 0;

  return (
    <ModalShell open={open} onClose={onClose} maxWidth={520}>
      {/* Header */}
      <div
        style={{
          padding: "22px 24px 18px",
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.3,
              letterSpacing: "-0.01em",
            }}
          >
            Unlock Seed Wallet
          </h2>
          <p
            style={{
              fontSize: 13,
              color: C.text2,
              margin: "4px 0 0",
              lineHeight: 1.5,
            }}
          >
            Decrypt the local vault for this browser session.
          </p>
        </div>
        <CloseIcon onClose={onClose} />
      </div>

      <div
        style={{
          height: 0,
          borderTop: `0.5px solid ${C.border1}`,
          margin: "0 24px",
        }}
      />

      {/* Body */}
      <div style={{ padding: "20px 24px" }}>
        {/* Linked wallet card */}
        <div
          style={{
            background: C.bgPage,
            border: `0.5px solid ${C.border1}`,
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 18,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              fontFamily: FONT_MONO,
              letterSpacing: "-0.01em",
              color: C.text1,
              marginBottom: 2,
            }}
          >
            {linkedWallet}
          </div>
          <div style={{ fontSize: 12, color: C.text2 }}>Linked wallet</div>
        </div>

        {/* Password */}
        <label
          htmlFor="wallet-password"
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 8,
            color: C.text1,
          }}
        >
          Wallet password
        </label>
        <input
          id="wallet-password"
          ref={passwordRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canUnlock) onUnlock(password);
          }}
          style={{
            width: "100%",
            border: `0.5px solid ${focused ? C.border3 : C.border1}`,
            borderRadius: 10,
            padding: "11px 14px",
            fontSize: 14,
            fontFamily: "inherit",
            outline: 0,
            background: C.bgPage,
            transition: "border-color 0.15s",
            color: C.text1,
            boxSizing: "border-box",
          }}
        />

        {/* Warning — inline, no box */}
        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 12.5,
            color: C.dangerText,
            lineHeight: 1.55,
          }}
        >
          <AlertTriangle
            size={13}
            strokeWidth={1.75}
            style={{ marginTop: 3, flexShrink: 0 }}
          />
          <span>
            Unlocking keeps the decrypted phrase in memory only. Lock the vault
            or log out to clear it.
          </span>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "14px 24px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <SecondaryButton onClick={onForget}>Forget local vault</SecondaryButton>
        <PrimaryButton
          onClick={() => onUnlock(password)}
          disabled={!canUnlock}
        >
          Unlock
        </PrimaryButton>
      </div>
    </ModalShell>
  );
}

// ─── RequestTaskModal ────────────────────────────────────────────────────────
export function RequestTaskModal({
  open = true,
  onClose = () => {},
  walletLocked = false,
  status = "idle", // "idle" | "publishing" | "success"
  publishedTx = null,
  onSubmit = () => {},
  onUnlock = () => {},
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (open && textareaRef.current && !walletLocked && status === "idle") {
      textareaRef.current.focus();
    }
  }, [open, walletLocked, status]);

  // Clear textarea once a request publishes
  useEffect(() => {
    if (status === "success") setValue("");
  }, [status]);

  const hasContent = value.trim().length > 0;
  const isPublishing = status === "publishing";
  const showSuccess = status === "success" && publishedTx;

  const handleSubmit = () => {
    if (!hasContent || isPublishing) return;
    onSubmit(value);
  };

  // Pick the right primary button for the current state
  let primary;
  if (walletLocked) {
    primary = <PrimaryButton onClick={onUnlock}>Unlock wallet</PrimaryButton>;
  } else if (isPublishing) {
    primary = (
      <PrimaryButton disabled>
        Publishing
      </PrimaryButton>
    );
  } else {
    primary = (
      <PrimaryButton onClick={handleSubmit} disabled={!hasContent} icon={ArrowRight}>
        Request task
      </PrimaryButton>
    );
  }

  return (
    <ModalShell open={open} onClose={onClose} maxWidth={640}>
      {/* Header */}
      <div
        style={{
          padding: "22px 24px 18px",
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.3,
              letterSpacing: "-0.01em",
            }}
          >
            Request task
          </h2>
          <p
            style={{
              fontSize: 13,
              color: C.text2,
              margin: "4px 0 0",
              lineHeight: 1.5,
            }}
          >
            Describe the kind of work you want generated.
          </p>
          {walletLocked && (
            <p
              style={{
                fontSize: 13,
                color: C.dangerText,
                margin: "8px 0 0",
                lineHeight: 1.5,
                fontWeight: 500,
              }}
            >
              Unlock your wallet to sign the request.
            </p>
          )}
        </div>
        <CloseIcon onClose={onClose} />
      </div>

      <div
        style={{
          height: 0,
          borderTop: `0.5px solid ${C.border1}`,
          margin: "0 24px",
        }}
      />

      {/* Body */}
      <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
        <label
          htmlFor="task-details"
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 8,
            color: C.text1,
          }}
        >
          Task details
        </label>

        <div
          style={{
            background: C.bgPage,
            border: `0.5px solid ${focused ? C.border3 : C.border1}`,
            borderRadius: 10,
            transition: "border-color 0.15s",
            overflow: "hidden",
          }}
        >
          <textarea
            id="task-details"
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Example: Give me a 2-4 hour engineering task that advances the PFTL task engine and has concrete verification evidence."
            rows={5}
            disabled={isPublishing}
            style={{
              width: "100%",
              border: 0,
              outline: 0,
              resize: "none",
              background: "transparent",
              fontFamily: "inherit",
              fontSize: 14,
              lineHeight: 1.6,
              color: C.text1,
              padding: "14px 16px",
              minHeight: 140,
              display: "block",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Success line */}
        {showSuccess && (
          <div
            style={{
              marginTop: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: C.greenText,
              lineHeight: 1.5,
            }}
          >
            <Check size={14} strokeWidth={2.25} />
            <span>
              Task request published to PFT. Transaction{" "}
              <span style={{ fontFamily: FONT_MONO, fontSize: 12.5 }}>
                {publishedTx}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "14px 24px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <TextButton onClick={onClose}>Close</TextButton>
        {primary}
      </div>
    </ModalShell>
  );
}

// ─── Demo wrapper: drives the full flow so all four states are reachable ─────
export default function TaskFlowDemo() {
  const [walletLocked, setWalletLocked] = useState(true);
  const [showUnlock, setShowUnlock] = useState(false);
  const [status, setStatus] = useState("idle");
  const [publishedTx, setPublishedTx] = useState(null);
  const [requestOpen, setRequestOpen] = useState(true);

  const handleRequestSubmit = () => {
    setStatus("publishing");
    setPublishedTx(null);
    // Simulated publish latency
    setTimeout(() => {
      setStatus("success");
      setPublishedTx("705B1C6AD56A0F8E4A2D…");
    }, 1500);
  };

  const handleClose = () => {
    setRequestOpen(false);
    // Reopen after a moment so the demo stays viewable
    setTimeout(() => {
      setRequestOpen(true);
      setStatus("idle");
      setPublishedTx(null);
      setWalletLocked(true);
    }, 600);
  };

  return (
    <div style={{ background: C.bgPage, minHeight: "100vh" }}>
      <RequestTaskModal
        open={requestOpen && !showUnlock}
        onClose={handleClose}
        walletLocked={walletLocked}
        status={status}
        publishedTx={publishedTx}
        onSubmit={handleRequestSubmit}
        onUnlock={() => setShowUnlock(true)}
      />
      <UnlockWalletModal
        open={showUnlock}
        onClose={() => setShowUnlock(false)}
        linkedWallet="rhwiJxki…yw2TaE"
        onUnlock={() => {
          setShowUnlock(false);
          setWalletLocked(false);
        }}
        onForget={() => setShowUnlock(false)}
      />
    </div>
  );
}
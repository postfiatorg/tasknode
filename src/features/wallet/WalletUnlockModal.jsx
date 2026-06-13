import React, { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { walletUnlockIdleLockMinutes } from "./wallet-unlocked-session";
import "./wallet-unlock.css";

function shortWalletAddress(address) {
  const text = String(address || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

export function WalletUnlockModal({
  linkedWallet,
  onClose,
  onWalletVaultChange,
  onWalletVaultUnlocked,
  session,
}) {
  const [walletCore, setWalletCore] = useState(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);

  useEffect(() => {
    let active = true;
    import("../../wallet-core")
      .then((module) => {
        if (active) setWalletCore(module);
      })
      .catch(() => {
        if (active) setMessage("Wallet tools could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, []);

  async function unlockVault() {
    if (!walletCore || unlocking) return;
    if (!session?.accountId) {
      setMessage("Sign in before unlocking a wallet.");
      return;
    }

    setUnlocking(true);
    setMessage("");
    try {
      const unlocked = await walletCore.unlockEncryptedMnemonicVault({
        accountId: session.accountId,
        password,
        expectedAddress: linkedWallet?.address || "",
      });
      onWalletVaultUnlocked?.(unlocked);
      setPassword("");
      onClose();
    } catch {
      setMessage("Wallet password did not unlock this vault.");
      setUnlocking(false);
    }
  }

  async function forgetVault() {
    if (!walletCore || forgetting || !session?.accountId) return;
    setForgetting(true);
    setMessage("");
    try {
      if (typeof walletCore.removeLocalWalletVaultAsync === "function") {
        await walletCore.removeLocalWalletVaultAsync({ accountId: session.accountId });
      } else {
        walletCore.removeLocalWalletVault({ accountId: session.accountId });
      }
      await onWalletVaultChange?.();
      onClose();
    } catch {
      setMessage("Local vault could not be removed.");
      setForgetting(false);
    }
  }

  return (
    <div className="modal-backdrop wallet-unlock-backdrop" onClick={onClose} role="presentation">
      <div
        className="wallet-unlock-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Unlock seed wallet"
      >
        <header>
          <div>
            <h2>Unlock Seed Wallet</h2>
            <p>Decrypt the local vault for this browser session.</p>
          </div>
          <button className="wallet-unlock-close" onClick={onClose} type="button" aria-label="Close wallet unlock">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="wallet-unlock-divider" />
        <div className="wallet-unlock-body">
          <div className="wallet-unlock-card">
            <strong>{shortWalletAddress(linkedWallet?.address)}</strong>
            <span>Linked wallet</span>
          </div>
          <label className="wallet-unlock-field" htmlFor="wallet-unlock-password">
            <span>Wallet password</span>
            <input
              id="wallet-unlock-password"
              aria-label="Wallet unlock password"
              autoComplete="current-password"
              autoFocus
              onChange={(event) => {
                setPassword(event.target.value);
                setMessage("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") unlockVault();
              }}
              type="password"
              value={password}
            />
          </label>
          <div className="wallet-unlock-warning">
            <AlertTriangle size={13} strokeWidth={1.75} />
            <span>
              The decrypted phrase stays available in this browser tab, including across page reloads, until you lock
              the vault, log out, or close the tab. It locks automatically after {walletUnlockIdleLockMinutes()} minutes
              of inactivity. On a shared computer, lock the vault when you are done.
            </span>
          </div>
          {message && <div className="wallet-unlock-message">{message}</div>}
        </div>
        {confirmingForget ? (
          <>
            <div className="wallet-unlock-warning">
              <AlertTriangle size={13} strokeWidth={1.75} />
              <span>
                This permanently deletes the encrypted seed vault from this browser. Without your 24-word backup
                phrase, this app cannot restore the wallet and its funds become unreachable from here.
              </span>
            </div>
            <footer>
              <button
                className="wallet-unlock-secondary"
                disabled={forgetting}
                onClick={() => setConfirmingForget(false)}
                type="button"
              >
                Keep vault
              </button>
              <button className="wallet-unlock-primary" disabled={forgetting} onClick={forgetVault} type="button">
                {forgetting ? "Forgetting" : "Yes, delete local vault"}
              </button>
            </footer>
          </>
        ) : (
          <footer>
            <button
              className="wallet-unlock-secondary"
              disabled={forgetting}
              onClick={() => setConfirmingForget(true)}
              type="button"
            >
              Forget local vault
            </button>
            <button
              className="wallet-unlock-primary"
              disabled={!walletCore || !password || unlocking}
              onClick={unlockVault}
              type="button"
            >
              {unlocking ? "Unlocking" : "Unlock"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

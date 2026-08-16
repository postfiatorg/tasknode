import { useEffect, useState } from "react";
import { Eye, EyeOff, X } from "lucide-react";

function shortWalletAddress(address) {
  const text = String(address || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

export function WalletSeedBackupModal({ linkedWallet, onClose, session }) {
  const [walletCore, setWalletCore] = useState(null);
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [message, setMessage] = useState("");
  const [decrypting, setDecrypting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

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

  async function decryptSeed() {
    if (!walletCore || decrypting) return;
    if (!session?.accountId) {
      setMessage("Sign in before backing up a wallet.");
      return;
    }
    if (!password) {
      setMessage("Enter your wallet password.");
      return;
    }

    setDecrypting(true);
    setMessage("");
    setCopied(false);
    try {
      const unlocked = await walletCore.unlockEncryptedMnemonicVault({
        accountId: session.accountId,
        password,
        expectedAddress: linkedWallet?.address || "",
      });
      setMnemonic(unlocked.mnemonic);
      setRevealed(true);
      setPassword("");
      setMessage("Seed phrase decrypted locally.");
    } catch {
      setMessage("Wallet password did not unlock this vault.");
    } finally {
      setDecrypting(false);
    }
  }

  async function copySeed() {
    if (!mnemonic) return;
    try {
      await navigator.clipboard?.writeText(mnemonic);
      setCopied(true);
      setMessage("Seed phrase copied.");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setMessage("Copy failed. Select the phrase and copy it manually.");
    }
  }

  const seedWords = mnemonic ? mnemonic.split(" ") : [];

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal wallet-seed-backup-modal" role="dialog" aria-modal="true" aria-label="Back up seed phrase">
        <header>
          <div>
            <h2>Back Up Seed</h2>
            <p>Enter your wallet password to decrypt the local vault on this device.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close seed backup">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="wallet-proof-summary single">
          <span>
            <strong>{shortWalletAddress(linkedWallet?.address)}</strong>
            Linked wallet
          </span>
        </div>

        {!mnemonic && (
          <label className="wallet-seed-field compact">
            <span>Wallet password</span>
            <input
              aria-label="Wallet backup password"
              autoComplete="current-password"
              autoFocus
              onChange={(event) => {
                setPassword(event.target.value);
                setMessage("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") decryptSeed();
              }}
              type="password"
              value={password}
            />
          </label>
        )}

        {mnemonic && (
          <section className="wallet-seed-backup-panel" aria-label="Seed phrase backup">
            <div className="wallet-seed-backup-head">
              <span>24-word recovery phrase</span>
              <button className="wallet-mini-action" onClick={() => setRevealed((value) => !value)} type="button">
                {revealed ? <EyeOff size={13} strokeWidth={1.8} /> : <Eye size={13} strokeWidth={1.8} />}
                {revealed ? "Hide" : "Show"}
              </button>
            </div>
            {revealed ? (
              <div className="wallet-seed-word-grid">
                {seedWords.map((word, index) => (
                  <span key={`${word}-${index}`}>
                    <em>{index + 1}</em>
                    {word}
                  </span>
                ))}
              </div>
            ) : (
              <div className="wallet-seed-hidden">Seed phrase hidden</div>
            )}
            <textarea readOnly value={revealed ? mnemonic : ""} aria-label="Seed phrase text" />
          </section>
        )}

        <div className="wallet-link-warning">
          Anyone with this phrase can control the wallet. Task Node does not receive it. Store it offline and do not paste it into chats, websites, or support messages.
        </div>
        {message && <div className="inline-message">{message}</div>}

        <footer>
          <button className="light-pill" onClick={onClose} type="button">
            Done
          </button>
          {mnemonic ? (
            <button className="dark-pill" disabled={!revealed} onClick={copySeed} type="button">
              {copied ? "Copied" : "Copy seed"}
            </button>
          ) : (
            <button className="dark-pill" disabled={!walletCore || !password || decrypting} onClick={decryptSeed} type="button">
              {decrypting ? "Decrypting" : "Reveal seed"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

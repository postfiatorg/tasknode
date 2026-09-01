import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import { requestJson } from "../../api";
import { isSignedInSession } from "../../session";
import {
  formatWalletTransactionAmount,
  formatWalletTransactionTime,
  truncateWalletNote,
  walletVaultPersistenceDecision,
  walletRestoreAddressDecision,
} from "./wallet-state";

export function shortWalletAddress(address) {
  const text = String(address || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function normalizeSeedInput(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function seedWordCount(value) {
  const normalized = normalizeSeedInput(value);
  return normalized ? normalized.split(" ").length : 0;
}

export function verifyBackupWord({ normalizedMnemonic = "", index = 0, input = "" } = {}) {
  const words = normalizeSeedInput(normalizedMnemonic).split(" ").filter(Boolean);
  const wordIndex = Number(index);
  if (!Number.isInteger(wordIndex) || wordIndex < 1 || wordIndex > words.length) return false;
  return String(input || "").trim().toLowerCase() === words[wordIndex - 1];
}

export function numberedRecoveryWords({ normalizedMnemonic = "", verifyIndex = 0 } = {}) {
  const targetIndex = Number(verifyIndex);
  return normalizeSeedInput(normalizedMnemonic)
    .split(" ")
    .filter(Boolean)
    .map((word, index) => ({
      index: index + 1,
      word,
      verificationTarget: Number.isInteger(targetIndex) && targetIndex === index + 1,
    }));
}

function randomWordIndex(wordCount) {
  const count = Number(wordCount) || 0;
  if (!Number.isInteger(count) || count < 1) return 0;
  return Math.floor(Math.random() * count) + 1;
}

export function formatPftFromDrops(drops) {
  const pft = Number(drops || 0) / 1_000_000;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 0,
    maximumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 6,
  }).format(pft);
}

export function WalletSendModal({
  action,
  linkedWallet,
  onAppStateChange,
  onClose,
  onSent,
  walletSecret,
}) {
  const [destination, setDestination] = useState("");
  const [amountPft, setAmountPft] = useState("");
  const [message, setMessage] = useState("");
  const [prepared, setPrepared] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  const fromAddress = linkedWallet?.address || "";
  const canPrepare = destination.trim() && amountPft.trim() && !sending && !sent;

  async function prepareAndSend() {
    if (!walletSecret?.mnemonic || walletSecret.address !== fromAddress) {
      setMessage("Unlock the matching local seed vault before sending PFT.");
      return;
    }

    setSending(true);
    setMessage("");
    setSent(null);
    try {
      const prepare = await requestJson(action?.path || "/api/wallet/send/prepare", {
        method: action?.method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destination: destination.trim(),
          amountPft: amountPft.trim(),
        }),
      });
      if (!prepare.ok || !prepare.body?.ok || !prepare.body?.txJson) {
        throw new Error(prepare.body?.message || prepare.body?.actionRequired || "PFT payment could not be prepared.");
      }
      setPrepared(prepare.body);

      const walletCore = await import("../../wallet-core");
      const signed = walletCore.signPreparedPftlTransaction({
        mnemonic: walletSecret.mnemonic,
        txJson: prepare.body.txJson,
        expectedAddress: fromAddress,
      });

      const submit = await requestJson("/api/wallet/send/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signedTxBlob: signed.txBlob,
          expectedDestination: prepare.body.destination,
          expectedAmountDrops: prepare.body.amountDrops,
        }),
      });
      if (!submit.ok || !submit.body?.ok) {
        throw new Error(submit.body?.message || submit.body?.actionRequired || "PFT payment could not be submitted.");
      }

      const result = {
        ...submit.body,
        amountDrops: prepare.body.amountDrops,
        message: submit.body.message || "PFT sent.",
      };
      setSent(result);
      setMessage(result.message);
      await onAppStateChange?.();
      await onSent?.(result);
    } catch (error) {
      setMessage(error?.message || "PFT send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <div
        aria-label="Send PFT"
        aria-modal="true"
        className="wallet-link-modal wallet-send-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2>Send PFT</h2>
            <p>Sign locally from {shortWalletAddress(fromAddress)}.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close PFT send">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <label className="wallet-seed-field compact">
          <span>Destination wallet</span>
          <input
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={sending || Boolean(sent)}
            onChange={(event) => {
              setDestination(event.target.value);
              setPrepared(null);
              setMessage("");
            }}
            placeholder="r..."
            spellCheck={false}
            value={destination}
          />
        </label>

        <label className="wallet-seed-field compact">
          <span>Amount</span>
          <input
            autoComplete="off"
            disabled={sending || Boolean(sent)}
            inputMode="decimal"
            onChange={(event) => {
              setAmountPft(event.target.value);
              setPrepared(null);
              setMessage("");
            }}
            placeholder="0.00"
            value={amountPft}
          />
        </label>

        <div className="wallet-proof-summary">
          <span>
            <strong>{shortWalletAddress(fromAddress)}</strong>
            From
          </span>
          <span>
            <strong>{prepared?.feeDrops ? formatPftFromDrops(prepared.feeDrops) : "-"}</strong>
            Fee PFT
          </span>
          <span>
            <strong>{prepared?.networkId || "-"}</strong>
            Network
          </span>
        </div>

        <div className="wallet-link-warning">
          The recovery phrase stays in this browser. Task Node receives only the signed PFTL transaction blob.
        </div>

        {sent?.txHash && (
          <div className="wallet-creation-result-state is-success">
            <span>Payment submitted</span>
            <strong>{formatPftFromDrops(sent.amountDrops)} PFT</strong>
            <small>Tx {shortWalletAddress(sent.txHash)}</small>
          </div>
        )}

        {message && <div className="inline-message">{message}</div>}

        <footer>
          <button className="light-pill" disabled={sending} onClick={onClose} type="button">
            {sent ? "Done" : "Cancel"}
          </button>
          {!sent && (
            <button className="dark-pill" disabled={!canPrepare} onClick={prepareAndSend} type="button">
              {sending ? "Sending" : "Send PFT"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

export function WalletManagementCard({ active = false, disabled = false, icon: Icon, label, onClick, status }) {
  return (
    <button
      className={`wallet-management-card${active ? " is-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>
        {Icon && <Icon size={16} strokeWidth={1.8} />}
        {label}
      </span>
      <small>{status}</small>
      <ChevronRight size={16} strokeWidth={1.8} />
    </button>
  );
}

export function WalletCreationResultModal({ onClose, onRetry, onTopUp, result, retrying = false }) {
  const gift = result?.initiationGift || {};
  const giftOk = gift.ok === true || gift.status === "completed";
  const needsUsdcTopUp = gift.reason === "email_ineligible";
  const canRetry = !giftOk && !needsUsdcTopUp && gift.status !== "not_eligible" && gift.reason !== "account_registered";
  const amountPft = Number(gift.amountPft || 12);
  const title = "Wallet Created";
  const body = giftOk
    ? `${amountPft.toLocaleString("en-US")} PFT initiation gift sent.`
    : needsUsdcTopUp
      ? "Your PFT wallet is linked. Email accounts can receive the initiation gift after topping up more than $10 USDC and unlocking the local vault."
      : gift.message || result?.message || "The wallet was linked, but the initiation gift did not complete.";
  const stateTone = giftOk ? "is-success" : needsUsdcTopUp ? "is-info" : "is-warning";
  const stateLabel = giftOk
    ? "Initiation gift sent"
    : needsUsdcTopUp
      ? "USDC top-up required"
      : retrying
        ? "Retrying gift"
        : "Gift not completed";
  const stateValue = needsUsdcTopUp
    ? `${amountPft.toLocaleString("en-US")} PFT after top-up`
    : `${amountPft.toLocaleString("en-US")} PFT`;

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <div
        aria-label="Wallet creation result"
        aria-modal="true"
        className="wallet-link-modal wallet-creation-result-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{body}</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet creation result">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <div className={`wallet-creation-result-state ${stateTone}`}>
          <span>{stateLabel}</span>
          <strong>{stateValue}</strong>
          {gift.txHash && <small>Tx {shortWalletAddress(gift.txHash)}</small>}
        </div>

        {result?.wallet?.address && (
          <div className="wallet-proof-summary single">
            <span>
              <strong>{shortWalletAddress(result.wallet.address)}</strong>
              Linked wallet
            </span>
          </div>
        )}

        {!giftOk && needsUsdcTopUp && (
          <div className="wallet-link-warning">
            Email sign-in does not include the PFT gift at wallet creation. Use Top up to deposit USDC on your account.
            After your credited balance is more than $10 USDC, unlock the local vault to send the{" "}
            {amountPft.toLocaleString("en-US")} PFT grant to this wallet.
          </div>
        )}

        {!giftOk && !needsUsdcTopUp && (
          <div className="wallet-link-warning">
            Wallet creation succeeded. The PFT gift is tracked separately and can be retried without creating another wallet.
          </div>
        )}

        <footer>
          <button className="light-pill" onClick={onClose} type="button">
            Done
          </button>
          {!giftOk && needsUsdcTopUp && onTopUp && (
            <button className="dark-pill" onClick={onTopUp} type="button">
              Top up USDC
            </button>
          )}
          {!giftOk && canRetry && (
            <button className="dark-pill" disabled={retrying} onClick={onRetry} type="button">
              {retrying ? "Retrying" : "Retry 12 PFT gift"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

export function WalletFeedEmpty({ body, title }) {
  return (
    <div className="wallet-feed-empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

export function WalletTransactionRow({ hovered = false, onHover, tx }) {
  const isIn = tx.type === "in";
  const isSelf = tx.type === "self";
  const taskTitle = tx.taskTitle ? truncateWalletNote(tx.taskTitle) : "";
  const note = !taskTitle && tx.note ? truncateWalletNote(tx.note) : "";

  return (
    <li
      className={`wallet-tx-row${hovered ? " is-hovered" : ""}`}
      onMouseEnter={() => onHover?.(tx.id)}
      onMouseLeave={() => onHover?.("")}
    >
      <div className={`wallet-tx-icon${isIn ? " is-in" : ""}${isSelf ? " is-self" : ""}`}>
        {isIn ? <ArrowDownLeft size={16} strokeWidth={2} /> : <ArrowUpRight size={16} strokeWidth={2} />}
      </div>
      <div className="wallet-tx-copy">
        <strong>{tx.label || (isIn ? "Received PFT" : "Sent PFT")}</strong>
        <small title={tx.taskTitle || tx.note || ""}>
          {isIn ? "From" : isSelf ? "Self" : "To"} {tx.counterpartyLabel || shortWalletAddress(tx.counterparty)}
          {taskTitle && (
            <>
              <span aria-hidden="true"> · </span>
              <span>{taskTitle}</span>
            </>
          )}
          {note && (
            <>
              <span aria-hidden="true"> · </span>
              <span>{note}</span>
            </>
          )}
        </small>
      </div>
      <div className={`wallet-tx-amount${isIn ? " is-in" : ""}`}>
        <strong>{formatWalletTransactionAmount(tx)} PFT</strong>
        <small>{formatWalletTransactionTime(tx.createdAt)}</small>
      </div>
    </li>
  );
}

export function WalletLinkModal({
  action,
  initiationRetryAction,
  onCreateResult,
  onAppStateChange,
  onWalletVaultChange,
  onWalletVaultUnlocked,
  onClose,
  onNotice,
  session,
}) {
  const isRelink = action?.id === "relink_start";
  const isCreate = action?.id === "create_start";
  const [walletCore, setWalletCore] = useState(null);
  const [mnemonic, setMnemonic] = useState("");
  const [verifyWord, setVerifyWord] = useState("");
  const [verifyWordIndex, setVerifyWordIndex] = useState(0);
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [linking, setLinking] = useState(false);
  const normalized = walletCore?.normalizeMnemonic?.(mnemonic) || normalizeSeedInput(mnemonic);
  const wordCount = walletCore?.mnemonicWordCount?.(mnemonic) || seedWordCount(mnemonic);
  const valid = walletCore?.isValidTaskNodeMnemonic?.(mnemonic) || false;
  const recoveryWords = numberedRecoveryWords({
    normalizedMnemonic: normalized,
    verifyIndex: verifyWordIndex,
  });
  const backupWordVerified = !isCreate || verifyBackupWord({
    normalizedMnemonic: normalized,
    index: verifyWordIndex,
    input: verifyWord,
  });
  const passwordReady = vaultPassword.length >= 10;
  const passwordsMatch = Boolean(vaultPassword) && vaultPassword === vaultPasswordConfirm;
  const vaultStatus = !vaultPassword
    ? "Required"
    : !passwordReady
      ? "10+ chars"
      : !vaultPasswordConfirm
        ? "Confirm"
        : !passwordsMatch
          ? "Mismatch"
          : "Ready";
  let walletSummary = null;

  useEffect(() => {
    let active = true;
    import("../../wallet-core")
      .then((module) => {
        if (active) setWalletCore(module);
        if (active && isCreate) {
          const generatedMnemonic = module.generateTaskNodeMnemonic();
          setMnemonic(generatedMnemonic);
          setVerifyWord("");
          setVerifyWordIndex(randomWordIndex(module.mnemonicWordCount(generatedMnemonic)));
        }
      })
      .catch(() => {
        if (active) setMessage("Wallet tools could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, [isCreate]);

  function regenerateMnemonic() {
    if (!walletCore?.generateTaskNodeMnemonic) return;
    const generatedMnemonic = walletCore.generateTaskNodeMnemonic();
    setMnemonic(generatedMnemonic);
    setVerifyWord("");
    setVerifyWordIndex(randomWordIndex(walletCore.mnemonicWordCount(generatedMnemonic)));
    setMessage("");
  }

  function backupWordMismatchMessage() {
    return `That word doesn't match — re-check word #${verifyWordIndex}.`;
  }

  if (valid) {
    try {
      walletSummary = walletCore.deriveWalletSummary(normalized);
    } catch {
      walletSummary = null;
    }
  }

  async function resolveSignedInSession() {
    if (isSignedInSession(session)) return session;
    const nextState = await onAppStateChange?.();
    return isSignedInSession(nextState?.session) ? nextState.session : null;
  }

  async function linkWallet() {
    if (!walletCore) {
      setMessage("Wallet tools are still loading.");
      return;
    }

    const activeSession = await resolveSignedInSession();
    if (!activeSession) {
      setMessage("Sign in before linking a seed wallet.");
      return;
    }

    if (!valid || !walletSummary) {
      setMessage("Enter a valid 24-word recovery phrase.");
      return;
    }
    if (isCreate && !backupWordVerified) {
      setMessage(backupWordMismatchMessage());
      return;
    }
    if (!passwordReady) {
      setMessage("Set a wallet password of at least 10 characters.");
      return;
    }
    if (!vaultPasswordConfirm) {
      setMessage("Confirm the wallet password.");
      return;
    }
    if (!passwordsMatch) {
      setMessage("Wallet passwords do not match.");
      return;
    }
    const restoreDecision = walletRestoreAddressDecision({
      derivedAddress: walletSummary.address,
      expectedAddress: action?.expectedWalletAddress || "",
    });
    if (!restoreDecision.ok) {
      setMessage("That recovery phrase belongs to a different wallet. The selected account was not changed.");
      return;
    }

    setLinking(true);
    setMessage(isCreate ? "Creating wallet and preparing the local seed vault." : "");

    try {
      const start = await requestJson(action?.path || "/api/wallet/link/start", {
        method: action?.method || "POST",
      });
      if (!start.ok || !start.body?.challenge?.message) {
        setMessage(start.body?.message || start.body?.actionRequired || "Wallet link could not start.");
        setLinking(false);
        return;
      }
      const challengeAccountId = String(start.body.challenge.accountId || "").trim();
      if (!challengeAccountId) {
        setMessage("Wallet verification could not confirm the selected account. Refresh and try again.");
        setLinking(false);
        return;
      }
      if (challengeAccountId !== activeSession.accountId) {
        setMessage("The selected account changed. Close this wallet flow and try again.");
        setLinking(false);
        return;
      }

      const proof = walletCore.signWalletChallenge(normalized, start.body.challenge.message);
      const tasknodeEncryptionPubkey = await walletCore.deriveTaskNodePublicKey(normalized);
      if (isCreate) setMessage("Wallet proof signed. Waiting for Task Node to link the wallet.");
      const verify = await requestJson(start.body.verifyPath || "/api/wallet/link/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: start.body.challenge.id,
          address: proof.address,
          publicKey: proof.publicKey,
          tasknodeEncryptionPubkey,
          signature: proof.signature,
        }),
      });

      if (!verify.ok) {
        setMessage(verify.body?.message || verify.body?.actionRequired || "Wallet proof did not verify.");
        setLinking(false);
        return;
      }

      const verifiedAccountId = String(verify.body?.wallet?.accountId || "").trim();
      const currentSessionResult = await requestJson("/api/session");
      const currentAccountId = String(currentSessionResult.body?.accountId || "").trim();
      const persistenceDecision = walletVaultPersistenceDecision({
        challengeAccountId: start.body.challenge.accountId,
        capturedAccountId: activeSession.accountId,
        derivedAddress: walletSummary.address,
        liveAccountId: currentSessionResult.ok ? currentAccountId : "",
        responseAccountId: verifiedAccountId,
        responseAddress: verify.body?.wallet?.address || "",
      });
      if (!persistenceDecision.ok) {
        setMessage("The selected account or wallet changed. The local vault was not saved.");
        setLinking(false);
        return;
      }

      let unlockedAt = new Date().toISOString();
      try {
        await walletCore.saveEncryptedMnemonicVault({
          accountId: activeSession.accountId,
          mnemonic: normalized,
          password: vaultPassword,
        });
        await onWalletVaultChange?.();
        onWalletVaultUnlocked?.({
          ...walletSummary,
          accountId: activeSession.accountId,
          mnemonic: normalized,
          unlockedAt,
        });
      } catch {
        await onAppStateChange?.({
          errorMessage: "Failed to load linked wallet state.",
          taskProjectionRefresh: true,
        });
        setMessage(
          isCreate
            ? "Wallet linked, but the local vault could NOT be saved on this device (private/incognito mode or storage blocked). Save your 24-word recovery phrase now — you will need it to restore the vault next session."
            : "Wallet linked, but the encrypted vault could not be saved on this device."
        );
        setLinking(false);
        return;
      }

      let finalMessage = verify.body?.message || (isCreate ? "Wallet created." : isRelink ? "Wallet relinked." : "Wallet linked.");
      let initiationGift = verify.body?.initiationGift || null;
      if (isCreate) {
        setMessage("Local vault saved. Sending the PFT initiation gift.");
        const grant = await requestJson(initiationRetryAction?.path || "/api/wallet/initiation/retry", {
          method: initiationRetryAction?.method || "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ localVaultConfirmed: true }),
        });
        initiationGift = grant.body?.initiationGift || initiationGift;
        finalMessage = grant.body?.message || initiationGift?.message || finalMessage;
      }

      setMnemonic("");
      setVerifyWord("");
      setVerifyWordIndex(0);
      setVaultPassword("");
      setVaultPasswordConfirm("");
      setMessage(finalMessage);
      await onAppStateChange?.({
        errorMessage: "Failed to load linked wallet state.",
        taskProjectionRefresh: true,
      });
      if (isCreate) {
        onCreateResult?.({
          ok: verify.body?.ok === true,
          message: finalMessage,
          initiationGift,
          wallet: verify.body?.wallet || walletSummary,
        });
      }
      onNotice?.(finalMessage);
      onClose();
    } catch (error) {
      setMessage(error?.message || "Wallet link failed.");
      setLinking(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal" role="dialog" aria-modal="true" aria-label="Link seed wallet">
        <header>
          <div>
            <h2>{isCreate ? "Create Seed Wallet" : isRelink ? "Relink Seed Wallet" : "Link Seed Wallet"}</h2>
            <p>
              {isCreate
                ? "A new recovery phrase is generated in this browser. Save it before continuing."
                : isRelink
                ? "Prove wallet ownership again. The recovery phrase stays in this browser."
                : "Validate and sign locally. Your recovery phrase is never sent to Task Node."}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet link">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        {isCreate ? (
          <section className="wallet-seed-backup-panel wallet-create-seed-panel" aria-label="Numbered recovery phrase">
            <div className="wallet-seed-backup-head">
              <div>
                <strong>Save these 24 words in order</strong>
                <small>Each word is numbered so you can verify the right position.</small>
              </div>
              <button className="wallet-mini-action" disabled={!walletCore || linking} onClick={regenerateMnemonic} type="button">
                <RefreshCw size={13} strokeWidth={1.8} />
                Regenerate
              </button>
            </div>
            <div className="wallet-seed-word-grid wallet-create-word-grid">
              {recoveryWords.map((item) => (
                <span
                  aria-label={`Recovery phrase word ${item.index}: ${item.word}${item.verificationTarget ? ", verify this word" : ""}`}
                  className={item.verificationTarget ? "is-verification-target" : undefined}
                  key={`${item.word}-${item.index}`}
                >
                  <em>{item.index}</em>
                  {item.word}
                  {item.verificationTarget && <small>Check</small>}
                </span>
              ))}
            </div>
          </section>
        ) : (
          <label className="wallet-seed-field">
            <span>24-word recovery phrase</span>
            <textarea
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              onChange={(event) => {
                setMnemonic(event.target.value);
                setMessage("");
              }}
              placeholder="word one word two ..."
              spellCheck={false}
              value={mnemonic}
            />
          </label>
        )}
        {isCreate && (
          <div className={`wallet-backup-confirmation${backupWordVerified ? " is-verified" : ""}`}>
            <div className="wallet-backup-confirmation-copy">
              <span>Backup check · word #{verifyWordIndex || "—"}</span>
              <strong>{backupWordVerified ? "Recovery word confirmed" : "Type the highlighted word"}</strong>
              <small>Find the numbered tile marked “Check” above, then enter that word here.</small>
            </div>
            <label className="wallet-seed-field compact wallet-backup-word-field">
              <span>Word #{verifyWordIndex || "—"}</span>
              <input
                aria-label={`Confirm recovery phrase word ${verifyWordIndex || ""}`.trim()}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                onChange={(event) => {
                  setVerifyWord(event.target.value);
                  setMessage("");
                }}
                onBlur={() => {
                  if (verifyWord && !backupWordVerified) setMessage(backupWordMismatchMessage());
                }}
                placeholder={`Type word #${verifyWordIndex || "—"}`}
                spellCheck={false}
                type="text"
                value={verifyWord}
              />
            </label>
            {backupWordVerified && <Check aria-hidden="true" className="wallet-backup-confirmation-check" size={18} strokeWidth={2} />}
          </div>
        )}
        <div className="wallet-password-grid">
          <label className="wallet-seed-field compact">
            <span>Wallet password</span>
            <input
              aria-label="Wallet password"
              autoComplete="new-password"
              onChange={(event) => {
                setVaultPassword(event.target.value);
                setMessage("");
              }}
              type="password"
              value={vaultPassword}
            />
          </label>
          <label className="wallet-seed-field compact">
            <span>Confirm password</span>
            <input
              aria-label="Confirm wallet password"
              autoComplete="new-password"
              onChange={(event) => {
                setVaultPasswordConfirm(event.target.value);
                setMessage("");
              }}
              type="password"
              value={vaultPasswordConfirm}
            />
          </label>
        </div>
        <div className="wallet-proof-summary">
          <span>
            <strong>{wordCount}/24</strong>
            Words
          </span>
          <span>
            <strong>{valid ? "Valid" : "Pending"}</strong>
            Mnemonic
          </span>
          <span>
            <strong>{walletSummary?.address ? shortWalletAddress(walletSummary.address) : "Not derived"}</strong>
            Address
          </span>
          <span>
            <strong>{vaultStatus}</strong>
            Local vault
          </span>
        </div>
        <div className="wallet-link-warning">
          {isCreate
            ? "Task Node links the public wallet address first, then sends an eligible initiation gift only after the local vault is saved."
            : "The encrypted vault is saved only in this browser. Task Node never receives the phrase or password."}
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="dark-pill" disabled={linking || (isCreate && !backupWordVerified)} onClick={linkWallet} type="button">
            {linking
              ? isCreate
                ? "Creating"
                : isRelink
                  ? "Relinking"
                  : "Linking"
              : isCreate
                ? "Create wallet"
                : isRelink
                  ? "Relink wallet"
                  : "Link wallet"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function WalletDelinkModal({
  action,
  linkedWallet,
  onAppStateChange,
  onClose,
  onWalletVaultChange,
  onWalletVaultLock,
  session,
}) {
  const [message, setMessage] = useState("");
  const [delinking, setDelinking] = useState(false);

  async function delinkWallet() {
    if (delinking) return;
    if (!session?.accountId) {
      setMessage("Sign in before delinking a wallet.");
      return;
    }
    if (!linkedWallet?.address) {
      setMessage("No active wallet is linked to this account.");
      return;
    }

    setDelinking(true);
    setMessage("");
    try {
      const result = await requestJson(action?.path || "/api/wallet/delink", {
        method: action?.method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmAddress: linkedWallet.address,
          reason: "user_requested",
        }),
      });

      if (!result.ok) {
        setMessage(result.body?.message || result.body?.actionRequired || "Wallet could not be delinked.");
        setDelinking(false);
        return;
      }

      onWalletVaultLock?.();
      try {
        const walletCore = await import("../../wallet-core");
        if (typeof walletCore.removeLocalWalletVaultAsync === "function") {
          await walletCore.removeLocalWalletVaultAsync({ accountId: session.accountId });
        } else {
          walletCore.removeLocalWalletVault({ accountId: session.accountId });
        }
      } catch {
        // Server delink succeeded. A local vault cleanup failure should not
        // restore server wallet ownership.
      }
      await onWalletVaultChange?.();
      await onAppStateChange?.();
      onClose();
    } catch (error) {
      setMessage(error?.message || "Wallet delink failed.");
      setDelinking(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal" role="dialog" aria-modal="true" aria-label="Delink wallet">
        <header>
          <div>
            <h2>Delink Wallet</h2>
            <p>Detach this wallet from the app account. Chain history and PFT balance are untouched.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet delink">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="wallet-proof-summary single">
          <span>
            <strong>{shortWalletAddress(linkedWallet?.address)}</strong>
            Linked wallet
          </span>
        </div>
        <div className="wallet-link-warning">
          Delinking clears the active server wallet link for this account and removes the encrypted local vault from this browser. Without your 24-word backup phrase, this app cannot restore the wallet afterwards. Relinking requires a fresh signed wallet proof.
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" disabled={delinking} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="dark-pill" disabled={delinking} onClick={delinkWallet} type="button">
            {delinking ? "Delinking" : "Delink wallet"}
          </button>
        </footer>
      </div>
    </div>
  );
}

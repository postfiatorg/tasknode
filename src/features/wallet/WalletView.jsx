import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Unlock,
  Unlink,
  X,
} from "lucide-react";
import { requestJson } from "../../api";
import "./wallet.css";
import { formatCreditUsd } from "../../formatters";
import { isSignedInSession } from "../../session";
import {
  formatPftBalance,
  formatWalletTransactionAmount,
  formatWalletTransactionTime,
  groupWalletTransactions,
  truncateWalletNote,
  walletBalanceStatusLabel,
  walletVaultDisplayState,
} from "./wallet-state";

const WALLET_TX_REFRESH_MS = 60000;
const ETH_TOP_UP_SYNC_INITIAL_DELAY_MS = 1200;
const ETH_TOP_UP_SYNC_INTERVAL_MS = 8000;

function shortWalletAddress(address) {
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

function mergeTopUpSyncResult(current, body) {
  return {
    ...(current?.data || {}),
    ...body,
    depositAccount: body?.depositAccount || current?.data?.depositAccount,
  };
}

function topUpDataSignature(data) {
  const deposit = data?.depositAccount || {};
  return JSON.stringify({
    address: deposit.address || "",
    lastSyncAt: deposit.lastSyncAt || "",
    lastSyncStatus: deposit.lastSyncStatus || "",
    observedBalances: deposit.observedBalances || {},
    pendingBalances: deposit.pendingBalances || {},
    creditedBalances: deposit.creditedBalances || {},
    availableCreditUsd: data?.usage?.availableCreditUsd ?? null,
    currentCreditUsd: data?.usage?.currentCreditUsd ?? null,
    currentSpendUsd: data?.usage?.currentSpendUsd ?? null,
  });
}

export function useEthereumTopUpSync({ enabled = true, onSynced, open, setTopUpState, state }) {
  const inFlightRef = useRef(false);
  const dataSignatureRef = useRef(topUpDataSignature(state?.data));
  const onSyncedRef = useRef(onSynced);
  const stateDataRef = useRef(state?.data);
  const syncPath = state?.data?.syncPath || "/api/usage/top-up/sync";
  const depositAddress = state?.data?.depositAccount?.address || "";

  useEffect(() => {
    stateDataRef.current = state?.data;
    dataSignatureRef.current = topUpDataSignature(state?.data);
  }, [state?.data]);

  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);

  const syncNow = useCallback(
    async ({ silent = false } = {}) => {
      if (!depositAddress || inFlightRef.current) return null;
      inFlightRef.current = true;

      if (!silent) {
        setTopUpState((current) => ({
          ...current,
          status: "syncing",
          message: "",
        }));
      }

      try {
        const result = await requestJson(syncPath, { method: "POST" });
        if (!result.ok || !result.body?.ok) {
          throw new Error(result.body?.message || result.body?.actionRequired || "Deposit refresh failed.");
        }

        const creditedEntries = result.body?.creditedEntries || [];
        const nextData = mergeTopUpSyncResult({ data: stateDataRef.current }, result.body);
        const nextSignature = topUpDataSignature(nextData);
        const changed = nextSignature !== dataSignatureRef.current;
        if (silent && !changed && creditedEntries.length === 0) {
          return result.body;
        }

        dataSignatureRef.current = nextSignature;
        setTopUpState((current) => ({
          status: "ready",
          data: mergeTopUpSyncResult(current, result.body),
          message: !silent || creditedEntries.length > 0 ? result.body.message || "" : current.message || "",
        }));
        if (!silent || changed || creditedEntries.length > 0) {
          await onSyncedRef.current?.(result.body);
        }
        return result.body;
      } catch (error) {
        if (!silent) {
          setTopUpState((current) => ({
            ...current,
            status: "ready",
            message: error?.message || "Deposit refresh failed.",
          }));
        }
        return null;
      } finally {
        inFlightRef.current = false;
      }
    },
    [depositAddress, setTopUpState, syncPath]
  );

  useEffect(() => {
    if (!enabled || !open || !depositAddress) return undefined;

    const run = () => {
      syncNow({ silent: true });
    };
    const firstTimer = window.setTimeout(run, ETH_TOP_UP_SYNC_INITIAL_DELAY_MS);
    const interval = window.setInterval(run, ETH_TOP_UP_SYNC_INTERVAL_MS);
    const onFocus = () => run();
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [depositAddress, enabled, open, syncNow]);

  return syncNow;
}

export function WalletView({
  onAppStateChange,
  onLoginRequired,
  onWalletVaultChange,
  onWalletVaultLock,
  onWalletVaultUnlocked,
  session,
  wallet,
  walletVault,
  usage,
}) {
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [hideBalance, setHideBalance] = useState(false);
  const [hoveredTx, setHoveredTx] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [walletProofAction, setWalletProofAction] = useState(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [delinkOpen, setDelinkOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpState, setTopUpState] = useState({
    status: wallet?.ethereumDeposit ? "ready" : "idle",
    data: wallet?.ethereumDeposit ? { depositAccount: wallet.ethereumDeposit } : null,
    message: "",
  });
  const [txFeed, setTxFeed] = useState({
    status: "idle",
    transactions: [],
    message: "",
    fetchedAt: null,
    scannedTransactions: 0,
    complete: true,
  });
  const actions = wallet?.actions || [];
  const linkAction = actions.find((action) => action.id === "link_start");
  const relinkAction = actions.find((action) => action.id === "relink_start");
  const delinkAction = actions.find((action) => action.id === "delink");
  const fundingActions = usage?.fundingActions || [];
  const topUpAction = fundingActions.find((action) => action.id === "top_up_start");
  const linkedWallet = wallet?.pftWallet || {};
  const walletLinked = linkedWallet.status === "linked";
  const vaultAvailable = Boolean(walletVault?.available && walletVault?.address === linkedWallet.address);
  const vaultUnlocked = Boolean(vaultAvailable && walletVault?.unlocked);
  const vaultDisplay = walletVaultDisplayState(walletVault, linkedWallet.address);
  const signedIn = isSignedInSession(session);
  const pftBalance = formatPftBalance(wallet);
  const balanceStatusLabel = walletLinked ? walletBalanceStatusLabel(wallet) : "";
  const balanceError = walletLinked && wallet?.pftBalanceError;
  const txGroups = groupWalletTransactions(txFeed.transactions);
  const txLoading = txFeed.status === "loading";
  const txRefreshing = txFeed.status === "refreshing";
  const txError = txFeed.status === "error";
  const networkLabel = !walletLinked
    ? "No wallet"
    : wallet?.pftBalanceStatus === "error" || txError
      ? "Network issue"
      : wallet?.pftBalanceStatus === "checking"
        ? "Checking"
        : "Network live";
  const networkTone = networkLabel === "Network live" ? "live" : networkLabel === "Network issue" ? "error" : "muted";
  const walletAddressLabel = walletLinked ? shortWalletAddress(linkedWallet.address) : "No wallet linked";
  const vaultStatusLabel = vaultUnlocked ? "Unlocked" : vaultAvailable ? "Locked" : walletLinked ? "Not saved" : "Seed not linked";
  const primaryActionLabel = !walletLinked || !vaultAvailable ? "Link wallet" : vaultUnlocked ? "Lock" : "Unlock";
  const syncTopUpDeposits = useEthereumTopUpSync({
    enabled: signedIn,
    onSynced: async () => {
      await onAppStateChange?.();
    },
    open: topUpOpen,
    setTopUpState,
    state: topUpState,
  });
  const visibleChatCreditUsd =
    topUpState.data?.usage?.availableCreditUsd ??
    usage?.availableCreditUsd ??
    wallet?.chatCreditUsd ??
    0;

  useEffect(() => {
    if (!signedIn) return;
    setMessage((current) =>
      current === "Sign in before linking a seed wallet." ? "" : current
    );
  }, [signedIn]);

  const walletDepositSignature = topUpDataSignature({ depositAccount: wallet?.ethereumDeposit });

  useEffect(() => {
    if (!wallet?.ethereumDeposit) return;
    setTopUpState((current) => {
      const nextData = {
        ...(current.data || {}),
        depositAccount: wallet.ethereumDeposit,
      };
      if (
        current.status !== "loading" &&
        topUpDataSignature(current.data) === topUpDataSignature(nextData)
      ) {
        return current;
      }
      return {
        ...current,
        status: current.status === "loading" ? current.status : "ready",
        data: nextData,
      };
    });
  }, [walletDepositSignature]);

  useEffect(() => {
    if (!signedIn || !wallet?.ethereumDeposit?.address || topUpOpen) return undefined;
    const timer = window.setTimeout(() => {
      syncTopUpDeposits({ silent: true });
    }, ETH_TOP_UP_SYNC_INITIAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, syncTopUpDeposits, topUpOpen, wallet?.ethereumDeposit?.address]);

  function requireSignedInForWalletLink() {
    if (signedIn) return true;
    if (!session?.status) {
      setMessage("Wallet actions are still loading.");
      return false;
    }
    setMessage("Sign in before linking a seed wallet.");
    onLoginRequired?.();
    return false;
  }

  function openVaultControl() {
    if (vaultUnlocked) {
      onWalletVaultLock?.();
      return;
    }
    if (vaultAvailable) {
      setUnlockOpen(true);
      return;
    }
    if (requireSignedInForWalletLink()) {
      setMessage("");
      setWalletProofAction(linkAction);
      setLinkOpen(true);
    }
  }

  async function openTopUpFlow() {
    if (!signedIn) {
      setMessage("Sign in before topping up.");
      onLoginRequired?.();
      return;
    }

    setTopUpOpen(true);
    setTopUpState((current) => ({
      ...current,
      status: current.data?.depositAccount ? "ready" : "loading",
      message: "",
    }));

    try {
      const result = await requestJson(topUpAction?.path || "/api/usage/top-up/start", {
        method: topUpAction?.method || "POST",
      });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.actionRequired || "Top-up is unavailable.");
      }
      setTopUpState({
        status: "ready",
        data: result.body,
        message: result.body.message || "",
      });
      await onAppStateChange?.();
    } catch (error) {
      setTopUpState({
        status: "error",
        data: null,
        message: error?.message || "Top-up is unavailable.",
      });
    }
  }

  async function refreshTopUpDeposits() {
    await syncTopUpDeposits({ silent: false });
  }

  async function startWalletAction(action) {
    if (!action) {
      setMessage("Wallet actions are still loading.");
      return;
    }
    if (action.id === "link_start") {
      if (!requireSignedInForWalletLink()) return;
      setMessage("");
      if (!walletLinked || !vaultAvailable) {
        setWalletProofAction(linkAction);
        setLinkOpen(true);
      } else if (vaultUnlocked) {
        onWalletVaultLock?.();
        setMessage("Vault locked.");
      } else {
        setUnlockOpen(true);
      }
      return;
    }
    if (action.id === "relink_start") {
      if (!requireSignedInForWalletLink()) return;
      setMessage("");
      setWalletProofAction(action);
      setLinkOpen(true);
      return;
    }
    if (action.id === "delink") {
      if (!requireSignedInForWalletLink()) return;
      if (!walletLinked) {
        setMessage("No active wallet is linked to this account.");
        return;
      }
      setMessage("");
      setDelinkOpen(true);
      return;
    }
    if (action.id === "unlock_start" && walletLinked && vaultAvailable && !vaultUnlocked) {
      setUnlockOpen(true);
      return;
    }

    setPendingAction(action.id);
    setMessage("");

    try {
      const result = await requestJson(action.path, { method: action.method || "POST" });
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${action.label} returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${action.label} is unavailable.`);
    } finally {
      setPendingAction("");
    }
  }

  const refreshWalletTransactions = useCallback(async ({ force = false } = {}) => {
    if (!signedIn || !walletLinked || !linkedWallet.address) {
      setTxFeed({
        status: walletLinked ? "idle" : "not_linked",
        transactions: [],
        message: "",
        fetchedAt: null,
        scannedTransactions: 0,
        complete: true,
      });
      return;
    }

    const path = wallet?.pftTransactionsPath || "/api/wallet/transactions";
    setTxFeed((current) => ({
      ...current,
      status: current.transactions.length ? "refreshing" : "loading",
      message: "",
    }));

    try {
      const query = `limit=50${force ? "&force=1" : ""}`;
      const result = await requestJson(`${path}?${query}`);
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Transaction feed unavailable.");
      }
      setTxFeed({
        status: "ready",
        transactions: Array.isArray(result.body.transactions) ? result.body.transactions : [],
        message: "",
        fetchedAt: result.body.fetchedAt || new Date().toISOString(),
        scannedTransactions: Number(result.body.scannedTransactions || 0),
        complete: result.body.complete !== false,
      });
    } catch (error) {
      setTxFeed((current) => ({
        ...current,
        status: "error",
        message: error?.message || "Transaction feed unavailable.",
      }));
    }
  }, [linkedWallet.address, signedIn, wallet?.pftTransactionsPath, walletLinked]);

  useEffect(() => {
    if (!signedIn || !walletLinked || !linkedWallet.address) {
      setTxFeed({
        status: walletLinked ? "idle" : "not_linked",
        transactions: [],
        message: "",
        fetchedAt: null,
        scannedTransactions: 0,
        complete: true,
      });
      return undefined;
    }

    refreshWalletTransactions({ force: true });
    const timer = window.setInterval(() => refreshWalletTransactions(), WALLET_TX_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [linkedWallet.address, refreshWalletTransactions, signedIn, walletLinked]);

  async function copyWalletAddress() {
    if (!walletLinked || !linkedWallet.address) return;
    try {
      await navigator.clipboard?.writeText(linkedWallet.address);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 1400);
    } catch {
      setMessage("Address copy failed.");
    }
  }

  return (
    <div className="route-scroll">
      <div className="wallet-view wallet-redesign">
        <header className="wallet-page-head">
          <div>
            <div className="wallet-page-kicker">Task Node</div>
            <h1>Wallet</h1>
          </div>
          <button
            className="wallet-hide-button"
            onClick={() => setHideBalance((value) => !value)}
            type="button"
          >
            {hideBalance ? <Eye size={14} strokeWidth={1.8} /> : <EyeOff size={14} strokeWidth={1.8} />}
            {hideBalance ? "Show" : "Hide"} balance
          </button>
        </header>

        <section className="wallet-balance-card">
          <div className="wallet-balance-inner">
            <div className="wallet-balance-top">
              <span>Available balance</span>
              <span className={`wallet-network-state is-${networkTone}`}>
                <span aria-hidden="true" />
                {networkLabel}
              </span>
            </div>

            <div className="wallet-balance-display">
              <strong>{hideBalance ? "••••" : pftBalance}</strong>
              <span>PFT</span>
            </div>

            <div className="wallet-identity-row">
              <button
                className="address-chip wallet-address-chip"
                disabled={!walletLinked}
                onClick={copyWalletAddress}
                type="button"
              >
                <span className={walletLinked ? "wallet-address-dot is-linked" : "wallet-address-dot"} />
                <span>{walletAddressLabel}</span>
                {copiedAddress ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
              </button>
              <span className={`wallet-vault-chip is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                <ShieldCheck size={14} strokeWidth={1.8} />
                {vaultStatusLabel}
              </span>
            </div>

            <p className="wallet-balance-note">
              {walletLinked
                ? vaultUnlocked
                  ? "Encrypted vault unlocked for this browser session. Your seed never leaves this device."
                  : vaultAvailable
                    ? "Encrypted seed vault saved locally. Unlock before wallet-bound signing actions."
                    : "Ownership proof is linked. Save an encrypted local vault before wallet-bound actions."
                : "Link a 24-word recovery phrase locally. Your seed never leaves your device."}
            </p>

            <div className="wallet-actions">
              <button className="wallet-primary-action" onClick={() => startWalletAction(linkAction)} type="button">
                {vaultUnlocked ? <Lock size={16} strokeWidth={2} /> : walletLinked && vaultAvailable ? <Unlock size={16} strokeWidth={2} /> : <Link2 size={16} strokeWidth={2} />}
                {primaryActionLabel}
              </button>
              <button
                className="wallet-secondary-action"
                disabled={!walletLinked}
                onClick={copyWalletAddress}
                type="button"
              >
                <Download size={16} strokeWidth={2} />
                Receive
              </button>
              <button className="wallet-secondary-action" disabled type="button">
                <Send size={16} strokeWidth={2} />
                Send
              </button>
            </div>
          </div>
        </section>

        {(balanceStatusLabel || balanceError || message) && (
          <div className="wallet-inline-status" role="status">
            {message || [balanceStatusLabel, balanceError].filter(Boolean).join(" · ")}
          </div>
        )}

        <section className="wallet-management-grid" aria-label="Wallet management">
          <WalletManagementCard
            icon={ShieldCheck}
            label="Local seed vault"
            onClick={openVaultControl}
            status={vaultUnlocked ? "Unlocked" : vaultAvailable ? "Locked" : "Not saved"}
          />
          <WalletManagementCard
            disabled={!walletLinked || pendingAction === "delink"}
            icon={Unlink}
            label="Delink wallet"
            onClick={() => startWalletAction(delinkAction)}
            status={pendingAction === "delink" ? "Working" : walletLinked ? "Ready" : "No wallet"}
          />
          <WalletManagementCard
            active={walletLinked}
            disabled={pendingAction === "relink_start"}
            icon={Link2}
            label="Relink wallet"
            onClick={() => startWalletAction(relinkAction)}
            status={pendingAction === "relink_start" ? "Working" : signedIn ? "Ready" : "Sign in"}
          />
        </section>

        <div className="wallet-usage-note wallet-credit-note">
          <span>
            Chat credit <strong>{formatCreditUsd(visibleChatCreditUsd)}</strong>. Billing is{" "}
            {usage?.billingModel === "usage_based" ? "usage-based" : "not ready"}.
          </span>
          <button
            className="wallet-mini-action"
            disabled={!signedIn || topUpState.status === "loading" || topUpState.status === "syncing"}
            onClick={openTopUpFlow}
            type="button"
          >
            <Plus size={13} strokeWidth={2} />
            Top up
          </button>
        </div>

        <section className="wallet-activity-section">
          <header className="wallet-activity-head">
            <div>
              <span>Activity</span>
              <h2>Your latest transactions</h2>
            </div>
            <button
              className="wallet-link-action"
              disabled={!walletLinked || txLoading || txRefreshing}
              onClick={() => refreshWalletTransactions({ force: true })}
              type="button"
            >
              {txRefreshing ? "Refreshing" : "Refresh"} <ChevronRight size={14} strokeWidth={1.8} />
            </button>
          </header>

          <div className="wallet-activity-card">
            {!walletLinked && (
              <WalletFeedEmpty
                title="No wallet linked"
                body="Link a wallet to read PFTL account history."
              />
            )}
            {walletLinked && txLoading && (
              <WalletFeedEmpty title="Loading transaction history" body="Reading PFTL account transactions." />
            )}
            {walletLinked && txError && (
              <WalletFeedEmpty title="Transaction feed unavailable" body={txFeed.message || "Try refreshing again."} />
            )}
            {walletLinked && !txLoading && !txError && txGroups.length === 0 && (
              <WalletFeedEmpty title="No PFTL transactions found" body="This wallet has no readable recent PFTL payments yet." />
            )}
            {walletLinked && !txLoading && !txError && txGroups.map((group) => (
              <div className="wallet-tx-group" key={group.group}>
                <div className="wallet-tx-group-label">
                  <span>{group.group}</span>
                  <span aria-hidden="true" />
                </div>
                <ul>
                  {group.items.map((tx, index) => (
                    <WalletTransactionRow
                      hovered={hoveredTx === tx.id}
                      key={tx.id || `${group.group}-${index}`}
                      onHover={setHoveredTx}
                      tx={tx}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {walletLinked && !txLoading && !txError && txGroups.length > 0 && (
              <footer className="wallet-activity-foot">
                <span>
                  Showing {txFeed.transactions.length} of {txFeed.scannedTransactions || txFeed.transactions.length} scanned transactions
                </span>
                <button
                  disabled={txRefreshing}
                  onClick={() => refreshWalletTransactions({ force: true })}
                  type="button"
                >
                  {txRefreshing ? "Refreshing" : "Load latest"} <ChevronRight size={14} strokeWidth={1.8} />
                </button>
              </footer>
            )}
          </div>
        </section>
      </div>
      {linkOpen && (
        <WalletLinkModal
          action={walletProofAction || linkAction}
          onAppStateChange={onAppStateChange}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultUnlocked={onWalletVaultUnlocked}
          onClose={() => {
            setLinkOpen(false);
            setWalletProofAction(null);
          }}
          session={session}
        />
      )}
      {delinkOpen && (
        <WalletDelinkModal
          action={delinkAction}
          linkedWallet={linkedWallet}
          onAppStateChange={onAppStateChange}
          onClose={() => setDelinkOpen(false)}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultLock={onWalletVaultLock}
          session={session}
        />
      )}
      {unlockOpen && (
        <WalletUnlockModal
          linkedWallet={linkedWallet}
          onClose={() => setUnlockOpen(false)}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultUnlocked={(unlock) => {
            setMessage("");
            onWalletVaultUnlocked?.(unlock);
          }}
          session={session}
        />
      )}
      {topUpOpen && (
        <EthereumTopUpModal
          onClose={() => setTopUpOpen(false)}
          onRefresh={refreshTopUpDeposits}
          state={topUpState}
        />
      )}
    </div>
  );
}

function WalletManagementCard({ active = false, disabled = false, icon: Icon, label, onClick, status }) {
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

export function EthereumTopUpModal({ onClose, onRefresh, state }) {
  const [copied, setCopied] = useState(false);
  const deposit = state?.data?.depositAccount || null;
  const assets = deposit?.assets || [];
  const busy = state?.status === "loading" || state?.status === "syncing";
  const error = state?.status === "error";

  async function copyDepositAddress() {
    if (!deposit?.address) return;
    try {
      await navigator.clipboard?.writeText(deposit.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <div
        aria-label="Top up account"
        aria-modal="true"
        className="wallet-link-modal eth-topup-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2>Top up</h2>
            <p>Send ETH, USDC, or USDT on Ethereum mainnet to your account deposit address.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close top up">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {busy && !deposit && (
          <div className="eth-topup-loading">
            <RefreshCw size={16} strokeWidth={2} />
            Preparing deposit address
          </div>
        )}

        {error && (
          <div className="wallet-link-warning">
            {state?.message || "Top-up is unavailable."}
          </div>
        )}

        {deposit && (
          <>
            <div className="eth-topup-address">
              <span>Ethereum mainnet address</span>
              <button onClick={copyDepositAddress} type="button">
                <strong>{deposit.address}</strong>
                {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
              </button>
            </div>

            <div className="eth-topup-assets" aria-label="Supported top-up assets">
              {assets.map((asset) => (
                <div className="eth-topup-asset" key={asset.symbol}>
                  <span>{asset.symbol}</span>
                  <div>
                    <strong>{asset.label || asset.symbol}</strong>
                    <small>
                      {asset.kind === "native"
                        ? "Native ETH"
                        : shortEthereumAddress(asset.contractAddress)}
                    </small>
                  </div>
                  <em className={deposit?.pendingBalances?.[asset.symbol] ? "pending" : ""}>
                    {formatDepositAssetBalance(deposit, asset.symbol)}
                  </em>
                </div>
              ))}
            </div>

            <div className="wallet-link-warning">
              This address is controlled by Task Node for account funding. It is not a user wallet,
              withdrawals are not available, and wrong-chain deposits may not be recoverable.
            </div>

            {state?.message && <div className="eth-topup-status">{state.message}</div>}
          </>
        )}

        <footer>
          <button className="ghost-button" onClick={onClose} type="button">
            Done
          </button>
          <button className="solid-button" disabled={!deposit || busy} onClick={onRefresh} type="button">
            {state?.status === "syncing" ? "Refreshing" : "Refresh deposits"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function shortEthereumAddress(address = "") {
  const text = String(address || "").trim();
  if (!text) return "";
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatDepositAssetBalance(deposit, symbol) {
  const balance = deposit?.observedBalances?.[symbol];
  const pending = deposit?.pendingBalances?.[symbol];
  if (balance?.amount && Number(balance.amount) > 0) {
    return formatDepositAmount(balance.amount, symbol);
  }
  if (pending?.amount && Number(pending.amount) > 0) {
    return `Pending ${formatDepositAmount(pending.amount, symbol)}`;
  }
  return "Not seen";
}

function formatDepositAmount(value, symbol) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${symbol}`;
  const options = symbol === "ETH"
    ? { maximumFractionDigits: 8 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 6 };
  return `${amount.toLocaleString(undefined, options)} ${symbol}`;
}

function WalletFeedEmpty({ body, title }) {
  return (
    <div className="wallet-feed-empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function WalletTransactionRow({ hovered = false, onHover, tx }) {
  const isIn = tx.type === "in";
  const isSelf = tx.type === "self";
  const note = tx.note ? truncateWalletNote(tx.note) : "";

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
        <small>
          {isIn ? "From" : isSelf ? "Self" : "To"} {tx.counterpartyLabel || shortWalletAddress(tx.counterparty)}
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

function WalletLinkModal({
  action,
  onAppStateChange,
  onWalletVaultChange,
  onWalletVaultUnlocked,
  onClose,
  session,
}) {
  const isRelink = action?.id === "relink_start";
  const [walletCore, setWalletCore] = useState(null);
  const [mnemonic, setMnemonic] = useState("");
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [linking, setLinking] = useState(false);
  const normalized = walletCore?.normalizeMnemonic?.(mnemonic) || normalizeSeedInput(mnemonic);
  const wordCount = walletCore?.mnemonicWordCount?.(mnemonic) || seedWordCount(mnemonic);
  const valid = walletCore?.isValidTaskNodeMnemonic?.(mnemonic) || false;
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
      })
      .catch(() => {
        if (active) setMessage("Wallet tools could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, []);

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

    setLinking(true);
    setMessage("");

    try {
      const start = await requestJson(action?.path || "/api/wallet/link/start", {
        method: action?.method || "POST",
      });
      if (!start.ok || !start.body?.challenge?.message) {
        setMessage(start.body?.message || start.body?.actionRequired || "Wallet link could not start.");
        setLinking(false);
        return;
      }

      const proof = walletCore.signWalletChallenge(normalized, start.body.challenge.message);
      const verify = await requestJson(start.body.verifyPath || "/api/wallet/link/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: start.body.challenge.id,
          address: proof.address,
          publicKey: proof.publicKey,
          signature: proof.signature,
        }),
      });

      if (!verify.ok) {
        setMessage(verify.body?.message || verify.body?.actionRequired || "Wallet proof did not verify.");
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
        await onAppStateChange?.();
        setMessage("Wallet linked, but the encrypted vault could not be saved on this device.");
        setLinking(false);
        return;
      }

      setMnemonic("");
      setVaultPassword("");
      setVaultPasswordConfirm("");
      setMessage(verify.body?.message || (isRelink ? "Wallet relinked." : "Wallet linked."));
      await onAppStateChange?.();
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
            <h2>{isRelink ? "Relink Seed Wallet" : "Link Seed Wallet"}</h2>
            <p>
              {isRelink
                ? "Prove wallet ownership again. The recovery phrase stays in this browser."
                : "Validate and sign locally. Your recovery phrase is never sent to Task Node."}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet link">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
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
          The encrypted vault is saved only in this browser. Task Node never receives the phrase or password.
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="dark-pill" disabled={linking} onClick={linkWallet} type="button">
            {linking ? (isRelink ? "Relinking" : "Linking") : isRelink ? "Relink wallet" : "Link wallet"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function WalletDelinkModal({
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
        walletCore.removeLocalWalletVault({ accountId: session.accountId });
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
          Delinking clears the active server wallet link for this account and removes the encrypted local vault from this browser. Relinking requires a fresh signed wallet proof.
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

function WalletUnlockModal({
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
      walletCore.removeLocalWalletVault({ accountId: session.accountId });
      await onWalletVaultChange?.();
      onClose();
    } catch {
      setMessage("Local vault could not be removed.");
      setForgetting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal" role="dialog" aria-modal="true" aria-label="Unlock seed wallet">
        <header>
          <div>
            <h2>Unlock Seed Wallet</h2>
            <p>Decrypt the local vault for this browser session.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet unlock">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="wallet-proof-summary single">
          <span>
            <strong>{shortWalletAddress(linkedWallet?.address)}</strong>
            Linked wallet
          </span>
        </div>
        <label className="wallet-seed-field compact">
          <span>Wallet password</span>
          <input
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
        <div className="wallet-link-warning">
          Unlocking keeps the decrypted phrase in memory only. Lock the vault or log out to clear it.
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" disabled={forgetting} onClick={forgetVault} type="button">
            {forgetting ? "Forgetting" : "Forget local vault"}
          </button>
          <button className="dark-pill" disabled={!walletCore || !password || unlocking} onClick={unlockVault} type="button">
            {unlocking ? "Unlocking" : "Unlock"}
          </button>
        </footer>
      </div>
    </div>
  );
}

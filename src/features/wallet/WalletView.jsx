import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
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
import { EthereumTopUpModal, topUpDataSignature, useEthereumTopUpSync } from "../billing/ethereum-top-up";
import { WalletSeedBackupModal } from "./WalletSeedBackupModal";
import { WalletUnlockModal } from "./WalletUnlockModal";
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

const WALLET_TX_REFRESH_MS = 3000;
const WALLET_ACTIVITY_EVENT_NAME = "tasknode:wallet-activity";
const ETH_TOP_UP_SYNC_INITIAL_DELAY_MS = 1200;
const OAUTH_LINK_PROVIDER_IDS = new Set(["github", "telegram", "discord", "x"]);

function hasLinkedOAuthProvider(linkedProviders = []) {
  return linkedProviders.some((provider) =>
    OAUTH_LINK_PROVIDER_IDS.has(String(provider?.id || "").trim().toLowerCase())
  );
}

function showsEmailTopUpGrantHint({ initiationGift, linkedProviders, signedIn }) {
  if (!signedIn || initiationGift?.reason !== "email_ineligible") return false;
  return !hasLinkedOAuthProvider(linkedProviders);
}

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

export function WalletView({
  onAppStateChange,
  onLoginRequired,
  onWalletBalanceRefresh,
  onWalletVaultChange,
  onWalletVaultLock,
  onWalletVaultUnlocked,
  session,
  wallet,
  walletSecret,
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
  const [backupOpen, setBackupOpen] = useState(false);
  const [delinkOpen, setDelinkOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [creationResult, setCreationResult] = useState(null);
  const [creationRetrying, setCreationRetrying] = useState(false);
  const [grantClaiming, setGrantClaiming] = useState(false);
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
  const createAction = actions.find((action) => action.id === "create_start");
  const linkAction = actions.find((action) => action.id === "link_start");
  const relinkAction = actions.find((action) => action.id === "relink_start");
  const sendAction = actions.find((action) => action.id === "send_pft");
  const delinkAction = actions.find((action) => action.id === "delink");
  const initiationRetryAction = actions.find((action) => action.id === "initiation_retry");
  const fundingActions = usage?.fundingActions || [];
  const topUpAction = fundingActions.find((action) => action.id === "top_up_start");
  const linkedWallet = wallet?.pftWallet || {};
  const walletLinked = linkedWallet.status === "linked";
  const vaultAvailable = Boolean(walletVault?.available && walletVault?.address === linkedWallet.address);
  const vaultUnlocked = Boolean(vaultAvailable && walletVault?.unlocked);
  const vaultDisplay = walletVaultDisplayState(walletVault, linkedWallet.address);
  const signedIn = isSignedInSession(session);
  const initiationGift = wallet?.initiationGift || {};
  const usdcTopUpGift = wallet?.usdcTopUpInitiationGift || {};
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
  const primaryActionLabel = !walletLinked ? "Create wallet" : !vaultAvailable ? "Link wallet" : vaultUnlocked ? "Lock" : "Unlock";
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
  const grantAlreadySent =
    usdcTopUpGift.reason === "account_registered" ||
    usdcTopUpGift.grant?.status === "completed";
  const completedUsdcGrant =
    usdcTopUpGift.grant?.status === "completed" ? usdcTopUpGift.grant : null;
  const canClaimUsdcGrant =
    signedIn &&
    walletLinked &&
    vaultUnlocked &&
    linkedWallet.walletCreatedInAccount === true &&
    usdcTopUpGift.eligible === true;
  const showGrantClaimRow = canClaimUsdcGrant && !grantAlreadySent;
  const showGrantVaultRequiredRow =
    signedIn &&
    walletLinked &&
    !vaultUnlocked &&
    linkedWallet.walletCreatedInAccount === true &&
    usdcTopUpGift.eligible === true &&
    !grantAlreadySent;
  const showEmailTopUpGrantHint =
    showsEmailTopUpGrantHint({
      initiationGift,
      linkedProviders: session?.linkedProviders,
      signedIn,
    }) &&
    !grantAlreadySent;

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

  function openSeedBackup() {
    if (!requireSignedInForWalletLink()) return;
    if (!walletLinked) {
      setMessage("Link or create a wallet before backing up a seed phrase.");
      return;
    }
    if (!vaultAvailable) {
      setMessage("This browser does not have a saved local seed vault to back up.");
      return;
    }
    setMessage("");
    setBackupOpen(true);
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

  function openSendFlow() {
    if (!signedIn) {
      setMessage("Sign in before sending PFT.");
      onLoginRequired?.();
      return;
    }
    if (!walletLinked) {
      setMessage("Link a PFT wallet before sending PFT.");
      return;
    }
    if (!vaultAvailable) {
      setMessage("Save the matching local seed vault before sending PFT.");
      setWalletProofAction(linkAction);
      setLinkOpen(true);
      return;
    }
    if (!vaultUnlocked) {
      setMessage("Unlock the local seed vault before sending PFT.");
      setUnlockOpen(true);
      return;
    }
    if (!walletSecret?.mnemonic || walletSecret.address !== linkedWallet.address) {
      setMessage("Unlock the matching local seed vault before sending PFT.");
      setUnlockOpen(true);
      return;
    }
    setMessage("");
    setSendOpen(true);
  }

  async function refreshTopUpDeposits() {
    await syncTopUpDeposits({ silent: false });
  }

  async function claimInitiationGrant({ localVaultConfirmed = vaultUnlocked, openResultModal = false } = {}) {
    if (!signedIn || grantClaiming || creationRetrying) return;
    if (!localVaultConfirmed) {
      const vaultMessage = vaultAvailable
        ? "Unlock the matching local seed vault before sending the PFT initiation grant."
        : "Save the matching local seed vault before sending the PFT initiation grant.";
      setMessage(vaultMessage);
      if (openResultModal) {
        setCreationResult((current) => ({
          ...(current || {}),
          ok: false,
          initiationGift: {
            ...(current?.initiationGift || {}),
            ok: false,
            status: "local_vault_required",
            reason: "local_vault_required",
            message: vaultMessage,
          },
          message: vaultMessage,
          wallet: current?.wallet || linkedWallet,
        }));
      }
      return;
    }
    setGrantClaiming(true);
    setMessage("Sending the 12 PFT initiation grant.");

    if (openResultModal) {
      setCreationRetrying(true);
      setCreationResult((current) => ({
        ...(current || {}),
        retrying: true,
        message: "Sending the 12 PFT initiation grant.",
      }));
    }

    try {
      const result = await requestJson(initiationRetryAction?.path || "/api/wallet/initiation/retry", {
        method: initiationRetryAction?.method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVaultConfirmed: true }),
      });
      const nextResult = {
        ok: result.body?.ok === true,
        message: result.body?.message || result.body?.initiationGift?.message || "Initiation grant request finished.",
        initiationGift: result.body?.initiationGift || null,
        wallet: result.body?.wallet || creationResult?.wallet || linkedWallet,
      };
      setMessage(nextResult.message);
      if (openResultModal) {
        setCreationResult(nextResult);
      }
      await onAppStateChange?.();
    } catch (error) {
      const failureMessage = error?.message || "Initiation grant request failed.";
      setMessage(failureMessage);
      if (openResultModal) {
        setCreationResult((current) => ({
          ...(current || {}),
          ok: false,
          initiationGift: {
            ...(current?.initiationGift || {}),
            ok: false,
            status: "failed",
            message: failureMessage,
          },
          message: failureMessage,
          wallet: current?.wallet || linkedWallet,
        }));
      }
    } finally {
      setGrantClaiming(false);
      if (openResultModal) {
        setCreationRetrying(false);
        setCreationResult((current) => (current ? { ...current, retrying: false } : current));
      }
    }
  }

  async function retryInitiationGift() {
    await claimInitiationGrant({ openResultModal: true });
  }

  async function startWalletAction(action) {
    if (!action) {
      setMessage("Wallet actions are still loading.");
      return;
    }
    if (action.id === "create_start") {
      if (!requireSignedInForWalletLink()) return;
      if (walletLinked) {
        setMessage("Delink the current wallet before creating a new one for this account.");
        return;
      }
      setMessage("");
      setWalletProofAction(action);
      setLinkOpen(true);
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
        complete: result.body.sync?.archiveComplete === true,
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
    const timer = window.setInterval(() => refreshWalletTransactions({ force: true }), WALLET_TX_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [linkedWallet.address, refreshWalletTransactions, signedIn, walletLinked]);

  useEffect(() => {
    if (!signedIn || !walletLinked || !linkedWallet.address || typeof window === "undefined") {
      return undefined;
    }

    function handleWalletActivity(event) {
      const walletAddress = String(event.detail?.walletAddress || "").trim();
      if (walletAddress && walletAddress !== linkedWallet.address) return;
      refreshWalletTransactions({ force: true });
    }

    window.addEventListener(WALLET_ACTIVITY_EVENT_NAME, handleWalletActivity);
    return () => window.removeEventListener(WALLET_ACTIVITY_EVENT_NAME, handleWalletActivity);
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
              <button
                aria-label={`${vaultStatusLabel} seed vault`}
                className={`wallet-vault-chip is-${vaultDisplay.tone}`}
                onClick={openVaultControl}
                title={vaultDisplay.detail}
                type="button"
              >
                <ShieldCheck size={14} strokeWidth={1.8} />
                {vaultStatusLabel}
              </button>
            </div>

            <p className="wallet-balance-note">
              {walletLinked
                ? vaultUnlocked
                  ? "Encrypted vault unlocked for this browser session. Your seed never leaves this device."
                  : vaultAvailable
                    ? "Encrypted seed vault saved locally. Unlock before wallet-bound signing actions."
                    : "Ownership proof is linked. Save an encrypted local vault before wallet-bound actions."
                : "Create a new 24-word PFT wallet locally, or link an existing one. Your seed never leaves this device."}
            </p>

            <div className="wallet-actions">
              <button
                className="wallet-primary-action"
                onClick={() => startWalletAction(!walletLinked ? createAction || linkAction : linkAction)}
                type="button"
              >
                {!walletLinked ? <Plus size={16} strokeWidth={2} /> : vaultUnlocked ? <Lock size={16} strokeWidth={2} /> : walletLinked && vaultAvailable ? <Unlock size={16} strokeWidth={2} /> : <Link2 size={16} strokeWidth={2} />}
                {primaryActionLabel}
              </button>
              {!walletLinked && (
                <button className="wallet-secondary-action" onClick={() => startWalletAction(linkAction)} type="button">
                  <Link2 size={16} strokeWidth={2} />
                  Link wallet
                </button>
              )}
              <button
                className="wallet-secondary-action"
                disabled={!walletLinked}
                onClick={copyWalletAddress}
                type="button"
              >
                <Download size={16} strokeWidth={2} />
                Receive
              </button>
              <button className="wallet-secondary-action" disabled={!walletLinked} onClick={openSendFlow} type="button">
                <Send size={16} strokeWidth={2} />
                Send
              </button>
            </div>
          </div>
        </section>

        {!walletLinked && initiationGift?.amountPft && (
          <div className="wallet-inline-status is-initiation" role="status">
            {initiationGift.eligible
              ? `${Number(initiationGift.amountPft).toLocaleString("en-US")} PFT initiation gift available for eligible OAuth accounts.`
              : initiationGift.reason === "email_ineligible"
                ? "Email-only accounts can receive the PFT gift after creating a wallet and crediting more than $10 USDC."
                : initiationGift.message || "Wallet initiation gift eligibility will be checked after sign-in."}
          </div>
        )}

        {(balanceStatusLabel || balanceError || message) && (
          <div className="wallet-inline-status" role="status">
            {message || [balanceStatusLabel, balanceError].filter(Boolean).join(" · ")}
          </div>
        )}

        <section className="wallet-management-grid" aria-label="Wallet management">
          <WalletManagementCard
            active={!walletLinked && initiationGift?.eligible}
            disabled={walletLinked || pendingAction === "create_start"}
            icon={Plus}
            label="Create wallet"
            onClick={() => startWalletAction(createAction)}
            status={pendingAction === "create_start" ? "Working" : initiationGift?.eligible ? `${initiationGift.amountPft} PFT` : signedIn ? "Ready" : "Sign in"}
          />
          <WalletManagementCard
            icon={ShieldCheck}
            label="Local seed vault"
            onClick={openVaultControl}
            status={vaultUnlocked ? "Unlocked" : vaultAvailable ? "Locked" : "Not saved"}
          />
          <WalletManagementCard
            disabled={!walletLinked || !vaultAvailable}
            icon={KeyRound}
            label="Back up seed"
            onClick={openSeedBackup}
            status={vaultAvailable ? "Password required" : walletLinked ? "Not saved" : "No wallet"}
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

        {showEmailTopUpGrantHint && !showGrantClaimRow && !grantAlreadySent && (
          <p className="wallet-email-topup-hint">
            Email sign-in accounts receive the{" "}
            {Number(initiationGift.amountPft || 12).toLocaleString("en-US")} PFT initiation grant after topping up
            more than $10 USDC.
          </p>
        )}

        {grantAlreadySent && completedUsdcGrant && (
          <div className="wallet-grant-sent-row" role="status">
            <p>
              {Number(completedUsdcGrant.amountPft || 12).toLocaleString("en-US")} PFT initiation grant sent to this
              wallet.
            </p>
            {completedUsdcGrant.txHash && (
              <small>Tx {shortWalletAddress(completedUsdcGrant.txHash)}</small>
            )}
          </div>
        )}

        {showGrantVaultRequiredRow && (
          <div className="wallet-grant-claim-row">
            <p className="wallet-email-topup-hint">
              Your account qualifies for the{" "}
              {Number(usdcTopUpGift.amountPft || 12).toLocaleString("en-US")} PFT initiation grant. Unlock the
              matching local seed vault before sending it.
            </p>
            <button
              className="wallet-mini-action"
              disabled={!vaultAvailable}
              onClick={() => setUnlockOpen(true)}
              type="button"
            >
              {vaultAvailable ? "Unlock vault" : "Vault missing"}
            </button>
          </div>
        )}

        {showGrantClaimRow && (
          <div className="wallet-grant-claim-row">
            <p className="wallet-email-topup-hint">
              Your account qualifies for the{" "}
              {Number(usdcTopUpGift.amountPft || 12).toLocaleString("en-US")} PFT initiation grant.
            </p>
            <button
              className="wallet-mini-action"
              disabled={grantClaiming}
              onClick={() => claimInitiationGrant()}
              type="button"
            >
              {grantClaiming ? "Sending..." : "Send 12 PFT grant"}
            </button>
          </div>
        )}

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
          initiationRetryAction={initiationRetryAction}
          onAppStateChange={onAppStateChange}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultUnlocked={onWalletVaultUnlocked}
          onClose={() => {
            setLinkOpen(false);
            setWalletProofAction(null);
          }}
          onCreateResult={(result) => setCreationResult(result)}
          onNotice={(notice) => setMessage(notice)}
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
      {backupOpen && (
        <WalletSeedBackupModal
          linkedWallet={linkedWallet}
          onClose={() => setBackupOpen(false)}
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
      {sendOpen && (
        <WalletSendModal
          action={sendAction}
          linkedWallet={linkedWallet}
          onAppStateChange={onAppStateChange}
          onClose={() => setSendOpen(false)}
          onSent={async (result) => {
            setMessage(result?.message || "PFT sent.");
            await onWalletBalanceRefresh?.();
            await refreshWalletTransactions({ force: true });
          }}
          walletSecret={walletSecret}
        />
      )}
      {creationResult && (
        <WalletCreationResultModal
          onClose={() => setCreationResult(null)}
          onRetry={retryInitiationGift}
          onTopUp={() => {
            setCreationResult(null);
            openTopUpFlow();
          }}
          retrying={creationRetrying}
          result={creationResult}
        />
      )}
    </div>
  );
}

function formatPftFromDrops(drops) {
  const pft = Number(drops || 0) / 1_000_000;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 0,
    maximumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 6,
  }).format(pft);
}

function WalletSendModal({
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

function WalletCreationResultModal({ onClose, onRetry, onTopUp, result, retrying = false }) {
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
  const [seedConfirmed, setSeedConfirmed] = useState(false);
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
        if (active && isCreate) setMnemonic(module.generateTaskNodeMnemonic());
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
    setMnemonic(walletCore.generateTaskNodeMnemonic());
    setSeedConfirmed(false);
    setMessage("");
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
    if (isCreate && !seedConfirmed) {
      setMessage("Confirm that you saved the recovery phrase before creating this wallet.");
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
        setMessage("Wallet linked, but the encrypted vault could not be saved on this device.");
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
      setSeedConfirmed(false);
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
        <label className="wallet-seed-field">
          <span>24-word recovery phrase</span>
          <textarea
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            onChange={(event) => {
              if (isCreate) return;
              setMnemonic(event.target.value);
              setMessage("");
            }}
            placeholder="word one word two ..."
            readOnly={isCreate}
            spellCheck={false}
            value={mnemonic}
          />
        </label>
        {isCreate && (
          <div className="wallet-create-controls">
            <button className="light-pill" disabled={!walletCore || linking} onClick={regenerateMnemonic} type="button">
              <RefreshCw size={13} strokeWidth={1.8} />
              Regenerate
            </button>
            <label className="wallet-confirm-row">
              <input
                checked={seedConfirmed}
                onChange={(event) => {
                  setSeedConfirmed(event.target.checked);
                  setMessage("");
                }}
                type="checkbox"
              />
              <span>I saved this recovery phrase.</span>
            </label>
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
          <button className="dark-pill" disabled={linking} onClick={linkWallet} type="button">
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

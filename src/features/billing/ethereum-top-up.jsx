import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { requestJson } from "../../api";
import "../wallet/wallet.css";

const ETH_TOP_UP_SYNC_INITIAL_DELAY_MS = 1200;
const ETH_TOP_UP_SYNC_INTERVAL_MS = 8000;

function mergeTopUpSyncResult(current, body) {
  return {
    ...(current?.data || {}),
    ...body,
    depositAccount: body?.depositAccount || current?.data?.depositAccount,
  };
}

export function topUpDataSignature(data) {
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
    [depositAddress, setTopUpState, syncPath],
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
  const credited = deposit?.creditedBalances?.[symbol];
  const observed = deposit?.observedBalances?.[symbol];
  const pending = deposit?.pendingBalances?.[symbol];
  if (credited?.amount && Number(credited.amount) > 0) {
    return `Credited ${formatDepositAmount(credited.amount, symbol)}`;
  }
  if (pending?.amount && Number(pending.amount) > 0) {
    return `Pending ${formatDepositAmount(pending.amount, symbol)}`;
  }
  if (observed?.amount && Number(observed.amount) > 0) {
    return `Seen ${formatDepositAmount(observed.amount, symbol)}, not credited`;
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

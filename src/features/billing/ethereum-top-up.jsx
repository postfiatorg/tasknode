import { useCallback, useEffect, useRef } from "react";
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

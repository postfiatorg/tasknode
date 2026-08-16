import { useCallback, useEffect, useState } from "react";
import { requestJson } from "../../api";
import { formatCreditUsd, formatUsageUsd } from "../../formatters";
import { EthereumTopUpModal, useEthereumTopUpSync } from "./ethereum-top-up";

const PAYMENT_METHODS = [
  { k: "eth", name: "Ether", chain: "Ethereum mainnet", accent: "#627eea", letter: "E" },
  { k: "usdt", name: "USDT", chain: "Ethereum ERC-20", accent: "#26a17b", letter: "T" },
  { k: "usdc", name: "USDC", chain: "Ethereum ERC-20", accent: "#2775ca", letter: "$" },
];

export function BillingSettings({ onAppStateChange }) {
  const [ledger, setLedger] = useState(null);
  const [ledgerError, setLedgerError] = useState("");
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpState, setTopUpState] = useState({ status: "idle", data: null, message: "" });

  const loadLedger = useCallback(() => {
    let active = true;

    requestJson("/api/usage/ledger")
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setLedger(result.body);
          setLedgerError("");
        } else {
          setLedgerError(result.body?.message || `Billing history returned HTTP ${result.status}.`);
        }
      })
      .catch((error) => {
        if (active) setLedgerError(error?.message || "Billing history is unavailable.");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => loadLedger(), [loadLedger]);

  const syncBillingTopUp = useEthereumTopUpSync({
    onSynced: async () => {
      loadLedger();
      await onAppStateChange?.();
    },
    open: topUpOpen,
    setTopUpState,
    state: topUpState,
  });

  async function openBillingTopUp() {
    setTopUpOpen(true);
    setTopUpState((current) => ({
      ...current,
      status: current.data?.depositAccount ? "ready" : "loading",
      message: "",
    }));

    try {
      const result = await requestJson("/api/usage/top-up/start", { method: "POST" });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.actionRequired || "Top-up is unavailable.");
      }
      setTopUpState({ status: "ready", data: result.body, message: result.body.message || "" });
    } catch (error) {
      setTopUpState({ status: "error", data: null, message: error?.message || "Top-up is unavailable." });
    }
  }

  async function refreshBillingTopUp() {
    await syncBillingTopUp({ silent: false });
  }

  const entries = ledger?.entries || [];

  return (
    <div className="billing-settings">
      <section>
        <div>
          <small>Account balance</small>
          <strong>{formatCreditUsd(ledger?.availableCreditUsd || 0)} <span>credit</span></strong>
          <p>{formatCreditUsd(ledger?.currentCreditUsd || 0)} credited - {formatUsageUsd(ledger?.currentSpendUsd || 0)} spent</p>
        </div>
        <button className="dark-pill" onClick={openBillingTopUp} type="button">Top up</button>
      </section>
      <div>
        <div className="billing-heading">
          <h3>Payment methods</h3>
          <button onClick={openBillingTopUp} type="button">Top up</button>
        </div>
        <p>Send ETH, USDT, or USDC to your account deposit address. No wallet connection or signature is required.</p>
        <div className="payment-methods">
          {PAYMENT_METHODS.map((method) => (
            <CryptoMethodRow key={method.k} method={method} onTopUp={openBillingTopUp} />
          ))}
        </div>
      </div>
      <div>
        <h3>Billing history</h3>
        {ledgerError && <div className="inline-message">{ledgerError}</div>}
        {!ledgerError && entries.length > 0 ? (
          <div className="billing-ledger">
            {entries.map((entry) => (
              <LedgerEntryRow entry={entry} key={entry.id} />
            ))}
          </div>
        ) : (
          <div className="empty-billing">
            <strong>No payments yet</strong>
            <p>Top-ups and premium feature charges will appear here.</p>
          </div>
        )}
      </div>
      {topUpOpen && (
        <EthereumTopUpModal
          onClose={() => setTopUpOpen(false)}
          onRefresh={refreshBillingTopUp}
          state={topUpState}
        />
      )}
    </div>
  );
}

function LedgerEntryRow({ entry }) {
  const credit = ["account_credit", "reward_credit", "refund_credit"].includes(entry.kind);
  const amount = Number(entry.amountUsd || 0);
  const timestamp = entry.createdAt ? new Date(entry.createdAt) : null;
  const dateLabel =
    timestamp && !Number.isNaN(timestamp.valueOf())
      ? timestamp.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : "Pending";

  return (
    <div className="ledger-row">
      <span className={credit ? "ledger-dot credit" : "ledger-dot debit"} />
      <div>
        <strong>{ledgerTitle(entry)}</strong>
        <small>{ledgerMeta(entry, dateLabel)}</small>
      </div>
      <em className={credit ? "credit" : "debit"}>
        {credit ? "+" : "-"}
        {formatUsageUsd(amount)}
      </em>
    </div>
  );
}

function ledgerTitle(entry) {
  if (entry.kind === "chat_debit") return "Chat response";
  if (entry.kind === "reward_credit") return "Task reward credit";
  if (entry.kind === "refund_credit") return "Refund";
  return "Account credit";
}

function ledgerMeta(entry, dateLabel) {
  if (entry.provider && entry.model) return `${entry.provider} - ${entry.model} - ${dateLabel}`;
  if (entry.source) return `${entry.source.replace(/_/g, " ")} - ${dateLabel}`;
  return dateLabel;
}

function CryptoMethodRow({ method, onTopUp }) {
  return (
    <div className="crypto-method">
      <span style={{ background: method.accent }}>{method.letter}</span>
      <div>
        <strong>{method.name}</strong>
        <small>{method.chain}</small>
      </div>
      <button onClick={onTopUp} type="button">Use</button>
    </div>
  );
}

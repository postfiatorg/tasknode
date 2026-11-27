import { useState } from "react";
import { ArrowDownToLine, RotateCcw, Flame, CheckCircle2, AlertTriangle, Layers } from "lucide-react";
import {
  buildBridgeHoldClaimOperation,
  buildBridgeHoldReturnOperation,
  formatAtoms,
  summarizeBridgeHold,
} from "./model.js";
import "./navcoin-compliance.css";

function shortHex(value = "") {
  const s = String(value || "");
  if (s.length <= 20) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

export function BridgeHoldClaimView({
  recipientAccount = "",
  holds = [],
  assetMetadataById = {},
  onPrepareOperation,
}) {
  const [preparedOp, setPreparedOp] = useState(null);
  const [error, setError] = useState("");

  const list = Array.isArray(holds) ? holds : [];

  function handleClaim(hold) {
    setError("");
    setPreparedOp(null);
    try {
      const built = buildBridgeHoldClaimOperation({
        recipient: recipientAccount || hold.recipient,
        assetId: hold.asset_id,
        amount: hold.amount,
        hold,
      });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setError(err?.message || "Could not prepare bridge_hold_claim.");
    }
  }

  function handleReturn(hold, burn = false) {
    setError("");
    setPreparedOp(null);
    try {
      const built = buildBridgeHoldReturnOperation({
        recipient: recipientAccount || hold.recipient,
        assetId: hold.asset_id,
        amount: hold.amount,
        burn,
        hold,
      });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setError(err?.message || "Could not prepare bridge_hold_return.");
    }
  }

  return (
    <section className="nvc-card" aria-label="Aggregated bridge holds">
      <div className="nvc-head">
        <div>
          <span className="nvc-eyebrow">Pillar 8 · Aggregated (asset, recipient) Bridge Holds</span>
          <h3 className="nvc-title">Claimable Cross-Chain Bridge Holds</h3>
        </div>
        <span className="nvc-pill is-open">
          <Layers size={12} aria-hidden /> {list.length} {list.length === 1 ? "hold" : "holds"}
        </span>
      </div>

      <p className="nvc-muted">
        Finalized Ethereum or Solana bridge credits that cannot yet enter your wallet are aggregated into one hold per <code>(asset, recipient)</code> — preventing stranded funds and Solana batch jams. Claim once credentialed, or exit immediately under Return-only.
      </p>

      {list.length === 0 ? (
        <div className="nvc-empty">
          No aggregated bridge holds for {recipientAccount ? shortHex(recipientAccount) : "this account"}.
        </div>
      ) : (
        <ul className="nvc-hold-list">
          {list.map((hold) => {
            const meta = assetMetadataById[hold.asset_id] || {};
            const symbol = meta.symbol || "NAVCoin";
            const precision = meta.precision ?? 6;
            const summary = summarizeBridgeHold(hold, {
              eligibleToClaim: Boolean(meta.eligibleToClaim),
              lapsedExitRule: meta.lapsedExitRule || "return_only",
            });

            return (
              <li key={summary.holdKey || `${summary.assetId}:${summary.recipient}`} className="nvc-hold-item">
                <div className="nvc-hold-top">
                  <div>
                    <strong>{formatAtoms(summary.amount, precision)} {symbol}</strong>
                    <span className="nvc-hold-sub">
                      {summary.creditCount} aggregated bridge {summary.creditCount === 1 ? "credit" : "credits"} · Hold key <code>{shortHex(summary.holdKey)}</code>
                    </span>
                  </div>
                  <span className={`nvc-pill ${summary.canClaim ? "is-open" : "is-gated"}`}>
                    {summary.canClaim ? "Eligible to claim" : "Awaiting credential / eligibility"}
                  </span>
                </div>

                <p className="nvc-muted">
                  Reason: <code>{summary.reasonCode}</code> — {summary.reasonText}
                </p>

                <div className="nvc-hold-actions">
                  <button
                    type="button"
                    className="nvc-btn is-primary"
                    disabled={!summary.canClaim}
                    onClick={() => handleClaim(hold)}
                  >
                    <ArrowDownToLine size={14} aria-hidden />
                    Claim to wallet
                  </button>
                  <button
                    type="button"
                    className="nvc-btn"
                    disabled={!summary.canReturnOrBurn}
                    onClick={() => handleReturn(hold, false)}
                  >
                    <RotateCcw size={14} aria-hidden />
                    Return to issuer
                  </button>
                  <button
                    type="button"
                    className="nvc-btn is-danger"
                    disabled={!summary.canReturnOrBurn}
                    onClick={() => handleReturn(hold, true)}
                  >
                    <Flame size={14} aria-hidden />
                    Burn held units
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <div className="nvc-callout is-danger" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {preparedOp?.operation && (
        <div className="nvc-callout is-ok">
          <CheckCircle2 size={14} aria-hidden />
          <span>
            Prepared ordered-consensus <code>{preparedOp.operation.operation}</code> for {shortHex(preparedOp.operation.asset_id)}.
          </span>
        </div>
      )}
    </section>
  );
}

import { Globe, ShieldCheck, SlidersHorizontal, Lock } from "lucide-react";
import { describeLaunchMode } from "./model.js";
import "./navcoin-compliance.css";

export function PermissionlessLaunchToggle({
  symbol = "NAVCoin",
  config,
  existingAsset = null,
  onChange,
  onOpenComplianceDrawer,
}) {
  const gated = Boolean(config?.gated || config?.requires_authorization);
  const retroactivelyLocked = Boolean(existingAsset && existingAsset.requires_authorization === false);
  const modeInfo = describeLaunchMode(config);
  const ruleCount = config?.credential_policy?.any_of?.length || 0;

  function selectGated(nextGated) {
    if (retroactivelyLocked && nextGated) return;
    onChange?.({
      ...config,
      gated: nextGated,
      requires_authorization: nextGated,
    });
  }

  return (
    <section className="nvc-card" aria-label="NAVCoin access mode">
      <div className="nvc-head">
        <div>
          <span className="nvc-eyebrow">Post Fiat L1 · Pillar 8 Access Default</span>
          <h3 className="nvc-title">{symbol} Transfer &amp; Launch Mode</h3>
        </div>
        <span className={`nvc-pill ${gated ? "is-gated" : "is-open"}`}>
          {gated ? "Opt-in credential gated" : "Permissionless · No trust lines"}
        </span>
      </div>

      <div className="nvc-mode-grid" role="radiogroup" aria-label="Choose permissionless or gated mode">
        <button
          type="button"
          role="radio"
          aria-checked={!gated}
          className={`nvc-mode-option ${!gated ? "is-selected" : ""}`}
          onClick={() => selectGated(false)}
        >
          <div className="nvc-mode-title">
            <Globe size={15} aria-hidden />
            <strong>Permissionless (Default)</strong>
          </div>
          <p className="nvc-muted">
            No trust lines required. Anyone can receive, bid on DEX offers, or hold {symbol} with automatic implicit lines.
          </p>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={gated}
          disabled={retroactivelyLocked}
          className={`nvc-mode-option ${gated ? "is-selected" : ""}`}
          onClick={() => selectGated(true)}
        >
          <div className="nvc-mode-title">
            <ShieldCheck size={15} aria-hidden />
            <strong>Optional Compliance Gating</strong>
          </div>
          <p className="nvc-muted">
            Creator chooses external W3C VC or ZK-Passport issuers. Return-only default exit; barred from shielded pools in v1.
          </p>
        </button>
      </div>

      <p className="nvc-summary">{modeInfo.summary}</p>

      {retroactivelyLocked && (
        <div className="nvc-callout is-info">
          <Lock size={14} aria-hidden />
          <span>
            This asset launched permissionless. Consensus permanently prevents retroactively enabling gating (<code>requires_authorization</code> cannot flip false → true).
          </span>
        </div>
      )}

      {gated && (
        <div className="nvc-drawer-bar">
          <span className="nvc-muted">
            {ruleCount > 0
              ? `${ruleCount} credential rule${ruleCount === 1 ? "" : "s"} configured · Exit rule: ${config.lapsed_exit_rule === "strict_freeze_clawback" ? "Strict freeze/clawback" : "Return-only (default)"}`
              : "Manual issuer approval only until you add creator-chosen credential issuers."}
          </span>
          <button
            type="button"
            className="nvc-btn is-primary"
            onClick={() => onOpenComplianceDrawer?.()}
          >
            <SlidersHorizontal size={14} aria-hidden />
            Configure Compliance Drawer
          </button>
        </div>
      )}
    </section>
  );
}

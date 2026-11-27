import { useState } from "react";
import { Clock, Lock, ShieldAlert, XCircle, Coins, CheckCircle2 } from "lucide-react";
import {
  DEFAULT_FEE_SCHEDULE_DRAFT,
  NAV_FEE_MAX_ANNUAL_RATE_BPS,
  NAV_FEE_MAX_FIX_FEE_CAP_BPS,
  NAV_FEE_MAX_HWM_RATE_BPS,
  NAV_FEE_MAX_SPREAD_BPS,
  NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS,
  buildNavFeeClaimOperation,
  buildNavFeeScheduleAttachOperation,
  buildNavFeeScheduleCancelOperation,
  buildNavFeeScheduleSetOperation,
  classifyScheduleChange,
  computePendingHikeCountdown,
  formatBlockDuration,
  formatBpsPercent,
  formatProvenVsAttestedSplit,
  formatUnitsFromAtoms,
  hasConfiguredFeeSchedule,
  validateNavFeeScheduleInput,
} from "./model.js";
import "./navcoin-fees.css";

function shortAccount(address = "") {
  const s = String(address || "");
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

const FIELD_LABELS = {
  annual_rate_bps: "Annual rate",
  hwm_rate_bps: "High-water-mark rate",
  issue_spread_bps: "Primary issue spread",
  redeem_spread_bps: "Primary redeem spread",
  fix_fee_cap_bps: "FX fix fee cap",
  accrual_cap_blocks: "Accrual cap (blocks)",
  increase_notice_blocks: "Increase notice window",
  recipient: "Fee recipient",
};

function formatFieldValue(field, value) {
  if (field.endsWith("_bps")) return `${formatBpsPercent(value)} (${value} bps)`;
  if (field.endsWith("_blocks")) return `${Number(value).toLocaleString("en-US")} blocks (${formatBlockDuration(value)})`;
  if (field === "recipient") return shortAccount(value);
  return String(value ?? "");
}

export function NavFeePanel({
  assetId = "",
  symbol = "NAVCoin",
  issuerAccount = "",
  viewerAccount = "",
  feeReport = null,
  accrualHistory = [],
  reserveSplit = null,
  currentBlockHeight = 0,
  allowOptIn = false,
  canManage = false,
  maxEpochGapBlocks = null,
  onPrepareOperation,
}) {
  const configured = hasConfiguredFeeSchedule(feeReport);
  const feeState = configured ? feeReport.fee_state : null;
  const active = feeState?.active || null;
  const pending = feeState?.pending || null;

  const [optInEnabled, setOptInEnabled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => (
    active
      ? { ...DEFAULT_FEE_SCHEDULE_DRAFT, ...active, disclosure_ref: active.disclosure_ref || "" }
      : { ...DEFAULT_FEE_SCHEDULE_DRAFT }
  ));
  const [claimAmount, setClaimAmount] = useState("");
  const [preparedOp, setPreparedOp] = useState(null);
  const [actionError, setActionError] = useState("");

  // Pillar 7 invariant: when no fee schedule is configured and caller is not
  // opting in as a creator/issuer, render ZERO UI clutter.
  if (!configured && !allowOptIn) {
    return null;
  }

  const height = Number(currentBlockHeight || feeReport?.block_height || 0);
  const countdown = computePendingHikeCountdown(pending, height);
  const pendingDiff = active && pending?.schedule ? classifyScheduleChange(active, pending.schedule) : null;
  const splitInfo = reserveSplit ? formatProvenVsAttestedSplit(reserveSplit) : null;
  const canClaim = Boolean(
    active &&
    viewerAccount &&
    viewerAccount === active.recipient &&
    Number(feeState?.unclaimed_fee_units || 0) > 0,
  );

  const validation = validateNavFeeScheduleInput(draft, {
    issuerAccount,
    activeSchedule: active,
    maxEpochGapBlocks,
  });

  function updateDraft(field, value) {
    setActionError("");
    setPreparedOp(null);
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function handleScheduleSubmit(event) {
    event.preventDefault();
    setActionError("");
    setPreparedOp(null);
    if (!validation.ok) {
      setActionError(validation.errors[0].message);
      return;
    }
    try {
      const built = configured
        ? buildNavFeeScheduleSetOperation({
          issuer: issuerAccount,
          assetId,
          schedule: draft,
          activeSchedule: active,
          maxEpochGapBlocks,
        })
        : buildNavFeeScheduleAttachOperation({
          issuer: issuerAccount,
          assetId,
          schedule: draft,
          maxEpochGapBlocks,
        });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setActionError(err?.message || "Could not prepare fee schedule operation.");
    }
  }

  function handleCancelPending() {
    setActionError("");
    setPreparedOp(null);
    try {
      const built = buildNavFeeScheduleCancelOperation({ issuer: issuerAccount, assetId });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setActionError(err?.message || "Could not prepare fee cancellation.");
    }
  }

  function handleClaimSubmit(event) {
    event.preventDefault();
    setActionError("");
    setPreparedOp(null);
    try {
      const amount = claimAmount.trim() || String(feeState?.unclaimed_fee_units || 0);
      const built = buildNavFeeClaimOperation({
        recipient: viewerAccount,
        assetId,
        amount,
        unclaimedFeeUnits: feeState?.unclaimed_fee_units,
      });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setActionError(err?.message || "Could not prepare fee claim.");
    }
  }

  // Strictly opt-in creator view: when disabled, render ONLY the minimal opt-in switch.
  if (!configured && !optInEnabled) {
    return (
      <section className="nvf-optin-bar" aria-label="Optional fee schedule">
        <div>
          <strong>Optional fee schedule</strong>
          <p className="nvf-muted">
            Disabled by default. {symbol} launches with zero fee schedule and no fee UI on holders&apos; screens.
          </p>
        </div>
        <label className="nvf-switch">
          <input
            type="checkbox"
            checked={optInEnabled}
            onChange={(e) => {
              setOptInEnabled(e.target.checked);
              setActionError("");
              setPreparedOp(null);
            }}
          />
          <span>Attach fee schedule</span>
        </label>
      </section>
    );
  }

  return (
    <section className="nvf-panel" aria-label={`${symbol} fee schedule`}>
      <div className="nvf-head">
        <div>
          <span className="nvf-eyebrow">Post Fiat L1 · Optional Protocol Fee Schedule</span>
          <h3 className="nvf-title">{configured ? `${symbol} Fee Schedule` : `Configure ${symbol} Fee Schedule`}</h3>
        </div>
        <div className="nvf-head-badges">
          {active?.rates_locked && (
            <span className="nvf-pill is-locked">
              <Lock size={12} aria-hidden /> Rates locked
            </span>
          )}
          {!configured && (
            <button
              type="button"
              className="nvf-btn"
              onClick={() => {
                setOptInEnabled(false);
                setPreparedOp(null);
                setActionError("");
              }}
            >
              Disable fee schedule
            </button>
          )}
          {configured && canManage && (
            <button
              type="button"
              className="nvf-btn"
              onClick={() => {
                setEditing((prev) => !prev);
                setPreparedOp(null);
                setActionError("");
              }}
            >
              {editing ? "Close editor" : "Update schedule"}
            </button>
          )}
        </div>
      </div>

      {configured && active && (
        <>
          <dl className="nvf-grid">
            <div>
              <dt>Annual rate</dt>
              <dd>{formatBpsPercent(active.annual_rate_bps)} <small>({active.annual_rate_bps} / {NAV_FEE_MAX_ANNUAL_RATE_BPS} bps)</small></dd>
            </div>
            <div>
              <dt>High-water-mark rate</dt>
              <dd>{formatBpsPercent(active.hwm_rate_bps)} <small>({active.hwm_rate_bps} / {NAV_FEE_MAX_HWM_RATE_BPS} bps)</small></dd>
            </div>
            <div>
              <dt>Primary issue spread</dt>
              <dd>{formatBpsPercent(active.issue_spread_bps)} <small>({active.issue_spread_bps} / {NAV_FEE_MAX_SPREAD_BPS} bps)</small></dd>
            </div>
            <div>
              <dt>Primary redeem spread</dt>
              <dd>{formatBpsPercent(active.redeem_spread_bps)} <small>({active.redeem_spread_bps} / {NAV_FEE_MAX_SPREAD_BPS} bps)</small></dd>
            </div>
            <div>
              <dt>FX fix fee cap</dt>
              <dd>{formatBpsPercent(active.fix_fee_cap_bps)} <small>({active.fix_fee_cap_bps} / {NAV_FEE_MAX_FIX_FEE_CAP_BPS} bps)</small></dd>
            </div>
            <div>
              <dt>Increase notice window</dt>
              <dd>{formatBlockDuration(active.increase_notice_blocks)} <small>({Number(active.increase_notice_blocks).toLocaleString("en-US")} blocks)</small></dd>
            </div>
            <div>
              <dt>Fee recipient</dt>
              <dd><code>{shortAccount(active.recipient)}</code></dd>
            </div>
            <div>
              <dt>High-water mark NAV / unit</dt>
              <dd>{formatUnitsFromAtoms(feeState.high_water_mark_nav_per_unit || 0)}</dd>
            </div>
            <div>
              <dt>Unclaimed fee units</dt>
              <dd>{formatUnitsFromAtoms(feeState.unclaimed_fee_units || 0)} {symbol}</dd>
            </div>
            <div>
              <dt>Accrual cap per epoch</dt>
              <dd>{formatBlockDuration(active.accrual_cap_blocks)}</dd>
            </div>
          </dl>

          {active.disclosure_ref && (
            <div className="nvf-meta-line">
              <span>Disclosure reference</span>
              <code>{active.disclosure_ref}</code>
            </div>
          )}

          {splitInfo && (
            <div className="nvf-split-box">
              <div className="nvf-split-row">
                <span>Reserve verification split</span>
                <strong>{splitInfo.provenPct}% proven · {splitInfo.attestedPct}% attested</strong>
              </div>
              {splitInfo.requiresNonIssuerAttestor && (
                <p className="nvf-muted">
                  Attested reserves accrue fees only when backed by a registered non-issuer attestor account.
                </p>
              )}
            </div>
          )}

          {countdown && pending && (
            <div className={`nvf-pending ${countdown.isIncrease ? "is-hike" : "is-cut"}`} role="status">
              <div className="nvf-pending-head">
                <div className="nvf-pending-title">
                  <Clock size={15} aria-hidden />
                  <strong>
                    {countdown.isIncrease ? "Pending fee increase notice" : "Pending fee reduction"}
                  </strong>
                </div>
                <span className="nvf-countdown-pill">
                  {countdown.isEffective
                    ? "Ready on next epoch"
                    : `${countdown.formattedRemaining} · ${countdown.blocksRemaining.toLocaleString("en-US")} blocks left`}
                </span>
              </div>

              <div className="nvf-progress" aria-hidden>
                <span style={{ width: `${countdown.progressPct}%` }} />
              </div>

              <p className="nvf-muted">
                Effective at block #{countdown.effectiveAtHeight.toLocaleString("en-US")} (proposed at #{countdown.proposedAtHeight.toLocaleString("en-US")}).
                {countdown.exitCapacityLocked && " Exit capacity cannot be reduced while this increase is pending."}
              </p>

              {pendingDiff?.changedFields?.length > 0 && (
                <ul className="nvf-diff-list">
                  {pendingDiff.changedFields.map((change) => (
                    <li key={change.field}>
                      <span>{FIELD_LABELS[change.field] || change.field}</span>
                      <strong>
                        {formatFieldValue(change.field, change.previous)} → {formatFieldValue(change.field, change.next)}
                      </strong>
                    </li>
                  ))}
                </ul>
              )}

              {canManage && (
                <div className="nvf-pending-actions">
                  <button
                    type="button"
                    className="nvf-btn is-danger"
                    onClick={handleCancelPending}
                  >
                    <XCircle size={14} aria-hidden />
                    Cancel pending fee change
                  </button>
                </div>
              )}
            </div>
          )}

          {canClaim && (
            <form className="nvf-claim-row" onSubmit={handleClaimSubmit}>
              <label className="nvf-field">
                <span>Claim accrued fee units (atoms, max {Number(feeState.unclaimed_fee_units).toLocaleString("en-US")})</span>
                <input
                  type="number"
                  min={1}
                  max={feeState.unclaimed_fee_units}
                  step={1}
                  placeholder={String(feeState.unclaimed_fee_units)}
                  value={claimAmount}
                  onChange={(e) => setClaimAmount(e.target.value)}
                />
              </label>
              <button type="submit" className="nvf-btn is-primary">
                <Coins size={14} aria-hidden /> Prepare nav_fee_claim
              </button>
            </form>
          )}

          {Array.isArray(accrualHistory) && accrualHistory.length > 0 && (
            <details className="nvf-history">
              <summary>Recent deterministic epoch accruals ({accrualHistory.length})</summary>
              <ul>
                {accrualHistory.slice(0, 5).map((item) => (
                  <li key={`${item.asset_id}:${item.epoch}`}>
                    <span>Epoch #{item.epoch} · block #{Number(item.block_height).toLocaleString("en-US")}</span>
                    <strong>
                      +{formatUnitsFromAtoms(item.minted_fee_units)} {symbol} ({item.reason_code})
                    </strong>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {(!configured || editing) && (
        <form className="nvf-form" onSubmit={handleScheduleSubmit}>
          <div className="nvf-form-grid">
            <label className="nvf-field">
              <span>Annual rate (0–{NAV_FEE_MAX_ANNUAL_RATE_BPS} bps · max 5%/yr)</span>
              <input
                type="number"
                min={0}
                max={NAV_FEE_MAX_ANNUAL_RATE_BPS}
                step={1}
                value={draft.annual_rate_bps}
                onChange={(e) => updateDraft("annual_rate_bps", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>High-water-mark rate (0–{NAV_FEE_MAX_HWM_RATE_BPS} bps · max 50%)</span>
              <input
                type="number"
                min={0}
                max={NAV_FEE_MAX_HWM_RATE_BPS}
                step={1}
                value={draft.hwm_rate_bps}
                onChange={(e) => updateDraft("hwm_rate_bps", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>Primary issue spread (0–{NAV_FEE_MAX_SPREAD_BPS} bps · max 5%)</span>
              <input
                type="number"
                min={0}
                max={NAV_FEE_MAX_SPREAD_BPS}
                step={1}
                value={draft.issue_spread_bps}
                onChange={(e) => updateDraft("issue_spread_bps", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>Primary redeem spread (0–{NAV_FEE_MAX_SPREAD_BPS} bps · max 5%)</span>
              <input
                type="number"
                min={0}
                max={NAV_FEE_MAX_SPREAD_BPS}
                step={1}
                value={draft.redeem_spread_bps}
                onChange={(e) => updateDraft("redeem_spread_bps", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>FX fix fee cap (0–{NAV_FEE_MAX_FIX_FEE_CAP_BPS} bps · max 1%)</span>
              <input
                type="number"
                min={0}
                max={NAV_FEE_MAX_FIX_FEE_CAP_BPS}
                step={1}
                value={draft.fix_fee_cap_bps}
                onChange={(e) => updateDraft("fix_fee_cap_bps", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>Increase notice blocks (min {NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS.toLocaleString("en-US")} · 7d)</span>
              <input
                type="number"
                min={NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS}
                step={1}
                value={draft.increase_notice_blocks}
                onChange={(e) => updateDraft("increase_notice_blocks", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>Accrual cap per epoch (blocks)</span>
              <input
                type="number"
                min={1}
                max={maxEpochGapBlocks || undefined}
                step={1}
                value={draft.accrual_cap_blocks}
                onChange={(e) => updateDraft("accrual_cap_blocks", Number(e.target.value))}
              />
            </label>
            <label className="nvf-field">
              <span>Fee recipient account (must differ from issuer)</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="pf..."
                value={draft.recipient}
                onChange={(e) => updateDraft("recipient", e.target.value)}
              />
            </label>
          </div>

          <label className="nvf-field">
            <span>Optional disclosure reference (IPFS CID or Pillar 2 pointer, ≤ 128 bytes)</span>
            <input
              type="text"
              spellCheck={false}
              placeholder="ipfs://..."
              value={draft.disclosure_ref}
              onChange={(e) => updateDraft("disclosure_ref", e.target.value)}
            />
          </label>

          <label className="nvf-checkbox">
            <input
              type="checkbox"
              checked={Boolean(draft.rates_locked)}
              disabled={Boolean(active?.rates_locked)}
              onChange={(e) => updateDraft("rates_locked", e.target.checked)}
            />
            <span>Permanently lock rate ceilings (one-way; recipient rotation still permitted)</span>
          </label>

          {configured && validation.change.isIncrease && (
            <div className="nvf-callout is-warn">
              <Clock size={14} aria-hidden />
              <span>
                This update raises fees or shortens notice and will queue behind a{" "}
                <strong>{formatBlockDuration(validation.change.requiredNoticeBlocks)}</strong>{" "}
                ({validation.change.requiredNoticeBlocks.toLocaleString("en-US")} blocks) notice window.
              </span>
            </div>
          )}

          {!validation.ok && (
            <div className="nvf-alert is-danger" role="alert">
              <ShieldAlert size={14} aria-hidden />
              <span>{validation.errors[0].message}</span>
            </div>
          )}

          <button type="submit" className="nvf-btn is-primary" disabled={!validation.ok}>
            {configured ? "Prepare nav_fee_schedule_set" : "Prepare nav_fee_schedule_attach"}
          </button>
        </form>
      )}

      {actionError && (
        <div className="nvf-alert is-danger" role="alert">
          <ShieldAlert size={14} aria-hidden />
          <span>{actionError}</span>
        </div>
      )}

      {preparedOp?.operation && (
        <div className="nvf-callout is-ok">
          <CheckCircle2 size={14} aria-hidden />
          <span>
            Prepared ordered-consensus <code>{preparedOp.operation.operation}</code> payload for signing.
          </span>
        </div>
      )}
    </section>
  );
}

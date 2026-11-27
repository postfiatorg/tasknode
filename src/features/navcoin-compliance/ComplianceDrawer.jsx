import { useState } from "react";
import { X, Plus, Trash2, ShieldCheck, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import {
  ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS,
  CREDENTIAL_PROVIDER_PRESETS,
  MAX_CREDENTIAL_POLICY_OR_CLAUSES,
  buildAssetAccessSetOperation,
  evaluatePrivacyLinkWarning,
  formatDidPftl,
  validateComplianceConfig,
} from "./model.js";
import "./navcoin-compliance.css";

export function ComplianceDrawer({
  open = false,
  assetId = "",
  issuerAccount = "",
  chainId = "postfiat-wan-devnet-2",
  config,
  existingAsset = null,
  knownIssuers = [],
  hasPillar6Identity = false,
  usingSameAccountAsIdentity = false,
  onChange,
  onClose,
  onPrepareOperation,
}) {
  const [selectedPreset, setSelectedPreset] = useState(CREDENTIAL_PROVIDER_PRESETS[0].id);
  const [issuerIdInput, setIssuerIdInput] = useState(knownIssuers[0]?.issuer_id || "");
  const [credTypeInput, setCredTypeInput] = useState(knownIssuers[0]?.allowed_credential_types?.[0] || "");
  const [preparedOp, setPreparedOp] = useState(null);
  const [error, setError] = useState("");

  // Strictly optional drawer: renders nothing when closed.
  if (!open) return null;

  const clauses = Array.isArray(config?.credential_policy?.any_of) ? config.credential_policy.any_of : [];
  const validation = validateComplianceConfig(config, { existingAsset });
  const privacyNotice = evaluatePrivacyLinkWarning({
    hasPillar6Identity,
    usingSameAccount: usingSameAccountAsIdentity,
    isGatedFlow: true,
  });
  const issuerDid = formatDidPftl(chainId, issuerAccount);

  function updateField(field, value) {
    setError("");
    setPreparedOp(null);
    onChange?.({ ...config, [field]: value });
  }

  function addOrClause() {
    setError("");
    if (clauses.length >= MAX_CREDENTIAL_POLICY_OR_CLAUSES) {
      setError(`Maximum ${MAX_CREDENTIAL_POLICY_OR_CLAUSES} OR clauses allowed.`);
      return;
    }
    const cleanIssuerId = issuerIdInput.trim().toLowerCase();
    const cleanCredType = credTypeInput.trim();
    if (!cleanIssuerId || !cleanCredType) {
      setError("Enter both a 96-hex issuer_id and a domain-namespaced credential type.");
      return;
    }
    const nextClauses = [
      ...clauses,
      { all_of: [{ issuer_id: cleanIssuerId, credential_type: cleanCredType }] },
    ];
    onChange?.({
      ...config,
      gated: true,
      requires_authorization: true,
      credential_policy: { any_of: nextClauses },
    });
    setCredTypeInput("");
  }

  function removeOrClause(index) {
    setError("");
    setPreparedOp(null);
    const nextClauses = clauses.filter((_, i) => i !== index);
    onChange?.({
      ...config,
      credential_policy: { any_of: nextClauses },
    });
  }

  function handlePrepareAccessSet(event) {
    event.preventDefault();
    setError("");
    setPreparedOp(null);
    try {
      const built = buildAssetAccessSetOperation({
        issuer: issuerAccount,
        assetId,
        config,
        existingAsset,
      });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setError(err?.message || "Could not prepare asset_access_set operation.");
    }
  }

  function handleOneWayOpen() {
    setError("");
    setPreparedOp(null);
    try {
      const built = buildAssetAccessSetOperation({
        issuer: issuerAccount,
        assetId,
        disableAuthorizationPermanently: true,
      });
      setPreparedOp(built);
      onPrepareOperation?.(built);
    } catch (err) {
      setError(err?.message || "Could not prepare permissionless conversion.");
    }
  }

  const presetMeta = CREDENTIAL_PROVIDER_PRESETS.find((p) => p.id === selectedPreset) || CREDENTIAL_PROVIDER_PRESETS[0];

  return (
    <div className="nvc-drawer-backdrop" role="presentation">
      <aside className="nvc-drawer" role="dialog" aria-modal="true" aria-labelledby="nvc-drawer-title">
        <div className="nvc-drawer-head">
          <div>
            <span className="nvc-eyebrow">Pillar 8 · Creator-Chosen Optional Compliance</span>
            <h2 id="nvc-drawer-title">Credential Gating &amp; Exit Policy</h2>
          </div>
          <button type="button" className="nvc-icon-btn" onClick={onClose} aria-label="Close compliance drawer">
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="nvc-callout is-info">
          <Info size={14} aria-hidden />
          <span>
            <strong>Creator-owned compliance · Zero PII on chain:</strong> You choose which W3C VC or ZK-Passport issuers your asset trusts. Post Fiat governance never approves or polices KYC vendors, and only salted commitment hashes are stored on chain.
          </span>
        </div>

        {issuerDid && (
          <div className="nvc-did-bar">
            <span>Issuer DID</span>
            <code>{issuerDid}</code>
          </div>
        )}

        {privacyNotice.warn && (
          <div className="nvc-callout is-warn" role="alert">
            <AlertTriangle size={14} aria-hidden />
            <span>{privacyNotice.message}</span>
          </div>
        )}

        <form className="nvc-form" onSubmit={handlePrepareAccessSet}>
          <div className="nvc-section">
            <h4>1. Creator-chosen credential issuers (OR-of-AND policy)</h4>
            <div className="nvc-provider-tabs" role="tablist" aria-label="Credential adapter type">
              {CREDENTIAL_PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedPreset === preset.id}
                  className={selectedPreset === preset.id ? "is-active" : ""}
                  onClick={() => setSelectedPreset(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="nvc-muted">{presetMeta.summary}</p>

            {knownIssuers.length > 0 && (
              <label className="nvc-field">
                <span>Select registered on-chain issuer</span>
                <select
                  value={issuerIdInput}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setIssuerIdInput(nextId);
                    const found = knownIssuers.find((iss) => iss.issuer_id === nextId);
                    if (found?.allowed_credential_types?.[0]) {
                      setCredTypeInput(found.allowed_credential_types[0]);
                    }
                  }}
                >
                  <option value="">Custom issuer_id…</option>
                  {knownIssuers.map((iss) => (
                    <option key={iss.issuer_id} value={iss.issuer_id}>
                      {iss.domain} ({iss.status})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="nvc-two-col">
              <label className="nvc-field">
                <span>Issuer ID (96 lowercase hex)</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder="96 hex issuer_id"
                  value={issuerIdInput}
                  onChange={(e) => setIssuerIdInput(e.target.value)}
                />
              </label>
              <label className="nvc-field">
                <span>Namespaced credential type</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder={`vendor.example/${presetMeta.sampleTypes[0]}`}
                  value={credTypeInput}
                  onChange={(e) => setCredTypeInput(e.target.value)}
                />
              </label>
            </div>

            <button type="button" className="nvc-btn" onClick={addOrClause}>
              <Plus size={14} aria-hidden /> Add accepted credential rule ({clauses.length}/{MAX_CREDENTIAL_POLICY_OR_CLAUSES})
            </button>

            {clauses.length > 0 && (
              <ul className="nvc-rule-list">
                {clauses.map((clause, index) => (
                  <li key={`${index}-${clause.all_of.map((p) => `${p.issuer_id}:${p.credential_type}`).join("+")}`}>
                    <div>
                      <strong>Rule #{index + 1}</strong>
                      <span>{clause.all_of.map((p) => `${p.credential_type} (${p.issuer_id.slice(0, 10)}…)`).join(" AND ")}</span>
                    </div>
                    <button
                      type="button"
                      className="nvc-icon-btn"
                      aria-label={`Remove rule ${index + 1}`}
                      onClick={() => removeOrClause(index)}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="nvc-section">
            <h4>2. Approval mode &amp; Return-only exit disclosure</h4>
            <div className="nvc-two-col">
              <label className="nvc-field">
                <span>Approval mode</span>
                <select
                  value={config.approval_mode || "either"}
                  onChange={(e) => updateField("approval_mode", e.target.value)}
                >
                  <option value="either">Either (manual approval OR valid credential)</option>
                  <option value="both">Both (manual approval AND valid credential)</option>
                </select>
              </label>

              <label className="nvc-field">
                <span>Lapsed-eligibility exit rule</span>
                <select
                  value={config.lapsed_exit_rule || "return_only"}
                  onChange={(e) => updateField("lapsed_exit_rule", e.target.value)}
                >
                  <option value="return_only">Return-only (Default — funds never stranded)</option>
                  <option value="strict_freeze_clawback">Strict freeze / clawback (jurisdiction-specific)</option>
                </select>
              </label>
            </div>

            <div className="nvc-callout is-ok">
              <ShieldCheck size={14} aria-hidden />
              <span>
                <strong>Return-only exit disclosure:</strong> Under Return-only (default), if a holder&apos;s credential expires or is revoked, third-party transfers are blocked while <code>NavRedeemAtNav</code>, <code>AssetBurn</code>, <code>bridge_hold_return</code>, and direct <code>pay-issuer</code> exits remain permanently open so funds are never stranded.
              </span>
            </div>
          </div>

          <div className="nvc-section">
            <h4>3. Cross-chain wrapper &amp; policy notice</h4>
            <div className="nvc-two-col">
              <label className="nvc-field">
                <span>Ethereum / Uniswap wrapper setting</span>
                <select
                  value={config.wrapper_mode || "pftl_only"}
                  onChange={(e) => updateField("wrapper_mode", e.target.value)}
                >
                  <option value="pftl_only">PFTL only (no Ethereum/Uniswap wrapper)</option>
                  <option value="pftl_plus_ethereum_free_wrapper">PFTL + Ethereum free-moving wrapper (clearly disclosed)</option>
                </select>
              </label>

              <label className="nvc-field">
                <span>Policy tightening notice (min 7d · 604,800 blocks)</span>
                <input
                  type="number"
                  min={ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS}
                  step={1}
                  value={config.notice_blocks ?? ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS}
                  onChange={(e) => updateField("notice_blocks", Number(e.target.value))}
                />
              </label>
            </div>
            <p className="nvc-muted">
              Gated assets stay barred from shielded pools in v1 (<code>gated_asset_shielded_pool_forbidden</code>). Brand-new 0-PFT holders can onboard via atomic issuer-submitted <code>credential_create_and_accept</code>.
            </p>
          </div>

          {!validation.ok && (
            <div className="nvc-callout is-danger" role="alert">
              <AlertTriangle size={14} aria-hidden />
              <span>{validation.errors[0].message}</span>
            </div>
          )}

          {error && (
            <div className="nvc-callout is-danger" role="alert">
              <AlertTriangle size={14} aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="nvc-drawer-actions">
            <button type="submit" className="nvc-btn is-primary" disabled={!validation.ok}>
              Prepare asset_access_set
            </button>
            {existingAsset?.requires_authorization && (
              <button type="button" className="nvc-btn" onClick={handleOneWayOpen}>
                Permanently remove gating (one-way)
              </button>
            )}
          </div>

          {preparedOp?.operation && (
            <div className="nvc-callout is-ok">
              <CheckCircle2 size={14} aria-hidden />
              <span>
                Prepared ordered-consensus <code>{preparedOp.operation.operation}</code> payload.
              </span>
            </div>
          )}
        </form>
      </aside>
    </div>
  );
}

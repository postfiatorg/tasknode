import { useState } from "react";
import { X, ShieldCheck, KeyRound, Link2, CheckCircle2, AlertTriangle } from "lucide-react";
import { requestJson } from "../../api";
import {
  DEFAULT_IDENTITY_NAMESPACE,
  DEFAULT_IDENTITY_RELAYS,
  IDENTITY_KINDS,
  IDENTITY_LINK_FEE_ATOMS,
  IDENTITY_MINT_FEE_ATOMS,
  buildLinkRequestPayload,
  buildMintRequestPayload,
  buildRotateRequestPayload,
  classifyHandle,
  describeLinkKind,
  formatPftFromAtoms,
} from "./onchain-identity-model.js";
import "./onchain-identity.css";

const LINK_OPTIONS = [
  "validator_node",
  "old_chain_account",
  "agent_controller",
  "custom_nip05",
  "evm_address",
  "solana_address",
];

export function MintIdentityModal({
  initialTab = "mint",
  status = null,
  defaultAccount = "",
  defaultHandle = "",
  onClose,
  onBuiltPayload,
}) {
  const namespace = status?.namespace || DEFAULT_IDENTITY_NAMESPACE;
  const legacyV1 = status?.legacyV1 || null;
  const onChain = status?.onChain || null;

  const [tab, setTab] = useState(initialTab);
  const [account, setAccount] = useState(onChain?.account || defaultAccount || "");
  const [handleInput, setHandleInput] = useState(onChain?.handle || defaultHandle || "");
  const [handleCheck, setHandleCheck] = useState(null);
  const [preserveV1, setPreserveV1] = useState(Boolean(legacyV1?.nostrPubkeyHex));
  const [nostrPubkeyHex, setNostrPubkeyHex] = useState(
    onChain?.nostr_pubkey || legacyV1?.nostrPubkeyHex || "",
  );
  const [identityKind, setIdentityKind] = useState(onChain?.identity_kind || "human");
  const [relaysText, setRelaysText] = useState(
    (onChain?.relays?.length ? onChain.relays : DEFAULT_IDENTITY_RELAYS).join("\n"),
  );
  const [avatarNftId, setAvatarNftId] = useState(onChain?.avatar_nft_id || "");
  const [pqReceiveAddress, setPqReceiveAddress] = useState(onChain?.pq_receive_address || "");
  const [reservation, setReservation] = useState(status?.reservations?.[0] || null);
  const [handleAttestation, setHandleAttestation] = useState(null);

  // Rotate state
  const [rotateMode, setRotateMode] = useState("planned");
  const [newNostrPubkeyHex, setNewNostrPubkeyHex] = useState("");
  const [rotateKeyIndex, setRotateKeyIndex] = useState((onChain?.key_index ?? 0) + 1);

  // Link & Custom NIP-05 state
  const [linkKind, setLinkKind] = useState("validator_node");
  const [linkTarget, setLinkTarget] = useState("");
  const [customVerifyResult, setCustomVerifyResult] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [builtResult, setBuiltResult] = useState(null);

  const localHandleInfo = handleInput.trim() ? classifyHandle(handleInput) : null;

  async function checkHandleAvailability() {
    setError("");
    setHandleCheck(null);
    const cleaned = handleInput.trim().replace(/^@+/, "");
    if (!cleaned) {
      setError("Enter a handle to check.");
      return;
    }
    setBusy(true);
    try {
      const res = await requestJson(
        `/api/identity/check-handle?handle=${encodeURIComponent(cleaned)}&kind=${encodeURIComponent(identityKind)}`,
      );
      setHandleCheck(res.body || { ok: false, error: "Could not check handle." });
    } catch (err) {
      setError(err?.message || "Handle availability check failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reserveHandle() {
    setError("");
    setBusy(true);
    try {
      const res = await requestJson("/api/identity/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: handleInput.trim().replace(/^@+/, ""),
          l1Account: account.trim(),
          nostrPubkeyHex: nostrPubkeyHex.trim().toLowerCase(),
          optIntoV2: !preserveV1,
          identityKind,
        }),
      });
      if (!res.ok || !res.body?.ok) {
        throw new Error(res.body?.error || "Could not reserve handle.");
      }
      setReservation(res.body.reservation);
      setHandleAttestation(null);
    } catch (err) {
      setError(err?.message || "Handle reservation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestHandleAttestation() {
    setError("");
    setBusy(true);
    try {
      const res = await requestJson("/api/identity/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: account.trim(),
          handle: reservation?.handle || handleInput.trim().replace(/^@+/, ""),
          nostrPubkeyHex: (reservation?.nostrPubkeyHex || nostrPubkeyHex).trim().toLowerCase(),
          reservationSaltHex: reservation?.reservationSaltHex || "",
          identityKind,
        }),
      });
      if (!res.ok || !res.body?.ok) {
        throw new Error(res.body?.error || "Could not obtain registrar handle attestation.");
      }
      setHandleAttestation(res.body.attestation || null);
    } catch (err) {
      setError(err?.message || "Handle attestation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function buildMintTx(event) {
    event.preventDefault();
    setError("");
    setBuiltResult(null);
    setBusy(true);
    try {
      const reqPayload = buildMintRequestPayload({
        account: account.trim(),
        nostrPubkeyHex,
        preserveV1Npub: preserveV1,
        keyIndex: 0,
        identityKind,
        handleAttestation: handleAttestation?.registrar_signature_hex ? handleAttestation : null,
        reservationSaltHex: reservation?.reservationSaltHex || "",
        relays: relaysText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        avatarNftId,
        pqReceiveAddress,
      });
      const res = await requestJson("/api/identity/build-tx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqPayload),
      });
      if (!res.ok || !res.body?.ok) {
        throw new Error(res.body?.message || res.body?.error || "Could not prepare identity_set transaction.");
      }
      setBuiltResult(res.body);
      onBuiltPayload?.(res.body);
    } catch (err) {
      setError(err?.message || "Failed to build mint payload.");
    } finally {
      setBusy(false);
    }
  }

  async function buildRotateTx(event) {
    event.preventDefault();
    setError("");
    setBuiltResult(null);
    setBusy(true);
    try {
      const reqPayload = buildRotateRequestPayload({
        account: account.trim(),
        mode: rotateMode,
        newNostrPubkeyHex,
        derivationVersion: 2,
        keyIndex: rotateKeyIndex,
        sequence: (onChain?.sequence || 1) + 1,
      });
      const res = await requestJson("/api/identity/build-tx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqPayload),
      });
      if (!res.ok || !res.body?.ok) {
        throw new Error(res.body?.message || res.body?.error || "Could not prepare key rotation.");
      }
      setBuiltResult(res.body);
      onBuiltPayload?.(res.body);
    } catch (err) {
      setError(err?.message || "Failed to build rotation payload.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCustomNip05Verify() {
    setError("");
    setCustomVerifyResult(null);
    setBusy(true);
    try {
      const res = await requestJson("/api/identity/custom-nip05/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identifier: linkTarget.trim(),
          nostrPubkeyHex: nostrPubkeyHex.trim().toLowerCase(),
          account: account.trim(),
          existingLinkCount: onChain?.links?.length || 0,
        }),
      });
      if (!res.ok || !res.body?.ok) {
        throw new Error(res.body?.error || "Custom NIP-05 verification failed.");
      }
      setCustomVerifyResult(res.body);
      if (res.body.linkTx) {
        setBuiltResult(res.body.linkTx);
        onBuiltPayload?.(res.body.linkTx);
      }
    } catch (err) {
      setError(err?.message || "Custom NIP-05 verification failed.");
    } finally {
      setBusy(false);
    }
  }

  async function buildLinkTx(event) {
    event.preventDefault();
    if (linkKind === "custom_nip05") {
      await handleCustomNip05Verify();
      return;
    }
    setError("");
    setBuiltResult(null);
    setBusy(true);
    try {
      const reqPayload = buildLinkRequestPayload({
        account: account.trim(),
        kind: linkKind,
        target: linkTarget.trim(),
        existingLinkCount: onChain?.links?.length || 0,
        sequence: (onChain?.sequence || 1) + 1,
      });
      const res = await requestJson("/api/identity/build-tx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqPayload),
      });
      if (!res.ok || !res.body?.ok) {
        throw new Error(res.body?.message || res.body?.error || "Could not prepare link payload.");
      }
      setBuiltResult(res.body);
      onBuiltPayload?.(res.body);
    } catch (err) {
      setError(err?.message || "Failed to build link payload.");
    } finally {
      setBusy(false);
    }
  }

  const linkMeta = describeLinkKind(linkKind);

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="login-dialog oci-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oci-modal-title"
      >
        <button className="dialog-close" type="button" onClick={onClose} aria-label="Close">
          <X size={18} strokeWidth={2} />
        </button>

        <span className="oci-eyebrow">Post Fiat L1 · Ordered Consensus</span>
        <h2 id="oci-modal-title">Mint Your Task Node Identity</h2>
        <p className="oci-lead">
          Anchor your Nostr key, <code>@{namespace}</code> handle, and opt-in validator or agent links directly on chain.
        </p>

        <div className="oci-tabs" role="tablist" aria-label="Identity actions">
          <button type="button" role="tab" aria-selected={tab === "mint"} className={tab === "mint" ? "is-active" : ""} onClick={() => { setTab("mint"); setError(""); setBuiltResult(null); }}>
            <ShieldCheck size={14} aria-hidden /> Mint
          </button>
          <button type="button" role="tab" aria-selected={tab === "rotate"} className={tab === "rotate" ? "is-active" : ""} onClick={() => { setTab("rotate"); setError(""); setBuiltResult(null); }}>
            <KeyRound size={14} aria-hidden /> Rotate key
          </button>
          <button type="button" role="tab" aria-selected={tab === "links"} className={tab === "links" ? "is-active" : ""} onClick={() => { setTab("links"); setError(""); setBuiltResult(null); }}>
            <Link2 size={14} aria-hidden /> Links &amp; custom NIP-05
          </button>
        </div>

        <label className="oci-field">
          <span>Post Fiat L1 account (ML-DSA-65)</span>
          <input
            type="text"
            spellCheck={false}
            placeholder="pf..."
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
        </label>

        {tab === "mint" && (
          <form className="oci-form" onSubmit={buildMintTx}>
            <div className="oci-field">
              <span>Handle under @{namespace}</span>
              <div className="oci-inline-row">
                <input
                  type="text"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="your-handle"
                  value={handleInput}
                  onChange={(e) => { setHandleInput(e.target.value); setHandleCheck(null); }}
                />
                <button type="button" className="oci-btn" disabled={busy} onClick={checkHandleAvailability}>
                  Check
                </button>
                <button type="button" className="oci-btn" disabled={busy || !nostrPubkeyHex} onClick={reserveHandle}>
                  Reserve
                </button>
              </div>
              {localHandleInfo && !localHandleInfo.valid && (
                <small className="oci-hint is-danger">
                  Use 2–32 lowercase letters, digits, dots, hyphens, or underscores with no leading/trailing punctuation.
                </small>
              )}
              {localHandleInfo?.reserved && (
                <small className="oci-hint is-warn">
                  Reserved {localHandleInfo.category} handle — requires authorized reservation commitment.
                </small>
              )}
              {handleCheck && (
                <small className={`oci-hint ${handleCheck.available ? "is-ok" : "is-danger"}`}>
                  {handleCheck.available
                    ? `${handleCheck.nip05} is available to reserve.`
                    : `Unavailable (${handleCheck.error || "reserved"}).`}
                </small>
              )}
              {reservation && (
                <div className="oci-callout is-ok">
                  <CheckCircle2 size={14} aria-hidden />
                  <span>
                    Salted reservation ready for <strong>{reservation.nip05}</strong> (derivation v{reservation.derivationVersion}).
                    {handleAttestation ? ` Attestation expires at height ${handleAttestation.expires_at_height}.` : ""}
                  </span>
                  <button
                    type="button"
                    className="oci-btn"
                    disabled={busy || !account.trim()}
                    onClick={requestHandleAttestation}
                  >
                    {handleAttestation ? "Re-attest" : "Request attestation"}
                  </button>
                </div>
              )}
            </div>

            <div className="oci-field">
              <span>Nostr public key (64 hex)</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="64 lowercase hex characters"
                value={nostrPubkeyHex}
                onChange={(e) => setNostrPubkeyHex(e.target.value)}
              />
              <label className="oci-checkbox">
                <input
                  type="checkbox"
                  checked={preserveV1}
                  onChange={(e) => setPreserveV1(e.target.checked)}
                />
                <span>Preserve existing v1 npub (keeps Hive chat history &amp; DM contacts intact)</span>
              </label>
            </div>

            <div className="oci-two-col">
              <label className="oci-field">
                <span>Identity kind</span>
                <select value={identityKind} onChange={(e) => setIdentityKind(e.target.value)}>
                  {IDENTITY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              <label className="oci-field">
                <span>Profile NFT avatar ID (optional)</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder="96 hex NFT ID"
                  value={avatarNftId}
                  onChange={(e) => setAvatarNftId(e.target.value)}
                />
              </label>
            </div>

            <label className="oci-field">
              <span>Shielded receive address (optional, Pillar 5)</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="pfpq1..."
                value={pqReceiveAddress}
                onChange={(e) => setPqReceiveAddress(e.target.value)}
              />
            </label>

            <label className="oci-field">
              <span>Nostr relays (max 5 wss:// URLs)</span>
              <textarea
                rows={3}
                spellCheck={false}
                value={relaysText}
                onChange={(e) => setRelaysText(e.target.value)}
              />
            </label>

            <div className="oci-fee-bar">
              <span>Burned state-expansion fee</span>
              <strong>{formatPftFromAtoms(IDENTITY_MINT_FEE_ATOMS)} ({IDENTITY_MINT_FEE_ATOMS.toLocaleString()} atoms)</strong>
            </div>

            <button type="submit" className="oci-btn is-primary is-block" disabled={busy}>
              {busy ? "Preparing…" : "Prepare identity_set Mint Transaction"}
            </button>
          </form>
        )}

        {tab === "rotate" && (
          <form className="oci-form" onSubmit={buildRotateTx}>
            <div className="oci-field">
              <span>Rotation mode</span>
              <select value={rotateMode} onChange={(e) => setRotateMode(e.target.value)}>
                <option value="planned">Planned rotation (preserves handle &amp; links)</option>
                <option value="compromised">Compromised rotation (permanently tombstones old npub)</option>
              </select>
              {rotateMode === "compromised" && (
                <div className="oci-alert is-danger">
                  <AlertTriangle size={14} aria-hidden />
                  <span>
                    Compromised mode permanently tombstones your old Nostr pubkey so it can never be rebound, and immediately strips badges from unanchored events.
                  </span>
                </div>
              )}
            </div>

            <label className="oci-field">
              <span>New Nostr public key (v2 seed KDF, 64 hex)</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="64 lowercase hex characters"
                value={newNostrPubkeyHex}
                onChange={(e) => setNewNostrPubkeyHex(e.target.value)}
              />
            </label>

            <label className="oci-field">
              <span>v2 key_index</span>
              <input
                type="number"
                min={0}
                step={1}
                value={rotateKeyIndex}
                onChange={(e) => setRotateKeyIndex(Number(e.target.value))}
              />
            </label>

            <button type="submit" className="oci-btn is-primary is-block" disabled={busy}>
              {busy ? "Preparing…" : "Prepare Key Rotation Transaction"}
            </button>
          </form>
        )}

        {tab === "links" && (
          <form className="oci-form" onSubmit={buildLinkTx}>
            <label className="oci-field">
              <span>Link type (opt-in only)</span>
              <select value={linkKind} onChange={(e) => { setLinkKind(e.target.value); setCustomVerifyResult(null); }}>
                {LINK_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>{describeLinkKind(kind).label}</option>
                ))}
              </select>
              <small className="oci-hint">{linkMeta.hint}</small>
            </label>

            <label className="oci-field">
              <span>
                {linkKind === "validator_node"
                  ? "Validator node_id"
                  : linkKind === "old_chain_account"
                    ? "Old-chain wallet address"
                    : linkKind === "agent_controller"
                      ? "Human controller L1 account (pf...)"
                      : linkKind === "custom_nip05"
                        ? "Custom NIP-05 (you@yourdomain.com)"
                        : "External wallet address"}
              </span>
              <input
                type="text"
                spellCheck={false}
                placeholder={linkKind === "custom_nip05" ? "you@yourdomain.com" : "Target identifier"}
                value={linkTarget}
                onChange={(e) => setLinkTarget(e.target.value)}
              />
            </label>

            {linkKind === "custom_nip05" && (
              <label className="oci-field">
                <span>Nostr public key to verify against domain</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder="64 lowercase hex characters"
                  value={nostrPubkeyHex}
                  onChange={(e) => setNostrPubkeyHex(e.target.value)}
                />
              </label>
            )}

            {customVerifyResult?.ok && (
              <div className="oci-callout is-ok">
                <CheckCircle2 size={14} aria-hidden />
                <span>
                  Verified <strong>{customVerifyResult.verification.identifier}</strong> via {customVerifyResult.verification.method} (client-verified, non-unique on chain).
                </span>
              </div>
            )}

            <div className="oci-fee-bar">
              <span>Burned state-expansion fee per link</span>
              <strong>{formatPftFromAtoms(IDENTITY_LINK_FEE_ATOMS)} ({IDENTITY_LINK_FEE_ATOMS.toLocaleString()} atoms)</strong>
            </div>

            <button type="submit" className="oci-btn is-primary is-block" disabled={busy}>
              {busy
                ? "Working…"
                : linkKind === "custom_nip05"
                  ? "Verify Custom NIP-05 & Prepare Link"
                  : "Prepare Co-Signed Link Payload"}
            </button>
          </form>
        )}

        {error && (
          <div className="oci-alert is-danger" role="alert">
            <AlertTriangle size={14} aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {builtResult?.operation && (
          <details className="oci-preview" open>
            <summary>Unsigned ordered-consensus identity_set payload</summary>
            <pre>{JSON.stringify(builtResult.operation, null, 2)}</pre>
          </details>
        )}
      </section>
    </div>
  );
}

import { ShieldCheck, KeyRound, Link2, AlertTriangle, Sparkles } from "lucide-react";
import {
  DEFAULT_IDENTITY_NAMESPACE,
  IDENTITY_MINT_FEE_ATOMS,
  deriveIdentityBadges,
  describeLinkKind,
  formatPftFromAtoms,
} from "./onchain-identity-model.js";
import "./onchain-identity.css";

function shortHex(value = "", head = 8, tail = 6) {
  const s = String(value || "");
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function IdentityStatusCard({
  status = null,
  loading = false,
  onOpenMint,
  onOpenRotate,
  onOpenLinks,
}) {
  const onChain = status?.onChain || null;
  const legacyV1 = status?.legacyV1 || null;
  const customClaims = Array.isArray(status?.customClaims) ? status.customClaims : [];
  const namespace = status?.namespace || DEFAULT_IDENTITY_NAMESPACE;
  const isMinted = Boolean(onChain && onChain.status === "active");
  const isRevoked = Boolean(onChain && onChain.status === "revoked");
  const isCompromised = Boolean(onChain?.compromised);
  const badges = deriveIdentityBadges(onChain);
  const activeHandle = onChain?.handle
    ? `${onChain.handle}@${onChain.registered_namespace || namespace}`
    : legacyV1?.nip05 || "";
  const activePubkey = onChain?.nostr_pubkey || legacyV1?.nostrPubkeyHex || "";
  const derivationVersion = onChain?.derivation_version || legacyV1?.derivationVersion || null;
  const links = Array.isArray(onChain?.links) ? onChain.links : [];

  return (
    <section className="oci-card" aria-label="On-chain identity status">
      <div className="oci-card-head">
        <div>
          <span className="oci-eyebrow">Post Fiat L1 · Pillar 6</span>
          <h3 className="oci-title">
            {isMinted ? "On-Chain Task Node Identity" : "Task Node Identity"}
          </h3>
        </div>
        <span className={`oci-pill ${isRevoked || isCompromised ? "is-danger" : isMinted ? "is-verified" : "is-muted"}`}>
          {isRevoked ? "Revoked" : isCompromised ? "Compromised" : isMinted ? "Minted on chain" : "Off-chain only"}
        </span>
      </div>

      {loading ? (
        <p className="oci-muted">Loading identity status…</p>
      ) : (
        <>
          <div className="oci-facts">
            <div className="oci-fact">
              <span>Handle (NIP-05)</span>
              <strong>{activeHandle || "Not assigned yet"}</strong>
            </div>
            <div className="oci-fact">
              <span>Nostr key</span>
              <strong>
                {activePubkey ? shortHex(activePubkey, 10, 8) : "None bound"}
                {derivationVersion === 1 && <em className="oci-tag">v1 preserved</em>}
                {derivationVersion === 2 && <em className="oci-tag">v2 seed</em>}
              </strong>
            </div>
            {onChain?.account && (
              <div className="oci-fact">
                <span>L1 account</span>
                <code>{shortHex(onChain.account, 10, 8)}</code>
              </div>
            )}
          </div>

          {badges.length > 0 && (
            <div className="oci-badges" aria-label="Chain-verified badges">
              {badges.map((badge) => (
                <span key={badge.id} className={`oci-badge is-${badge.tone}`}>
                  <ShieldCheck size={12} aria-hidden />
                  {badge.label}
                </span>
              ))}
            </div>
          )}

          {(isRevoked || isCompromised) && (
            <div className="oci-alert is-danger" role="alert">
              <AlertTriangle size={14} aria-hidden />
              <span>
                {isRevoked
                  ? "This identity was revoked on chain. Verification badges are stripped immediately."
                  : "Previous Nostr key was marked compromised and permanently tombstoned."}
              </span>
            </div>
          )}

          {links.length > 0 && (
            <div className="oci-links">
              <span className="oci-section-label">Linked accounts &amp; claims ({links.length}/16)</span>
              <ul>
                {links.map((link) => {
                  const info = describeLinkKind(link.kind);
                  return (
                    <li key={link.link_id || `${link.kind}:${link.target}`}>
                      <div>
                        <strong>{info.label}</strong>
                        <code>{link.target}</code>
                      </div>
                      <span className={`oci-pill ${link.status === "pending_reconfirmation" ? "is-warn" : link.consensus_verified ? "is-verified" : "is-muted"}`}>
                        {link.status === "pending_reconfirmation"
                          ? "Pending re-confirmation"
                          : link.consensus_verified
                            ? "Consensus-verified"
                            : "Client-verified"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {customClaims.length > 0 && (
            <div className="oci-custom-claims">
              <span className="oci-section-label">Verified custom NIP-05 domains</span>
              <div className="oci-badges">
                {customClaims.map((claim) => (
                  <span key={claim.identifier} className="oci-badge is-neutral">
                    {claim.identifier} · client-verified
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="oci-actions">
            {!isMinted ? (
              <button
                type="button"
                className="oci-btn is-primary"
                onClick={() => onOpenMint?.("mint")}
              >
                <Sparkles size={14} aria-hidden />
                Mint Your Task Node Identity
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="oci-btn"
                  onClick={() => onOpenRotate?.("rotate")}
                >
                  <KeyRound size={14} aria-hidden />
                  Rotate Nostr key
                </button>
                <button
                  type="button"
                  className="oci-btn"
                  onClick={() => onOpenLinks?.("links")}
                >
                  <Link2 size={14} aria-hidden />
                  Manage links
                </button>
              </>
            )}
          </div>

          {!isMinted && (
            <p className="oci-footnote">
              Optional everywhere except per-operator validator rewards. Existing v1 npub, contacts, and Hive history stay intact. State-expansion fee: {formatPftFromAtoms(IDENTITY_MINT_FEE_ATOMS)}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

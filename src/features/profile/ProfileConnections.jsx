import { useEffect, useMemo, useState } from "react";
import { requestJson } from "../../api";
import { profileNftImageCandidates } from "./profile-nft-images.js";
import { connectionInitials, connectionLabel } from "./ProfileStudioPanels.jsx";
import {
  C,
  SectionHead,
  fmtDateTime,
  fmtPft,
  shortHash,
} from "./profile-view-shared.jsx";

export function ConnectionAvatar({ connection = {}, size = 48 } = {}) {
  const imageCandidates = useMemo(
    () => profileNftImageCandidates(connection.heroNft || {}, { avatarCssSize: size }),
    [connection.heroNft, size]
  );
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  return (
    <div style={{
      alignItems: "center",
      background: C.paper2,
      border: `1px solid ${C.ruleSoft}`,
      borderRadius: 10,
      color: C.ink2,
      display: "flex",
      fontSize: Math.max(12, Math.round(size * 0.29)),
      fontWeight: 650,
      height: size,
      justifyContent: "center",
      overflow: "hidden",
      width: size,
    }}>
      {imageSrc ? (
	        <img
	          alt={`${connectionLabel(connection)} profile NFT`}
	          decoding="async"
	          loading="lazy"
	          onError={() => setImageIndex((index) => index + 1)}
	          src={imageSrc}
          style={{ display: "block", height: "100%", objectFit: "cover", width: "100%" }}
        />
      ) : (
        connectionInitials(connection)
      )}
    </div>
  );
}

export function walletExplorerHref(walletAddress = "", explorerBase = "") {
  const address = String(walletAddress || "").trim();
  const base = String(explorerBase || "").trim();
  if (!address || !base) return "";
  if (base.includes("{address}")) return base.replace("{address}", encodeURIComponent(address));
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(address)}`;
}

export function ProfilePreviewPanel({ connection = null, error = "", loading = false, onClose, onCopyWallet, pftlExplorerUrl = "", profile = null } = {}) {
  if (!connection) return null;
  const identity = profile?.identity || {};
  const role = profile?.role || {};
  const metrics = profile?.metrics || {};
  const displayHandle = identity.hiveHandle ? `@${identity.hiveHandle}` : "";
  const displayName = identity.displayName || displayHandle || connectionLabel(connection);
  const displayWallet = identity.displayWallet || identity.primaryWallet || connection.walletAddress || "";
  const explorerHref = walletExplorerHref(displayWallet, pftlExplorerUrl);
  const skills = Array.isArray(role.skills) ? role.skills.filter(Boolean).slice(0, 6) : [];

  return (
    <div
      aria-live="polite"
      style={{
        background: C.paper3,
        border: `1px solid ${C.ruleSoft}`,
        borderRadius: 8,
        marginTop: 14,
        padding: 16,
      }}
    >
      <div style={{ alignItems: "flex-start", display: "flex", gap: 14, justifyContent: "space-between" }}>
        <div style={{ alignItems: "center", display: "flex", gap: 12, minWidth: 0 }}>
          <ConnectionAvatar connection={{ ...connection, heroNft: profile?.heroNft || connection.heroNft }} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Member profile</div>
            <div style={{ color: C.ink, fontSize: 16, fontWeight: 650, lineHeight: 1.25 }}>
              {loading ? "Loading profile..." : displayName}
            </div>
            {displayHandle && displayHandle !== displayName && (
              <div className="tn-mono" style={{ color: C.ink4, fontSize: 12.5, marginTop: 4 }}>{displayHandle}</div>
            )}
          </div>
        </div>
        <button className="tn-btn" onClick={onClose} style={{ fontSize: 12.5, paddingTop: 0 }} type="button">
          Close
        </button>
      </div>

      {error && (
        <div style={{ borderTop: `1px solid ${C.ruleSoft}`, color: C.rust, fontSize: 13.5, lineHeight: 1.5, marginTop: 14, paddingTop: 14 }}>
          {error}
        </div>
      )}

      {!error && !loading && (
        <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
          <div>
            <div style={{ color: C.ink, fontSize: 14, fontWeight: 600, lineHeight: 1.35, marginBottom: 7 }}>
              {role.roleTitle || connection.roleTitle || "Public profile"}
            </div>
            <div style={{ color: C.ink2, fontSize: 13, lineHeight: 1.55, maxWidth: 640 }}>
              {role.roleSummary || connection.roleSummary || "No public profile summary is available yet."}
            </div>
            {role.usefulTo && (
              <div style={{ borderLeft: `2px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 12.5, lineHeight: 1.5, marginTop: 12, paddingLeft: 10 }}>
                <span style={{ color: C.ink, fontWeight: 600 }}>Best fit: </span>
                {role.usefulTo}
              </div>
            )}
          </div>

          {skills.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {skills.map((skill) => (
                <span key={skill} style={{
                  background: C.paper2,
                  border: `1px solid ${C.ruleSoft}`,
                  borderRadius: 999,
                  color: C.ink2,
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "6px 9px",
                }}>
                  {skill}
                </span>
              ))}
            </div>
          )}

          <div style={{
            borderTop: `1px solid ${C.ruleSoft}`,
            color: C.ink3,
            display: "flex",
            flexWrap: "wrap",
            fontSize: 12.5,
            gap: 12,
            paddingTop: 14,
          }}>
            {displayWallet && (
              explorerHref ? (
                <a className="tn-link tn-mono" href={explorerHref} rel="noreferrer" target="_blank">
                  Wallet {shortHash(displayWallet, 8, 6)}
                </a>
              ) : (
                <button className="tn-link tn-mono" onClick={() => onCopyWallet(displayWallet, connection)} style={{ background: "transparent", border: 0, padding: 0 }} type="button">
                  Wallet {shortHash(displayWallet, 8, 6)}
                </button>
              )
            )}
            {displayWallet && (
              <button className="tn-link" onClick={() => onCopyWallet(displayWallet, connection)} style={{ background: "transparent", border: 0, padding: 0 }} type="button">
                Copy wallet
              </button>
            )}
            <span>{fmtPft(metrics.lifetimeTotalPft || 0)} lifetime PFT</span>
            <span>{Number(metrics.lifetimeRewardedTasks || 0)} rewarded tasks</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function recommendationStatusText(status = "", run = null) {
  if (status === "vector_tables_not_ready") return "The recommendation store is not ready yet.";
  if (status === "profile_private") return "Profile hidden. Recommended connections are off while your profile is private.";
  if (status === "failed") return run?.lastError || "Recommendation generation failed.";
  return "No recommendations yet. You need a public profile, a completed Network Diagnostic Report, and other public members to compare against.";
}

export function ConnectionRecommendationRow({
  connection,
  copiedWallet = false,
  index = 0,
  onCopyWallet,
  onCloseProfile,
  onOpenProfile,
  onRecordEvent,
  pftlExplorerUrl = "",
  profilePreview = null,
} = {}) {
  const explorerHref = walletExplorerHref(connection.walletAddress, pftlExplorerUrl);
  const previewOpen = Boolean(profilePreview);
  return (
    <div key={connection.id || connection.accountId} style={{
      alignItems: "flex-start",
      borderTop: index === 0 ? "none" : `1px solid ${C.ruleSoft}`,
      display: "grid",
      gap: 18,
      gridTemplateColumns: "48px 1fr",
      padding: "20px 0",
    }}>
      <ConnectionAvatar connection={connection} size={48} />
      <div>
        <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
          <button
            className="tn-btn"
            onClick={() => onOpenProfile(connection)}
            style={{ color: C.ink, fontSize: 14, fontWeight: 600, padding: 0 }}
            type="button"
          >
            {connectionLabel(connection)}
          </button>
          {connection.roleTitle && <span style={{ color: C.ink4, fontSize: 12 }}>{connection.roleTitle}</span>}
        </div>
        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          <button
            className="tn-link"
            onClick={() => onOpenProfile(connection)}
            style={{ background: "transparent", border: 0, padding: 0 }}
            type="button"
          >
            {previewOpen ? "Hide profile" : "View profile"}
          </button>
          {connection.walletAddress && (
            explorerHref ? (
              <a
                className="tn-link tn-mono"
                href={explorerHref}
                onClick={() => onRecordEvent(connection, "wallet_clicked").catch(() => null)}
                rel="noreferrer"
                target="_blank"
              >
                Wallet {shortHash(connection.walletAddress, 8, 6)}
              </a>
            ) : (
              <button
                className="tn-link tn-mono"
                onClick={() => onCopyWallet(connection.walletAddress, connection)}
                style={{ background: "transparent", border: 0, padding: 0 }}
                type="button"
              >
                {copiedWallet ? "Copied wallet" : `Wallet ${shortHash(connection.walletAddress, 8, 6)}`}
              </button>
            )
          )}
        </div>
        <div style={{ color: C.ink2, fontSize: 13.5, lineHeight: 1.55, marginBottom: 10, maxWidth: 680 }}>
          {connection.reason}
        </div>
        {connection.suggestedFirstAction && (
          <div style={{ color: C.ink3, fontSize: 13, lineHeight: 1.5, marginBottom: 8, maxWidth: 680 }}>
            <span style={{ color: C.ink, fontWeight: 600 }}>Suggested first move: </span>
            {connection.suggestedFirstAction}
          </div>
        )}
        {Array.isArray(connection.supportingSignals) && connection.supportingSignals.length > 0 && (
          <div style={{ color: C.ink4, fontSize: 12, lineHeight: 1.7 }}>
            {connection.supportingSignals.map((signal, signalIndex) => (
              <span key={`${connection.id || connection.accountId}-${signal}`}>
                {signal}{signalIndex < connection.supportingSignals.length - 1 && <span style={{ color: C.ink5, margin: "0 8px" }}>·</span>}
              </span>
            ))}
          </div>
        )}
        {previewOpen && (
          <ProfilePreviewPanel
            connection={connection}
            error={profilePreview.error}
            loading={profilePreview.loading}
            onClose={onCloseProfile}
            onCopyWallet={onCopyWallet}
            pftlExplorerUrl={pftlExplorerUrl}
            profile={profilePreview.profile}
          />
        )}
      </div>
    </div>
  );
}

export function ConnectionsCard({ accountId = "", pftlExplorerUrl = "", profilePublic = true } = {}) {
  const [state, setState] = useState({ loading: Boolean(accountId), refreshing: false, error: "", data: null });
  const [previewState, setPreviewState] = useState({ connection: null, error: "", loading: false, profile: null });
  const [copiedWalletId, setCopiedWalletId] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setState({ loading: false, refreshing: false, error: "", data: null });
      return () => {
        cancelled = true;
      };
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/recommended-connections").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState({ loading: false, refreshing: false, error: "", data: result.body || null });
        return;
      }
      setState({
        loading: false,
        refreshing: false,
        error: result.body?.message || result.body?.error || "Recommended connections could not be loaded.",
        data: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const refresh = async () => {
    if (!accountId || state.refreshing || profilePublic === false) return;
    setState((current) => ({ ...current, refreshing: true, error: "" }));
    const result = await requestJson("/api/profile/recommended-connections/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: "profile_page_manual_refresh" }),
    });
    if (result.ok || result.body?.ok) {
      setState({ loading: false, refreshing: false, error: "", data: result.body || null });
      return;
    }
    setState((current) => ({
      ...current,
      loading: false,
      refreshing: false,
      error: result.body?.message || result.body?.error || "Recommended connections could not be refreshed.",
    }));
  };

  const recordEvent = async (connection, eventType) => {
    if (!connection?.accountId) return;
    await requestJson("/api/profile/recommended-connections/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateAccountId: connection.accountId,
        connectionId: connection.id,
        eventType,
      }),
    });
  };

  const copyWalletAddress = async (walletAddress = "", connection = null) => {
    const value = String(walletAddress || "").trim();
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedWalletId(connection?.id || connection?.accountId || value);
      window.setTimeout(() => setCopiedWalletId(""), 1600);
      if (connection?.accountId) recordEvent(connection, "wallet_copied").catch(() => null);
    } catch {
      setCopiedWalletId("");
    }
  };

  const openProfilePreview = async (connection) => {
    if (!connection?.accountId) return;
    const current = previewState.connection || {};
    const sameConnection = (current.id || current.accountId) === (connection.id || connection.accountId);
    if (sameConnection && !previewState.loading) {
      setPreviewState({ connection: null, error: "", loading: false, profile: null });
      return;
    }
    const path = connection.profilePath || `/api/profile/member?accountId=${encodeURIComponent(connection.accountId)}`;
    setPreviewState({ connection, error: "", loading: true, profile: null });
    const result = await requestJson(path);
    if (result.ok && result.body?.ok) {
      setPreviewState({ connection, error: "", loading: false, profile: result.body.profile || null });
      recordEvent(connection, "profile_viewed").catch(() => null);
      return;
    }
    setPreviewState({
      connection,
      error: result.body?.message || result.body?.error || "Member profile could not be loaded.",
      loading: false,
      profile: null,
    });
  };

  const data = state.data || {};
  const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
  const isPrivate = profilePublic === false || data.status === "profile_private";
  const visibleRecommendations = isPrivate ? [] : recommendations;
  const canRefresh = !isPrivate && data.available !== false && data.refresh?.allowed !== false;
  const showEmpty = !state.loading && visibleRecommendations.length === 0;
  const action = (
    <button
      className="tn-btn"
      disabled={!canRefresh || state.refreshing}
      onClick={refresh}
      style={{ fontSize: 13, opacity: !canRefresh ? 0.45 : 1 }}
      type="button"
    >
      {state.refreshing ? "Refreshing..." : "Refresh"}
    </button>
  );

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        action={action}
        eyebrow="Recommended connections"
        sub="People worth knowing, with the signals behind the recommendation"
      />

      {state.loading && (
        <div className="tn-fadeIn" style={{ color: C.ink3, fontSize: 13.5, padding: "8px 0 24px" }}>
          Loading recommendations.
        </div>
      )}

      {(state.error || showEmpty) && (
        <div className="tn-fadeIn" style={{
          borderTop: `1px solid ${C.ruleSoft}`,
          color: state.error || data.status === "failed" ? C.rust : C.ink3,
          fontSize: 13.5,
          lineHeight: 1.55,
          padding: "20px 0",
        }}>
          {state.error || recommendationStatusText(isPrivate ? "profile_private" : data.status, data.run)}
        </div>
      )}

      <div>
        {visibleRecommendations.map((connection, index) => {
          const previewKey = previewState.connection?.id || previewState.connection?.accountId || "";
          const connectionKey = connection.id || connection.accountId || "";
          return (
            <ConnectionRecommendationRow
              connection={connection}
              copiedWallet={copiedWalletId === (connection.id || connection.accountId || connection.walletAddress)}
              index={index}
              key={connection.id || connection.accountId}
              onCloseProfile={() => setPreviewState({ connection: null, error: "", loading: false, profile: null })}
              onCopyWallet={copyWalletAddress}
              onOpenProfile={openProfilePreview}
              onRecordEvent={recordEvent}
              pftlExplorerUrl={pftlExplorerUrl}
              profilePreview={previewKey && previewKey === connectionKey ? previewState : null}
            />
          );
        })}
      </div>

      {data.run?.completedAt && visibleRecommendations.length > 0 && (
        <div style={{ color: C.ink4, fontSize: 11.5, paddingTop: 6 }}>
          Refreshed {fmtDateTime(data.run.completedAt)}
        </div>
      )}
    </section>
  );
}

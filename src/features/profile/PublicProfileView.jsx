import React, { useEffect, useMemo, useState } from "react";
import { requestJson } from "../../api";

const C = {
  paper2: "#FBF7EE",
  ink: "#1F1B16",
  ink2: "#3D362C",
  ink3: "#6B6052",
  ink4: "#9B9081",
  ink5: "#C4BBA9",
  ruleSoft: "#EFE7D6",
  success: "#5C8C4F",
  warning: "#B07628",
};

const fmtN = (n, options = {}) => Number(n || 0).toLocaleString("en-US", options);
const fmtPft = (n) => fmtN(n, { maximumFractionDigits: Number(n || 0) % 1 === 0 ? 0 : 2 });
const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDateTime = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const NFT_GALLERY_PAGE_SIZE = 10;
const contributionLevelLabel = (tierNumber) => {
  const tier = Number(tierNumber || 0);
  if (tier >= 4) return "Network operator";
  if (tier >= 3) return "Core contributor";
  if (tier >= 2) return "Active contributor";
  if (tier >= 1) return "Contributor";
  return "Not established";
};

function imageCandidatesForNft(nft = {}) {
  const candidates = [nft.imageDataUrl];
  if (nft.imageCid) {
    candidates.push(`/api/profile/nft/image/${encodeURIComponent(nft.imageCid)}`);
  } else {
    candidates.push(nft.imageGatewayUrl);
  }
  return candidates
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function SectionHead({ eyebrow, sub }) {
  return (
    <div style={{
      alignItems: "baseline",
      borderBottom: `1px solid ${C.ruleSoft}`,
      display: "flex",
      justifyContent: "space-between",
      marginBottom: 28,
      paddingBottom: 14,
    }}>
      <div>
        <div className="tn-eyebrow">{eyebrow}</div>
        {sub && <div style={{ color: C.ink3, fontSize: 13, marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
}

function ProfileAvatar({ nft = null, size = 120 }) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(nft || {}), [nft]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  return (
    <div style={{
      alignItems: "center",
      aspectRatio: "1 / 1",
      background: C.paper2,
      border: `1px solid ${C.ruleSoft}`,
      borderRadius: 14,
      display: "flex",
      justifyContent: "center",
      overflow: "hidden",
      width: size,
    }}>
      {imageSrc ? (
        <img
          alt={nft?.title || "Profile NFT"}
          decoding="async"
          onError={() => setImageIndex((index) => index + 1)}
          src={imageSrc}
          style={{ display: "block", height: "100%", objectFit: "cover", width: "100%" }}
        />
      ) : (
        <div className="tn-eyebrow" style={{ color: C.ink4, letterSpacing: "0.1em" }}>Profile NFT</div>
      )}
    </div>
  );
}

function IdentityHero({ profile = null, loading = false, profilePublic = true }) {
  const identity = profile?.identity || {};
  const metrics = profile?.metrics || {};
  const displayWallet = identity.displayWallet || identity.primaryWallet || "";
  const displayHandle = identity.hiveHandle ? `@${identity.hiveHandle}` : "";
  const displayName = identity.displayName || displayHandle || "Hive contributor";
  const publicAliases = Array.isArray(identity.publicAliases) ? identity.publicAliases : [];
  const totalPft = metrics.lifetimeTotalPft || 0;
  const taskPft = metrics.lifetimeTaskRewardPft || 0;
  const airdropPft = metrics.lifetimeAirdropPft || 0;
  const snapshot = profile?.snapshot || null;
  return (
    <section style={{ paddingTop: 8 }}>
      <div style={{ alignItems: "center", display: "grid", gap: 32, gridTemplateColumns: "120px 1fr auto" }}>
        <ProfileAvatar nft={profile?.heroNft || null} size={120} />

        <div>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Hive profile</div>
          <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 12 }}>
            <span style={{ color: C.ink, fontSize: 22, fontWeight: 600 }}>
              {loading ? "Loading profile..." : displayName}
            </span>
            {displayHandle && displayHandle !== displayName && (
              <span className="tn-mono" style={{ color: C.ink3, fontSize: 14 }}>
                {displayHandle}
              </span>
            )}
            {displayHandle && (
              <button
                className="tn-btn"
                onClick={() => navigator.clipboard?.writeText(displayHandle).catch(() => null)}
                style={{ padding: 4 }}
                title="Copy handle"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            )}
          </div>
          <div style={{ alignItems: "center", color: C.ink3, display: "flex", flexWrap: "wrap", fontSize: 13, gap: 12 }}>
            <span style={{ alignItems: "center", color: profilePublic ? C.success : C.ink4, display: "inline-flex", fontWeight: 500, gap: 7 }}>
              <span className="tn-pulseGreen" />
              {profilePublic ? "Public profile enabled" : "Public profile hidden"}
            </span>
            {displayWallet && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span className="tn-mono">{displayWallet}</span>
              </>
            )}
            {publicAliases.map((alias) => (
              <React.Fragment key={`${alias.provider}-${alias.handle || alias.label}`}>
                <span style={{ color: C.ink5 }}>·</span>
                <span>
                  {alias.label}
                  {alias.handle ? ` @${alias.handle}` : ""}
                  {alias.verified ? " verified" : ""}
                </span>
              </React.Fragment>
            ))}
            {snapshot?.completedAt && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span>Profile refreshed {fmtDateTime(snapshot.completedAt)}</span>
              </>
            )}
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Total lifetime</div>
          <div className="tn-bigNum" style={{ color: C.ink, fontSize: 42, lineHeight: 1 }}>{loading ? "—" : fmtPft(totalPft)}</div>
          <div style={{ color: C.ink4, fontSize: 13, marginTop: 4 }}>
            PFT earned
            {!loading && <span> · {fmtPft(taskPft)} rewards · {fmtPft(airdropPft)} airdrops</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileRole({ role = null, snapshot = null, loading = false, error = "", regenerating = false, onRegenerate }) {
  const skills = Array.isArray(role?.skills) ? role.skills.filter(Boolean) : [];
  return (
    <section style={{ paddingTop: 56 }}>
      <div style={{
        alignItems: "start",
        display: "grid",
        gap: 48,
        gridTemplateColumns: "minmax(0, 720px) 180px",
        justifyContent: "space-between",
      }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ color: C.ink, fontSize: 26, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.22, margin: "0 0 14px", maxWidth: 720 }}>
            {loading ? "Loading public profile..." : role?.roleTitle || "Profile snapshot pending"}
          </h3>
          <div style={{ color: C.ink2, fontSize: 15.5, lineHeight: 1.62, marginBottom: 18, maxWidth: 720 }}>
            {role?.roleSummary || (error ? error : "Run a public profile snapshot after task rewards or NFT activity exists.")}
          </div>
          {skills.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: role?.usefulTo ? 18 : 0 }}>
              {skills.map((skill, index) => (
                <span
                  key={`${skill}-${index}`}
                  style={{
                    background: C.paper2,
                    border: `1px solid ${C.ruleSoft}`,
                    borderRadius: 999,
                    color: C.ink2,
                    display: "inline-flex",
                    fontSize: 12.5,
                    fontWeight: 500,
                    lineHeight: 1,
                    padding: "7px 10px",
                  }}
                >
                  {skill}
                </span>
              ))}
            </div>
          )}
          {role?.usefulTo && (
            <div style={{ borderLeft: `2px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 13.5, lineHeight: 1.55, marginTop: 2, maxWidth: 700, paddingLeft: 12 }}>
              <span style={{ color: C.ink4, fontWeight: 600 }}>Best fit: </span>
              {role.usefulTo}
            </div>
          )}
          {role?.dataCaveat && (
            <div style={{ color: C.ink4, fontSize: 12.5, lineHeight: 1.5, marginTop: 12, maxWidth: 680 }}>
              {role.dataCaveat}
            </div>
          )}
        </div>

        <div style={{ minWidth: 0, paddingTop: 2, textAlign: "right" }}>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Archetype</div>
          <div style={{ color: C.ink2, fontSize: 13.5, fontWeight: 500 }}>{role?.archetype || "Not scored"}</div>
          {role?.archetypeContrast && <div style={{ color: C.ink4, fontSize: 12.5, marginTop: 2 }}>{role.archetypeContrast}</div>}
          <button
            className="tn-btn"
            disabled={regenerating}
            onClick={onRegenerate}
            style={{ fontSize: 12.5, marginTop: 14, padding: 0 }}
            type="button"
          >
            {regenerating ? "Regenerating..." : snapshot?.completedAt ? "Refresh profile" : "Generate profile"}
          </button>
          {snapshot?.model && <div style={{ color: C.ink4, fontSize: 11.5, marginTop: 8 }}>{snapshot.model}</div>}
        </div>
      </div>
    </section>
  );
}

function CredentialStrip({ metrics = {}, loading = false }) {
  const alignment = metrics.alignmentScore0To100;
  const hasAlignment = alignment !== null && alignment !== undefined && Number.isFinite(Number(alignment));
  const items = [
    {
      label: "Alignment score",
      max: "100",
      score: loading ? "—" : hasAlignment ? String(Math.round(Number(alignment))) : "—",
      status: hasAlignment ? "Airdrop alignment" : "Not scored yet",
      sub: hasAlignment
        ? `${fmtPft(metrics.actualAirdropPft7d)} of ${fmtPft(metrics.maxPossibleAirdropPft7d)} possible PFT over the scored window`
        : "Run a daily airdrop score to populate alignment.",
      tone: hasAlignment ? C.success : C.ink4,
    },
    {
      label: "Contribution level",
      score: loading ? "—" : contributionLevelLabel(metrics.contributionTierNumber),
      status: metrics.contributionTierBasis || "No contribution tier yet",
      sub: "Calculated from positive task rewards, not airdrops.",
      tone: Number(metrics.contributionTierNumber || 0) >= 2 ? C.warning : C.ink4,
      wide: true,
    },
  ];
  return (
    <section style={{ paddingTop: 64 }}>
      <div style={{ borderTop: `1px solid ${C.ruleSoft}`, display: "grid", gap: 48, gridTemplateColumns: "1fr 1fr", paddingTop: 22 }}>
        {items.map((item) => (
          <div key={item.label}>
            <div className="tn-eyebrow">{item.label}</div>
            <div style={{ alignItems: "baseline", display: "flex", gap: 8, marginTop: 12 }}>
              <span
                className="tn-bigNum"
                style={{
                  color: C.ink,
                  fontSize: item.wide ? 30 : 42,
                  letterSpacing: item.wide ? 0 : undefined,
                  lineHeight: 1.05,
                }}
              >
                {item.score}
              </span>
              {item.max && <span style={{ color: C.ink5, fontSize: 14, fontWeight: 500 }}>/ {item.max}</span>}
            </div>
            <div style={{ color: item.tone, fontSize: 13, fontWeight: 500, marginTop: 10 }}>{item.status}</div>
            <div style={{ color: C.ink3, fontSize: 12.5, lineHeight: 1.45, marginTop: 6 }}>{item.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PublicNFTTile({ nft }) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(nft), [nft]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  return (
    <div className="tn-lift" style={{ cursor: "pointer" }}>
      <div style={{ aspectRatio: "1 / 1", background: C.paper2, borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
        {imageSrc ? (
          <img
            alt={nft.title || "Profile NFT"}
            decoding="async"
            loading="lazy"
            onError={() => setImageIndex((index) => index + 1)}
            src={imageSrc}
            style={{ display: "block", height: "100%", objectFit: "cover", width: "100%" }}
          />
        ) : (
          <div style={{
            alignItems: "center",
            border: `1px solid ${C.ruleSoft}`,
            color: C.ink4,
            display: "flex",
            fontSize: 12,
            height: "100%",
            justifyContent: "center",
          }}>
            Image unavailable
          </div>
        )}
      </div>
      <div style={{ color: C.ink, fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.005em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {nft.title || "Task Node Profile NFT"}
      </div>
      <div style={{ color: C.ink4, display: "flex", fontSize: 11.5, gap: 8, marginTop: 3 }}>
        <span>{nft.mintedAt ? fmtDate(new Date(nft.mintedAt)) : nft.generatedAt ? fmtDate(new Date(nft.generatedAt)) : "Generated"}</span>
        <span style={{ color: C.ink5 }}>·</span>
        <span>{nft.status || "generated"}</span>
      </div>
    </div>
  );
}

function PublicNFTGallery({ nfts = [] }) {
  const [page, setPage] = useState(0);
  const mintedCount = nfts.filter((nft) => String(nft.status || "").toLowerCase() === "minted").length;
  const pageCount = Math.max(1, Math.ceil(nfts.length / NFT_GALLERY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * NFT_GALLERY_PAGE_SIZE;
  const visibleNfts = nfts.slice(start, start + NFT_GALLERY_PAGE_SIZE);
  const showingStart = nfts.length ? start + 1 : 0;
  const showingEnd = Math.min(nfts.length, start + visibleNfts.length);

  useEffect(() => {
    setPage(0);
  }, [nfts.length]);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="NFT gallery"
        sub={`${nfts.length} profile NFTs · ${mintedCount} minted${nfts.length > NFT_GALLERY_PAGE_SIZE ? ` · showing ${showingStart}-${showingEnd}` : ""}`}
      />
      {nfts.length > 0 ? (
        <>
          <div style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(4, 1fr)" }}>
            {visibleNfts.map((nft) => <PublicNFTTile key={nft.id} nft={nft} />)}
          </div>
          {pageCount > 1 && (
            <div style={{ alignItems: "center", display: "flex", gap: 18, justifyContent: "space-between", marginTop: 24 }}>
              <div style={{ color: C.ink4, fontSize: 12.5 }}>
                Page {currentPage + 1} of {pageCount}
              </div>
              <div style={{ display: "flex", gap: 14 }}>
                <button
                  className="tn-tab"
                  disabled={currentPage === 0}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  style={{ fontSize: 12.5, opacity: currentPage === 0 ? 0.45 : 1 }}
                  type="button"
                >
                  Prev
                </button>
                <button
                  className="tn-tab"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                  style={{ fontSize: 12.5, opacity: currentPage >= pageCount - 1 ? 0.45 : 1 }}
                  type="button"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ borderTop: `1px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 13.5, lineHeight: 1.55, paddingTop: 18 }}>
          No public profile NFTs yet. Generate or mint a profile NFT from the private profile tab.
        </div>
      )}
    </section>
  );
}

export function PublicProfile({ accountId = "", profilePublic = true } = {}) {
  const [state, setState] = useState({
    loading: Boolean(accountId),
    error: "",
    profile: null,
    regenerating: false,
  });

  const loadProfile = async () => {
    if (!accountId) {
      setState({ loading: false, error: "", profile: null, regenerating: false });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    const result = await requestJson("/api/profile/public");
    if (result.ok) {
      setState((current) => ({ ...current, loading: false, error: "", profile: result.body?.profile || null }));
      return;
    }
    setState((current) => ({
      ...current,
      loading: false,
      error: result.body?.message || result.body?.error || "Public profile could not be loaded.",
    }));
  };

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setState({ loading: false, error: "", profile: null, regenerating: false });
      return () => {
        cancelled = true;
      };
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/public").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState((current) => ({ ...current, loading: false, error: "", profile: result.body?.profile || null }));
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        error: result.body?.message || result.body?.error || "Public profile could not be loaded.",
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const regenerate = async () => {
    if (!accountId || state.regenerating) return;
    setState((current) => ({ ...current, regenerating: true, error: "" }));
    const result = await requestJson("/api/profile/public/regenerate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (result.ok) {
      setState((current) => ({
        ...current,
        regenerating: false,
        profile: result.body?.profile || current.profile,
        error: "",
      }));
      await loadProfile();
      return;
    }
    setState((current) => ({
      ...current,
      regenerating: false,
      error: result.body?.message || result.body?.error || "Public profile regeneration failed.",
    }));
  };

  const profile = state.profile || null;
  const role = profile?.role || null;
  return (
    <div>
      <IdentityHero loading={state.loading} profile={profile} profilePublic={profilePublic} />
      <ProfileRole
        error={state.error}
        loading={state.loading}
        onRegenerate={regenerate}
        regenerating={state.regenerating}
        role={role}
        snapshot={profile?.snapshot || null}
      />
      <CredentialStrip loading={state.loading} metrics={profile?.metrics || {}} />
      <PublicNFTGallery nfts={profile?.nfts || []} />
    </div>
  );
}

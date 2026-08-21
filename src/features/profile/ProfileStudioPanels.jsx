import { useCallback, useEffect, useMemo, useState } from "react";
import { requestJson } from "../../api";
import { profileNftImageCandidates } from "./profile-nft-images.js";
import {
  NFTArt,
  NFT_DATA,
  RewardsChart,
  latestAvatarNft,
  mintStepForPhase,
  profileNftCanBecomeAvatar,
  profileNftFailed,
  profileNftIsGenerating,
  profileNftStatus,
} from "./ProfileBriefing.jsx";
import {
  C,
  NFT_GALLERY_LIMIT,
  NFT_GALLERY_PAGE_SIZE,
  SANS,
  SectionHead,
  fmtDate,
  fmtN,
  fmtPft,
  shortHash,
} from "./profile-view-shared.jsx";

export function ProfileStudio({
  accountId = "",
  linkedWalletAddress = "",
  onNftsChange,
  onProfileAvatarChange,
  onViewGallery,
  onWalletUnlock,
  walletSecret = null,
  walletVault = {},
} = {}) {
  const [seed, setSeed] = useState(0);
  const [generatedNft, setGeneratedNft] = useState(null);
  const [generationStatus, setGenerationStatus] = useState("idle");
  const [generationError, setGenerationError] = useState("");
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [mintPhase, setMintPhase] = useState("idle");
  const [mintError, setMintError] = useState("");
  const palettes = ["green", "gray", "gold", "blue"];
  const kinds = ["topology", "circuit", "sunburst", "flow"];
  const titles = [
    "Network Verification Engineer",
    "Ledger Triage Operator",
    "Reward Composer",
    "Daily Signal Analyst",
  ];
  const palette = palettes[seed % 4];
  const kind = kinds[seed % 4];
  const title = titles[seed % 4];
  const recoveredNftStatus = profileNftStatus(generatedNft);
  const generationFailed = profileNftFailed(generatedNft);
  const recoveredGenerationPending = profileNftIsGenerating(generatedNft);
  const generating = generationStatus === "generating" || recoveredGenerationPending;
  const minting = ["preparing", "signing", "broadcasting", "confirming"].includes(mintPhase);
  const minted = mintPhase === "success" || generatedNft?.status === "minted";
  const currentStep = mintStepForPhase(mintPhase);
  const generatedImageSrc = imageLoadFailed || recoveredGenerationPending || generationFailed
    ? ""
    : generatedNft?.imageDataUrl || generatedNft?.imageGatewayUrl || "";
  const mintReady = Boolean(generatedNft?.id && generatedNft?.imageCid && !recoveredGenerationPending && !generationFailed);
  const walletReady = Boolean(
    accountId &&
      linkedWalletAddress &&
      walletSecret?.mnemonic &&
      walletSecret?.accountId === accountId &&
      walletSecret?.address === linkedWalletAddress &&
      walletVault?.unlocked &&
      walletVault?.address === linkedWalletAddress
  );

  const syncGenerationStateFromNft = useCallback((nft = null) => {
    const status = profileNftStatus(nft);
    if (status === "generating") {
      setGenerationStatus("generating");
      setGenerationError("");
      setMintError("");
      setMintPhase("idle");
      return;
    }
    if (status === "failed") {
      setGenerationStatus("idle");
      setGenerationError(nft?.error || "Profile NFT generation failed.");
      setMintPhase("idle");
      return;
    }
    if (["generated", "prepared", "minted"].includes(status)) {
      setGenerationStatus("ready");
      setGenerationError("");
    }
  }, []);

  const loadNfts = useCallback(async ({ hydrateLatest = false } = {}) => {
    const result = await requestJson(`/api/profile/nfts?limit=${NFT_GALLERY_LIMIT}`);
    if (!result.ok) return;
    const nextNfts = Array.isArray(result.body?.nfts) ? result.body.nfts : [];
    if (typeof onNftsChange === "function") onNftsChange(nextNfts, result.body?.total);
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(nextNfts));
    const latest = result.body?.latest || nextNfts[0] || null;
    if (hydrateLatest && latest) {
      setGeneratedNft((current) => latest.id === current?.id
        ? { ...latest, imageDataUrl: current?.imageDataUrl }
        : latest);
      syncGenerationStateFromNft(latest);
    }
  }, [onNftsChange, onProfileAvatarChange, syncGenerationStateFromNft]);

  useEffect(() => {
    let cancelled = false;
    requestJson(`/api/profile/nfts?limit=${NFT_GALLERY_LIMIT}`).then((result) => {
      if (cancelled || !result.ok) return;
      const nextNfts = Array.isArray(result.body?.nfts) ? result.body.nfts : [];
      if (typeof onNftsChange === "function") onNftsChange(nextNfts, result.body?.total);
      if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(nextNfts));
      if (result.body?.latest) {
        setGeneratedNft((current) => current || result.body.latest);
        syncGenerationStateFromNft(result.body.latest);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onNftsChange, onProfileAvatarChange, syncGenerationStateFromNft]);

  useEffect(() => {
    if (!generating) return undefined;
    const interval = window.setInterval(() => {
      loadNfts({ hydrateLatest: true }).catch(() => null);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [generating, loadNfts]);

  const regenerate = async () => {
    if (minting || generating) return;
    setGenerationError("");
    setMintError("");
    setImageLoadFailed(false);
    setGenerationStatus("generating");
    const result = await requestJson("/api/profile/nft/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: "1024x1024", quality: "high" }),
    });
    if (result.ok && result.body?.nft) {
      const nextNft = { ...result.body.nft, imageDataUrl: result.body.imageDataUrl };
      setGeneratedNft(nextNft);
      if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(nextNft);
      setSeed(s => s + 1);
      setGenerationStatus("ready");
      await loadNfts({ hydrateLatest: false });
      return;
    }
    if (result.body?.nft) {
      setGeneratedNft(result.body.nft);
      syncGenerationStateFromNft(result.body.nft);
      await loadNfts({ hydrateLatest: true });
      return;
    }
    setGenerationError(result.body?.message || result.body?.error || "Profile NFT generation failed.");
    setGenerationStatus("idle");
  };

  const mintGeneratedNft = async () => {
    if (minting || generating) return;
    setMintError("");
    if (!generatedNft?.id) {
      setMintError("Generate profile art before minting.");
      return;
    }
    if (!mintReady) {
      setMintError(generationFailed ? "Retry profile art generation before minting." : "Wait for profile art to finish generating.");
      return;
    }
    if (!walletReady) {
      setMintError("Unlock the linked wallet before minting.");
      if (typeof onWalletUnlock === "function") onWalletUnlock();
      return;
    }

    setMintPhase("preparing");
    const prepared = await requestJson("/api/profile/nft/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "prepare", nftId: generatedNft.id }),
    });
    if (!prepared.ok || !prepared.body?.txJson) {
      setMintPhase("idle");
      setMintError(prepared.body?.message || prepared.body?.error || "Profile NFT mint could not be prepared.");
      return;
    }

    setGeneratedNft((current) => ({
      ...(current || {}),
      ...(prepared.body.nft || {}),
      imageDataUrl: current?.imageDataUrl,
    }));
    setMintPhase("signing");

    let signed;
    try {
      const walletCore = await import("../../wallet-core");
      signed = walletCore.signPreparedPftlTransaction({
        mnemonic: walletSecret.mnemonic,
        txJson: prepared.body.txJson,
        expectedAddress: linkedWalletAddress,
      });
    } catch (error) {
      setMintPhase("idle");
      setMintError(error?.message || "Wallet signature failed.");
      return;
    }

    setMintPhase("broadcasting");
    const submitted = await requestJson("/api/profile/nft/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase: "submit",
        nftId: generatedNft.id,
        signedTxBlob: signed.txBlob,
      }),
    });
    if (!submitted.ok || !submitted.body?.nft) {
      setMintPhase("idle");
      setMintError(submitted.body?.message || submitted.body?.error || "Profile NFT mint could not be submitted.");
      return;
    }

    setMintPhase("confirming");
    const nextNft = {
      ...(generatedNft || {}),
      ...submitted.body.nft,
      imageDataUrl: generatedNft?.imageDataUrl,
    };
    setGeneratedNft((current) => ({
      ...(current || {}),
      ...submitted.body.nft,
      imageDataUrl: current?.imageDataUrl,
    }));
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(nextNft);
    await loadNfts();
    setMintPhase("success");
  };

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="Profile Studio · today's identity"
        sub="Generated from your last 28 days of network behavior"
      />

      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 32, alignItems: "center" }}>
        <div className={minted ? "tn-glow" : ""}
          style={{ borderRadius: 12, overflow: "hidden", position: "relative" }}>
          {generatedImageSrc ? (
            <img
              alt="Generated profile NFT"
              onError={() => setImageLoadFailed(true)}
              onLoad={() => setImageLoadFailed(false)}
              src={generatedImageSrc}
              style={{ display: "block", height: 180, objectFit: "cover", width: 180 }}
            />
          ) : (
            <NFTArt kind={kind} palette={palette} size={180} />
          )}
          {minted && (
            <div style={{
              position: "absolute", top: 8, right: 8,
              background: C.success, color: "#fff",
              width: 22, height: 22, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700,
            }}>✓</div>
          )}
        </div>

        <div>
          <h3 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 600, letterSpacing: "-0.015em", color: C.ink }}>
            {generatedNft?.title || title}
          </h3>
          <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 20, maxWidth: 480 }}>
            {recoveredGenerationPending
              ? "Generation is still running. You can leave this page; the result will appear here and in the gallery."
              : generationFailed
                ? "Generation failed before the image was ready. Retry to create a new recoverable draft."
                : "Mint it as today's identity, or reroll. One free mint per day."}
          </div>

          {!minted && (
            <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
              <button className="tn-btn" disabled={generating || minting} onClick={regenerate} type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-3.4-7.04" /><path d="M21 4v6h-6" />
                </svg>
                {generationFailed ? "Retry generation" : "Regenerate"}
              </button>
              <button className="tn-btn-primary" disabled={generating || minting || !mintReady} onClick={mintGeneratedNft} type="button"
                style={{ border: "none", cursor: generating || minting || !mintReady ? "not-allowed" : "pointer", fontFamily: SANS, fontSize: 13.5, fontWeight: 500, opacity: generating || minting || !mintReady ? 0.6 : 1 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 6, verticalAlign: -1 }}>
                  <path d="M12 2L14.5 9 22 9.5 16 14 18 22 12 18 6 22 8 14 2 9.5 9.5 9z" />
                </svg>
                Mint as NFT
              </button>
            </div>
          )}

          {generating && (
            <div className="tn-fadeIn" style={{ color: C.ink3, fontSize: 12.5, marginTop: 14, maxWidth: 460 }}>
              Generating with gpt-image-2, then pinning the image to IPFS. Safe to leave; this draft is saved.
            </div>
          )}

          {(generationError || mintError) && (
            <div className="tn-fadeIn" style={{ color: C.rust, fontSize: 12.5, marginTop: 14, maxWidth: 460 }}>
              {generationError || mintError}
            </div>
          )}

          {generatedNft?.promptDigest && (
            <div className="tn-fadeIn" style={{ color: C.ink4, fontSize: 12.5, marginTop: 14, maxWidth: 460 }}>
              Generated with {generatedNft.model} · prompt {generatedNft.promptDigest.slice(0, 12)}
              {generatedNft.imageCid ? ` · image ${shortHash(generatedNft.imageCid, 8, 6)}` : ""}
            </div>
          )}

          {generatedNft?.id && (recoveredGenerationPending || generationFailed) && (
            <div className="tn-fadeIn" style={{ color: generationFailed ? C.rust : C.ink4, fontSize: 12.5, marginTop: 14, maxWidth: 460 }}>
              Recovery record {shortHash(generatedNft.id, 12, 6)} · {recoveredNftStatus || "unknown"}
            </div>
          )}

          {minting && (
            <div className="tn-fadeIn" style={{ maxWidth: 360 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13.5, color: C.ink2, fontWeight: 500 }}>{currentStep.label}…</span>
                <span className="tn-mono" style={{ fontSize: 11, color: C.ink4 }}>{currentStep.pct}%</span>
              </div>
              <div className="tn-progressLine">
                <span style={{ width: `${currentStep.pct}%` }} />
              </div>
            </div>
          )}

          {minted && (
            <div className="tn-fadeIn" style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <span style={{ color: C.success, fontWeight: 600, fontSize: 13.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Minted on-chain
              </span>
              {generatedNft?.txHash && (
                <span className="tn-mono" style={{ color: C.ink4, fontSize: 11.5 }}>{shortHash(generatedNft.txHash, 10, 6)}</span>
              )}
              <button
                className="tn-link"
                onClick={() => onViewGallery?.()}
                style={{ background: "none", border: 0, cursor: "pointer", padding: 0 }}
                type="button"
              >
                View in gallery →
              </button>
              <button
                className="tn-btn"
                onClick={() => {
                  setGeneratedNft(null);
                  setMintPhase("idle");
                }}
                style={{ marginLeft: "auto" }}
              >
                Mint another
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function PFTTimeseries({ error = "", history, loading = false, onRangeChange, range = "28d" }) {
  const points = history?.points || [];
  const rewardPft = Number(history?.totals?.rewardPft || 0);
  const airdropPft = Number(history?.totals?.airdropPft || 0);
  const grand = Number(history?.totals?.totalPft ?? (rewardPft + airdropPft));
  const taskCount = Number(history?.totals?.taskCount || 0);
  const airdropCount = Number(history?.totals?.airdropCount || 0);

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="PFT generation"
        sub={
          <span>
            <span className="tn-bigNum" style={{ fontSize: 18, color: C.ink, letterSpacing: "-0.01em" }}>{fmtPft(grand)}</span>
            <span style={{ color: C.ink4, marginLeft: 6 }}>
              PFT from {fmtN(airdropCount)} airdrop{airdropCount === 1 ? "" : "s"} and {fmtN(taskCount)} rewarded task{taskCount === 1 ? "" : "s"} in this range
            </span>
          </span>
        }
        action={
          <div>
            {["7d", "28d", "90d"].map(p => (
              <button key={p} className={`tn-tab ${range === p ? "tn-tab-active" : ""}`}
                onClick={() => onRangeChange?.(p)} style={{ fontSize: 12.5, marginRight: 16 }}>
                {p}
              </button>
            ))}
          </div>
        }
      />

      {loading ? (
        <div className="tn-shimmer" style={{ height: 220, borderRadius: 12 }} />
      ) : error ? (
        <div style={{ color: C.rust, fontSize: 13.5 }}>{error}</div>
      ) : (
        <RewardsChart data={points} />
      )}
    </section>
  );
}

export function NFTGallery({
  minted = [],
  total = null,
  allowMockFallback = true,
  emptyCopy = "No profile NFTs yet.",
  onSetProfilePicture = null,
  selectingNftId = "",
} = {}) {
  const [page, setPage] = useState(0);
  const usingMockFallback = !minted.length && allowMockFallback;
  const records = minted.length ? minted : (usingMockFallback ? NFT_DATA : []);
  const mintedCount = records.filter((n) => (n.status || "").toLowerCase() === "minted" || n.rarity).length;
  const totalCount = usingMockFallback ? records.length : (Number.isFinite(Number(total)) ? Number(total) : records.length);
  const countLabel = totalCount > records.length ? `${records.length} of ${totalCount}` : `${totalCount}`;
  const pageCount = Math.max(1, Math.ceil(records.length / NFT_GALLERY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * NFT_GALLERY_PAGE_SIZE;
  const visibleRecords = records.slice(start, start + NFT_GALLERY_PAGE_SIZE);
  const showingStart = records.length ? start + 1 : 0;
  const showingEnd = Math.min(records.length, start + visibleRecords.length);

  useEffect(() => {
    setPage(0);
  }, [records.length]);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  return (
    <section id="profile-nft-gallery" style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="NFT gallery"
        sub={`${countLabel} profile NFTs · ${mintedCount} minted${records.length > NFT_GALLERY_PAGE_SIZE ? ` · showing ${showingStart}-${showingEnd}` : ""}`}
      />

      {records.length > 0 ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32 }}>
            {visibleRecords.map(n => (
              <NFTTile
                key={n.id}
                nft={n}
                onSetProfilePicture={onSetProfilePicture}
                selecting={selectingNftId === n.id}
              />
            ))}
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
        <div style={{
          borderTop: `1px solid ${C.ruleSoft}`,
          color: C.ink3,
          fontSize: 13.5,
          lineHeight: 1.55,
          paddingTop: 18,
        }}>
          {emptyCopy}
        </div>
      )}
    </section>
  );
}

export function imageCandidatesForNft(nft = {}) {
  return profileNftImageCandidates(nft);
}

export function nftStatusLabel(nft = {}) {
  const status = profileNftStatus(nft);
  if (status === "generating") return "Generating";
  if (status === "failed") return "Failed";
  if (status === "prepared") return "Prepared";
  if (status === "minted") return "Minted";
  if (status === "generated") return "Generated";
  return nft.status || "Generated";
}

export function nftDateLabel(nft = {}) {
  const status = profileNftStatus(nft);
  if (nft.date) return nft.date;
  if (nft.mintedAt) return fmtDate(new Date(nft.mintedAt));
  if (status === "generating") return "In progress";
  if (status === "failed") return "Needs retry";
  if (nft.generatedAt) return fmtDate(new Date(nft.generatedAt));
  return "Generated";
}

export function NFTTile({ nft, onSetProfilePicture = null, selecting = false }) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(nft), [nft]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";
  const hasImageCid = Boolean(String(nft.imageCid || "").trim());
  const status = profileNftStatus(nft);
  const statusLabel = nftStatusLabel(nft);
  const canBecomeProfilePicture = profileNftCanBecomeAvatar(nft);
  const selected = nft.selected === true;

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  const handleImageError = () => {
    setImageIndex((index) => index + 1);
  };

  return (
    <div className="tn-lift" style={{ cursor: "pointer" }}>
      <div style={{
        aspectRatio: "1 / 1",
        background: C.paper2,
        borderRadius: 12,
        marginBottom: 10,
        overflow: "hidden",
        position: "relative",
      }}>
        {selected && (
          <div style={{
            background: "rgba(31, 27, 22, 0.78)",
            borderRadius: 999,
            color: C.paper3,
            fontSize: 11,
            fontWeight: 650,
            left: 10,
            lineHeight: 1,
            padding: "7px 9px",
            position: "absolute",
            top: 10,
            zIndex: 2,
          }}>
            Profile picture
          </div>
        )}
        {imageSrc ? (
          <img
            alt={nft.title || "Profile NFT"}
            decoding="async"
            loading="lazy"
            onError={handleImageError}
            src={imageSrc}
            style={{
              display: "block",
              height: "100%",
              objectFit: "cover",
              width: "100%",
            }}
          />
        ) : hasImageCid ? (
          <div style={{
            alignItems: "center",
            border: `1px solid ${C.ruleSoft}`,
            color: C.ink4,
            display: "flex",
            flexDirection: "column",
            fontSize: 12,
            gap: 8,
            height: "100%",
            justifyContent: "center",
            padding: 14,
            textAlign: "center",
          }}>
            <span style={{ color: C.ink3, fontWeight: 650 }}>Image unavailable</span>
            <span className="tn-mono" style={{ fontSize: 10.5, lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {shortHash(nft.imageCid, 10, 8)}
            </span>
          </div>
        ) : status === "generating" || status === "failed" ? (
          <div style={{
            alignItems: "center",
            border: `1px solid ${status === "failed" ? C.rust : C.ruleSoft}`,
            color: status === "failed" ? C.rust : C.ink4,
            display: "flex",
            flexDirection: "column",
            fontSize: 12,
            gap: 8,
            height: "100%",
            justifyContent: "center",
            padding: 14,
            textAlign: "center",
          }}>
            <span style={{ color: status === "failed" ? C.rust : C.ink3, fontWeight: 650 }}>{statusLabel}</span>
            <span style={{ lineHeight: 1.35 }}>
              {status === "failed" ? (nft.error || "Generation failed.") : "Saved draft will finish here."}
            </span>
          </div>
        ) : (
          <NFTArt kind={nft.kind || "topology"} palette={nft.palette || "green"} size="100%" />
        )}
      </div>
      <div style={{
        fontSize: 13.5, fontWeight: 600, color: C.ink,
        letterSpacing: "-0.005em",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {nft.title}
      </div>
      <div style={{ fontSize: 11.5, color: C.ink4, marginTop: 3, display: "flex", gap: 8 }}>
        <span>{nftDateLabel(nft)}</span>
        <span style={{ color: C.ink5 }}>·</span>
        <span style={{ color: nft.rarity === "Common" ? C.ink4 : status === "failed" ? C.rust : C.warning }}>{nft.rarity || statusLabel}</span>
      </div>
      {canBecomeProfilePicture && typeof onSetProfilePicture === "function" && (
        <button
          className="tn-btn"
          disabled={selected || selecting}
          onClick={(event) => {
            event.stopPropagation();
            onSetProfilePicture(nft);
          }}
          style={{
            color: selected ? C.success : C.ink3,
            fontSize: 12.5,
            marginTop: 8,
            opacity: selecting ? 0.6 : 1,
            padding: 0,
          }}
          type="button"
        >
          {selected ? "Profile picture" : selecting ? "Setting..." : "Set as profile picture"}
        </button>
      )}
    </div>
  );
}

export function connectionLabel(connection = {}) {
  return connection.hiveHandle
    ? `@${String(connection.hiveHandle).replace(/^@+/, "")}`
    : connection.displayName || shortHash(connection.accountId || "", 10, 6) || "Task Node member";
}

export function connectionInitials(connection = {}) {
  const label = connection.displayName || connection.hiveHandle || "TN";
  return String(label)
    .replace(/^@+/, "")
    .split(/\s+|[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "TN";
}

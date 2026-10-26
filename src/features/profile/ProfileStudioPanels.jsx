import { ExpandableProfileImage } from "./ExpandableProfileImage.jsx";
import { ProfileArtTraits } from "./ProfilePortrait.jsx";
import { PROFILE_NFT_TITLE } from "../../../shared/profile-nft-art.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { requestJson } from "../../api";
import { profileNftImageCandidates } from "./profile-nft-images.js";
import {
  RewardsChart,
  latestAvatarNft,
  mintStepForPhase,
  profileNftCanBecomeAvatar,
  profileNftFailed,
  profileNftIsGenerating,
  profileNftStatus,
} from "./ProfileBriefing.jsx";
import {
  NFT_GALLERY_LIMIT,
  NFT_GALLERY_PAGE_SIZE,
  fmtDate,
  fmtN,
  fmtPft,
  shortHash,
} from "./profile-view-shared.jsx";

export function ProfileStudio({
  accountId = "",
  linkedWalletAddress = "",
  nfts: parentNfts = null,
  onNftsChange,
  onProfileAvatarChange,
  onViewGallery,
  onWalletUnlock,
  walletSecret = null,
  walletVault = {},
} = {}) {
  const [generatedNft, setGeneratedNft] = useState(null);
  const [nfts, setNfts] = useState([]);
  const [generationStatus, setGenerationStatus] = useState("idle");
  const [generationError, setGenerationError] = useState("");
  const [imageIndex, setImageIndex] = useState(0);
  const [mintPhase, setMintPhase] = useState("idle");
  const [mintError, setMintError] = useState("");
  const generationFailed = profileNftFailed(generatedNft);
  const recoveredGenerationPending = profileNftIsGenerating(generatedNft);
  const generating = generationStatus === "generating" || recoveredGenerationPending;
  // A failed render never replaces the portrait on screen: show the newest
  // usable one and a one-line note instead of an error card.
  // The parent's list carries gallery selections; fall back to our own load.
  const avatarSource = Array.isArray(parentNfts) && parentNfts.length ? parentNfts : nfts;
  const shownNft = generationFailed || recoveredGenerationPending
    ? latestAvatarNft(avatarSource)
    : generatedNft || latestAvatarNft(avatarSource);
  const minting = ["preparing", "signing", "broadcasting", "confirming"].includes(mintPhase);
  const minted = mintPhase === "success" || shownNft?.status === "minted";
  const currentStep = mintStepForPhase(mintPhase);
  const shownImageCandidates = useMemo(() => profileNftImageCandidates(shownNft || {}), [shownNft]);
  const shownImageSrc = shownImageCandidates[imageIndex] || "";
  useEffect(() => setImageIndex(0), [shownNft?.id]);
  const mintReady = Boolean(shownNft?.id && shownNft?.imageCid && ["generated", "prepared"].includes(profileNftStatus(shownNft)));
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
      setGenerationError("");
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
    setNfts(nextNfts);
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
      setNfts(nextNfts);
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
    setGenerationError(result.body?.message || result.body?.error || "A new portrait could not be started.");
    setGenerationStatus("idle");
  };

  const mintGeneratedNft = async () => {
    if (minting || generating) return;
    setMintError("");
    const target = shownNft;
    if (!target?.id || !mintReady) {
      setMintError("Generate a portrait before minting.");
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
      body: JSON.stringify({ phase: "prepare", nftId: target.id }),
    });
    if (!prepared.ok || !prepared.body?.txJson) {
      setMintPhase("idle");
      setMintError(prepared.body?.message || prepared.body?.error || "Profile NFT mint could not be prepared.");
      return;
    }

    setGeneratedNft({ ...target, ...(prepared.body.nft || {}) });
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
        nftId: target.id,
        signedTxBlob: signed.txBlob,
      }),
    });
    if (!submitted.ok || !submitted.body?.nft) {
      setMintPhase("idle");
      setMintError(submitted.body?.message || submitted.body?.error || "Profile NFT mint could not be submitted.");
      return;
    }

    setMintPhase("confirming");
    const nextNft = { ...target, ...submitted.body.nft };
    setGeneratedNft((current) => ({
      ...(current || {}),
      ...submitted.body.nft,
      imageDataUrl: current?.imageDataUrl,
    }));
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(nextNft);
    await loadNfts();
    setMintPhase("success");
  };

  const shownTitle = shownNft?.title || PROFILE_NFT_TITLE;
  const statusLine = generating
    ? "Creating and reviewing a new portrait. You can leave this page; it appears here when it's ready."
    : generationFailed
      ? "Your newest portrait didn't finish rendering. Generate again to retry."
      : minted
        ? "Minted on-chain and used as your profile picture."
        : shownNft
          ? "Use it as your profile picture or mint it to your wallet."
          : "Portraits are drawn from your completed work.";

  return (
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h2>Profile picture</h2>
          <p>Portraits generated from your completed work.</p>
        </div>
        {nfts.length > 0 && (
          <div className="pf-section-actions">
            <button className="pf-text-button" onClick={() => onViewGallery?.()} type="button">All portraits</button>
          </div>
        )}
      </div>
      <div className="pf-studio">
        <div className={`pf-studio-frame${minted ? " tn-glow" : ""}`}>
          {shownImageSrc ? (
            <ExpandableProfileImage nft={shownNft}>
              <img
                alt={shownTitle}
                onError={() => setImageIndex((index) => index + 1)}
                src={shownImageSrc}
              />
            </ExpandableProfileImage>
          ) : (
            <div className="pf-studio-empty">{generating ? "Drawing your portrait" : "No portrait yet"}</div>
          )}
          {generating && <div className="pf-studio-progress" aria-hidden="true" />}
        </div>
        <div>
          <h3>{shownTitle}</h3>
          {shownNft && <ProfileArtTraits nft={shownNft} />}
          <p className="pf-note">{statusLine}</p>
          {!minting && (
            <div className="pf-studio-actions">
              <button className="pf-button" disabled={generating} onClick={regenerate} type="button">
                {generating ? "Generating…" : "Generate new portrait"}
              </button>
              {!minted && mintReady && (
                <button className="pf-button is-primary" disabled={generating} onClick={mintGeneratedNft} type="button">
                  Mint as NFT
                </button>
              )}
              {minted && shownNft?.txHash && (
                <span className="pf-muted tn-mono" style={{ alignSelf: "center" }}>{shortHash(shownNft.txHash, 10, 6)}</span>
              )}
            </div>
          )}
          {minting && (
            <div className="tn-fadeIn" style={{ marginTop: 16, maxWidth: 360 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="pf-muted">{currentStep.label}…</span>
                <span className="pf-muted tn-mono">{currentStep.pct}%</span>
              </div>
              <div className="tn-progressLine"><span style={{ width: `${currentStep.pct}%` }} /></div>
            </div>
          )}
          {(generationError || mintError) && <p className="pf-note is-error">{generationError || mintError}</p>}
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
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h2>PFT earned</h2>
          <p>
            {fmtPft(grand)} PFT from {fmtN(taskCount)} rewarded task{taskCount === 1 ? "" : "s"} and {fmtN(airdropCount)} airdrop{airdropCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="pf-tabs" role="tablist" aria-label="Range">
          {["7d", "28d", "90d"].map((option) => (
            <button aria-selected={range === option} key={option} onClick={() => onRangeChange?.(option)} role="tab" type="button">
              {option}
            </button>
          ))}
        </div>
      </div>
      <div style={{ paddingTop: 20 }}>
        {loading ? (
          <div className="tn-shimmer" style={{ height: 220, borderRadius: 12 }} />
        ) : error ? (
          <p className="pf-error">{error}</p>
        ) : (
          <RewardsChart data={points} />
        )}
      </div>
    </section>
  );
}

export function NFTGallery({
  minted = [],
  emptyCopy = "Portraits you generate appear here.",
  onSetProfilePicture = null,
  selectingNftId = "",
} = {}) {
  const [page, setPage] = useState(0);
  // Failed and abandoned renders are not portraits; they stay out of the gallery.
  const records = useMemo(() => (Array.isArray(minted) ? minted : []).filter((nft) => !profileNftFailed(nft)), [minted]);
  const mintedCount = records.filter((nft) => profileNftStatus(nft) === "minted").length;
  const pageCount = Math.max(1, Math.ceil(records.length / NFT_GALLERY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * NFT_GALLERY_PAGE_SIZE;
  const visibleRecords = records.slice(start, start + NFT_GALLERY_PAGE_SIZE);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  return (
    <section className="pf-section" id="profile-nft-gallery">
      <div className="pf-section-head">
        <div>
          <h2>Portraits</h2>
          <p>{records.length ? `${fmtN(records.length)} portrait${records.length === 1 ? "" : "s"} · ${fmtN(mintedCount)} minted` : emptyCopy}</p>
        </div>
      </div>
      {records.length > 0 && (
        <>
          <div className="pf-gallery">
            {visibleRecords.map((nft) => (
              <NFTTile key={nft.id} nft={nft} onSetProfilePicture={onSetProfilePicture} selecting={selectingNftId === nft.id} />
            ))}
          </div>
          {pageCount > 1 && (
            <div className="pf-pager">
              <span className="pf-muted">Page {currentPage + 1} of {pageCount}</span>
              <span>
                <button className="pf-text-button" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} type="button">Previous</button>
                <button className="pf-text-button" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} type="button">Next</button>
              </span>
            </div>
          )}
        </>
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
  if (status === "minted") return "Minted";
  return "Not minted";
}

export function nftDateLabel(nft = {}) {
  const status = profileNftStatus(nft);
  if (nft.mintedAt) return fmtDate(new Date(nft.mintedAt));
  if (status === "generating") return "In progress";
  if (nft.generatedAt) return fmtDate(new Date(nft.generatedAt));
  if (nft.createdAt) return fmtDate(new Date(nft.createdAt));
  return "";
}

export function NFTTile({ nft, onSetProfilePicture = null, selecting = false }) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(nft), [nft]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";
  const status = profileNftStatus(nft);
  const canBecomeProfilePicture = profileNftCanBecomeAvatar(nft);
  const selected = nft.selected === true;
  const dateLabel = nftDateLabel(nft);

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  return (
    <div className="pf-tile">
      <ExpandableProfileImage className="pf-tile-image" disabled={!imageSrc} nft={nft}>
        {selected && <span className="pf-tile-flag">Profile picture</span>}
        {imageSrc ? (
          <img alt={nft.title || "Portrait"} decoding="async" loading="lazy" onError={() => setImageIndex((index) => index + 1)} src={imageSrc} />
        ) : (
          <div className="pf-studio-empty">{status === "generating" ? "Drawing…" : "Image unavailable"}</div>
        )}
      </ExpandableProfileImage>
      <div className="pf-tile-title">{nft.title || PROFILE_NFT_TITLE}</div>
      <div className="pf-tile-meta">
        {dateLabel && <span>{dateLabel} · </span>}
        <span className={status === "minted" ? "is-minted" : ""}>{nftStatusLabel(nft)}</span>
      </div>
      {canBecomeProfilePicture && !selected && typeof onSetProfilePicture === "function" && (
        <button
          className="pf-text-button"
          disabled={selecting}
          onClick={(event) => {
            event.stopPropagation();
            onSetProfilePicture(nft);
          }}
          type="button"
        >
          {selecting ? "Setting…" : "Use as profile picture"}
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

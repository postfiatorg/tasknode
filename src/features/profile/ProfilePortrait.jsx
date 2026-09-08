import { useCallback, useEffect, useRef, useState } from "react";
import { profileNftImageCandidates } from "./profile-nft-images.js";

function portraitSeed(value) {
  let hash = 2166136261;
  for (const character of String(value || "member")) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return hash;
}

// Original local artwork gives every account a PFP immediately. This is a
// starter portrait, not an earned creature level or a minted NFT.
export function StarterPortrait({ seed = "member" }) {
  const hash = portraitSeed(seed);
  const accent = ["#42644d", "#345d75", "#a65440", "#89723f", "#5e566f"][hash % 5];
  const lean = hash % 9 - 4;
  const visor = hash % 3;
  return (
    <svg viewBox="0 0 128 128" width="100%" height="100%" aria-hidden="true" style={{ display: "block" }}>
      <rect width="128" height="128" fill="#e9e2d2" />
      <circle cx={66 + lean} cy="57" r="42" fill={accent} opacity=".23" />
      <path d="M8 111 22 82 37 91 32 119M114 19 108 44 119 55M11 41 25 29 19 52" fill="none" stroke={accent} strokeWidth="2" />
      <path d={`M15 128 26 99 47 89 46 73 39 61 43 37 59 26 78 31 87 46 85 67 78 83 82 92 104 102 117 128Z`} fill="#242b27" />
      <path d={`M47 43 62 34 77 39 81 53 74 75 60 85 48 69Z`} fill="#d6cdb8" stroke="#242b27" strokeWidth="3" transform={`translate(${lean} 0)`} />
      <path d={visor === 0 ? "M44 51 80 48 76 58 47 61Z" : visor === 1 ? "M48 48 61 53 77 46 77 55 63 61 49 56Z" : "M48 50 77 50 75 57 49 58Z"} fill={accent} stroke="#242b27" strokeWidth="2" />
      <path d="M61 60 58 68 69 69M54 77 67 78M47 90 59 109 77 88 87 101 70 126 40 105Z" fill="none" stroke="#e9e2d2" strokeWidth="2" />
      <path d="M29 107 23 127M35 110 30 128M41 115 37 128M89 110 98 128M95 108 108 128M44 39 51 36M43 44 53 39" stroke={accent} strokeWidth="2" />
      <path d="M70 36 78 42 81 49M77 63 72 74M65 96 62 112" fill="none" stroke="#242b27" strokeWidth="1.5" />
    </svg>
  );
}

function PortraitCandidate({ src, loaded, onLoad, onError, fullResolution }) {
  const thumbnail = src.startsWith("/api/profile/nft/pfp/");
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  useEffect(() => {
    if (!thumbnail) return;
    const controller = new AbortController();
    let timer;
    let objectUrl;
    let attempts = 0;
    const read = async () => {
      try {
        const response = await fetch(src, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), credentials: "same-origin" });
        if (controller.signal.aborted) return;
        const type = (response.headers.get("content-type") || "").split(";")[0];
        // Older deployments returned a successful SVG placeholder on a cold
        // cache. It is not the NFT and must never replace the starter portrait.
        if (response.status === 202 || (response.ok && type === "image/svg+xml")) {
          await response.body?.cancel();
          attempts++;
          timer = setTimeout(read, Math.min(30_000, 2000 * 2 ** Math.min(attempts - 1, 4)));
          return;
        }
        if (!response.ok || !["image/webp", "image/png", "image/jpeg", "image/gif"].includes(type)) {
          await response.body?.cancel();
          onError();
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setThumbnailUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) onError();
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, thumbnail, onError]);
  const resolved = thumbnail ? thumbnailUrl : src;
  if (!resolved) return null;
  return <img alt="" decoding="async" loading={fullResolution ? "eager" : "lazy"} fetchPriority={fullResolution ? "high" : "auto"} src={resolved} onLoad={onLoad} onError={onError}
    style={{ position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0 }} />;
}

function PortraitImages({ candidates, seed, label, size, className, fullResolution }) {
  const container = useRef(null);
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = candidates[index];
  const onError = useCallback(() => { setLoaded(false); setIndex((value) => value + 1); }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={container} className={className} role="img" aria-label={label} style={{ position: "relative", display: "inline-block", flexShrink: 0, width: size, height: size, overflow: "hidden", borderRadius: 10, background: "var(--tn-dark-hover, #e9e2d2)", verticalAlign: "middle" }}>
      {!loaded && <StarterPortrait seed={seed} />}
      {src && (visible || fullResolution) && <PortraitCandidate key={src} src={src} loaded={loaded} onLoad={() => setLoaded(true)} onError={onError} fullResolution={fullResolution} />}
    </span>
  );
}

export function ProfilePortrait({ nft = null, seed = "member", label = "Profile picture", size = 64, className = "", imageCandidates, fullResolution = false }) {
  const candidates = imageCandidates || profileNftImageCandidates(nft, fullResolution
    ? { thumbnailFallback: false }
    : { avatarCssSize: typeof size === "number" ? size : 48 });
  return <PortraitImages key={`${seed}|${candidates.join("|")}`} candidates={candidates} seed={seed} label={label} size={size} className={className} fullResolution={fullResolution} />;
}

export function ProfileArtTraits({ nft }) {
  const art = nft?.metadataJson?.art;
  if (!art?.creature) return null;
  return <span style={{ color: "var(--directory-muted, var(--tn-dark-muted, #6b6c64))", display: "block", fontSize: 11, lineHeight: 1.5, marginTop: 4 }} title={`Creature level ${art.creature_level} · Momentum: ${art.momentum}`}>
    {art.creature} · Hyperstition {art.hyperstition}
  </span>;
}

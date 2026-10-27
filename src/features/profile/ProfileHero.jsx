import { useEffect, useMemo, useState } from "react";
import { profileNftImageCandidates } from "./profile-nft-images.js";
import { fmtN, fmtPft } from "./profile-view-shared.jsx";

function initials(label = "") {
  return String(label || "TN")
    .replace(/^@+/, "")
    .split(/\s+|[-_.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "TN";
}

function HeroPortrait({ label, nft }) {
  const candidates = useMemo(() => profileNftImageCandidates(nft || {}, { avatarCssSize: 112 }), [nft]);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [candidates]);
  const src = candidates[index] || "";
  return (
    <div className="pf-hero-portrait">
      {src ? (
        <img alt={`${label} profile picture`} onError={() => setIndex((value) => value + 1)} src={src} />
      ) : (
        <span className="pf-hero-portrait-empty" aria-hidden="true">{initials(label)}</span>
      )}
    </div>
  );
}

export function ProfileHero({ alignment = null, avatarNft = null, rewardHistory = null, rewardRange = "28d", session = null }) {
  const handle = String(session?.hiveHandle || "").replace(/^@+/, "");
  const name = session?.publicDisplayName || session?.displayName || (handle ? `@${handle}` : "Your profile");
  const totals = rewardHistory?.totals || {};
  const totalPft = Number(totals.totalPft ?? (Number(totals.rewardPft || 0) + Number(totals.airdropPft || 0)));
  const taskCount = Number(totals.taskCount || 0);
  const rangeLabel = String(rewardHistory?.range || rewardRange || "28d").replace("d", " days");
  const alignmentScore = alignment?.score0To100;
  const windowDays = Number(alignment?.windowDays) || 30;
  const scoredDays = Number(alignment?.scoredDays) || 0;
  const linked = (session?.linkedProviders || []).map((provider) => provider?.label || provider?.id).filter(Boolean);

  return (
    <header>
      <div className="pf-hero">
        <HeroPortrait label={name} nft={avatarNft} />
        <div>
          <h1>{name}</h1>
          <div className="pf-hero-sub">
            {handle && name !== `@${handle}` && <span>@{handle}</span>}
            {linked.length > 0 && <span>{linked.join(", ")}</span>}
          </div>
        </div>
      </div>
      <dl className="pf-stats">
        <div className="pf-stat">
          <dt>PFT earned</dt>
          <dd>{fmtPft(totalPft)}</dd>
          <p>Last {rangeLabel}</p>
        </div>
        <div className="pf-stat">
          <dt>Rewarded tasks</dt>
          <dd>{fmtN(taskCount)}</dd>
          <p>Last {rangeLabel}</p>
        </div>
        <div className="pf-stat">
          <dt>Alignment</dt>
          <dd>{alignmentScore ?? "—"}{alignmentScore !== null && alignmentScore !== undefined && <small>/ 100</small>}</dd>
          <p>{scoredDays ? `${scoredDays} scored day${scoredDays === 1 ? "" : "s"} · ${windowDays}d` : `No scored work in ${windowDays} days`}</p>
        </div>
        <div className="pf-stat">
          <dt>Airdrops</dt>
          <dd>{fmtPft(totals.airdropPft || 0)}</dd>
          <p>{fmtN(totals.airdropCount || 0)} in the last {rangeLabel}</p>
        </div>
      </dl>
    </header>
  );
}

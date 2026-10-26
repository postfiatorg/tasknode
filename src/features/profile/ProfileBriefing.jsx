import { useRef, useState } from "react";
import { transactionExplorerHref } from "../../pftl-explorer.js";
import {
  C,
  MONO,
  dateKeyUtc,
  fmtDate,
  fmtDateLabel,
  fmtN,
  fmtPft,
} from "./profile-view-shared.jsx";

export function RewardsChart({ data = [] }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const points = Array.isArray(data) ? data : [];

  if (!points.length) {
    return (
      <div style={{
        borderTop: `1px solid ${C.ruleSoft}`,
        color: C.ink4,
        fontSize: 13.5,
        lineHeight: 1.55,
        paddingTop: 24,
      }}>
        No rewarded task payments are available for this range yet.
      </div>
    );
  }

  const W = 760, H = 240;
  const padL = 8, padR = 64, padT = 28, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const totals = points.map(d => Number(d.total || 0));
  const maxY = Math.max(1, ...totals) * 1.12;
  const x = i => points.length <= 1 ? padL + innerW : padL + (i / (points.length - 1)) * innerW;
  const y = v => padT + innerH - (Number(v || 0) / maxY) * innerH;
  const baseline = H - padB;
  const linePath = "M " + points.map((d, i) => `${x(i)} ${y(d.total)}`).join(" L ");
  const areaPath = [
    `M ${x(0)} ${baseline}`,
    ...points.map((d, i) => `L ${x(i)} ${y(d.total)}`),
    `L ${x(points.length - 1)} ${baseline}`,
    "Z",
  ].join(" ");
  const ticks = points.map((d, i) => ({ i, d })).filter(({ i }) => i % 7 === 0 || i === points.length - 1);
  const lastIdx = points.length - 1;
  const lastTotal = totals[lastIdx] || 0;

  const handleMove = (e) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < padL || px > padL + innerW) { setHover(null); return; }
    const rel = (px - padL) / innerW;
    const idx = Math.round(rel * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, idx)));
  };
  const handleLeave = () => setHover(null);

  return (
    <div style={{ position: "relative" }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%"
        style={{ display: "block", overflow: "visible" }}
        onMouseMove={handleMove} onMouseLeave={handleLeave}>
        <defs>
          <linearGradient id="grad-reward-actual" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={C.layerNetwork} stopOpacity="0.30" />
            <stop offset="100%" stopColor={C.layerNetwork} stopOpacity="0.08" />
          </linearGradient>
        </defs>

        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={C.rule} strokeWidth="0.8" />

        <path d={areaPath} fill="url(#grad-reward-actual)" />
        <path d={linePath} fill="none" stroke={C.ink} strokeWidth="1.4" />

        <circle cx={x(lastIdx)} cy={y(lastTotal)} r="4" fill={C.paper3} stroke={C.ink} strokeWidth="1.5" />
        <text x={x(lastIdx)} y={Math.max(12, y(lastTotal) - 12)} fontSize="10" fill={C.ink2}
          textAnchor="end" fontWeight="600" letterSpacing="0.05em">
          TODAY · {fmtPft(lastTotal)}
        </text>

        <text x={x(lastIdx)} y={padT - 6} fontSize="9.5" fill={C.ink5}
          textAnchor="end" fontFamily={MONO}>
          peak {fmtPft(Math.max(...totals))}
        </text>

        {ticks.map(({ i, d }) => (
          <text key={i} x={x(i)} y={H - 6} fontSize="10" fill={C.ink4}
            textAnchor="middle" fontFamily={MONO}>
            {fmtDate(new Date(`${d.date}T00:00:00Z`))}
          </text>
        ))}

        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB}
              stroke={C.ink} strokeOpacity="0.18" />
            <circle cx={x(hover)}
              cy={y(points[hover].total)}
              r="3" fill={C.ink} />
          </g>
        )}
      </svg>

      {hover !== null && (
        <div className="tn-fadeIn tn-mono" style={{
          position: "absolute",
          left: `${(x(hover) / W) * 100}%`,
          top: 8,
          transform: hover > data.length / 2 ? "translateX(-110%)" : "translateX(8%)",
          fontSize: 11.5,
          color: C.ink2,
          pointerEvents: "none",
          lineHeight: 1.55,
          background: "var(--tn-dark-bg, rgba(255,252,245,0.88))",
          padding: "6px 10px",
          backdropFilter: "blur(2px)",
        }}>
          <div style={{ color: C.ink4, marginBottom: 2 }}>
            {fmtDate(new Date(`${points[hover].date}T00:00:00Z`))}{hover === points.length - 1 ? " · today" : ""}
          </div>
          <div style={{ color: C.ink, fontWeight: 600 }}>
            {fmtPft(points[hover].total)} PFT
          </div>
          <div style={{ color: C.ink4 }}>
            Airdrops {fmtPft(points[hover].airdropPft || 0)} · Rewards {fmtPft(points[hover].rewardPft || 0)}
          </div>
          <div style={{ color: C.ink4 }}>
            {fmtN(points[hover].airdropCount || 0)} airdrop{Number(points[hover].airdropCount || 0) === 1 ? "" : "s"} · {fmtN(points[hover].taskCount)} rewarded task{Number(points[hover].taskCount || 0) === 1 ? "" : "s"}
          </div>
        </div>
      )}
    </div>
  );
}

export const MINT_STEPS = [
  { id: "prep",    label: "Preparing transaction",  pct: 18 },
  { id: "sign",    label: "Requesting signature",    pct: 38 },
  { id: "broad",   label: "Broadcasting to network", pct: 62 },
  { id: "confirm", label: "Confirming on ledger",    pct: 88 },
  { id: "done",    label: "Minted",                  pct: 100 },
];

export function mintStepForPhase(phase = "idle") {
  if (phase === "signing") return MINT_STEPS[1];
  if (phase === "broadcasting") return MINT_STEPS[2];
  if (phase === "confirming") return MINT_STEPS[3];
  if (phase === "success") return MINT_STEPS[4];
  return MINT_STEPS[0];
}

// Server fallback copy written when the feedback reviewer fails
// (server/profile-daily-airdrop.js). It carries no information, so the panel
// hides it instead of showing three columns of filler.
const AIRDROP_FALLBACK_FEEDBACK = new Set([
  "This airdrop uses the rewarded tasks in the lookback window.",
  "Detailed feedback is temporarily unavailable.",
  "No corrective action is being requested while feedback is unavailable.",
]);

function airdropFeedbackText(value = "") {
  const text = String(value || "").trim();
  return text && !AIRDROP_FALLBACK_FEEDBACK.has(text) ? text : "";
}

const PAYOUT_STATUS_TEXT = {
  submitted: "Paid",
  scored: "Payout pending",
  pending: "Payout queued",
  processing_pre_submit: "Preparing payout",
  failed_before_submit: "Retry pending",
  submitting: "Submitting",
  submit_unknown: "Needs reconciliation",
  cancelled: "Cancelled",
};

export function TodaysBriefing({ airdrop, error = "", loading = false, pftlExplorerUrl = "" }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const head = (
    <div className="pf-section-head">
      <div>
        <h2>Daily airdrop</h2>
        <p>Scored from your rewarded work each day.</p>
      </div>
      {airdrop && String(airdrop.reasoningText || "").trim() && (
        <div className="pf-section-actions">
          <button className="pf-text-button" onClick={() => setReasoningOpen((value) => !value)} type="button">
            {reasoningOpen ? "Hide reasoning" : "Full reasoning"}
          </button>
        </div>
      )}
    </div>
  );

  if (loading) return <section className="pf-section">{head}<div className="tn-shimmer" style={{ height: 64, marginTop: 16, borderRadius: 10 }} /></section>;
  if (error) return <section className="pf-section">{head}<p className="pf-error">{error}</p></section>;
  if (!airdrop) {
    return (
      <section className="pf-section">
        {head}
        <p className="pf-muted" style={{ paddingTop: 16 }}>Your first airdrop is scored after a task is rewarded.</p>
      </section>
    );
  }

  const paidAirdrop = airdrop?.issuance?.status === "submitted" ? airdrop.issuance : null;
  const payoutStatus = airdrop?.issuance?.status || "scored";
  const statusText = PAYOUT_STATUS_TEXT[payoutStatus] || payoutStatus.replaceAll("_", " ");
  const amount = Number(paidAirdrop?.amountPft || airdrop?.dailyAirdropPft || 0);
  const dateSource = paidAirdrop?.submittedAt || airdrop?.completedAt || airdrop?.runDate;
  const isToday = Boolean(dateSource) && dateKeyUtc(dateSource) === dateKeyUtc(new Date());
  const dateLabel = isToday ? "Today" : fmtDateLabel(dateSource);
  const workQuality = Number.isFinite(airdrop?.retentionValueScore)
    ? Math.round(Math.min(100, Math.max(0, airdrop.retentionValueScore)))
    : null;
  const txHref = transactionExplorerHref(paidAirdrop?.txHash, pftlExplorerUrl);
  const feedback = [
    ["What contributed", airdropFeedbackText(airdrop.whatRaisedToday)],
    ["What held it back", airdropFeedbackText(airdrop.whatKeptItLower)],
    ["Next step", airdropFeedbackText(airdrop.toImproveTomorrow)],
  ].filter(([, text]) => text);

  return (
    <section className="pf-section">
      {head}
      <div className="pf-airdrop">
        <div>
          <div className="pf-airdrop-amount">{fmtPft(amount)}<small>PFT</small></div>
          <div className="pf-airdrop-meta">
            <span>{dateLabel ? `${isToday ? "" : "Latest · "}${dateLabel}` : "Latest"}</span>
            <span className={paidAirdrop ? "is-paid" : "is-pending"}>{statusText}</span>
            {workQuality !== null && <span>Work quality {workQuality} / 100</span>}
            {paidAirdrop?.txHash && (txHref
              ? <a className="tn-link" href={txHref} rel="noopener noreferrer" target="_blank">Tx {paidAirdrop.txHash.slice(0, 8)}…</a>
              : <span title={paidAirdrop.txHash}>Tx {paidAirdrop.txHash.slice(0, 8)}…</span>)}
          </div>
        </div>
      </div>
      {feedback.length > 0 && (
        <div className="pf-feedback">
          {feedback.map(([label, text]) => (
            <div key={label}>
              <h3>{label}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      )}
      {reasoningOpen && <p className="pf-reasoning tn-fadeIn">{airdrop.reasoningText}</p>}
    </section>
  );
}

export function profileNftStatus(nft = {}) {
  return String(nft?.status || "").trim().toLowerCase();
}

export function profileNftIsGenerating(nft = {}) {
  return profileNftStatus(nft) === "generating";
}

export function profileNftFailed(nft = {}) {
  return profileNftStatus(nft) === "failed";
}

export function profileNftCanBecomeAvatar(nft = {}) {
  const status = profileNftStatus(nft);
  return Boolean(nft?.imageCid || nft?.imageDataUrl || nft?.imageGatewayUrl) &&
    status !== "generating" &&
    status !== "failed";
}

export function profileNftCreatedTime(nft = {}) {
  const date = new Date(nft?.createdAt || nft?.generatedAt || nft?.mintedAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function latestAvatarNft(nfts = []) {
  const eligible = (Array.isArray(nfts) ? nfts : []).filter(profileNftCanBecomeAvatar);
  return eligible.find((nft) => nft.selected) || eligible
    .sort((left, right) => profileNftCreatedTime(right) - profileNftCreatedTime(left))[0] || null;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestJson } from "../../api";
import { ProfileIdentityCard } from "./ProfileIdentityCard.jsx";
import { PublicProfile } from "./PublicProfileView.jsx";

const C = {
  paper:    "#F4EFE6",
  paper2:   "#FBF7EE",
  paper3:   "#FFFCF5",
  ink:      "#1F1B16",
  ink2:     "#3D362C",
  ink3:     "#6B6052",
  ink4:     "#9B9081",
  ink5:     "#C4BBA9",
  rule:     "#E5DCC8",
  ruleSoft: "#EFE7D6",
  success:  "#5C8C4F",
  warning:  "#B07628",
  rust:     "#B8451F",
  flag:     "#C2410C",
  layerPersonal: "#6B5D43",
  layerNetwork:  "#B8451F",
  layerAlpha:    "#C99F4E",
};

const SANS = "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const fmtN = (n, options = {}) => Number(n || 0).toLocaleString("en-US", options);
const fmtPft = (n) => fmtN(n, { maximumFractionDigits: Number(n || 0) % 1 === 0 ? 0 : 2 });
const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDateLabel = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const dateKeyUtc = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};
const fmtDateTime = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const NFT_GALLERY_PAGE_SIZE = 10;
const shortHash = (value = "", head = 8, tail = 6) => {
  const text = String(value || "");
  return text.length > head + tail + 3 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
};

function useStylesheet() {
  useEffect(() => {
    const id = "tasknode-profile-styles";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      * { box-sizing: border-box; }
      .tn-root {
        background: ${C.paper};
        color: ${C.ink};
        font-family: ${SANS};
        -webkit-font-smoothing: antialiased;
        font-size: 15px;
        line-height: 1.5;
      }
      .tn-eyebrow {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: ${C.ink4};
      }
      .tn-mono { font-family: ${MONO}; }
      .tn-bigNum {
        font-feature-settings: "ss01", "tnum";
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.025em;
        font-weight: 600;
      }
      .tn-link {
        color: ${C.ink3};
        font-size: 13px;
        cursor: pointer;
        text-decoration: none;
        border-bottom: 1px solid transparent;
        transition: color .15s, border-color .15s;
      }
      .tn-link:hover { color: ${C.ink}; border-bottom-color: ${C.ink4}; }
      .tn-btn {
        display: inline-flex; align-items: center; gap: 7px;
        font: inherit; font-size: 13.5px; font-weight: 500;
        padding: 6px 0;
        background: transparent; border: none;
        color: ${C.ink3};
        cursor: pointer; letter-spacing: -0.005em;
        transition: color .15s ease;
      }
      .tn-btn:hover { color: ${C.ink}; }
      .tn-btn-primary {
        background: ${C.ink}; color: ${C.paper};
        padding: 10px 18px; border-radius: 10px;
      }
      .tn-btn-primary:hover { background: #000; }
      .tn-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .tn-tab {
        padding: 4px 0; margin-right: 24px;
        font-size: 14px; font-weight: 500;
        background: transparent; border: none; cursor: pointer;
        color: ${C.ink4}; letter-spacing: -0.005em;
        border-bottom: 1.5px solid transparent;
        transition: color .15s, border-color .15s;
      }
      .tn-tab-active { color: ${C.ink}; border-bottom-color: ${C.ink}; }
      .tn-tab:hover:not(.tn-tab-active) { color: ${C.ink2}; }
      .tn-pulseGreen {
        width: 7px; height: 7px; border-radius: 50%; background: ${C.success};
        box-shadow: 0 0 0 0 ${C.success};
        animation: tn-pulse 2.4s ease-out infinite;
        display: inline-block;
      }
      @keyframes tn-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(92,140,79,.45); }
        70%  { box-shadow: 0 0 0 6px rgba(92,140,79,0); }
        100% { box-shadow: 0 0 0 0 rgba(92,140,79,0); }
      }
      .tn-glow { animation: tn-glowPulse 2s ease-out; border-radius: 12px; }
      @keyframes tn-glowPulse {
        0%   { box-shadow: 0 0 0 0 rgba(95,166,109,0); transform: scale(1); }
        20%  { box-shadow: 0 0 0 8px rgba(95,166,109,.35); transform: scale(1.015); }
        60%  { box-shadow: 0 0 0 24px rgba(95,166,109,0); transform: scale(1); }
        100% { box-shadow: 0 0 0 0 rgba(95,166,109,0); transform: scale(1); }
      }
      .tn-fadeIn { animation: tn-fade .35s ease both; }
      @keyframes tn-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
      .tn-lift { transition: transform .2s ease; }
      .tn-lift:hover { transform: translateY(-1px); }
      .tn-shimmer {
        background: linear-gradient(90deg, ${C.paper2} 0%, ${C.paper3} 50%, ${C.paper2} 100%);
        background-size: 200% 100%;
        animation: tn-shim 1.6s ease-in-out infinite;
      }
      @keyframes tn-shim {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .tn-progressLine {
        height: 1.5px; background: ${C.ruleSoft}; position: relative; overflow: hidden;
        border-radius: 1px;
      }
      .tn-progressLine > span {
        position: absolute; inset: 0; right: auto;
        background: ${C.ink};
        transition: width .35s cubic-bezier(.4,0,.2,1);
      }
    `;
    document.head.appendChild(style);
  }, []);
}
function SectionHead({ eyebrow, sub, action }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      paddingBottom: 14, borderBottom: `1px solid ${C.ruleSoft}`,
      marginBottom: 28,
    }}>
      <div>
        <div className="tn-eyebrow">{eyebrow}</div>
        {sub && <div style={{ fontSize: 13, color: C.ink3, marginTop: 4 }}>{sub}</div>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
const NFT_DATA = [
  { id: "n1", title: "Network Reliability Engineer", date: "May 13, 2026", kind: "topology", palette: "green", rarity: "Common" },
  { id: "n2", title: "NFT 2026-05-12",               date: "May 12, 2026", kind: "circuit",  palette: "gray",  rarity: "Common" },
  { id: "n3", title: "Alpha Brief Analyst",          date: "May 7, 2026",  kind: "sunburst", palette: "gold",  rarity: "Uncommon" },
  { id: "n4", title: "Alpha Brief Analyst",          date: "May 7, 2026",  kind: "flow",     palette: "blue",  rarity: "Uncommon" },
];

function NFTArt({ kind, palette, size = 160 }) {
  const id = useMemo(() => Math.random().toString(36).slice(2, 8), []);
  const palettes = {
    green: { base: "#5FA66D", dark: "#2F5A3A", light: "#B8E0BB", accent: "#0F3A1E" },
    gray:  { base: "#7C7269", dark: "#3D3833", light: "#C9C2BA", accent: "#1F1B16" },
    gold:  { base: "#D89A30", dark: "#7A4C00", light: "#F3D88E", accent: "#3B2304" },
    blue:  { base: "#5293C2", dark: "#1E4561", light: "#B6D5E8", accent: "#0E2538" },
  };
  const p = palettes[palette] || palettes.green;
  return (
    <svg viewBox="0 0 160 160" width={size} height={size} style={{ display: "block", borderRadius: 12 }}>
      <defs>
        <radialGradient id={`bg-${id}`} cx="35%" cy="32%" r="80%">
          <stop offset="0%"  stopColor={p.light} stopOpacity="0.95" />
          <stop offset="55%" stopColor={p.base}  stopOpacity="1" />
          <stop offset="100%" stopColor={p.dark} stopOpacity="1" />
        </radialGradient>
        <linearGradient id={`sheen-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <filter id={`grain-${id}`}>
          <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.06 0" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <clipPath id={`clip-${id}`}>
          <rect width="160" height="160" rx="12" />
        </clipPath>
      </defs>

      <g clipPath={`url(#clip-${id})`}>
        <rect width="160" height="160" fill={`url(#bg-${id})`} />

        {kind === "topology" && (
          <g stroke={p.accent} strokeOpacity="0.55" fill="none" strokeWidth="0.6">
            {[14, 26, 38, 50, 62, 74, 86].map((r, i) => (
              <circle key={i} cx="62" cy="74" r={r} strokeDasharray={i % 2 ? "2 3" : "0"} />
            ))}
            {[[62,74],[108,50],[120,100],[40,110],[30,50],[100,36],[82,130]].map(([x,y], i) => (
              <circle key={i} cx={x} cy={y} r={i === 0 ? 4 : 2.2} fill={p.accent} strokeWidth="0" />
            ))}
            {[[62,74,108,50],[62,74,120,100],[62,74,40,110],[62,74,30,50],[62,74,100,36],[62,74,82,130]].map(([x1,y1,x2,y2], i) => (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeOpacity="0.4" />
            ))}
          </g>
        )}

        {kind === "circuit" && (
          <g stroke={p.accent} strokeOpacity="0.6" fill="none" strokeWidth="0.7">
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`v-${i}`} x1={20 + i * 16} y1="20" x2={20 + i * 16} y2="140" strokeOpacity="0.18" />
            ))}
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`h-${i}`} x1="20" y1={20 + i * 16} x2="140" y2={20 + i * 16} strokeOpacity="0.18" />
            ))}
            <path d="M28 36 L60 36 L60 60 L92 60 L92 92 L124 92" strokeWidth="1.4" />
            <path d="M28 100 L44 100 L44 116 L84 116 L84 132 L116 132" strokeWidth="1.4" />
            <path d="M132 28 L132 60 L116 60 L116 76" strokeWidth="1.4" />
            {[[60,60],[92,60],[92,92],[124,92],[84,116],[116,132],[116,76],[44,100]].map(([x,y], i) => (
              <circle key={i} cx={x} cy={y} r="2.4" fill={p.accent} />
            ))}
          </g>
        )}

        {kind === "sunburst" && (
          <g transform="translate(80 86)">
            {Array.from({ length: 36 }).map((_, i) => {
              const a = (i / 36) * Math.PI * 2;
              const len = 52 + ((i * 13) % 9);
              const x1 = Math.cos(a) * 16, y1 = Math.sin(a) * 16;
              const x2 = Math.cos(a) * len, y2 = Math.sin(a) * len;
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={p.accent} strokeOpacity={i % 3 ? 0.35 : 0.7}
                strokeWidth={i % 3 ? 0.7 : 1.2} />;
            })}
            <circle r="14" fill={p.accent} fillOpacity="0.9" />
            <circle r="8"  fill={p.light} />
            <circle r="3"  fill={p.accent} />
          </g>
        )}

        {kind === "flow" && (
          <g stroke={p.accent} strokeOpacity="0.55" fill="none" strokeWidth="0.8">
            {Array.from({ length: 11 }).map((_, i) => {
              const y = 18 + i * 11;
              const o = (i % 2) * 6;
              return (
                <path key={i}
                  d={`M${0+o} ${y} C 40 ${y - 14}, 80 ${y + 14}, 120 ${y - 6} S 200 ${y + 8}, 240 ${y}`}
                  strokeOpacity={0.18 + (i % 3) * 0.18} />
              );
            })}
            <circle cx="48" cy="62" r="3" fill={p.accent} stroke="none" />
            <circle cx="100" cy="92" r="2.4" fill={p.accent} stroke="none" />
            <circle cx="124" cy="46" r="1.8" fill={p.accent} stroke="none" />
          </g>
        )}

        <rect width="160" height="160" fill={`url(#sheen-${id})`} />
        <rect width="160" height="160" filter={`url(#grain-${id})`} />
        <rect width="160" height="160" fill="none" stroke="rgba(0,0,0,.18)" strokeWidth="1" rx="12" />
      </g>
    </svg>
  );
}
function RewardsChart({ data = [] }) {
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
          background: "rgba(255,252,245,0.88)",
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

const MINT_STEPS = [
  { id: "prep",    label: "Preparing transaction",  pct: 18 },
  { id: "sign",    label: "Requesting signature",    pct: 38 },
  { id: "broad",   label: "Broadcasting to network", pct: 62 },
  { id: "confirm", label: "Confirming on ledger",    pct: 88 },
  { id: "done",    label: "Minted",                  pct: 100 },
];

function mintStepForPhase(phase = "idle") {
  if (phase === "signing") return MINT_STEPS[1];
  if (phase === "broadcasting") return MINT_STEPS[2];
  if (phase === "confirming") return MINT_STEPS[3];
  if (phase === "success") return MINT_STEPS[4];
  return MINT_STEPS[0];
}

function TodaysBriefing({ airdrop, error = "", loading = false, rewardHistory }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const points = rewardHistory?.points || [];
  const totals = points.map((point) => Number(point.total || 0));
  const rewardTotal = Number(rewardHistory?.totals?.rewardPft || 0);
  const airdropTotal = Number(rewardHistory?.totals?.airdropPft || 0);
  const earnedTotal = Number(rewardHistory?.totals?.totalPft ?? (rewardTotal + airdropTotal));
  const taskCount = Number(rewardHistory?.totals?.taskCount || 0);
  const airdropCount = Number(rewardHistory?.totals?.airdropCount || 0);
  const paidAirdrop = airdrop?.issuance?.status === "submitted" ? airdrop.issuance : null;
  const payoutStatus = airdrop?.issuance?.status || (airdrop ? "scored" : "");
  const payoutStatusText = {
    submitted: "Paid",
    scored: "Scored, payout pending",
    pending: "Payout queued",
    processing_pre_submit: "Preparing payout",
    failed_before_submit: "Retry pending",
    submitting: "Submission in progress",
    submit_unknown: "Needs reconciliation",
    cancelled: "Cancelled",
  }[payoutStatus] || payoutStatus.replaceAll("_", " ");
  const payoutStatusTone = paidAirdrop
    ? C.success
    : payoutStatus === "submit_unknown" || payoutStatus === "submitting"
      ? C.rust
      : C.warning;
  const airdropAmount = Number(paidAirdrop?.amountPft || airdrop?.dailyAirdropPft || 0);
  const alignmentPct = Math.round(Number(airdrop?.alignmentScore7d || 0) * 100);
  const airdropDateSource = paidAirdrop?.submittedAt || airdrop?.completedAt || airdrop?.runDate;
  const runDate = fmtDateLabel(airdropDateSource);
  const isTodaysAirdrop = Boolean(airdropDateSource) && dateKeyUtc(airdropDateSource) === dateKeyUtc(new Date());
  const airdropTitle = `${isTodaysAirdrop ? "Today's" : "Latest"} airdrop${runDate ? ` · ${runDate}` : ""}`;
  const headlineLabel = paidAirdrop ? "Daily airdrop paid" : "Daily airdrop scored, not paid yet";
  const rewardedTasks = Number(airdrop?.rewardTotals?.rewarded_task_count || 0);
  const hasReasoning = Boolean(String(airdrop?.reasoningText || "").trim());
  const airdropPointIndex = points.findIndex((point) => point.date === dateKeyUtc(airdropDateSource));
  const airdropPointWindowEnd = airdropPointIndex >= 0 ? airdropPointIndex : points.length - 1;
  const previousSeven = points.slice(Math.max(0, airdropPointWindowEnd - 7), Math.max(0, airdropPointWindowEnd));
  const previousSevenAverage = previousSeven.length
    ? previousSeven.reduce((sum, point) => sum + Number(point.airdropPft || 0), 0) / previousSeven.length
    : 0;
  const deltaVs7d = previousSevenAverage > 0
    ? ((airdropAmount - previousSevenAverage) / previousSevenAverage) * 100
    : null;
  const sparkW = 260;
  const sparkH = 56;
  const maxSpark = Math.max(1, ...totals);
  const sparkPoints = points.map((point, i) => {
    const x = points.length <= 1 ? sparkW : (i / (points.length - 1)) * sparkW;
    const y = sparkH - (Number(point.total || 0) / maxSpark) * sparkH + 2;
    return `${x},${y}`;
  }).join(" ");

  if (loading) {
    return (
      <section style={{ paddingTop: 8 }}>
        <div style={{ fontSize: 13, color: C.ink3, marginBottom: 28 }}>Today's airdrop</div>
        <div className="tn-shimmer" style={{ height: 116, borderRadius: 12 }} />
      </section>
    );
  }

  if (error) {
    return (
      <section style={{ paddingTop: 8 }}>
        <div style={{ fontSize: 13, color: C.ink3, marginBottom: 28 }}>Today's airdrop</div>
        <div style={{ color: C.rust, fontSize: 14 }}>{error}</div>
      </section>
    );
  }

  if (!airdrop) {
    return (
      <section style={{ paddingTop: 8 }}>
        <div style={{ fontSize: 13, color: C.ink3, marginBottom: 28 }}>Today's airdrop</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 56, alignItems: "end", marginBottom: 36 }}>
          <div>
            <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 6 }}>No score generated yet</div>
            <div className="tn-bigNum" style={{ fontSize: 72, lineHeight: 0.95, color: C.ink, marginBottom: 16 }}>
              0<span style={{ fontSize: 24, color: C.ink4, fontWeight: 500, marginLeft: 12, letterSpacing: 0 }}>PFT</span>
            </div>
            <div style={{ fontSize: 13.5, color: C.ink4 }}>
              Run the daily airdrop scorer to populate this account-level panel.
            </div>
          </div>
          <RewardSparkline
            airdropTotal={airdropTotal}
            earnedTotal={earnedTotal}
            points={points}
            rewardTotal={rewardTotal}
            taskCount={taskCount}
          />
        </div>
      </section>
    );
  }

  return (
    <section style={{ paddingTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: C.ink3 }}>
          {airdropTitle}
        </div>
        {hasReasoning && (
          <button
            className="tn-link"
            onClick={() => setReasoningOpen((value) => !value)}
            style={{ background: "transparent", border: 0, padding: 0 }}
            type="button"
          >
            {reasoningOpen ? "Hide reasoning" : "Full reasoning"} →
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 56, alignItems: "flex-end", marginBottom: 36 }}>
        <div>
          <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 6 }}>
            {headlineLabel}
          </div>
          <div className="tn-bigNum" style={{ fontSize: 88, lineHeight: 0.95, color: C.ink, marginBottom: 16 }}>
            {fmtPft(airdropAmount)}<span style={{ fontSize: 24, color: C.ink4, fontWeight: 500, marginLeft: 12, letterSpacing: 0 }}>PFT</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13.5, color: C.ink3, flexWrap: "wrap" }}>
            <span style={{ color: payoutStatusTone, fontWeight: 600 }}>
              {payoutStatusText}
            </span>
            {paidAirdrop?.txHash && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span title={paidAirdrop.txHash}>Tx {paidAirdrop.txHash.slice(0, 10)}...</span>
              </>
            )}
            <span style={{ color: C.ink5 }}>·</span>
            {deltaVs7d !== null && (
              <>
                <span style={{ color: deltaVs7d >= 0 ? C.success : C.rust, fontWeight: 600 }}>
                  {deltaVs7d >= 0 ? "↑" : "↓"} {Math.abs(deltaVs7d).toFixed(0)}% <span style={{ color: C.ink4, fontWeight: 400 }}>vs 7-day avg</span>
                </span>
                <span style={{ color: C.ink5 }}>·</span>
              </>
            )}
            <span>Alignment <strong style={{ color: C.ink, fontWeight: 600 }}>{alignmentPct}</strong><span style={{ color: C.ink5 }}> / 100</span></span>
            {rewardedTasks > 0 && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span>{fmtN(rewardedTasks)} rewarded task{rewardedTasks === 1 ? "" : "s"}</span>
              </>
            )}
          </div>
        </div>

        <RewardSparkline
          airdropCount={airdropCount}
          airdropTotal={airdropTotal}
          earnedTotal={earnedTotal}
          points={points}
          rangeLabel={rewardHistory?.range || "28d"}
          rewardTotal={rewardTotal}
          taskCount={taskCount}
          sparkPoints={sparkPoints}
          sparkW={sparkW}
          sparkH={sparkH}
        />
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        gap: 40, paddingTop: 24, borderTop: `1px solid ${C.ruleSoft}`,
      }}>
        <Reasoning sign="↑" tone={C.success} label="What raised today" body={airdrop.whatRaisedToday || "No positive driver was recorded."} />
        <Reasoning sign="↓" tone={C.warning} label="What kept it lower" body={airdrop.whatKeptItLower || "No limiting factor was recorded."} />
        <Reasoning sign="→" tone={C.rust} label="To improve tomorrow" body={airdrop.toImproveTomorrow || "No next-step recommendation was recorded."} />
      </div>

      {reasoningOpen && (
        <div className="tn-fadeIn" style={{
          borderTop: `1px solid ${C.ruleSoft}`,
          color: C.ink2,
          fontSize: 13.5,
          lineHeight: 1.6,
          marginTop: 24,
          paddingTop: 18,
          maxWidth: 760,
        }}>
          {airdrop.reasoningText}
        </div>
      )}
    </section>
  );
}

function RewardSparkline({
  airdropCount = 0,
  airdropTotal = 0,
  earnedTotal = 0,
  points = [],
  rangeLabel = "28d",
  rewardTotal = 0,
  taskCount = 0,
  sparkPoints = "",
  sparkW = 260,
  sparkH = 56,
}) {
  const nonZero = points.some((point) => Number(point.total || 0) > 0);
  const totals = points.map((point) => Number(point.total || 0));
  const maxSpark = Math.max(1, ...totals);
  const line = sparkPoints || points.map((point, i) => {
    const x = points.length <= 1 ? sparkW : (i / (points.length - 1)) * sparkW;
    const y = sparkH - (Number(point.total || 0) / maxSpark) * sparkH + 2;
    return `${x},${y}`;
  }).join(" ");
  const lastTotal = totals[totals.length - 1] || 0;
  return (
    <div>
      <div className="tn-eyebrow" style={{ marginBottom: 8, textAlign: "right" }}>Last {rangeLabel.replace("d", " days")}</div>
      {nonZero ? (
        <>
          <svg viewBox={`0 0 ${sparkW} ${sparkH + 4}`} width="100%" height={sparkH + 4} style={{ display: "block", overflow: "visible" }}>
            <polyline points={line} fill="none" stroke={C.ink} strokeWidth="1.4" />
            <circle cx={sparkW} cy={sparkH - (lastTotal / maxSpark) * sparkH + 2} r="3.5" fill={C.rust} />
          </svg>
          <div style={{ color: C.ink4, fontSize: 12, marginTop: 8, textAlign: "right" }}>
            {fmtPft(earnedTotal || rewardTotal + airdropTotal)} PFT · {fmtPft(airdropTotal)} airdrops · {fmtPft(rewardTotal)} rewards
            {airdropCount > 0 ? ` · ${fmtN(airdropCount)} airdrop${airdropCount === 1 ? "" : "s"}` : ""}
            {taskCount > 0 ? ` · ${fmtN(taskCount)} task${taskCount === 1 ? "" : "s"}` : ""}
          </div>
        </>
      ) : (
        <div style={{ color: C.ink4, fontSize: 13, lineHeight: 1.5, textAlign: "right" }}>
          No paid task rewards in this range.
        </div>
      )}
    </div>
  );
}

function Reasoning({ sign, tone, label, body }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: "0.14em",
        textTransform: "uppercase", color: tone, marginBottom: 8,
      }}>
        <span style={{ fontSize: 13, marginRight: 4 }}>{sign}</span>{label}
      </div>
      <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

function profileNftStatus(nft = {}) {
  return String(nft?.status || "").trim().toLowerCase();
}

function profileNftIsGenerating(nft = {}) {
  return profileNftStatus(nft) === "generating";
}

function profileNftFailed(nft = {}) {
  return profileNftStatus(nft) === "failed";
}

function profileNftCanBecomeAvatar(nft = {}) {
  const status = profileNftStatus(nft);
  return Boolean(nft?.imageCid || nft?.imageDataUrl || nft?.imageGatewayUrl) &&
    status !== "generating" &&
    status !== "failed";
}

function latestAvatarNft(nfts = []) {
  return (Array.isArray(nfts) ? nfts : []).find(profileNftCanBecomeAvatar) || null;
}

function ProfileStudio({
  accountId = "",
  linkedWalletAddress = "",
  onNftsChange,
  onProfileAvatarChange,
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

  const syncGenerationStateFromNft = (nft = null) => {
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
  };

  const loadNfts = async ({ hydrateLatest = false } = {}) => {
    const result = await requestJson("/api/profile/nfts");
    if (!result.ok) return;
    const nextNfts = Array.isArray(result.body?.nfts) ? result.body.nfts : [];
    if (typeof onNftsChange === "function") onNftsChange(nextNfts);
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(nextNfts));
    const latest = result.body?.latest || nextNfts[0] || null;
    if (hydrateLatest && latest) {
      setGeneratedNft((current) => latest.id === current?.id
        ? { ...latest, imageDataUrl: current?.imageDataUrl }
        : latest);
      syncGenerationStateFromNft(latest);
    }
  };

  useEffect(() => {
    let cancelled = false;
    requestJson("/api/profile/nfts").then((result) => {
      if (cancelled || !result.ok) return;
      const nextNfts = Array.isArray(result.body?.nfts) ? result.body.nfts : [];
      if (typeof onNftsChange === "function") onNftsChange(nextNfts);
      if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(nextNfts));
      if (result.body?.latest) {
        setGeneratedNft((current) => current || result.body.latest);
        syncGenerationStateFromNft(result.body.latest);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onNftsChange, onProfileAvatarChange]);

  useEffect(() => {
    if (!generating) return undefined;
    const interval = window.setInterval(() => {
      loadNfts({ hydrateLatest: true }).catch(() => null);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [generating]);

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
              <a className="tn-link" onClick={(e) => e.preventDefault()} href="#">View in gallery →</a>
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

function PFTTimeseries({ error = "", history, loading = false, onRangeChange, range = "28d" }) {
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

function NFTGallery({ minted = [], allowMockFallback = true, emptyCopy = "No profile NFTs yet." }) {
  const [page, setPage] = useState(0);
  const records = minted.length ? minted : (allowMockFallback ? NFT_DATA : []);
  const mintedCount = records.filter((n) => (n.status || "").toLowerCase() === "minted" || n.rarity).length;
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
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="NFT gallery"
        sub={`${records.length} profile NFTs · ${mintedCount} minted${records.length > NFT_GALLERY_PAGE_SIZE ? ` · showing ${showingStart}-${showingEnd}` : ""}`}
      />

      {records.length > 0 ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32 }}>
            {visibleRecords.map(n => <NFTTile key={n.id} nft={n} />)}
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

function nftStatusLabel(nft = {}) {
  const status = profileNftStatus(nft);
  if (status === "generating") return "Generating";
  if (status === "failed") return "Failed";
  if (status === "prepared") return "Prepared";
  if (status === "minted") return "Minted";
  if (status === "generated") return "Generated";
  return nft.status || "Generated";
}

function nftDateLabel(nft = {}) {
  const status = profileNftStatus(nft);
  if (nft.date) return nft.date;
  if (nft.mintedAt) return fmtDate(new Date(nft.mintedAt));
  if (status === "generating") return "In progress";
  if (status === "failed") return "Needs retry";
  if (nft.generatedAt) return fmtDate(new Date(nft.generatedAt));
  return "Generated";
}

function NFTTile({ nft }) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(nft), [nft]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";
  const hasImageCid = Boolean(String(nft.imageCid || "").trim());
  const status = profileNftStatus(nft);
  const statusLabel = nftStatusLabel(nft);

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
    </div>
  );
}

function connectionLabel(connection = {}) {
  return connection.hiveHandle
    ? `@${String(connection.hiveHandle).replace(/^@+/, "")}`
    : connection.displayName || shortHash(connection.accountId || "", 10, 6) || "Task Node member";
}

function connectionInitials(connection = {}) {
  const label = connection.displayName || connection.hiveHandle || "TN";
  return String(label)
    .replace(/^@+/, "")
    .split(/\s+|[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "TN";
}

function ConnectionAvatar({ connection = {}, size = 48 } = {}) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(connection.heroNft || {}), [connection.heroNft]);
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

function walletExplorerHref(walletAddress = "", explorerBase = "") {
  const address = String(walletAddress || "").trim();
  const base = String(explorerBase || "").trim();
  if (!address || !base) return "";
  if (base.includes("{address}")) return base.replace("{address}", encodeURIComponent(address));
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(address)}`;
}

function ProfilePreviewPanel({ connection = null, error = "", loading = false, onClose, onCopyWallet, pftlExplorerUrl = "", profile = null } = {}) {
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

function recommendationStatusText(status = "", run = null) {
  if (status === "vector_tables_not_ready") return "The recommendation store is not ready yet.";
  if (status === "profile_private") return "Profile hidden. Recommended connections are off while your profile is private.";
  if (status === "failed") return run?.lastError || "Recommendation generation failed.";
  return "No recommendations yet. You need a public profile, a completed Network Diagnostic Report, and other public members to compare against.";
}

function ConnectionRecommendationRow({
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

function ConnectionsCard({ accountId = "", pftlExplorerUrl = "", profilePublic = true } = {}) {
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

function PrivateProfile({
  accountId = "",
  linkedWalletAddress = "",
  onProfileIdentityChange,
  onProfileAvatarChange,
  onWalletUnlock,
  pftlExplorerUrl = "",
  profilePublic = true,
  session = null,
  walletSecret = null,
  walletVault = {},
} = {}) {
  const [profileNfts, setProfileNfts] = useState([]);
  const [airdropState, setAirdropState] = useState({ loading: Boolean(accountId), error: "", latest: null });
  const [rewardRange, setRewardRange] = useState("28d");
  const [rewardHistoryState, setRewardHistoryState] = useState({ loading: Boolean(accountId), error: "", history: null });
  const handleNftsChange = useCallback((nextNfts = []) => {
    setProfileNfts(nextNfts);
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(nextNfts[0] || null);
  }, [onProfileAvatarChange]);

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setAirdropState({ loading: false, error: "", latest: null });
      return () => {
        cancelled = true;
      };
    }
    setAirdropState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/daily-airdrop").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAirdropState({ loading: false, error: "", latest: result.body?.latest || null });
        return;
      }
      setAirdropState({
        loading: false,
        error: result.body?.message || result.body?.error || "Daily airdrop score could not be loaded.",
        latest: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setRewardHistoryState({ loading: false, error: "", history: null });
      return () => {
        cancelled = true;
      };
    }
    setRewardHistoryState((current) => ({ ...current, loading: true, error: "" }));
    requestJson(`/api/profile/reward-history?range=${encodeURIComponent(rewardRange)}`).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setRewardHistoryState({ loading: false, error: "", history: result.body?.history || null });
        return;
      }
      setRewardHistoryState({
        loading: false,
        error: result.body?.message || result.body?.error || "Task reward history could not be loaded.",
        history: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, rewardRange]);

  return (
    <div>
      <TodaysBriefing
        airdrop={airdropState.latest}
        error={airdropState.error}
        loading={airdropState.loading}
        rewardHistory={rewardHistoryState.history}
      />
      <ProfileIdentityCard
        onProfileIdentityChange={onProfileIdentityChange}
        session={session}
      />
      <ProfileStudio
        accountId={accountId}
        linkedWalletAddress={linkedWalletAddress}
        onNftsChange={handleNftsChange}
        onProfileAvatarChange={onProfileAvatarChange}
        onWalletUnlock={onWalletUnlock}
        walletSecret={walletSecret}
        walletVault={walletVault}
      />
      <PFTTimeseries
        error={rewardHistoryState.error}
        history={rewardHistoryState.history}
        loading={rewardHistoryState.loading}
        onRangeChange={setRewardRange}
        range={rewardRange}
      />
      <NFTGallery minted={profileNfts.length ? profileNfts : NFT_DATA} />
      <ConnectionsCard accountId={accountId} pftlExplorerUrl={pftlExplorerUrl} profilePublic={profilePublic} />
    </div>
  );
}

export function ProfileView({
  accountId = "",
  linkedWalletAddress = "",
  onProfileIdentityChange,
  onProfileAvatarChange,
  onWalletUnlock,
  pftlExplorerUrl = "",
  profilePublic = true,
  profileTab = "private",
  session = null,
  setProfilePublic,
  setProfileTab,
  walletSecret = null,
  walletVault = {},
} = {}) {
  useStylesheet();
  const [localView, setLocalView] = useState(profileTab === "public" ? "public" : "private");
  const [visibilityState, setVisibilityState] = useState({
    error: "",
    loading: Boolean(accountId),
    saving: false,
    visibility: profilePublic ? "public" : "private",
  });
  const controlledView = typeof setProfileTab === "function";
  const view = controlledView ? (profileTab === "public" ? "public" : "private") : localView;
  const setView = (nextView) => {
    if (controlledView) {
      setProfileTab(nextView);
      return;
    }
    setLocalView(nextView);
  };
  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setVisibilityState({
        error: "",
        loading: false,
        saving: false,
        visibility: profilePublic ? "public" : "private",
      });
      return () => {
        cancelled = true;
      };
    }
    setVisibilityState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/visibility").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        const visibility = result.body?.visibility?.visibility === "private" ? "private" : "public";
        setVisibilityState({ error: "", loading: false, saving: false, visibility });
        if (typeof setProfilePublic === "function") setProfilePublic(visibility !== "private");
        return;
      }
      setVisibilityState((current) => ({
        ...current,
        error: result.body?.message || result.body?.error || "Profile visibility could not be loaded.",
        loading: false,
        saving: false,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, profilePublic, setProfilePublic]);
  const effectiveProfilePublic = visibilityState.visibility !== "private";
  const togglePublic = async () => {
    if (!accountId || visibilityState.saving) return;
    const nextVisibility = effectiveProfilePublic ? "private" : "public";
    setVisibilityState((current) => ({
      ...current,
      error: "",
      saving: true,
      visibility: nextVisibility,
    }));
    const result = await requestJson("/api/profile/visibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: nextVisibility }),
    });
    if (result.ok && result.body?.ok !== false) {
      const visibility = result.body?.visibility?.visibility === "private" ? "private" : "public";
      setVisibilityState({ error: "", loading: false, saving: false, visibility });
      if (typeof setProfilePublic === "function") setProfilePublic(visibility !== "private");
      return;
    }
    const previousVisibility = nextVisibility === "private" ? "public" : "private";
    setVisibilityState({
      error: result.body?.message || result.body?.error || "Profile visibility could not be saved.",
      loading: false,
      saving: false,
      visibility: previousVisibility,
    });
    if (typeof setProfilePublic === "function") setProfilePublic(previousVisibility !== "private");
  };

  return (
    <div className="route-scroll">
      <div className="tn-root" style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "40px 36px 140px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <button
              className={`tn-tab ${view === "private" ? "tn-tab-active" : ""}`}
              onClick={() => setView("private")}
            >Private</button>
            <button
              className={`tn-tab ${view === "public" ? "tn-tab-active" : ""}`}
              onClick={() => setView("public")}
            >Public</button>
          </div>

          <button
            onClick={togglePublic}
            disabled={!accountId || visibilityState.saving || visibilityState.loading}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              color: effectiveProfilePublic ? C.success : C.ink4,
              cursor: !accountId || visibilityState.saving || visibilityState.loading ? "default" : "pointer",
              display: "inline-flex",
              fontFamily: SANS,
              fontSize: 13,
              fontWeight: 500,
              gap: 7,
              padding: 0,
            }}
            type="button"
          >
            <span
              className="tn-pulseGreen"
              style={{ background: effectiveProfilePublic ? C.success : C.ink5 }}
            />
            {visibilityState.saving ? "Saving..." : effectiveProfilePublic ? "Profile public" : "Profile hidden"}
          </button>
        </div>
        {visibilityState.error && (
          <div style={{ color: C.rust, fontSize: 12.5, marginBottom: 12, textAlign: "right" }}>
            {visibilityState.error}
          </div>
        )}

        <div className="tn-fadeIn" key={view}>
          {view === "private" ? (
            <PrivateProfile
              accountId={accountId}
              linkedWalletAddress={linkedWalletAddress}
              onProfileIdentityChange={onProfileIdentityChange}
              onProfileAvatarChange={onProfileAvatarChange}
              onWalletUnlock={onWalletUnlock}
              pftlExplorerUrl={pftlExplorerUrl}
              profilePublic={effectiveProfilePublic}
              session={session}
              walletSecret={walletSecret}
              walletVault={walletVault}
            />
          ) : (
            <PublicProfile accountId={accountId} profilePublic={effectiveProfilePublic} />
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

export default ProfileView;

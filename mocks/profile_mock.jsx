import React, { useState, useEffect, useRef, useMemo } from "react";

/* =====================================================================
   PALETTE
===================================================================== */
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

const fmtN = n => n.toLocaleString("en-US");
const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

/* =====================================================================
   STYLESHEET — drastically reduced
===================================================================== */
function useStylesheet() {
  useEffect(() => {
    const id = "tasknode-profile-styles";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);

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

/* =====================================================================
   SHARED — Section header (eyebrow + hairline)
===================================================================== */
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

/* =====================================================================
   DATA — chart series
===================================================================== */
function generateRewardsData() {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const out = [];
  const today = new Date(2026, 4, 20);
  for (let i = 0; i < 28; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - (27 - i));
    if (i === 27) { out.push({ date, personal: 4200, network: 3300, alpha: 900 }); continue; }
    const wave = (Math.sin(i * 0.65) + 1) * 0.5;
    const base = 110 + wave * 240 * (0.5 + rand() * 0.6);
    out.push({
      date,
      personal: Math.round(base * (1.25 + rand() * 0.45)),
      network: Math.round(base * (1.55 + rand() * 0.55)),
      alpha: i > 18 ? Math.round(base * (0.15 + rand() * 0.35)) : 0,
    });
  }
  return out;
}

const NFT_DATA = [
  { id: "n1", title: "Network Reliability Engineer", date: "May 13, 2026", kind: "topology", palette: "green", rarity: "Common" },
  { id: "n2", title: "NFT 2026-05-12",               date: "May 12, 2026", kind: "circuit",  palette: "gray",  rarity: "Common" },
  { id: "n3", title: "Alpha Brief Analyst",          date: "May 7, 2026",  kind: "sunburst", palette: "gold",  rarity: "Uncommon" },
  { id: "n4", title: "Alpha Brief Analyst",          date: "May 7, 2026",  kind: "flow",     palette: "blue",  rarity: "Uncommon" },
];

/* =====================================================================
   NFT PROCEDURAL ART — unchanged
===================================================================== */
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

/* =====================================================================
   REWARDS CHART — gridlines gone, direct labels added
===================================================================== */
function RewardsChart({ data }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);

  const W = 760, H = 240;
  const padL = 8, padR = 76, padT = 28, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const totals = data.map(d => d.personal + d.network + d.alpha);
  const maxY = Math.max(...totals) * 1.06;
  const x = i => padL + (i / (data.length - 1)) * innerW;
  const y = v => padT + innerH - (v / maxY) * innerH;

  const buildArea = key => {
    const top = data.map((d, i) => {
      const cum =
        (key === "personal" ? d.personal :
         key === "network"  ? d.personal + d.network :
                              d.personal + d.network + d.alpha);
      return [x(i), y(cum)];
    });
    const bot = data.map((d, i) => {
      const cum =
        (key === "personal" ? 0 :
         key === "network"  ? d.personal :
                              d.personal + d.network);
      return [x(i), y(cum)];
    }).reverse();
    const all = [...top, ...bot];
    return "M " + all.map(p => p.join(" ")).join(" L ") + " Z";
  };

  const ticks = data.map((d, i) => ({ i, d })).filter(({ i }) => i % 7 === 0 || i === data.length - 1);

  const lastIdx = data.length - 1;
  const lastP = data[lastIdx].personal;
  const lastPN = lastP + data[lastIdx].network;
  const lastPNA = lastPN + data[lastIdx].alpha;

  const handleMove = (e) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < padL || px > padL + innerW) { setHover(null); return; }
    const rel = (px - padL) / innerW;
    const idx = Math.round(rel * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, idx)));
  };
  const handleLeave = () => setHover(null);

  return (
    <div style={{ position: "relative" }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%"
        style={{ display: "block", overflow: "visible" }}
        onMouseMove={handleMove} onMouseLeave={handleLeave}>
        <defs>
          <linearGradient id="grad-personal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={C.layerPersonal} stopOpacity="0.22" />
            <stop offset="100%" stopColor={C.layerPersonal} stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id="grad-network" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={C.layerNetwork} stopOpacity="0.28" />
            <stop offset="100%" stopColor={C.layerNetwork} stopOpacity="0.10" />
          </linearGradient>
          <linearGradient id="grad-alpha" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={C.layerAlpha} stopOpacity="0.38" />
            <stop offset="100%" stopColor={C.layerAlpha} stopOpacity="0.12" />
          </linearGradient>
        </defs>

        {/* baseline only — no gridlines */}
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={C.rule} strokeWidth="0.8" />

        {/* areas */}
        <path d={buildArea("personal")} fill="url(#grad-personal)" />
        <path d={buildArea("network")}  fill="url(#grad-network)"  />
        <path d={buildArea("alpha")}    fill="url(#grad-alpha)"    />

        {/* top line — the total — the headline data */}
        <path
          d={"M " + data.map((d, i) => `${x(i)} ${y(d.personal + d.network + d.alpha)}`).join(" L ")}
          fill="none" stroke={C.ink} strokeWidth="1.3"
        />

        {/* faint layer separators */}
        <path
          d={"M " + data.map((d, i) => `${x(i)} ${y(d.personal + d.network)}`).join(" L ")}
          fill="none" stroke={C.layerNetwork} strokeWidth="0.6" strokeOpacity="0.5"
        />
        <path
          d={"M " + data.map((d, i) => `${x(i)} ${y(d.personal)}`).join(" L ")}
          fill="none" stroke={C.layerPersonal} strokeWidth="0.6" strokeOpacity="0.5"
        />

        {/* direct labels at right edge — replaces a legend */}
        <text x={x(lastIdx) + 8} y={y(lastP / 2) + 3} fontSize="10.5" fill={C.layerPersonal} fontWeight="600">Personal</text>
        <text x={x(lastIdx) + 8} y={y(lastP + (lastPN - lastP) / 2) + 3} fontSize="10.5" fill={C.layerNetwork} fontWeight="600">Network</text>
        <text x={x(lastIdx) + 8} y={y(lastPN + (lastPNA - lastPN) / 2) + 3} fontSize="10.5" fill={C.layerAlpha} fontWeight="600">Alpha</text>

        {/* today annotation */}
        <circle cx={x(lastIdx)} cy={y(lastPNA)} r="4" fill={C.paper3} stroke={C.ink} strokeWidth="1.5" />
        <text x={x(lastIdx)} y={y(lastPNA) - 12} fontSize="10" fill={C.ink2}
          textAnchor="end" fontWeight="600" letterSpacing="0.05em">
          TODAY · 8,400
        </text>

        {/* max value label, top-right, very subtle */}
        <text x={x(lastIdx)} y={padT - 6} fontSize="9.5" fill={C.ink5}
          textAnchor="end" fontFamily={MONO}>
          peak {Math.round(maxY / 100) / 10}k
        </text>

        {/* date labels */}
        {ticks.map(({ i, d }) => (
          <text key={i} x={x(i)} y={H - 6} fontSize="10" fill={C.ink4}
            textAnchor="middle" fontFamily={MONO}>
            {fmtDate(d.date)}
          </text>
        ))}

        {/* hover guideline */}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB}
              stroke={C.ink} strokeOpacity="0.18" />
            <circle cx={x(hover)}
              cy={y(data[hover].personal + data[hover].network + data[hover].alpha)}
              r="3" fill={C.ink} />
          </g>
        )}
      </svg>

      {/* tooltip — no card, just monospaced figures */}
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
            {fmtDate(data[hover].date)}{hover === data.length - 1 ? " · today" : ""}
          </div>
          <div style={{ color: C.layerAlpha    }}>A {fmtN(data[hover].alpha).padStart(6, " ")}</div>
          <div style={{ color: C.layerNetwork  }}>N {fmtN(data[hover].network).padStart(6, " ")}</div>
          <div style={{ color: C.layerPersonal }}>P {fmtN(data[hover].personal).padStart(6, " ")}</div>
          <div style={{ borderTop: `1px solid ${C.ruleSoft}`, marginTop: 4, paddingTop: 4, color: C.ink, fontWeight: 600 }}>
            ∑ {fmtN(data[hover].personal + data[hover].network + data[hover].alpha)}
          </div>
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   MINT FLOW
===================================================================== */
const MINT_STEPS = [
  { id: "prep",    label: "Preparing transaction",  pct: 18 },
  { id: "sign",    label: "Requesting signature",    pct: 38 },
  { id: "broad",   label: "Broadcasting to network", pct: 62 },
  { id: "confirm", label: "Confirming on ledger",    pct: 88 },
  { id: "done",    label: "Minted",                  pct: 100 },
];

function useMintFlow() {
  const [phase, setPhase] = useState("idle");
  const [stepIdx, setStepIdx] = useState(0);
  const timers = useRef([]);

  const start = () => {
    if (phase !== "idle") return;
    setPhase("minting");
    setStepIdx(0);
    const delays = [700, 900, 900, 900];
    let cum = 0;
    delays.forEach((d, i) => {
      cum += d;
      timers.current.push(setTimeout(() => setStepIdx(i + 1), cum));
    });
    timers.current.push(setTimeout(() => setPhase("success"), cum + 500));
  };
  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase("idle");
    setStepIdx(0);
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { phase, stepIdx, start, reset, currentStep: MINT_STEPS[stepIdx] };
}

/* =====================================================================
   TODAY'S BRIEFING — the hero
===================================================================== */
function TodaysBriefing({ data }) {
  const last = data[data.length - 1];
  const lastTotal = last.personal + last.network + last.alpha;
  const avg7 = data.slice(-8, -1).reduce((s, d) => s + d.personal + d.network + d.alpha, 0) / 7;
  const delta = ((lastTotal - avg7) / avg7) * 100;

  const sparkW = 260, sparkH = 56;
  const totals = data.map(d => d.personal + d.network + d.alpha);
  const max = Math.max(...totals);
  const points = totals.map((t, i) => {
    const x = (i / (totals.length - 1)) * sparkW;
    const y = sparkH - (t / max) * sparkH + 2;
    return `${x},${y}`;
  }).join(" ");

  return (
    <section style={{ paddingTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: C.ink3 }}>
          Today's airdrop · Wed, May 20, 2026
        </div>
        <a href="#" className="tn-link" onClick={(e) => e.preventDefault()}>Full reasoning →</a>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 56, alignItems: "flex-end", marginBottom: 36 }}>
        <div>
          <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 6 }}>The network paid you</div>
          <div className="tn-bigNum" style={{ fontSize: 88, lineHeight: 0.95, color: C.ink, marginBottom: 16 }}>
            8,400<span style={{ fontSize: 24, color: C.ink4, fontWeight: 500, marginLeft: 12, letterSpacing: 0 }}>PFT</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13.5, color: C.ink3, flexWrap: "wrap" }}>
            <span style={{ color: C.success, fontWeight: 600 }}>
              ↑ {delta.toFixed(0)}% <span style={{ color: C.ink4, fontWeight: 400 }}>vs 7-day avg</span>
            </span>
            <span style={{ color: C.ink5 }}>·</span>
            <span>Alignment <strong style={{ color: C.ink, fontWeight: 600 }}>84</strong>
              <span style={{ color: C.ink5 }}> / 100</span></span>
            <span style={{ color: C.ink5 }}>·</span>
            <span style={{ color: C.warning, fontWeight: 500 }}>High retention</span>
          </div>
          <div style={{ marginTop: 14, fontSize: 12.5, color: C.ink4, lineHeight: 1.55, maxWidth: 480 }}>
            <span style={{ color: C.ink3, fontWeight: 500 }}>Alignment</span> is the share of your tier's max daily airdrop you captured today — 8,400 of a possible 10,000 PFT.
          </div>
        </div>

        <div>
          <div className="tn-eyebrow" style={{ marginBottom: 8, textAlign: "right" }}>Last 28 days</div>
          <svg viewBox={`0 0 ${sparkW} ${sparkH + 4}`} width="100%" height={sparkH + 4} style={{ display: "block", overflow: "visible" }}>
            <polyline points={points} fill="none" stroke={C.ink} strokeWidth="1.4" />
            <circle cx={sparkW} cy={sparkH - (totals[totals.length - 1] / max) * sparkH + 2} r="3.5" fill={C.rust} />
          </svg>
        </div>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        gap: 40, paddingTop: 24, borderTop: `1px solid ${C.ruleSoft}`,
      }}>
        <Reasoning sign="↑" tone={C.success} label="What raised today"
          body="Shipping core network fixes and automation around rewards and NFT generation." />
        <Reasoning sign="↓" tone={C.warning} label="What kept it lower"
          body="Recent activity skews toward product stabilization rather than measured network growth." />
        <Reasoning sign="→" tone={C.rust} label="To improve tomorrow"
          body="Tie shipped fixes to visible user adoption and repeatable network growth loops." />
      </div>
    </section>
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

/* =====================================================================
   PROFILE STUDIO
===================================================================== */
function ProfileStudio() {
  const flow = useMintFlow();
  const [seed, setSeed] = useState(0);
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

  const regenerate = () => { if (flow.phase === "idle") setSeed(s => s + 1); };

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="Profile Studio · today's identity"
        sub="Generated from your last 28 days of network behavior"
      />

      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 32, alignItems: "center" }}>
        <div className={flow.phase === "success" ? "tn-glow" : ""}
          style={{ borderRadius: 12, overflow: "hidden", position: "relative" }}>
          <NFTArt kind={kind} palette={palette} size={180} />
          {flow.phase === "minting" && (
            <div style={{
              position: "absolute", inset: 0,
              background: "rgba(31,27,22,.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 12,
            }}>
              <div className="tn-shimmer" style={{ width: 42, height: 42, borderRadius: 10, opacity: 0.85 }} />
            </div>
          )}
          {flow.phase === "success" && (
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
            {title}
          </h3>
          <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 20, maxWidth: 480 }}>
            Mint it as today's identity, or reroll. One free mint per day.
          </div>

          {flow.phase === "idle" && (
            <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
              <button className="tn-btn" onClick={regenerate} type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-3.4-7.04" /><path d="M21 4v6h-6" />
                </svg>
                Regenerate
              </button>
              <button className="tn-btn-primary" onClick={flow.start} type="button"
                style={{ border: "none", cursor: "pointer", fontFamily: SANS, fontSize: 13.5, fontWeight: 500 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 6, verticalAlign: -1 }}>
                  <path d="M12 2L14.5 9 22 9.5 16 14 18 22 12 18 6 22 8 14 2 9.5 9.5 9z" />
                </svg>
                Mint as NFT
              </button>
            </div>
          )}

          {flow.phase === "minting" && (
            <div className="tn-fadeIn" style={{ maxWidth: 360 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13.5, color: C.ink2, fontWeight: 500 }}>{flow.currentStep.label}…</span>
                <span className="tn-mono" style={{ fontSize: 11, color: C.ink4 }}>{flow.currentStep.pct}%</span>
              </div>
              <div className="tn-progressLine">
                <span style={{ width: `${flow.currentStep.pct}%` }} />
              </div>
            </div>
          )}

          {flow.phase === "success" && (
            <div className="tn-fadeIn" style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <span style={{ color: C.success, fontWeight: 600, fontSize: 13.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Minted on-chain
              </span>
              <a className="tn-link" onClick={(e) => e.preventDefault()} href="#">View in gallery →</a>
              <button className="tn-btn" onClick={flow.reset} style={{ marginLeft: "auto" }}>Mint another</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* =====================================================================
   PFT TIMESERIES
===================================================================== */
function PFTTimeseries({ data }) {
  const totals = data.reduce(
    (acc, d) => ({
      personal: acc.personal + d.personal,
      network: acc.network + d.network,
      alpha: acc.alpha + d.alpha,
    }),
    { personal: 0, network: 0, alpha: 0 }
  );
  const grand = totals.personal + totals.network + totals.alpha;
  const [range, setRange] = useState("28d");

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="PFT generation"
        sub={
          <span>
            <span className="tn-bigNum" style={{ fontSize: 18, color: C.ink, letterSpacing: "-0.01em" }}>{fmtN(grand)}</span>
            <span style={{ color: C.ink4, marginLeft: 6 }}>PFT in the last 28 days</span>
          </span>
        }
        action={
          <div>
            {["28d", "90d", "All"].map(p => (
              <button key={p} className={`tn-tab ${range === p ? "tn-tab-active" : ""}`}
                onClick={() => setRange(p)} style={{ fontSize: 12.5, marginRight: 16 }}>
                {p}
              </button>
            ))}
          </div>
        }
      />

      <RewardsChart data={data} />
    </section>
  );
}

/* =====================================================================
   NFT GALLERY — no card around each tile
===================================================================== */
function NFTGallery({ minted = NFT_DATA }) {
  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="NFT gallery"
        sub={`${minted.length} minted · ${minted.filter(n => n.rarity !== "Common").length} uncommon`}
        action={<a className="tn-link" onClick={(e) => e.preventDefault()} href="#">View all →</a>}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32 }}>
        {minted.map(n => (
          <div key={n.id} className="tn-lift" style={{ cursor: "pointer" }}>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <NFTArt kind={n.kind} palette={n.palette} size="100%" />
            </div>
            <div style={{
              fontSize: 13.5, fontWeight: 600, color: C.ink,
              letterSpacing: "-0.005em",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {n.title}
            </div>
            <div style={{ fontSize: 11.5, color: C.ink4, marginTop: 3, display: "flex", gap: 8 }}>
              <span>{n.date}</span>
              <span style={{ color: C.ink5 }}>·</span>
              <span style={{ color: n.rarity === "Common" ? C.ink4 : C.warning }}>{n.rarity}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =====================================================================
   CONNECTIONS — rows, hairlines, no cards
===================================================================== */
const CONNECTIONS = [
  {
    addr: "rDVKRN...tyjB", match: 95, palette: "green", kind: "topology",
    body: "Strong synergy between your deterministic reward composers and their deterministic task-generation parser and verification policy fixes.",
    tags: ["Task-generation parser", "Verification policy", "DB-backed constraints"],
  },
  {
    addr: "rDep8S...EQKu", match: 88, palette: "gold", kind: "sunburst",
    body: "Direct alignment in building deterministic Python reducers and handling task-generation logic with regression-style scoring.",
    tags: ["Python reducers", "Dependency-light validators", "Prompt escaping"],
  },
  {
    addr: "rGu432...Dcw9", match: 85, palette: "blue", kind: "flow",
    body: "Overlap in deterministic tools and verification workflows with CLI-first JSON scoring and auditable triage.",
    tags: ["CLI JSON scoring", "Triage packet design", "Sim engineering"],
  },
];

function ConnectionsCard() {
  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="Recommended connections"
        sub="Members whose work overlaps yours this week"
      />

      <div>
        {CONNECTIONS.map((c, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "48px 1fr auto",
            gap: 20, alignItems: "flex-start",
            padding: "20px 0",
            borderTop: i === 0 ? "none" : `1px solid ${C.ruleSoft}`,
          }}>
            <div style={{ borderRadius: 10, overflow: "hidden" }}>
              <NFTArt kind={c.kind} palette={c.palette} size={48} />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <span className="tn-mono" style={{ fontSize: 13.5, fontWeight: 500, color: C.ink }}>{c.addr}</span>
                <span style={{ fontSize: 11.5, color: C.ink4 }}>active 2h ago</span>
              </div>
              <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.55, marginBottom: 8, maxWidth: 620 }}>
                {c.body}
              </div>
              <div style={{ fontSize: 12, color: C.ink4 }}>
                {c.tags.map((t, j) => (
                  <span key={t}>
                    {t}{j < c.tags.length - 1 && <span style={{ margin: "0 8px", color: C.ink5 }}>·</span>}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <MatchScore pct={c.match} />
              <button className="tn-btn" style={{ fontSize: 13 }}>Connect →</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MatchScore({ pct }) {
  const tone = pct >= 90 ? C.success : pct >= 80 ? C.warning : C.ink4;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
      <span className="tn-bigNum" style={{ fontSize: 22, color: tone, lineHeight: 1 }}>{pct}</span>
      <span style={{ fontSize: 11, color: C.ink4 }}>%</span>
    </div>
  );
}

/* =====================================================================
   IDENTITY HERO — public
===================================================================== */
function IdentityHero() {
  return (
    <section style={{ paddingTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 32, alignItems: "center" }}>
        <div style={{ borderRadius: 14, overflow: "hidden" }}>
          <NFTArt kind="topology" palette="green" size={120} />
        </div>

        <div>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Wallet</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span className="tn-mono" style={{ fontSize: 18, fontWeight: 500, color: C.ink, letterSpacing: "-0.005em" }}>
              rPo8GkCA9YMKzuJGTHbj11kdVfPq5JHxNx
            </span>
            <button className="tn-btn" style={{ padding: 4 }} title="Copy address">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13, color: C.ink3 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: C.success, fontWeight: 500 }}>
              <span className="tn-pulseGreen" />
              Active 18 min ago
            </span>
            <span style={{ color: C.ink5 }}>·</span>
            <span>Member since Jan 2026</span>
            <span style={{ color: C.ink5 }}>·</span>
            <span>28 connections</span>
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Total lifetime</div>
          <div className="tn-bigNum" style={{ fontSize: 42, color: C.ink, lineHeight: 1 }}>552,308</div>
          <div style={{ fontSize: 13, color: C.ink4, marginTop: 4 }}>PFT earned</div>
        </div>
      </div>
    </section>
  );
}

/* =====================================================================
   NETWORK ROLE — machine-generated "who is this person" read
===================================================================== */
function NetworkRole() {
  const skills = [
    "Backend systems",
    "Deterministic tooling",
    "CLI-first scoring",
    "Verification policy",
    "Python reducers",
    "Ledger ops",
  ];
  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="Network role · machine-read"
        sub="Inferred from on-ledger activity, task history, and connection graph"
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 40, alignItems: "flex-start" }}>
        <div>
          <h3 style={{
            margin: "0 0 10px", fontSize: 22, fontWeight: 600,
            letterSpacing: "-0.015em", color: C.ink,
          }}>
            Network Verification Engineer
          </h3>
          <div style={{ fontSize: 14.5, color: C.ink2, lineHeight: 1.6, maxWidth: 640, marginBottom: 14 }}>
            Builds deterministic reward composers and verification tooling for the Task Node loop.
            Strong on CLI-first scoring, auditable triage, and reducer pipelines.
            Most useful to backend engineers, ledger-ops folks, and anyone building validation tools.
          </div>
          <div style={{ fontSize: 12.5, color: C.ink4 }}>
            {skills.map((s, i) => (
              <span key={s}>
                {s}{i < skills.length - 1 && <span style={{ margin: "0 8px", color: C.ink5 }}>·</span>}
              </span>
            ))}
          </div>
        </div>

        <div style={{ textAlign: "right", minWidth: 140 }}>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Archetype</div>
          <div style={{ fontSize: 13.5, color: C.ink2, fontWeight: 500 }}>Builder</div>
          <div style={{ fontSize: 12.5, color: C.ink4, marginTop: 2 }}>not Validator · not Curator</div>
        </div>
      </div>
    </section>
  );
}

/* =====================================================================
   CREDENTIAL TRIO — columns, no cards
===================================================================== */
function CredentialTrio() {
  const items = [
    { label: "Sybil score",       score: "88", max: "100", status: "Low risk",          tone: C.success, sub: "Strong signals of authentic activity" },
    { label: "Alignment score",   score: "86", max: "100", status: "Active contributor", tone: C.success, sub: "Shipping aligned with network goals" },
    { label: "Contribution tier", score: "T2", max: "T4",  status: "Top 18%",            tone: C.warning, sub: "5 tasks completed this month" },
  ];
  return (
    <section style={{ paddingTop: 64 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 48,
        paddingTop: 22, borderTop: `1px solid ${C.ruleSoft}` }}>
        {items.map((it, i) => (
          <div key={i} style={{
            paddingLeft: i === 0 ? 0 : 0,
          }}>
            <div className="tn-eyebrow">{it.label}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
              <span className="tn-bigNum" style={{ fontSize: 42, color: C.ink, lineHeight: 1 }}>{it.score}</span>
              <span style={{ fontSize: 14, color: C.ink5, fontWeight: 500 }}>/ {it.max}</span>
            </div>
            <div style={{ fontSize: 13, color: it.tone, fontWeight: 500, marginTop: 10 }}>{it.status}</div>
            <div style={{ fontSize: 12.5, color: C.ink3, marginTop: 6, lineHeight: 1.45 }}>{it.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =====================================================================
   ABOUT
===================================================================== */
function AboutCard() {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState("");

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="About"
        sub="How you'd introduce yourself to a collaborator"
        action={
          <button className="tn-btn" onClick={() => setEdit(e => !e)} style={{ fontSize: 13 }}>
            {edit ? "Save" : "Edit"}
          </button>
        }
      />

      {edit ? (
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="I work on deterministic reward composers for the Task Node loop. I focus on auditable triage and CLI-first scoring tools…"
          style={{
            width: "100%", minHeight: 80,
            padding: "12px 0",
            border: "none", borderBottom: `1px solid ${C.rule}`,
            background: "transparent", color: C.ink, fontSize: 15,
            fontFamily: SANS, resize: "vertical", outline: "none",
            lineHeight: 1.55,
          }}
          autoFocus
        />
      ) : (
        <div style={{ fontSize: 15, color: text ? C.ink2 : C.ink4, lineHeight: 1.6, maxWidth: 700 }}>
          {text || "Not specified yet — click edit to add a short bio."}
        </div>
      )}
    </section>
  );
}


/* =====================================================================
   PAGES
===================================================================== */
function PrivateProfile() {
  const data = useMemo(generateRewardsData, []);
  return (
    <div>
      <TodaysBriefing data={data} />
      <ProfileStudio />
      <PFTTimeseries data={data} />
      <NFTGallery />
      <ConnectionsCard />
    </div>
  );
}

function PublicProfile() {
  return (
    <div>
      <IdentityHero />
      <NetworkRole />
      <CredentialTrio />
      <AboutCard />
      <NFTGallery />
    </div>
  );
}

/* =====================================================================
   APP
===================================================================== */
export default function App() {
  useStylesheet();
  const [view, setView] = useState("private");

  return (
    <div className="tn-root" style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "40px 36px 140px" }}>
        {/* top bar — text tabs, status as inline text */}
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

          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: C.success, fontSize: 13, fontWeight: 500 }}>
            <span className="tn-pulseGreen" />
            Profile public
          </span>
        </div>

        <div className="tn-fadeIn" key={view}>
          {view === "private" ? <PrivateProfile /> : <PublicProfile />}
        </div>
      </div>
    </div>
  );
}
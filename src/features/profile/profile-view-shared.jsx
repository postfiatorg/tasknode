import { useEffect } from "react";
import { Bug, Crown, GitPullRequest, GraduationCap, Megaphone } from "lucide-react";

export const C = {
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

export const SANS = "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const fmtN = (n, options = {}) => Number(n || 0).toLocaleString("en-US", options);
export const fmtPft = (n) => fmtN(n, { maximumFractionDigits: Number(n || 0) % 1 === 0 ? 0 : 2 });
export const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const fmtDateLabel = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
export const dateKeyUtc = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};
export const fmtDateTime = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
export const NFT_GALLERY_PAGE_SIZE = 10;
export const NFT_GALLERY_LIMIT = 240;
export const identityApprovalBadges = [
  {
    id: "kol",
    label: "KOL",
    icon: Megaphone,
    maxPayout: "20K per X post / 50K per article",
    lane: "Amplification",
    requirements: [
      { id: "x_link", label: "X linked", provider: "x" },
      { id: "x_metrics", label: "X follower count passes threshold", metric: "followersCount", metricProvider: "x", min: 5000 },
    ],
  },
  {
    id: "core_contributor",
    label: "Core Contributor",
    icon: GitPullRequest,
    maxPayout: "30K per task",
    lane: "Core repo work",
    requirements: [
      { id: "github_link", label: "GitHub linked", provider: "github" },
      { id: "github_handle", label: "Sanctioned GitHub handle", provider: "github", coreContributor: "sanctioned" },
      { id: "core_scope", label: "Core Contributor scope recorded", provider: "github", coreContributorScope: true },
    ],
  },
  {
    id: "expert",
    label: "Expert",
    icon: GraduationCap,
    maxPayout: "30K per 5-task bundle",
    lane: "Domain expertise",
    requirements: [
      { id: "personal_task_count", label: "20 completed Personal tasks", personalTaskCount: 20 },
      { id: "expert_topic", label: "Expert topic supplied", expertTopic: true },
      { id: "expert_score", label: "GLM 5.2 expertise score passes threshold", expertScore: 80 },
    ],
  },
  {
    id: "project_leader",
    label: "Project Leader",
    icon: Crown,
    maxPayout: "Discretionary",
    lane: "Special projects",
    requirements: [
      { id: "project_leader_discretionary", label: "Manual Project Leader grant", projectLeader: true },
    ],
  },
  {
    id: "qa_worker",
    label: "QA Worker",
    icon: Bug,
    maxPayout: "5K per QA report",
    lane: "Product QA",
    requirements: [
      { id: "telegram_link", label: "Telegram linked", provider: "telegram" },
      { id: "discord_link", label: "Discord linked", provider: "discord" },
      { id: "usdc_chat_topup", label: "USDC chat wallet top-up recorded", qaTopUp: "usdc" },
    ],
  },
];
export const shortHash = (value = "", head = 8, tail = 6) => {
  const text = String(value || "");
  return text.length > head + tail + 3 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
};

export function useStylesheet() {
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
export function SectionHead({ eyebrow, sub, action }) {
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

import React, { useState } from "react";

/* ————————————————————————————————————————————————
   Task Node — Docs (pfdocs)
   Wallet-linked CryptPad fork. Matches Task Node UI language:
   cream ground, hairline card borders, green status accents,
   amber lock pills, mono address strings, dot-separated meta.
   ———————————————————————————————————————————————— */

const T = {
  bg: "#F7F5EF",
  card: "#FFFFFF",
  line: "#E7E3D8",
  lineSoft: "#EEEBE1",
  ink: "#20261F",
  inkSoft: "#6E7268",
  inkFaint: "#9A9D92",
  green: "#3E7B52",
  greenBg: "#EBF2EC",
  greenLine: "#CFE0D3",
  amber: "#8F6E1E",
  amberBg: "#F6EDD2",
  monoBg: "#EFEDE3",
  sans: "'Inter','Helvetica Neue',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  mono: "'SF Mono',ui-monospace,'JetBrains Mono',Menlo,monospace",
};

const Dot = () => (
  <span style={{ color: T.inkFaint, margin: "0 8px", fontSize: 12 }}>·</span>
);

const Mono = ({ children }) => (
  <span
    style={{
      fontFamily: T.mono,
      fontSize: 12.5,
      color: T.inkSoft,
      background: T.monoBg,
      padding: "2px 7px",
      borderRadius: 6,
    }}
  >
    {children}
  </span>
);

const LockPill = ({ label = "Encrypted" }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      alignSelf: "center",
      flexShrink: 0,
      whiteSpace: "nowrap",
      lineHeight: 1.4,
      gap: 5,
      fontSize: 11.5,
      fontWeight: 600,
      color: T.amber,
      background: T.amberBg,
      padding: "3px 10px",
      borderRadius: 999,
      letterSpacing: 0.2,
    }}
  >
    <svg width="10" height="11" viewBox="0 0 10 11" fill="none">
      <rect x="1" y="4.5" width="8" height="6" rx="1.5" fill={T.amber} />
      <path d="M3 4.5V3a2 2 0 1 1 4 0v1.5" stroke={T.amber} strokeWidth="1.4" />
    </svg>
    {label}
  </span>
);

const Avatar = ({ seed, size = 22 }) => {
  const hues = ["#8A9A7B", "#7B8E9A", "#9A8A7B", "#7F7B9A", "#9A7B8B"];
  const c = hues[seed.charCodeAt(1) % hues.length];
  return (
    <span
      title={seed}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(135deg, ${c}, ${c}CC)`,
        color: "#FFF",
        fontSize: size * 0.42,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1.5px solid #FFF",
        boxSizing: "border-box",
      }}
    >
      {seed.replace("@", "")[0].toUpperCase()}
    </span>
  );
};

const AvatarStack = ({ seeds }) => (
  <span style={{ display: "inline-flex", alignItems: "center" }}>
    {seeds.map((s, i) => (
      <span key={s} style={{ marginLeft: i === 0 ? 0 : -7 }}>
        <Avatar seed={s} />
      </span>
    ))}
  </span>
);

/* Doc-type glyphs, drawn to sit quietly at 16px */
const TypeIcon = ({ type }) => {
  const s = { stroke: T.inkSoft, strokeWidth: 1.5, fill: "none" };
  const box = { width: 34, height: 34, borderRadius: 9, background: T.bg, border: `1px solid ${T.lineSoft}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
  const icons = {
    doc: (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M4 2.5h6l2.5 2.5v8.5H4z" {...s} strokeLinejoin="round" />
        <path d="M6 8h4.5M6 10.5h4.5" {...s} />
      </svg>
    ),
    sheet: (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2.5" y="3" width="11" height="10" rx="1" {...s} />
        <path d="M2.5 6.5h11M7 3v10" {...s} />
      </svg>
    ),
    code: (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5" {...s} strokeLinecap="round" />
      </svg>
    ),
    kanban: (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2.5" y="3" width="3.4" height="10" rx="1" {...s} />
        <rect x="7.3" y="3" width="3.4" height="6.5" rx="1" {...s} />
        <rect x="12.1" y="3" width="1.4" height="8" rx="0.7" {...s} />
      </svg>
    ),
    board: (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2.5" y="3" width="11" height="10" rx="1" {...s} />
        <path d="M5 10.5c1.5-3 3-5.5 6-4.5" {...s} strokeLinecap="round" />
      </svg>
    ),
  };
  return <span style={box}>{icons[type] || icons.doc}</span>;
};

/* —— Sidebar (condensed, for standalone preview) —— */
const NavItem = ({ label, active, badge, tone }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "9px 14px",
      borderRadius: 10,
      cursor: "pointer",
      background: active ? T.greenBg : "transparent",
      border: active ? `1px solid ${T.greenLine}` : "1px solid transparent",
      color: active ? T.green : T.ink,
      fontWeight: active ? 600 : 450,
      fontSize: 14.5,
      marginBottom: 2,
    }}
  >
    <span>{label}</span>
    {badge &&
      (tone === "live" ? (
        <span style={{ fontSize: 12, color: T.green, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: T.green }} /> live
        </span>
      ) : tone === "lock" ? (
        <LockPill label="Locked" />
      ) : (
        <span
          style={{
            background: T.ink,
            color: "#FFF",
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 999,
            padding: "1px 7px",
          }}
        >
          {badge}
        </span>
      ))}
  </div>
);

const Sidebar = () => (
  <aside
    style={{
      width: 252,
      flexShrink: 0,
      borderRight: `1px solid ${T.line}`,
      padding: "18px 12px",
      display: "flex",
      flexDirection: "column",
      minHeight: "100vh",
      boxSizing: "border-box",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 8px 20px", fontWeight: 650, fontSize: 16 }}>
      <span style={{ fontSize: 15 }}>✕</span> Task Node
    </div>
    <NavItem label="New chat" />
    <NavItem label="Search chats" />
    <NavItem label="Tasks" badge="5" />
    <NavItem label="Hive" badge tone="live" />
    <NavItem label="Docs" active badge="12" />
    <NavItem label="Wallet" badge tone="lock" />
    <NavItem label="Context" />
    <NavItem label="Team" />
    <NavItem label="More" />
    <div style={{ marginTop: "auto", padding: "14px 10px 0", borderTop: `1px solid ${T.lineSoft}`, fontSize: 13 }}>
      <div style={{ fontWeight: 650 }}>1,495,797.72 <span style={{ fontSize: 10, color: T.inkFaint, letterSpacing: 1 }}>PFT</span></div>
      <div style={{ color: T.inkSoft, margin: "4px 0 10px" }}>$20.94 <span style={{ fontSize: 12 }}>chat</span></div>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Avatar seed="@goodalexander" size={30} />
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>@goodalexander</div>
          <div style={{ color: T.inkFaint, fontSize: 12 }}>@goodalexander</div>
        </div>
      </div>
    </div>
  </aside>
);

/* —— Data —— */
const DOCS = [
  {
    type: "doc",
    title: "My Context Doc",
    pinned: true,
    meta: { edited: "22m ago", versions: 47, ctx: "61.7% task context" },
    shared: ["@goodalexander"],
    excerpt:
      "Private operating context for the Task Node AI system and the author's agents. Use it to choose tactics, preserve truth-status boundaries, and prevent overclaiming.",
  },
  {
    type: "doc",
    title: "Hyperliquid Strategies — Production Decision Packet",
    meta: { edited: "2d ago", versions: 18 },
    shared: ["@goodalexander", "@jollydinger"],
    task: "Finalize Hyperliquid Strategies and Commit Production Decision Packet",
  },
  {
    type: "sheet",
    title: "NAV Product Ledger Q3",
    meta: { edited: "5h ago", versions: 112 },
    shared: ["@goodalexander", "@shake", "@gmoney"],
  },
  {
    type: "code",
    title: "orchard-batch-verification.md",
    meta: { edited: "4d ago", versions: 9 },
    shared: ["@goodalexander", "@user8833"],
    task: "Fix Orchard Batch Verification and Add Regression Tests",
  },
  {
    type: "kanban",
    title: "PfTerminal Release Board",
    meta: { edited: "1d ago", versions: 64 },
    shared: ["@goodalexander", "@surfer77", "@user8833", "@jollydinger"],
  },
  {
    type: "board",
    title: "Buy-side Rail Architecture Sketch",
    meta: { edited: "6d ago", versions: 5 },
    shared: ["@goodalexander"],
  },
];

const TABS = [
  { label: "All", count: 12 },
  { label: "Shared", count: 3 },
  { label: "Templates", count: 4 },
  { label: "Archived", count: 6 },
];

/* —— Rows —— */
const DocRow = ({ d, last }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 16,
      padding: "20px 26px",
      borderBottom: last ? "none" : `1px solid ${T.lineSoft}`,
      cursor: "pointer",
    }}
  >
    <TypeIcon type={d.type} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 16.5, fontWeight: 650, letterSpacing: -0.2 }}>{d.title}</div>
      <div style={{ marginTop: 6, fontSize: 13.5, color: T.inkSoft, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: T.green, fontWeight: 550, textTransform: "capitalize" }}>{d.type === "doc" ? "Rich text" : d.type}</span>
        <Dot />
        <span>Edited {d.meta.edited}</span>
        <Dot />
        <span>{d.meta.versions} versions</span>
        {d.task && (
          <>
            <Dot />
            <span style={{ color: T.inkFaint }}>Linked to task “{d.task.slice(0, 34)}…”</span>
          </>
        )}
      </div>
    </div>
    <AvatarStack seeds={d.shared} />
    <LockPill />
  </div>
);

/* —— Page —— */
export default function DocsPage() {
  const [tab, setTab] = useState("All");
  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: T.sans, color: T.ink, display: "flex" }}>
      <Sidebar />
      <main style={{ flex: 1, padding: "56px 64px", maxWidth: 1120, boxSizing: "border-box" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1, margin: 0 }}>Docs</h1>
            <div style={{ marginTop: 14, fontSize: 14.5, color: T.inkSoft, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 650, color: T.ink }}>12 documents</span>
              <Dot />
              <span>3 shared / 9 private</span>
              <Dot />
              <span style={{ fontWeight: 650, color: T.ink }}>247 versions</span>
              <Dot />
              <span>pfdocs synced</span>
            </div>
            {/* Wallet-link banner, mirrors the Tasks status block */}
            <div style={{ marginTop: 18, fontSize: 14, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: T.green, marginRight: 9 }} />
              <span style={{ fontWeight: 650 }}>Wallet linked</span>
              <Dot />
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.inkSoft }}>rhwiJxk...Cyw2TaE</span>
              <Dot />
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.inkSoft }}>XSALSA20</span>
              <span style={{ marginLeft: 18 }}>
                <span style={{ fontSize: 12, letterSpacing: 1.5, color: T.inkFaint, fontWeight: 600 }}>DETAILS</span>
              </span>
            </div>
            <div style={{ marginTop: 8, fontSize: 14, color: T.inkSoft }}>
              · Documents are encrypted client-side with your wallet key before sync
            </div>
          </div>
          <button
            style={{
              background: T.ink,
              color: "#FFF",
              border: "none",
              borderRadius: 999,
              padding: "12px 22px",
              fontSize: 14.5,
              fontWeight: 600,
              fontFamily: T.sans,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 17, lineHeight: 1 }}>+</span> New document
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 34, marginTop: 44, borderBottom: `1px solid ${T.line}` }}>
          {TABS.map((t) => {
            const active = t.label === tab;
            return (
              <div
                key={t.label}
                onClick={() => setTab(t.label)}
                style={{
                  paddingBottom: 13,
                  cursor: "pointer",
                  borderBottom: active ? `2px solid ${T.ink}` : "2px solid transparent",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 15.5, fontWeight: active ? 650 : 480, color: active ? T.ink : T.inkSoft }}>
                  {t.label}
                </span>
                <span
                  style={{
                    background: active ? T.ink : T.lineSoft,
                    color: active ? "#FFF" : T.inkSoft,
                    fontSize: 11.5,
                    fontWeight: 600,
                    borderRadius: 999,
                    padding: "1px 8px",
                  }}
                >
                  {t.count}
                </span>
              </div>
            );
          })}
        </div>

        {/* Pinned context doc — echoes the editor footer */}
        <div
          style={{
            marginTop: 30,
            background: T.card,
            border: `1px solid ${T.line}`,
            borderRadius: 14,
            padding: "24px 26px",
          }}
        >
          <div style={{ fontSize: 11.5, letterSpacing: 2, fontWeight: 650, color: T.inkFaint, marginBottom: 14 }}>
            PINNED
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            <TypeIcon type="doc" />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 680, letterSpacing: -0.3 }}>My Context Doc</div>
              <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: T.inkSoft, maxWidth: 640 }}>
                {DOCS[0].excerpt}
              </p>
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", fontSize: 13.5, color: T.inkSoft, flexWrap: "wrap" }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: T.green, marginRight: 8 }} />
                Saved 22m ago
                <Dot />
                <span style={{ color: T.green, fontWeight: 600 }}>61.7% task context</span>
                <Dot />
                Versions <span style={{ background: T.lineSoft, borderRadius: 999, padding: "0 8px", marginLeft: 6, fontWeight: 600 }}>47</span>
                <Dot />
                <span style={{ fontWeight: 600, color: T.ink }}>↑ Publish to PFT</span>
              </div>
            </div>
            <span style={{ marginTop: 4 }}>
              <LockPill />
            </span>
          </div>
        </div>

        {/* Document list */}
        <div style={{ marginTop: 26 }}>
          <div style={{ fontSize: 12, letterSpacing: 2, fontWeight: 650, color: T.inkFaint, margin: "0 2px 12px" }}>
            RECENT
          </div>
          <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 14, overflow: "hidden" }}>
            {DOCS.slice(1).map((d, i, arr) => (
              <DocRow key={d.title} d={d} last={i === arr.length - 1} />
            ))}
          </div>
          <div style={{ marginTop: 16, fontSize: 13, color: T.inkFaint, textAlign: "center" }}>
            End-to-end encrypted · keys never leave this device · pfdocs v0.9.2
          </div>
        </div>
      </main>
    </div>
  );
}
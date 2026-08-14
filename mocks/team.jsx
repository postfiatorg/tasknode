import React, { useState } from "react";

/* ————————————————————————————————————————————————
   Task Node — Team
   Collaborators share task history. Three relationship levels:
   · Collaborator   — bidirectional, unfettered view both ways
   · Manager        — they see your tasks; you don't see theirs
   · Direct report  — you see their tasks; they don't see yours
   Visual language mirrors the Hive contributor cards.
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

const Avatar = ({ seed, size = 46 }) => {
  const hues = ["#8A9A7B", "#7B8E9A", "#9A8A7B", "#7F7B9A", "#9A7B8B"];
  const c = hues[seed.charCodeAt(1) % hues.length];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        background: `linear-gradient(135deg, ${c}, ${c}B8)`,
        color: "#FFF",
        fontSize: size * 0.4,
        fontWeight: 650,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {seed.replace("@", "")[0].toUpperCase()}
    </span>
  );
};

const AddrPill = ({ handle, addr }) => (
  <span
    style={{
      fontFamily: T.mono,
      fontSize: 11.5,
      color: T.inkSoft,
      background: T.monoBg,
      padding: "3px 9px",
      borderRadius: 6,
      letterSpacing: 0.2,
    }}
  >
    {handle.toUpperCase()} · {addr}
  </span>
);

/* Role badge — quiet, tonal */
const RoleBadge = ({ role }) => {
  const styles = {
    collaborator: { color: T.green, bg: T.greenBg, label: "Collaborator" },
    manager: { color: T.amber, bg: T.amberBg, label: "Manager" },
    report: { color: T.inkSoft, bg: T.lineSoft, label: "Direct report" },
  }[role];
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 650,
        color: styles.color,
        background: styles.bg,
        padding: "3px 10px",
        borderRadius: 999,
        letterSpacing: 0.3,
      }}
    >
      {styles.label}
    </span>
  );
};

/* Visibility indicator — the page's one signature device.
   Two fixed lanes: "they → you" and "you → them", each ticked
   or crossed, so the asymmetry of Manager/Report is legible at
   a glance instead of buried in copy. */
const VisLane = ({ ok, label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5 }}>
    <span
      style={{
        width: 15,
        height: 15,
        borderRadius: 8,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: ok ? T.greenBg : T.lineSoft,
        color: ok ? T.green : T.inkFaint,
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {ok ? "✓" : "—"}
    </span>
    <span style={{ color: ok ? T.ink : T.inkFaint, fontWeight: ok ? 550 : 450 }}>{label}</span>
  </div>
);

const Visibility = ({ seesTheirs, theySeeYours }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 6,
      borderLeft: `1px solid ${T.lineSoft}`,
      paddingLeft: 18,
      minWidth: 168,
    }}
  >
    <VisLane ok={seesTheirs} label="You see their tasks" />
    <VisLane ok={theySeeYours} label="They see your tasks" />
  </div>
);

/* —— Person card, patterned on Hive contributor cards —— */
const PersonCard = ({ p }) => (
  <div
    style={{
      background: T.card,
      border: `1px solid ${T.line}`,
      borderRadius: 14,
      padding: "22px 24px",
      display: "flex",
      alignItems: "center",
      gap: 18,
    }}
  >
    <Avatar seed={p.handle} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16.5, fontWeight: 680, letterSpacing: -0.2 }}>{p.handle}</span>
        <RoleBadge role={p.role} />
      </div>
      <div style={{ marginTop: 7 }}>
        <AddrPill handle={p.handle} addr={p.addr} />
      </div>
      <div style={{ marginTop: 9, fontSize: 13.5, color: T.inkSoft, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {p.working ? <>Working on {p.working}</> : <span style={{ color: T.inkFaint }}>{p.note}</span>}
      </div>
    </div>
    <div style={{ textAlign: "right", fontSize: 13, color: T.inkSoft, minWidth: 96 }}>
      <div style={{ fontSize: 15.5, fontWeight: 680, color: T.ink }}>
        {p.tasks} <span style={{ fontSize: 12, fontWeight: 500, color: T.inkSoft }}>tasks</span>
      </div>
      <div style={{ marginTop: 3 }}>
        {p.pft.toLocaleString()} <span style={{ fontSize: 10, letterSpacing: 1 }}>PFT</span>
      </div>
      <div style={{ marginTop: 3, color: T.inkFaint, fontSize: 12.5 }}>active recently</div>
    </div>
    <Visibility {...p.vis} />
  </div>
);

/* —— Data —— */
const PEOPLE = {
  collaborators: [
    {
      handle: "@jollydinger",
      addr: "RFMDKP...XEGMB",
      role: "collaborator",
      tasks: 3,
      pft: 12500,
      working: "Publish a Practical PfTerminal Walkthrough on Medium",
      vis: { seesTheirs: true, theySeeYours: true },
    },
    {
      handle: "@shake",
      addr: "RGQVOR...VQM7H",
      role: "collaborator",
      tasks: 2,
      pft: 8000,
      working: "Publish PfTerminal and PFT Rewards X Thread",
      vis: { seesTheirs: true, theySeeYours: true },
    },
  ],
  manager: [
    {
      handle: "@selini_pm",
      addr: "R9KWXA...T4QLN",
      role: "manager",
      tasks: null,
      pft: null,
      note: "Task history not visible at this level",
      vis: { seesTheirs: false, theySeeYours: true },
      hidden: true,
    },
  ],
  reports: [
    {
      handle: "@user8833",
      addr: "R3RQBC...48SUD",
      role: "report",
      tasks: 6,
      pft: 13000,
      working: "Outstanding Network Task Content Smoke",
      vis: { seesTheirs: true, theySeeYours: false },
    },
    {
      handle: "@surfer77",
      addr: "RA7SSG...K9YH8",
      role: "report",
      tasks: 1,
      pft: 5000,
      working: "Publish One X Post About PfTerminal",
      vis: { seesTheirs: true, theySeeYours: false },
    },
    {
      handle: "@gmoney",
      addr: "RKTBXK...CGOT3",
      role: "report",
      tasks: 1,
      pft: 1000,
      working: "Rank Recent Post Fiat Posts for Amplification",
      vis: { seesTheirs: true, theySeeYours: false },
    },
  ],
};

/* Manager card variant — deliberately withholds detail to make
   the one-way visibility tangible in the UI itself. */
const ManagerCard = ({ p }) => (
  <div
    style={{
      background: T.card,
      border: `1px solid ${T.line}`,
      borderRadius: 14,
      padding: "22px 24px",
      display: "flex",
      alignItems: "center",
      gap: 18,
    }}
  >
    <Avatar seed={p.handle} />
    <div style={{ flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16.5, fontWeight: 680 }}>{p.handle}</span>
        <RoleBadge role="manager" />
      </div>
      <div style={{ marginTop: 7 }}>
        <AddrPill handle={p.handle} addr={p.addr} />
      </div>
      <div style={{ marginTop: 9, fontSize: 13.5, color: T.inkFaint, display: "flex", alignItems: "center", gap: 7 }}>
        <svg width="12" height="13" viewBox="0 0 10 11" fill="none">
          <rect x="1" y="4.5" width="8" height="6" rx="1.5" fill={T.inkFaint} />
          <path d="M3 4.5V3a2 2 0 1 1 4 0v1.5" stroke={T.inkFaint} strokeWidth="1.4" />
        </svg>
        Their task history isn't visible to you at this level
      </div>
    </div>
    <div style={{ textAlign: "right", fontSize: 15, color: T.inkFaint, minWidth: 96, fontWeight: 600 }}>
      — <span style={{ fontSize: 12, fontWeight: 500 }}>tasks</span>
      <div style={{ marginTop: 3, fontSize: 13 }}>— <span style={{ fontSize: 10, letterSpacing: 1 }}>PFT</span></div>
    </div>
    <Visibility {...p.vis} />
  </div>
);

const SectionHead = ({ num, title, sub, count }) => (
  <div style={{ margin: "44px 2px 14px" }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.inkFaint }}>{num}</span>
      <span style={{ fontSize: 12.5, letterSpacing: 2.2, fontWeight: 680, color: T.ink }}>{title}</span>
      {count != null && (
        <span style={{ background: T.lineSoft, color: T.inkSoft, fontSize: 11.5, fontWeight: 600, borderRadius: 999, padding: "1px 8px" }}>
          {count}
        </span>
      )}
    </div>
    <div style={{ marginTop: 5, marginLeft: 30, fontSize: 13.5, color: T.inkSoft }}>{sub}</div>
  </div>
);

/* —— Page —— */
export default function TeamPage() {
  const [inviteOpen, setInviteOpen] = useState(false);
  const total =
    PEOPLE.collaborators.length + PEOPLE.manager.length + PEOPLE.reports.length;

  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: T.sans, color: T.ink }}>
      <main style={{ maxWidth: 980, margin: "0 auto", padding: "56px 40px", boxSizing: "border-box" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1, margin: 0 }}>Team</h1>
            <div style={{ marginTop: 14, fontSize: 14.5, color: T.inkSoft, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 650, color: T.ink }}>{total} people</span>
              <Dot />
              <span>2 collaborators / 1 manager / 3 direct reports</span>
              <Dot />
              <span style={{ fontWeight: 650, color: T.ink }}>13 shared tasks</span>
              <Dot />
              <span>history synced</span>
            </div>
            {/* Visibility rule banner — mirrors Tasks status block */}
            <div style={{ marginTop: 18, fontSize: 14, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: T.green, marginRight: 9 }} />
              <span style={{ fontWeight: 650 }}>Sharing active</span>
              <Dot />
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.inkSoft }}>rhwiJxk...Cyw2TaE</span>
              <Dot />
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.inkSoft }}>signed grants</span>
              <span style={{ marginLeft: 18, fontSize: 12, letterSpacing: 1.5, color: T.inkFaint, fontWeight: 600 }}>DETAILS</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 14, color: T.inkSoft }}>
              · Collaborators see each other fully · managers see reports · reports never see up
            </div>
          </div>
          <button
            onClick={() => setInviteOpen(!inviteOpen)}
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
            <span style={{ fontSize: 17, lineHeight: 1 }}>+</span> Invite
          </button>
        </div>

        {/* Invite panel */}
        {inviteOpen && (
          <div
            style={{
              marginTop: 26,
              background: T.card,
              border: `1px solid ${T.line}`,
              borderRadius: 14,
              padding: "22px 24px",
            }}
          >
            <div style={{ fontSize: 12, letterSpacing: 2, fontWeight: 650, color: T.inkFaint, marginBottom: 14 }}>
              INVITE BY WALLET ADDRESS
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <input
                placeholder="r… wallet address or @handle"
                style={{
                  flex: 1,
                  minWidth: 260,
                  fontFamily: T.mono,
                  fontSize: 13.5,
                  padding: "11px 14px",
                  border: `1px solid ${T.line}`,
                  borderRadius: 10,
                  background: T.bg,
                  color: T.ink,
                  outline: "none",
                }}
              />
              {["Collaborator", "Manager", "Direct report"].map((r, i) => (
                <button
                  key={r}
                  style={{
                    fontFamily: T.sans,
                    fontSize: 13.5,
                    fontWeight: 600,
                    padding: "10px 16px",
                    borderRadius: 10,
                    cursor: "pointer",
                    background: i === 0 ? T.greenBg : T.card,
                    color: i === 0 ? T.green : T.inkSoft,
                    border: `1px solid ${i === 0 ? T.greenLine : T.line}`,
                  }}
                >
                  {r}
                </button>
              ))}
              <button
                style={{
                  background: T.ink,
                  color: "#FFF",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 20px",
                  fontSize: 13.5,
                  fontWeight: 600,
                  fontFamily: T.sans,
                  cursor: "pointer",
                }}
              >
                Send invite
              </button>
            </div>
            <div style={{ marginTop: 12, fontSize: 12.5, color: T.inkFaint }}>
              Both wallets sign the grant. The role sets who can read whose task history — it can be changed or revoked any time.
            </div>
          </div>
        )}

        {/* Collaborators */}
        <SectionHead
          num="01"
          title="COLLABORATORS"
          count={PEOPLE.collaborators.length}
          sub="Bidirectional. You see their full task history; they see yours."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {PEOPLE.collaborators.map((p) => (
            <PersonCard key={p.handle} p={p} />
          ))}
        </div>

        {/* Manager */}
        <SectionHead
          num="02"
          title="YOUR MANAGER"
          count={PEOPLE.manager.length}
          sub="One-way, upward. They see your tasks; their history stays private to you."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {PEOPLE.manager.map((p) => (
            <ManagerCard key={p.handle} p={p} />
          ))}
        </div>

        {/* Direct reports */}
        <SectionHead
          num="03"
          title="DIRECT REPORTS"
          count={PEOPLE.reports.length}
          sub="One-way, downward. You see their tasks; your history stays private to them."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {PEOPLE.reports.map((p) => (
            <PersonCard key={p.handle} p={p} />
          ))}
        </div>

        <div style={{ margin: "40px 0 10px", fontSize: 13, color: T.inkFaint, textAlign: "center" }}>
          Access grants are wallet-signed and revocable · nothing is shared beyond task history
        </div>
      </main>
    </div>
  );
}
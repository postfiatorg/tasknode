import React, { useState } from "react";
import {
  X, SquarePen, Search, Settings, LifeBuoy, ChevronRight, ChevronDown,
  Mic, Copy, ChevronLeft, RotateCw, MoreHorizontal, Plus, ArrowUp,
  ListTodo, Activity, Wallet, BookOpen, LockOpen, Network, UserRound,
  LogOut, CircleCheck, Share, Image as ImageIcon,
  Paperclip, Wand2, ListPlus, Check,
  Heading1, Heading2, Heading3, Bold, Italic, List, ListOrdered, Table, Hash, PenLine,
  ArrowRight,
} from "lucide-react";

const CONTEXT_DOC = [
  { n: 1, t: "Task Node is the current product priority." },
  { n: 2, t: "Core belief:" },
  { n: 3, t: "If we do not have one working product, nobody will take us seriously. The rebuilt Task Node must become a usable app surface that can earn 30+ DAUs." },
  { n: 4, t: "Current direction:" },
  { n: 5, t: "Completely rebuild the Task Node from scratch around one trustworthy loop.", b: true },
  { n: 6, t: "Fix all P0s before expanding scope.", b: true },
  { n: 7, t: "Make task creation/request, state, submission, review, and reward feel deterministic and obvious.", b: true },
  { n: 8, t: "The user should always know: what the task is, what state it is in, what happens next, and whether the system acknowledged their work.", b: true },
  { n: 9, t: "Reduce ambiguity more than adding new features.", b: true },
  { n: 10, t: "Completed/foundation:" },
  { n: 11, t: "Implemented a full pipeline.", b: true },
  { n: 12, t: "Deterministic task model / JSON storage loop exists.", b: true },
  { n: 13, t: "State transition validation, review workflows, replay/integrity work, latency profiling, timestamp fixes, and frontend workflow audits have been completed or advanced.", b: true },
  { n: 14, t: "Active priority stack:" },
  { n: 15, t: "P0. Hive acceptance gates:" },
  { n: 16, t: "All user-facing surfaces must pass the four gates:" },
  { n: 17, t: "Task clarity: the user immediately understands what the task is.", b: true },
  { n: 18, t: "State visibility: the user immediately understands the current state.", b: true },
  { n: 19, t: "Next action: the user immediately understands what to do next.", b: true },
  { n: 20, t: "Acknowledgment: the system clearly confirms that the user's action was received.", b: true },
  { n: 21, t: "Priority work: audit Hive board outputs, Telegram outputs, task cards, and task detail views; fix the three highest-impact confusion points; capture before/after evidence." },
  { n: 22, t: "P0. Chat contract enforcement:" },
];

const MODELS = [
  { name: "Private Instant", desc: "ZDR. Open Source. Fast." },
  { name: "Private Thinking", desc: "ZDR. Open Source. More reasoning." },
  { name: "Discount Thinking", desc: "DeepSeek API Direct" },
  { name: "Frontier Instant", desc: "Fast frontier model" },
  { name: "Frontier Thinking", desc: "Deeper frontier reasoning" },
];

const ink = "#0d0d0d";
const GREEN = "#0e7a43";
const GREEN_BG = "#e7f4ec";
const FONT = "ui-sans-serif, -apple-system, 'Helvetica Neue', Segoe UI, sans-serif";

/* ── glyphs ── */
function Avatar({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="20" fill="#1a1a1a" />
      <g stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <line x1="13" y1="13" x2="27" y2="27" /><line x1="27" y1="13" x2="13" y2="27" />
        <line x1="20" y1="9" x2="20" y2="31" /><line x1="9" y1="20" x2="31" y2="20" />
      </g>
    </svg>
  );
}
function TelegramIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="20" fill="#229ED9" />
      <path d="M9 19.5l20-7.6c.9-.34 1.7.22 1.4 1.6l-3.4 16c-.24 1.1-.9 1.37-1.83.86l-5.05-3.73-2.43 2.34c-.27.27-.5.5-1 .5l.36-5.13L26 13.9c.4-.36-.09-.56-.62-.2l-11.6 7.3-5-1.56c-1.08-.34-1.1-1.08.22-1.6z" fill="#fff" />
    </svg>
  );
}
function NodeGlyph({ size = 18, color = GREEN }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="2.2" /><circle cx="5.5" cy="18" r="2.2" /><circle cx="18.5" cy="18" r="2.2" />
      <path d="M12 7.2 6.6 15.8M12 7.2l5.4 8.6M7.7 18h8.6" />
    </svg>
  );
}
function TaskNodeMark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round">
      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

/* ── status + browser bars ── */
function StatusBar() {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 52, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 28px 0", pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.3 }}>11:26</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill={ink}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></svg>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2 }}>{[5, 7, 9, 11].map((h, i) => <div key={i} style={{ width: 3, height: h, borderRadius: 1, background: ink }} />)}</div>
        <span style={{ fontSize: 14, fontWeight: 600 }}>5G</span>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ position: "relative", width: 26, height: 13, borderRadius: 4, border: "1.5px solid rgba(0,0,0,.35)", display: "flex", alignItems: "center", padding: "0 1.5px", boxSizing: "border-box" }}>
            <div style={{ height: 8, width: "24%", borderRadius: 2, background: ink }} />
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600 }}>24</span>
          </div>
          <div style={{ width: 1.5, height: 5, borderRadius: 1, background: "rgba(0,0,0,.35)", marginLeft: 1 }} />
        </div>
      </div>
    </div>
  );
}
function BrowserBar() {
  const round = { width: 44, height: 44, borderRadius: 999, border: "none", background: "rgba(0,0,0,.04)", display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 80, height: 72, background: "rgba(255,255,255,.96)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px 8px" }}>
      <button style={round}><ChevronLeft size={24} color="rgba(13,13,13,.8)" /></button>
      <div style={{ flex: 1, margin: "0 12px", height: 44, borderRadius: 999, background: "#5b5b5b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <ImageIcon size={16} style={{ opacity: .7 }} /><span style={{ fontSize: 16, fontWeight: 500 }}>tasknode.app</span><RotateCw size={16} style={{ opacity: .8 }} />
      </div>
      <button style={round}><MoreHorizontal size={22} color="rgba(13,13,13,.8)" /></button>
    </div>
  );
}

/* ── reusable rows ── */
function Row({ icon, label, active, current, trailing, onClick, danger }) {
  const [h, setH] = useState(false);
  const bg = active ? GREEN_BG : current ? "rgba(0,0,0,.06)" : h ? "rgba(0,0,0,0.04)" : "transparent";
  const fg = danger ? "#c0392b" : active ? GREEN : "rgba(13,13,13,0.9)";
  return (
    <button onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: "flex", alignItems: "center", gap: 13, width: "100%", textAlign: "left", border: "none", cursor: "pointer", borderRadius: 14, padding: "11px 12px", background: bg, transition: "background .15s" }}>
      <span style={{ color: danger ? "#c0392b" : active ? GREEN : "rgba(13,13,13,0.85)", display: "flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 15.5, color: fg, fontWeight: active || current ? 600 : 400, flex: 1, lineHeight: 1.1 }}>{label}</span>
      {trailing}
    </button>
  );
}

/* mobile editor toolbar — horizontally scrollable; buttons toggle visual state */
function TBtn({ children, onClick, on }) {
  return (
    <button onClick={onClick} style={{ flexShrink: 0, minWidth: 38, height: 36, padding: "0 9px", borderRadius: 9, border: "none", cursor: "pointer", background: on ? "rgba(0,0,0,.08)" : "transparent", color: "rgba(13,13,13,.8)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 14, fontWeight: 600 }}>
      {children}
    </button>
  );
}
function EditorToolbar() {
  const [bold, setBold] = useState(false);
  const [ital, setItal] = useState(false);
  const div = <span style={{ width: 1, height: 22, background: "rgba(0,0,0,.1)", flexShrink: 0, margin: "0 4px" }} />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, borderBottom: "1px solid rgba(0,0,0,.08)", padding: "6px 10px", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <TBtn><Heading1 size={19} /></TBtn>
      <TBtn><Heading2 size={19} /></TBtn>
      <TBtn><Heading3 size={19} /></TBtn>
      {div}
      <TBtn on={bold} onClick={() => setBold(v => !v)}><Bold size={18} /></TBtn>
      <TBtn on={ital} onClick={() => setItal(v => !v)}><Italic size={18} /></TBtn>
      {div}
      <TBtn><List size={19} /></TBtn>
      <TBtn><ListOrdered size={19} /></TBtn>
      {div}
      <TBtn><Table size={18} /><ChevronDown size={13} /></TBtn>
      {div}
      <TBtn><Hash size={18} /></TBtn>
      <TBtn><Copy size={16} /> Copy</TBtn>
    </div>
  );
}
const Pill = ({ children, dark }) => (
  <span style={{ fontSize: 12.5, fontWeight: 600, padding: "3px 9px", borderRadius: 999, background: dark ? ink : "transparent", color: dark ? "#fff" : GREEN, border: dark ? "none" : `1px solid ${GREEN}` }}>{children}</span>
);

const NAV = [
  { icon: <SquarePen size={21} strokeWidth={1.75} />, label: "New chat" },
  { icon: <Search size={21} strokeWidth={1.75} />, label: "Search chats" },
  { icon: <ListTodo size={21} strokeWidth={1.75} />, label: "Tasks", trailing: <Pill dark>1</Pill> },
  { icon: <Activity size={21} strokeWidth={1.75} />, label: "Hive", trailing: <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 13, fontWeight: 600, color: GREEN, display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 999, background: GREEN }} />live</span><Pill dark>1</Pill></span> },
  { icon: <Wallet size={21} strokeWidth={1.75} />, label: "Wallet", trailing: <Pill>Unlocked</Pill> },
  { icon: <BookOpen size={21} strokeWidth={1.75} />, label: "Context" },
  { icon: <MoreHorizontal size={21} strokeWidth={1.75} />, label: "More" },
];
const RECENTS = [
  { t: "Hive Chat", active: true, node: true },
  { t: "i need to do this" }, { t: "Hello" }, { t: "what should I work on" },
  { t: "thoughts" }, { t: "Okay - so basically Post Fia…" }, { t: "top 5 things to focus on" },
  { t: "the key products of Post Fi…" }, { t: "I want some advice about …" },
];

/* ── Hive data ── */
const CREAM = "#f4efe3";
const STATE_COLOR = { proposed: "#b07a1a", accepted: GREEN, rewarded: "rgba(0,0,0,.5)", refused: "rgba(0,0,0,.5)", cancelled: "rgba(0,0,0,.5)" };
const HIVE_STATS = [
  { label: "Active projects", value: "3" },
  { label: "Task rows", value: "32" },
  { label: "PFT routed", value: "556K", green: true },
];
const HIVE_PROJECTS = [
  { title: "Network Onboarding and Positioning", tag: "PROTOCOL MARKETING", desc: "Explain Hive Chat, Board Manager, boards, network tasks, eligibility, and rewards in plain language.", task: { title: "Draft Plain-Language Network Onboarding Starter Pack", state: "accepted", pft: "15,000 PFT", note: "Complete the task and submit evidence for r…" }, ops: 1, pending: 0, rows: "1", routed: "15,000 PFT routed" },
  { title: "Task Node Core Product", tag: "PROTOCOL APPLICATIONS", desc: "Build and operate Task Node as one product loop for chat, context, tasks, wallets, Telegram, Hive, profiles, rewards, and reliability.", task: { title: "Produce Context Document Compliance Audit And Patch", state: "proposed", pft: "12,000 PFT", note: "Open the task and accept or refuse it before…" }, ops: 3, pending: 1, rows: "26", routed: "412,000 PFT routed" },
  { title: "Market Alpha Tasks", tag: "ALPHA GENERATION", desc: "Prepare production market-alpha tasks for public equities and crypto where contributors may have edge.", task: { title: "Draft Ten High-Signal Market Alpha Experiments", state: "proposed", pft: "30,000 PFT", note: "Open the task and accept or refuse it before…" }, ops: 1, pending: 0, rows: "5", routed: "129,000 PFT routed" },
];
const HIVE_FEED = [
  { u: "@goodalexander", id: "rhwiJx…w2TaE", s: "proposed", t: "Produce Context Document Compliance Audit A…" },
  { u: "@wizbubba", id: "rKjozZ…Dkf4u", s: "accepted", t: "Draft Plain-Language Network Onboarding Start…" },
  { u: "@wizbubba", id: "rKjozZ…Dkf4u", s: "rewarded", t: "QA Hive Chat Onboarding Flow · T…", pft: "+12,000 PFT" },
  { u: "@goodalexander", id: "rhwiJx…w2TaE", s: "rewarded", t: "Audit And Reproduce Double Rew…", pft: "+18,000 PFT" },
  { u: "@goodalexander", id: "rhwiJx…w2TaE", s: "rewarded", t: "Verify And Patch Hive Acceptance…", pft: "+12,000 PFT" },
  { u: "@agticorp", id: "rU963x…efyUj", s: "proposed", t: "Draft Ten High-Signal Market Alpha Experiments…" },
  { u: "@agticorp", id: "rU963x…efyUj", s: "refused", t: "Produce Ranked Market Alpha Task Backlog · Ma…" },
  { u: "@agticorp", id: "rU963x…efyUj", s: "refused", t: "Create Initial Market Alpha Task Inventory · Mark…" },
  { u: "@agticorp", id: "rU963x…efyUj", s: "rewarded", t: "Write Task Node Boundary and S…", pft: "+30,000 PFT" },
  { u: "@agticorp", id: "rU963x…efyUj", s: "rewarded", t: "Audit Task Node Determinism an…", pft: "+30,000 PFT" },
  { u: "@goodalexander", id: "rhwiJx…w2TaE", s: "cancelled", t: "Fix Acceptance Gate Failures In Hive Outputs · T…" },
  { u: "@agticorp", id: "rU963x…efyUj", s: "refused", t: "Audit Contributor Reward Visibility Gaps · Task N…" },
];
const HIVE_OPERATORS = [
  { u: "@wizbubba", id: "rKjozZ…Dkf4u", role: "Network task contributor", working: "Working on Draft Plain-Language Network Onboarding Starter Pack · Network Onboarding and Positioning", prog: "1/1" },
  { u: "@goodalexander", id: "rhwiJx…w2TaE", role: "Financial Protocol Quality Engineer", working: "Working on Produce Context Document Compliance Audit And Patch · Task Node Core Product", prog: "2/2" },
  { u: "@agticorp", id: "rU963x…efyUj", role: "Network task contributor", working: "Working on Draft Ten High-Signal Market Alpha Experiments · Market Alpha Tasks", prog: "1/1" },
];

const SectionLabel = ({ title, sub }) => (
  <div style={{ marginTop: 26, marginBottom: 12 }}>
    <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.8, color: "rgba(0,0,0,.45)" }}>{title}</div>
    {sub && <div style={{ fontSize: 14.5, color: "rgba(0,0,0,.5)", marginTop: 2 }}>{sub}</div>}
  </div>
);

function HiveScreen() {
  const card = { background: "#fff", borderRadius: 18, boxShadow: "0 1px 3px rgba(0,0,0,.06)", border: "1px solid rgba(0,0,0,.04)" };
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "18px 16px 96px" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.8, color: GREEN, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: GREEN }} /> LIVE
      </div>
      <h1 style={{ fontSize: 38, fontWeight: 800, margin: "6px 0 10px", letterSpacing: -1 }}>Hive</h1>
      <p style={{ fontSize: 16, lineHeight: 1.45, color: "rgba(0,0,0,.55)", margin: 0 }}>Aggregate view of what the network is doing. The hive routes work to nodes; this is its memory in motion.</p>

      <div style={{ display: "flex", gap: 18, marginTop: 22 }}>
        {HIVE_STATS.map(s => (
          <div key={s.label} style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, color: "rgba(0,0,0,.45)", marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: s.green ? GREEN : ink, letterSpacing: -0.5 }}>{s.value}</div>
          </div>
        ))}
      </div>

      <SectionLabel title="ACTIVE PROJECTS" sub="What the hive is routing operators to" />
      {HIVE_PROJECTS.map(p => (
        <div key={p.title} style={{ ...card, padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: -0.3 }}>{p.title}</div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.6, color: "rgba(0,0,0,.4)", margin: "6px 0 10px" }}>{p.tag}</div>
          <p style={{ fontSize: 15.5, lineHeight: 1.5, color: "rgba(0,0,0,.6)", margin: 0 }}>{p.desc}</p>
          <div style={{ background: "rgba(0,0,0,.03)", borderRadius: 12, padding: "12px 14px", marginTop: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, color: "rgba(0,0,0,.4)" }}>NEXT REWARD TASK</div>
            <div style={{ fontSize: 16, fontWeight: 700, margin: "5px 0 4px", lineHeight: 1.3 }}>{p.task.title}</div>
            <div style={{ fontSize: 13.5, color: "rgba(0,0,0,.5)" }}><span style={{ color: STATE_COLOR[p.task.state], fontWeight: 600 }}>{p.task.state}</span> · {p.task.pft}</div>
            <div style={{ fontSize: 14, color: "rgba(0,0,0,.45)", marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.task.note}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
            <div style={{ display: "flex" }}>{Array.from({ length: Math.min(p.ops, 3) }).map((_, i) => <span key={i} style={{ marginLeft: i ? -8 : 0, border: "2px solid #fff", borderRadius: 999, display: "flex" }}><Avatar size={26} /></span>)}</div>
            <span style={{ fontSize: 14, color: "rgba(0,0,0,.6)" }}>{p.ops} operator{p.ops > 1 ? "s" : ""}{p.pending ? <span style={{ color: "#b07a1a", display: "block", fontSize: 13 }}>{p.pending} pending generation</span> : null}</span>
          </div>
          <div style={{ borderTop: "1px solid rgba(0,0,0,.07)", margin: "14px 0 0", paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14.5, color: "rgba(0,0,0,.6)" }}><b style={{ color: ink }}>{p.rows}</b> task row{p.rows !== "1" ? "s" : ""}</span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: GREEN, display: "flex", alignItems: "center", gap: 4 }}>{p.routed} <ChevronRight size={16} /></span>
          </div>
        </div>
      ))}

      <SectionLabel title="ROUTING FEED" sub="Recent state transitions across the network" />
      <div style={{ ...card, padding: 4 }}>
        {HIVE_FEED.map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderTop: i ? "1px solid rgba(0,0,0,.06)" : "none" }}>
            <Avatar size={30} />
            <div style={{ width: 96, flexShrink: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.u}</div>
              <div style={{ fontSize: 11.5, color: "rgba(0,0,0,.4)", fontFamily: "ui-monospace, monospace" }}>{f.id}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: STATE_COLOR[f.s], marginBottom: 2 }}>{f.s}</div>
              <div style={{ fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.t}</div>
            </div>
            {f.pft && <span style={{ fontSize: 13.5, fontWeight: 600, color: GREEN, flexShrink: 0 }}>{f.pft}</span>}
          </div>
        ))}
      </div>

      <SectionLabel title="ALLOTTED OPERATORS" sub="Operators currently routed by live project tasks" />
      <div style={{ ...card, padding: 4 }}>
        {HIVE_OPERATORS.map((o, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 12px", borderTop: i ? "1px solid rgba(0,0,0,.06)" : "none" }}>
            <Avatar size={32} />
            <div style={{ width: 92, flexShrink: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.u}</div>
              <div style={{ fontSize: 11.5, color: "rgba(0,0,0,.4)", fontFamily: "ui-monospace, monospace" }}>{o.id}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: GREEN, marginTop: 6, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, color: "rgba(0,0,0,.55)" }}>{o.role}</div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", lineHeight: 1.35, marginTop: 2 }}>{o.working}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: GREEN }} />
                  <span style={{ fontSize: 13, color: "rgba(0,0,0,.5)" }}>{o.prog}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Tasks data ── */
const TASKS_BG = "#f7f5f0";
const TASK_STATE_COLOR = { Proposed: "#b07a1a", Rewarded: "#9c7a3b", Refused: "rgba(0,0,0,.45)", Verification: "#b07a1a" };
const TASK_TABS = [["Outstanding", 1], ["Verification", 0], ["Refused", 14], ["Rewarded", 36]];
const TASK_DATA = {
  Outstanding: [
    { title: "Produce Context Document Compliance Audit And Patch", cat: "Network", state: "Proposed", date: "Jun 5", ago: "50m ago", pft: "12,000", hollow: true },
  ],
  Verification: [],
  Refused: [
    { title: "Produce Ranked Market Alpha Task Backlog", cat: "Network", state: "Refused", date: "May 28", ago: "3d ago", pft: "9,000" },
    { title: "Create Initial Market Alpha Task Inventory", cat: "Network", state: "Refused", date: "May 27", ago: "4d ago", pft: "6,000" },
    { title: "Audit Contributor Reward Visibility Gaps", cat: "Network", state: "Refused", date: "May 26", ago: "5d ago", pft: "8,000" },
    { title: "Draft Telegram Output Formatting Spec", cat: "Personal", state: "Refused", date: "May 25", ago: "6d ago", pft: "3,000" },
    { title: "Refactor Board Manager State Machine", cat: "Network", state: "Refused", date: "May 24", ago: "7d ago", pft: "11,000" },
    { title: "Add Replay Integrity Checks To Pipeline", cat: "Personal", state: "Refused", date: "May 22", ago: "9d ago", pft: "2.0" },
  ],
  Rewarded: [
    { title: "Draft Contributor Trust And Reward Framework", cat: "Network", state: "Rewarded", date: "Jun 9", ago: "58m ago", pft: "18,000" },
    { title: "Merge Chat Attachment Validation Branch Into Main", cat: "Personal", state: "Rewarded", date: "May 20", ago: "2h ago", pft: "1.25" },
    { title: "Audit frontend state and hardcoded task workflows", cat: "Personal", state: "Rewarded", date: "May 20", ago: "2h ago", pft: "2.4" },
    { title: "Validate Distribution V3 Idempotency Under Replay Conditions", cat: "Network", state: "Rewarded", date: "Jun 3", ago: "2h ago", pft: "14,000" },
    { title: "Update Context Document Priority Stack", cat: "Personal", state: "Rewarded", date: "Jun 5", ago: "12h ago", pft: "2.5" },
    { title: "Verify Reward Deduplication Across Distribution V3 Paths", cat: "Network", state: "Rewarded", date: "Jun 3", ago: "13h ago", pft: "18,000" },
    { title: "Launch Death March Discord Protocol", cat: "Personal", state: "Rewarded", date: "Jun 2", ago: "16h ago", pft: "0" },
    { title: "Trace Distribution V3 Reward Routing Consistency", cat: "Network", state: "Rewarded", date: "Jun 8", ago: "22h ago", pft: "18,000" },
    { title: "Audit And Reproduce Double Reward Event Path", cat: "Network", state: "Rewarded", date: "Jun 8", ago: "1d ago", pft: "18,000" },
  ],
};

function TaskDot({ state, hollow }) {
  const c = TASK_STATE_COLOR[state] || "rgba(0,0,0,.4)";
  return <span style={{ width: 11, height: 11, borderRadius: 999, flexShrink: 0, marginTop: 6, background: hollow ? "transparent" : c, border: hollow ? `2px solid ${c}` : "none" }} />;
}

function TasksScreen({ tab, setTab, onRequest }) {
  const rows = TASK_DATA[tab] || [];
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 96px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, margin: 0, letterSpacing: -1 }}>Tasks</h1>
        <button onClick={onRequest} style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, background: ink, color: "#fff", border: "none", borderRadius: 999, padding: "10px 16px", fontSize: 14.5, fontWeight: 600, cursor: "pointer", marginTop: 4 }}>
          <Plus size={17} /> Request task
        </button>
      </div>
      <div style={{ fontSize: 14.5, color: "rgba(0,0,0,.55)", marginTop: 8 }}>
        <b style={{ color: ink }}>1 outstanding</b> · <b style={{ color: GREEN }}>12,000 PFT in flight</b> · 51 chain indexed
      </div>

      {/* tabs — even 2×2 grid, equal-width cells */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 18 }}>
        {TASK_TABS.map(([name, count]) => {
          const on = tab === name;
          return (
            <button key={name} onClick={() => setTab(name)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "13px 15px", borderRadius: 14, cursor: "pointer", border: on ? "1px solid " + ink : "1px solid rgba(0,0,0,.1)", background: on ? ink : "#fff", transition: "background .15s" }}>
              <span style={{ fontSize: 14.5, fontWeight: on ? 700 : 600, color: on ? "#fff" : "rgba(0,0,0,.65)" }}>{name}</span>
              <span style={{ fontSize: 12, fontWeight: 700, minWidth: 20, textAlign: "center", padding: "2px 7px", borderRadius: 999, background: on ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.06)", color: on ? "#fff" : "rgba(0,0,0,.45)" }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* list */}
      {rows.length === 0 ? (
        <div style={{ textAlign: "center", color: "rgba(0,0,0,.4)", fontSize: 15, padding: "60px 0" }}>No tasks in {tab.toLowerCase()}.</div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 18, boxShadow: "0 1px 3px rgba(0,0,0,.06)", border: "1px solid rgba(0,0,0,.04)", marginTop: 16, overflow: "hidden" }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "16px 16px", borderTop: i ? "1px solid rgba(0,0,0,.06)" : "none" }}>
              <TaskDot state={r.state} hollow={r.hollow} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16.5, fontWeight: 700, lineHeight: 1.3 }}>{r.title}</div>
                <div style={{ fontSize: 13.5, color: "rgba(0,0,0,.5)", marginTop: 5 }}>
                  <b style={{ color: "rgba(0,0,0,.7)", fontWeight: 600 }}>{r.cat}</b> · <span style={{ color: TASK_STATE_COLOR[r.state] }}>{r.state}</span> · {r.date} · {r.ago}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>{r.pft}</div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "rgba(0,0,0,.4)" }}>PFT</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═════════════ APP ═════════════ */
export default function TaskNodeMobileFlow() {
  const [loggedIn, setLoggedIn] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [login, setLogin] = useState(false);
  const [profile, setProfile] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [plusMenu, setPlusMenu] = useState(false);
  const [model, setModel] = useState("Frontier Instant");
  const [screen, setScreen] = useState("chat");
  const [tasksTab, setTasksTab] = useState("Outstanding");
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestText, setRequestText] = useState("");

  const signOut = () => { setLoggedIn(false); setProfile(false); setDrawer(false); setScreen("chat"); };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#d4d4d4", padding: 24, fontFamily: FONT }}>
      <div style={{ position: "relative", width: 393, height: 852, background: "#fff", borderRadius: 44, overflow: "hidden", boxShadow: "0 30px 60px rgba(0,0,0,.35)", boxSizing: "border-box", userSelect: "none" }}>
        <StatusBar />

        {/* chat background */}
        <div style={{ position: "absolute", inset: 0, paddingTop: 52, background: screen === "hive" ? CREAM : screen === "tasks" ? TASKS_BG : "#fff", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px" }}>
            <button onClick={() => setDrawer(true)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
              <TaskNodeMark size={24} /><span style={{ fontSize: 20, fontWeight: 700 }}>Task Node</span>
            </button>
            {loggedIn
              ? (screen !== "chat"
                ? <button style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(0,0,0,.7)", display: "flex", padding: 4 }}><PenLine size={22} /></button>
                : <button style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 600, color: "rgba(0,0,0,.7)" }}><Share size={17} />Share</button>)
              : <button onClick={() => { setDrawer(false); setLogin(true); }} style={{ background: ink, color: "#fff", fontSize: 15, fontWeight: 500, border: "none", borderRadius: 999, padding: "10px 20px", cursor: "pointer" }}>Log in</button>}
          </div>

          {/* body */}
          {screen === "tasks" ? (
            <TasksScreen tab={tasksTab} setTab={setTasksTab} onRequest={() => { setRequestText(""); setRequestOpen(true); }} />
          ) : screen === "hive" ? (
            <HiveScreen />
          ) : screen === "context" ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <EditorToolbar />
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 18px 90px", color: "rgba(13,13,13,.92)" }}>
                <h1 style={{ fontSize: 27, fontWeight: 800, margin: "0 0 20px", letterSpacing: -0.5 }}>Historical PFT Context</h1>
                {CONTEXT_DOC.map((l) => (
                  <div key={l.n} style={{ display: "flex", gap: 14, marginBottom: 16 }}>
                    <span style={{ flexShrink: 0, width: 18, textAlign: "right", fontSize: 13, color: "rgba(0,0,0,.32)", paddingTop: 4, fontVariantNumeric: "tabular-nums" }}>{l.n}</span>
                    <div style={{ flex: 1, display: "flex", gap: 8, paddingLeft: l.b ? 14 : 0 }}>
                      {l.b && <span style={{ color: "rgba(0,0,0,.45)", lineHeight: 1.5 }}>•</span>}
                      <span style={{ fontSize: 16.5, lineHeight: 1.5 }}>{l.t}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px 0", color: "rgba(13,13,13,.92)" }}>
            {loggedIn ? (
              <>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: "10px 0 8px" }}>Red — sealed</h3>
                {["ticker universe", "factor definition", "filters", "parameters", "data sources", "notebook/code"].map(b => (
                  <div key={b} style={{ display: "flex", gap: 10, fontSize: 16, lineHeight: 1.6 }}><span style={{ color: "rgba(0,0,0,.4)" }}>•</span>{b}</div>
                ))}
                <p style={{ fontSize: 16, lineHeight: 1.55, marginTop: 14 }}>Use the Task Node standard from your Context: clarity, state, next action, acknowledgment.</p>
                <div style={{ background: "rgba(14,122,67,.07)", borderRadius: 10, padding: "12px 14px", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13.5, lineHeight: 1.6, margin: "12px 0" }}>
                  Death March Update · State: in progress / submitted · Public proof: artifact hash + timestamp · Private payload: sealed
                </div>
                <p style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.55 }}>Next step: post one Death March backtest update with a sealed artifact hash, not the notebook or results.</p>
                <div style={{ display: "flex", gap: 20, margin: "12px 0", color: "rgba(0,0,0,.4)" }}><Copy size={18} /><ArrowUp size={18} /></div>
              </>
            ) : (
              <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingBottom: 40 }}>
                <TaskNodeMark size={40} />
                <div style={{ fontSize: 26, fontWeight: 700, marginTop: 18 }}>What are you working on?</div>
                <div style={{ fontSize: 15.5, color: "rgba(0,0,0,.5)", marginTop: 8, maxWidth: 260, lineHeight: 1.4 }}>Log in to sync your Hive, Wallet, and saved tasks.</div>
              </div>
            )}
          </div>
          )}

          {/* composer — NO voice; only in chat view */}
          {screen === "chat" && (
          <div style={{ padding: "0 12px 84px" }}>
            <div style={{ border: "1px solid rgba(0,0,0,.12)", borderRadius: 28, padding: "10px 12px 10px 16px", display: "flex", alignItems: "center", gap: 10, boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}>
              <button onClick={() => { setPlusMenu(v => !v); setModelMenu(false); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", transition: "transform .2s", transform: plusMenu ? "rotate(45deg)" : "none" }}>
                <Plus size={22} color="rgba(13,13,13,.7)" />
              </button>
              <span style={{ flex: 1, fontSize: 16, color: "rgba(0,0,0,.4)" }}>Ask anything</span>
              <button onClick={() => { setModelMenu(v => !v); setPlusMenu(false); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4, fontSize: 14, fontWeight: 500, color: "rgba(0,0,0,.6)" }}>
                {model} <ChevronDown size={15} style={{ transition: "transform .2s", transform: modelMenu ? "rotate(180deg)" : "none" }} />
              </button>
              <span style={{ width: 36, height: 36, borderRadius: 999, background: ink, display: "flex", alignItems: "center", justifyContent: "center" }}><ArrowUp size={19} color="#fff" /></span>
            </div>
            <p style={{ textAlign: "center", fontSize: 12, color: "rgba(0,0,0,.4)", marginTop: 8 }}>Task Node can make mistakes. Check important info.</p>
          </div>
          )}
        </div>

        {/* drawer scrim */}
        {drawer && <div onClick={() => setDrawer(false)} style={{ position: "absolute", inset: 0, zIndex: 30, background: "rgba(0,0,0,.12)" }} />}

        {/* drawer — paddingBottom clears the browser bar so the account row is always reachable */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, zIndex: 40, width: 286, background: "#fff", boxShadow: "8px 0 24px rgba(0,0,0,.08)", display: "flex", flexDirection: "column", paddingTop: 52, paddingBottom: 80, boxSizing: "border-box", transform: drawer ? "translateX(0)" : "translateX(-100%)", transition: "transform .3s ease" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px 6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><TaskNodeMark size={24} /><span style={{ fontSize: 19, fontWeight: 700 }}>Task Node</span></div>
            <button onClick={() => setDrawer(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(13,13,13,.7)", padding: 4 }}><X size={24} strokeWidth={1.9} /></button>
          </div>

          <div style={{ padding: "6px 8px 0", display: "flex", flexDirection: "column", gap: 1 }}>
            {(loggedIn ? NAV : NAV.slice(0, 2)).map((n) => {
              const target = n.label === "Context" ? "context" : n.label === "Hive" ? "hive" : n.label === "Tasks" ? "tasks" : "chat";
              return (
                <Row key={n.label} icon={n.icon} label={n.label} trailing={n.trailing}
                  current={(n.label === "Context" && screen === "context") || (n.label === "Hive" && screen === "hive") || (n.label === "Tasks" && screen === "tasks")}
                  onClick={() => { setScreen(target); setDrawer(false); }} />
              );
            })}
          </div>

          {loggedIn ? (
            <>
              {/* recents scroll independently → minHeight:0 lets the flex child shrink & scroll */}
              <div style={{ padding: "10px 20px 4px", fontSize: 14, fontWeight: 600, color: "rgba(0,0,0,.5)" }}>Recents</div>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px" }}>
                {RECENTS.map((r) => (
                  <button key={r.t} onClick={() => { setScreen("chat"); setDrawer(false); }}
                    style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 14, background: r.active && screen === "chat" ? GREEN_BG : "transparent" }}>
                    {r.node && <NodeGlyph size={18} color={r.active && screen === "chat" ? GREEN : "rgba(0,0,0,.55)"} />}
                    <span style={{ flex: 1, fontSize: 15.5, fontWeight: r.active ? 600 : 400, color: r.active && screen === "chat" ? GREEN : "rgba(13,13,13,.9)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.t}</span>
                    {(r.active || r.t === "Hello") && <MoreHorizontal size={18} color="rgba(0,0,0,.4)" style={{ flexShrink: 0 }} />}
                  </button>
                ))}
              </div>

              {/* wallet balances — pinned above account row */}
              <div style={{ flexShrink: 0, padding: "8px 18px 6px", borderTop: "1px solid rgba(0,0,0,.06)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14.5 }}>
                  <Wallet size={15} color="rgba(0,0,0,.4)" /><b style={{ fontWeight: 700 }}>404,631.9</b><span style={{ color: "rgba(0,0,0,.45)" }}>PFT</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14.5, marginTop: 5 }}>
                  <Wallet size={15} color="rgba(0,0,0,.4)" /><b style={{ fontWeight: 700 }}>$3.1746</b><span style={{ color: "rgba(0,0,0,.45)" }}>chat</span>
                  <ChevronRight size={15} color="rgba(0,0,0,.35)" style={{ marginLeft: "auto" }} />
                </div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 12.5, fontWeight: 600, color: GREEN, border: `1px solid ${GREEN}`, borderRadius: 999, padding: "3px 9px" }}>
                  <LockOpen size={13} /> Unlocked
                </div>
              </div>

              {/* account row — pinned, always above browser bar */}
              <button onClick={() => setProfile(true)} style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 12, margin: "6px 8px 0", padding: "10px 12px", borderRadius: 16, background: profile ? "rgba(0,0,0,.05)" : "#fff", border: "none", cursor: "pointer", width: "calc(100% - 16px)" }}>
                <Avatar size={32} />
                <span style={{ flex: 1, textAlign: "left", overflow: "hidden" }}>
                  <div style={{ fontSize: 15.5, fontWeight: 600, color: "rgba(13,13,13,.9)" }}>@goodalexander</div>
                  <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>@goodalexander</div>
                </span>
                <CircleCheck size={20} color={GREEN} />
              </button>
            </>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              <div style={{ borderTop: "1px solid rgba(0,0,0,.08)", margin: "0 16px 16px" }} />
              <div style={{ padding: "0 16px" }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "rgba(13,13,13,.9)", margin: "0 0 6px" }}>Get the full Task Node</h3>
                <p style={{ fontSize: 14, lineHeight: 1.35, color: "rgba(0,0,0,.5)", margin: "0 0 14px" }}>Log in to access Tasks, Hive, Wallet, Context, and your saved chats.</p>
                <button onClick={() => { setDrawer(false); setLogin(true); }} style={{ width: "100%", background: ink, color: "#fff", border: "none", borderRadius: 999, padding: "13px 0", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Log in</button>
              </div>
            </>
          )}
        </div>

        {/* profile popout — scrollable, fully on-screen, sits above the browser bar */}
        {profile && (
          <>
            <div onClick={() => setProfile(false)} style={{ position: "absolute", inset: 0, zIndex: 55 }} />
            <div style={{ position: "absolute", left: 12, bottom: 86, zIndex: 60, width: 300, maxHeight: 600, overflowY: "auto", background: "#fff", borderRadius: 20, boxShadow: "0 16px 48px rgba(0,0,0,.22)", border: "1px solid rgba(0,0,0,.06)", padding: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px" }}>
                <Avatar size={34} />
                <span style={{ flex: 1, overflow: "hidden" }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>@goodalexander</div>
                  <div style={{ fontSize: 13.5, color: "rgba(0,0,0,.45)" }}>@goodalexander</div>
                </span>
                <ChevronRight size={18} color="rgba(0,0,0,.4)" />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 14px 10px", color: GREEN, fontSize: 14.5, fontWeight: 600 }}>
                <CircleCheck size={18} /> Signed in
              </div>

              <Row icon={<LockOpen size={20} strokeWidth={1.75} />} label="Wallet Unlocked" trailing={<ChevronRight size={18} color="rgba(0,0,0,.4)" />} onClick={() => setProfile(false)} />

              <Row icon={<Network size={20} strokeWidth={1.75} />} label="Directory" trailing={<Pill dark>#16</Pill>} onClick={() => setProfile(false)} />

              <button onClick={() => setProfile(false)} style={{ display: "flex", alignItems: "center", gap: 13, width: "100%", border: "none", background: "none", cursor: "pointer", borderRadius: 14, padding: "9px 12px", textAlign: "left" }}>
                <TelegramIcon size={28} />
                <span style={{ flex: 1 }}>
                  <div style={{ fontSize: 15.5, fontWeight: 600 }}>Telegram Chat</div>
                  <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>@goodalexander</div>
                </span>
                <Pill>Linked</Pill>
              </button>

              <div style={{ borderTop: "1px solid rgba(0,0,0,.08)", margin: "4px 8px" }} />
              <Row icon={<Settings size={20} strokeWidth={1.75} />} label="Settings" onClick={() => setProfile(false)} />
              <Row icon={<UserRound size={20} strokeWidth={1.75} />} label="Profile" onClick={() => setProfile(false)} />
              <div style={{ borderTop: "1px solid rgba(0,0,0,.08)", margin: "4px 8px" }} />
              <Row icon={<LifeBuoy size={20} strokeWidth={1.75} />} label="Help" trailing={<ChevronRight size={18} color="rgba(0,0,0,.4)" />} onClick={() => setProfile(false)} />
              <Row icon={<LogOut size={20} strokeWidth={1.75} />} label="Log out" onClick={signOut} />
            </div>
          </>
        )}

        {/* model picker — opens from the model pill */}
        {modelMenu && (
          <>
            <div onClick={() => setModelMenu(false)} style={{ position: "absolute", inset: 0, zIndex: 64 }} />
            <div style={{ position: "absolute", right: 12, bottom: 150, zIndex: 65, width: 320, maxHeight: 520, overflowY: "auto", background: "#fff", borderRadius: 22, boxShadow: "0 16px 48px rgba(0,0,0,.22)", border: "1px solid rgba(0,0,0,.06)", padding: 8 }}>
              {MODELS.map((m) => {
                const sel = m.name === model;
                return (
                  <button key={m.name} onClick={() => { setModel(m.name); setModelMenu(false); }}
                    style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", border: "none", cursor: "pointer", borderRadius: 16, padding: "12px 14px", background: sel ? "rgba(0,0,0,.05)" : "transparent" }}>
                    <span style={{ flex: 1 }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: ink }}>{m.name}</div>
                      <div style={{ fontSize: 14.5, color: "rgba(0,0,0,.5)", marginTop: 2 }}>{m.desc}</div>
                    </span>
                    {sel && <Check size={22} color={ink} strokeWidth={2.5} />}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* + attachment menu — opens from the plus button */}
        {plusMenu && (
          <>
            <div onClick={() => setPlusMenu(false)} style={{ position: "absolute", inset: 0, zIndex: 64 }} />
            <div style={{ position: "absolute", left: 12, bottom: 150, zIndex: 65, width: 300, background: "#fff", borderRadius: 22, boxShadow: "0 16px 48px rgba(0,0,0,.22)", border: "1px solid rgba(0,0,0,.06)", padding: 8 }}>
              <Row icon={<Paperclip size={21} strokeWidth={1.9} />} label="Upload photos & files" onClick={() => setPlusMenu(false)} />
              <div style={{ borderTop: "1px solid rgba(0,0,0,.08)", margin: "4px 10px" }} />
              <Row icon={<Wand2 size={21} strokeWidth={1.9} />} label="Context Refine" onClick={() => setPlusMenu(false)} />
              <Row icon={<ListPlus size={21} strokeWidth={1.9} />} label="Request a task" onClick={() => setPlusMenu(false)} />
              <Row icon={<MoreHorizontal size={21} strokeWidth={1.9} />} label="More" trailing={<ChevronRight size={18} color="rgba(0,0,0,.4)" />} onClick={() => setPlusMenu(false)} />
            </div>
          </>
        )}

        {/* Request task modal */}
        {requestOpen && (
          <>
            <div onClick={() => setRequestOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 75, background: "rgba(0,0,0,.35)" }} />
            <div style={{ position: "absolute", left: 16, right: 16, top: 150, zIndex: 76, background: "#fff", borderRadius: 22, boxShadow: "0 20px 50px rgba(0,0,0,.3)", padding: 22 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0, letterSpacing: -0.4 }}>Request task</h2>
                <button onClick={() => setRequestOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(0,0,0,.5)", padding: 2 }}><X size={24} /></button>
              </div>
              <p style={{ fontSize: 15, color: "rgba(0,0,0,.55)", margin: "6px 0 18px" }}>Describe the kind of work you want generated.</p>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Task details</div>
              <textarea value={requestText} onChange={(e) => setRequestText(e.target.value)}
                placeholder="Example: Give me a 2-4 hour engineering task that advances the PFTL task engine and has concrete verification evidence."
                style={{ width: "100%", boxSizing: "border-box", height: 130, resize: "none", background: TASKS_BG, border: "1px solid rgba(0,0,0,.08)", borderRadius: 14, padding: "14px 16px", fontSize: 15.5, lineHeight: 1.45, fontFamily: FONT, color: ink, outline: "none" }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 18, marginTop: 18 }}>
                <button onClick={() => setRequestOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, fontWeight: 600, color: "rgba(0,0,0,.7)" }}>Close</button>
                <button disabled={!requestText.trim()} onClick={() => { setRequestOpen(false); setRequestText(""); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 999, padding: "13px 22px", fontSize: 16, fontWeight: 600, cursor: requestText.trim() ? "pointer" : "default", background: requestText.trim() ? ink : "rgba(0,0,0,.12)", color: requestText.trim() ? "#fff" : "rgba(0,0,0,.4)" }}>
                  Request task <ArrowRight size={18} />
                </button>
              </div>
            </div>
          </>
        )}

        {/* login sheet (kept; no voice anywhere) */}
        {login && <div onClick={() => setLogin(false)} style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,.18)" }} />}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 46, background: "#fff", borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: "20px 22px 90px", boxShadow: "0 -8px 30px rgba(0,0,0,.12)", transform: login ? "translateY(0)" : "translateY(115%)", transition: "transform .32s cubic-bezier(.2,.8,.2,1)" }}>
          <button onClick={() => setLogin(false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 14 }}><X size={28} /></button>
          <h2 style={{ fontSize: 29, fontWeight: 700, textAlign: "center", margin: "8px 0 14px", letterSpacing: -0.5 }}>Log in or sign up</h2>
          <p style={{ textAlign: "center", fontSize: 16, color: "rgba(0,0,0,.55)", lineHeight: 1.35, margin: "0 0 24px" }}>Connect your wallet and Telegram to sync your Task Node.</p>
          <button onClick={() => { setLoggedIn(true); setLogin(false); setDrawer(true); }} style={{ width: "100%", background: ink, color: "#fff", border: "none", borderRadius: 999, padding: "16px 0", fontSize: 17, fontWeight: 600, cursor: "pointer", marginBottom: 12 }}>Continue with Wallet</button>
          <button onClick={() => { setLoggedIn(true); setLogin(false); setDrawer(true); }} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, border: "1px solid rgba(0,0,0,.18)", background: "#fff", borderRadius: 999, padding: "15px 0", fontSize: 17, fontWeight: 500, cursor: "pointer" }}>
            <TelegramIcon size={22} /> Continue with Telegram
          </button>
        </div>

        <BrowserBar />
      </div>
    </div>
  );
}

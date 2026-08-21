import React, { useState, useRef, useEffect } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import {
  SquarePen,
  Search,
  ListTodo,
  Wallet,
  BookOpen,
  MoreHorizontal,
  PanelLeft,
  ChevronRight,
  Plus,
  Store,
  ArrowUp,
  Paperclip,
  FileText,
  LogOut,
  LifeBuoy,
  Settings as SettingsIcon,
  User as UserIcon,
  Sparkles,
  Copy,
  Share,
  ArrowUpRight,
  Network,
  MessageSquare,
  MessageCircle,
  Bot,
  Database,
  Trophy,
  Send,
  ArrowDownToLine,
  ArrowDownLeft,
  Flame,
  Lightbulb,
  Check,
  Wand2,
  PenLine,
  X,
  Pencil,
  Shield,
  AlertTriangle,
  Activity,
  UserCheck,
  RefreshCw,
  Sparkle,
  Eye,
  EyeOff,
  ListPlus,
  Flag,
  HelpCircle,
  ExternalLink,
  ChevronDown,
  CreditCard,
  Lock,
  ArrowDown,
  Link2,
  Linkedin,
  ChevronUp,
} from "lucide-react";

/**
 * ChatGPT-style interface for the Task Node ecosystem.
 *
 * Replacements vs. ChatGPT:
 *   - Projects → Tasks
 *   - Codex    → Wallet
 *   - (new)    Context
 *   - Audio (mic + voice mode) is removed entirely.
 *
 * Task Node integration is deliberately subtle:
 *   - Tasks / Wallet / Context behave like ChatGPT's Projects page — they swap the
 *     main view instead of overlaying the chat, so the chat surface stays clean.
 *   - A small PFT balance pill sits above the user profile so balance is always
 *     glanceable without intruding on the chat.
 */

const RECENTS = [
  { id: "building", title: "Building Discussion" },
  { id: "greeting", title: "Greeting exchange", unread: true },
  { id: "sj-brainstorm", title: "Steve Jobs Brainstorming Pri…", unread: true },
  { id: "sj-motivation", title: "Steve Jobs Motivation Principles" },
  { id: "sj-essence", title: "Steve Jobs Essence" },
  { id: "sj-speech", title: "Steve Jobs Speech Guide" },
  { id: "sj-iphone", title: "Steve Jobs iPhone Launch" },
  { id: "sj-ipod", title: "Steve Jobs iPod Strategy" },
  { id: "sj-biz-1", title: "Steve Jobs Business Principles" },
  { id: "sj-biz-2", title: "Steve Jobs Business Insights" },
  { id: "caucasian", title: "Caucasian Quant Trader" },
  { id: "hamburger", title: "Hamburger Affordability Compari…" },
  { id: "logitcoin", title: "Logitcoin Research Packet" },
];

// Rich sample thread used by the "Building Discussion" recent so the chat
// shell has something to render that exercises markdown, the thinking trace,
// the action toolbar, edit affordances, etc.
const SAMPLE_THREAD = [
  { role: "user", text: "hi" },
  {
    role: "assistant",
    blocks: [{ type: "p", text: "Hey Alex — what are we building today?" }],
  },
  { role: "user", text: "not sure what do you think i should build" },
  {
    role: "assistant",
    thinking: { state: "stopped", duration: "7s" },
    blocks: [
      {
        type: "p",
        inline: [
          { text: "You should build something that feels " },
          { italic: "slightly illegal from the future" },
          { text: "." },
        ],
      },
      {
        type: "p",
        text:
          "Not another wrapper. Not another dashboard. Something where the first reaction is:",
      },
      {
        type: "quote",
        text: "\u201CWait\u2026 are people allowed to do that?\u201D",
      },
      {
        type: "p",
        text:
          "You\u2019re already circling the right territory with Logitcoin: turning AI inference itself into a consensus primitive is exactly the kind of \u201Cdifferent game\u201D thinking that matters. The question is whether you want to spend the next 5 years turning that into a civilization-scale protocol company.",
      },
      {
        type: "p",
        inline: [
          { text: "But if I were optimizing for maximum upside " },
          { italic: "and" },
          {
            text:
              " maximum personal leverage for you specifically, I\u2019d think in terms of one of these:",
          },
        ],
      },
      { type: "hr" },
      { type: "h2", text: "1. The \u201CAI Native Operating System\u201D Layer" },
      { type: "p", text: "Everyone is building AI apps." },
      { type: "p", text: "Almost nobody is building:" },
      {
        type: "ul",
        items: [
          "deterministic identity for agents",
          "persistent memory",
          "economic coordination",
          "verifiable cognition",
          "long-lived autonomous workflows",
          "agent-to-agent markets",
          "runtime governance",
        ],
      },
      { type: "p", text: "The ones who win this layer set the rules for the next decade. You already think in this register \u2014 protocols, primitives, verification \u2014 which is much rarer than it looks." },
      { type: "p", text: "Your unfair advantages here:" },
      {
        type: "ul",
        items: [
          "product taste",
          "anti-mediocrity",
          "deterministic truth",
          "charisma and persuasion",
          "ambitious infrastructure",
        ],
      },
      { type: "p", text: "That combination is unusual." },
      { type: "p", text: "Most people are:" },
      {
        type: "ul",
        items: [
          "either technical with no taste",
          "or aesthetic with no systems thinking",
        ],
      },
      { type: "p", text: "You seem to care about both simultaneously." },
      { type: "p", text: "That\u2019s where the interesting companies come from." },
      { type: "hr" },
      {
        type: "p",
        inline: [
          { text: "If I were placing bets on " },
          { italic: "you specifically" },
          { text: ", I\u2019d rank them:" },
        ],
      },
      {
        type: "ol",
        items: [
          "AI infrastructure with strong cryptographic / consensus / verification properties",
          "Taste / cognition / strategic-intelligence tooling",
          "Autonomous agent coordination systems",
          "New economic primitives around inference and cognition",
          "Media/tools that teach people how legendary operators think",
        ],
      },
      { type: "p", text: "The key is:" },
      { type: "p", text: "don\u2019t build something merely useful." },
      { type: "p", text: "Build something that creates a new category vocabulary." },
      { type: "p", text: "People remember:" },
      {
        type: "ul",
        items: [
          "\u201Csmartphone\u201D",
          "\u201Csearch engine\u201D",
          "\u201Csocial network\u201D",
          "\u201Ccloud computing\u201D",
        ],
      },
      { type: "p", text: "Not:" },
      { type: "ul", items: ["\u201CAI productivity SaaS #847.\u201D"] },
      { type: "p", text: "The real game is naming a new thing." },
    ],
  },
];

// Activity panel content for the sample thread — what the assistant pulled in
// while drafting its reply.
const SAMPLE_ACTIVITY = {
  duration: "7s",
  thinking: [
    { kind: "primary", label: "Personalizing", icon: "BookOpen" },
    { kind: "dot", label: "Tracking your projects" },
    { kind: "dot", label: "Identifying your interests" },
    { kind: "dot", label: "Exploring your goals" },
    { kind: "dot", label: "Matching key domains" },
  ],
  memory: [
    { title: "Steve Jobs Motivation Principles", preview: "Today \u2014 you are to step into the role of Steve Jobs. imagine that you are tasked with teaching\u2026" },
    { title: "Steve Jobs Essence", preview: "Today \u2014 your job is simple. give me the essence of steve jobs in 10 pages or less. plain english. a\u2026" },
    { title: "Steve Jobs Business Principles", preview: "Today \u2014 Please provide a summary of this in as much detail as you can. The main things are not\u2026" },
    { title: "Steve Jobs Business Principles", preview: "Today \u2014 Please provide a summary of this in as much detail as you can. The main things are not\u2026" },
    { title: "Logitcoin Research Packet", preview: "May 10, 2026 \u2014 asdf# Logitcoin Qwen Proof-Of-Logits External Research Packet Status: single-\u2026" },
    { title: "Steve Jobs Business Principles", preview: "Today \u2014 Please provide a summary of this in as much detail as you can. The main things are not\u2026" },
  ],
  memoryMore: 5,
  files: [{ name: "Pasted text.txt", type: "TXT" }],
};

const TASKS = {
  outstanding: [
    {
      id: "221bb8e5",
      fullId: "221bb8e5-5a64-44f6-a4fc-712841e01ee7",
      title: "Ship A 90 Percent Task Node Surface Cut",
      kind: "Personal",
      status: "Proposed",
      due: "Due May 17 @ 1:27 PM",
      fullDue: "Sun, May 17 at 1:27 PM",
      ago: "4m ago",
      pft: 3600,
      description:
        'Implement a temporary founder-controlled "simple mode" for Task Node that hides or disables the majority of nonessential product surfaces and leaves only the core path a user should take next. Scope this as an aggressive product triage patch, not a redesign: reduce visible navigation/actions, remove confusing secondary flows from the default view, and make one primary task/request path obvious.',
      steps: [
        "Inventory the current default Task Node entry surface and mark every visible nav item, button, module, or flow as keep, hide, or defer.",
        "Implement a simple-mode flag or equivalent product gate that makes the default user view expose only the minimum viable task/request path and one support or recovery path.",
        "Replace ambiguous or multi-action empty states with one clear primary call to action and remove competing CTAs from the first screen.",
        "Run the app locally or in staging and verify that the default surface area is visibly reduced by roughly 90% without breaking the primary path.",
      ],
      verification: {
        title: "Submit a screenshot",
        body:
          "Submit one screenshot of the updated Task Node default user view with simple mode active. The screenshot must visibly show a dramatically reduced interface with one dominant primary action and no broad navigation/menu sprawl.",
      },
    },
    {
      id: "e808cfe2",
      fullId: "e808cfe2-9a11-4d27-bc04-3a5f9b18d2c1",
      title: "Make The 8-K Extractor Emit Cited Rows",
      kind: "Personal",
      status: "Accepted",
      due: "Due May 16 @ 5:09 PM",
      fullDue: "Sat, May 16 at 5:09 PM",
      ago: "2h ago",
      pft: 3000,
      description:
        "Update the 8-K extraction pipeline so that every emitted row includes an explicit citation pointing back to the source document and offset. The goal is to make downstream verification trivially possible without re-reading the filing.",
      steps: [
        "Extend the extractor schema with a citation field that carries the filing URL, page or section reference, and a character offset range.",
        "Modify the extraction step to populate the citation from the source span used to produce each row.",
        "Backfill or invalidate any cached rows that lack citations so downstream consumers can rely on the new contract.",
        "Add an end-to-end test that fails if any emitted row is missing a citation.",
      ],
      verification: {
        title: "Submit a CSV sample",
        body:
          "Submit a CSV of at least 20 extracted rows from a real 8-K filing showing the new citation column populated for every row. The verifier will spot-check a handful against the source filing.",
      },
    },
  ],
  verification: [],
  refused: 62,
  rewarded: 92,
};

const ACTIVITY = [
  {
    group: "Today",
    items: [
      {
        kind: "in",
        title: "Daily airdrop",
        party: "Task Verifier",
        amount: 8400,
        time: "11:15 AM",
      },
      {
        kind: "in",
        title: "Task reward",
        sub: "Ship A 90 Percent Task Node Surface Cut",
        party: "Task Verifier",
        amount: 3600,
        time: "10:42 AM",
      },
      {
        kind: "out",
        title: "Verification fee",
        party: "Task Verifier",
        amount: 0,
        time: "11:15 AM",
      },
      {
        kind: "out",
        title: "Verification fee",
        party: "Task Verifier",
        amount: 0,
        time: "11:03 AM",
      },
    ],
  },
  {
    group: "Yesterday",
    items: [
      {
        kind: "in",
        title: "Daily airdrop",
        party: "Task Verifier",
        amount: 6200,
        time: "9:18 AM",
      },
      {
        kind: "in",
        title: "Task reward",
        sub: "Verify 8-K extractor output",
        party: "Task Verifier",
        amount: 3000,
        time: "5:09 PM",
      },
    ],
  },
  {
    group: "May 13",
    items: [
      {
        kind: "in",
        title: "Daily airdrop",
        party: "Task Verifier",
        amount: 7800,
        time: "9:24 AM",
      },
      {
        kind: "in",
        title: "Task reward",
        sub: "Wire post-fiat heartbeat composer",
        party: "Task Verifier",
        amount: 5400,
        time: "2:18 PM",
      },
    ],
  },
];

// 28 days of PFT generation, with one spike to match the user's screenshot
const PFT_GENERATION = [
  { d: "04/18", v: 1800 },
  { d: "04/19", v: 2200 },
  { d: "04/20", v: 1900 },
  { d: "04/21", v: 2400 },
  { d: "04/22", v: 2100 },
  { d: "04/23", v: 1700 },
  { d: "04/24", v: 2600 },
  { d: "04/25", v: 2300 },
  { d: "04/26", v: 1850 },
  { d: "04/27", v: 2900 },
  { d: "04/28", v: 2100 },
  { d: "04/29", v: 1950 },
  { d: "04/30", v: 2400 },
  { d: "05/01", v: 2800 },
  { d: "05/02", v: 2200 },
  { d: "05/03", v: 2050 },
  { d: "05/04", v: 2700 },
  { d: "05/05", v: 1900 },
  { d: "05/06", v: 2300 },
  { d: "05/07", v: 2500 },
  { d: "05/08", v: 2100 },
  { d: "05/09", v: 2400 },
  { d: "05/10", v: 2200 },
  { d: "05/11", v: 2800 },
  { d: "05/12", v: 36000 },
  { d: "05/13", v: 3200 },
  { d: "05/14", v: 2400 },
  { d: "05/15", v: 2200 },
];

const PFT_BREAKDOWN = [
  { label: "Personal", value: "42,900" },
  { label: "Network", value: "52,555.4" },
  { label: "Alpha", value: "10,000" },
];

const NFTS = [
  { id: "1", title: "Network Reliability Engineer", date: "May 13, 2026", g: "from-emerald-200 to-emerald-500" },
  { id: "2", title: "NFT 2026-05-12", date: "May 12, 2026", g: "from-stone-300 to-stone-700" },
  { id: "3", title: "Alpha Brief Analyst", date: "May 7, 2026", g: "from-amber-200 to-amber-600" },
  { id: "4", title: "Alpha Brief Analyst", date: "May 7, 2026", g: "from-sky-200 to-sky-600" },
];

const CONNECTIONS = [
  {
    handle: "rDVKRN…tyjB",
    match: 95,
    summary:
      "Strong synergy between your deterministic reward composers and their deterministic task-generation parser and verification policy fixes.",
    tags: ["Task-generation parser", "Verification policy", "DB-backed constraints"],
  },
  {
    handle: "rDep8S…EQKu",
    match: 88,
    summary:
      "Direct alignment in building deterministic Python reducers and handling task-generation logic with regression-style scoring.",
    tags: ["Python reducers", "Dependency-light validators", "Prompt escaping"],
  },
  {
    handle: "rGu432…Dcw9",
    match: 85,
    summary:
      "Overlap in deterministic tools and verification workflows with CLI-first JSON scoring and auditable triage.",
    tags: ["CLI JSON scoring", "Triage packet design", "Sim engineering"],
  },
];

const CONTEXT_SOURCES = [
  {
    key: "gdocs",
    icon: FileText,
    name: "Google Docs",
    desc: "Pull in research notes, drafts, and reference docs from Drive.",
    accent: "#1A73E8",
    status: "available",
  },
  {
    key: "notion",
    icon: BookOpen,
    name: "Notion",
    desc: "Bring workspaces, databases, and meeting notes into context.",
    accent: "#0D0D0D",
    status: "available",
  },
  {
    key: "pft",
    icon: Database,
    name: "Internal PFT Context",
    desc: "On-chain history, verifier feedback, and your task corpus.",
    accent: "#10A37F",
    status: "connected",
  },
];

// ChatGPT-inspired palette. Warm off-white that shifts very slightly between
// sidebar and main surface, with stone neutrals for borders and hovers.
const PALETTE = {
  bg: "#faf9f6",
  sidebar: "#f4f3ee",
  border: "#e8e6df",
  hover: "rgba(0,0,0,0.05)",
  active: "rgba(0,0,0,0.08)",
  text: "#0d0d0d",
  mute: "#6b6b66",
  brand: "#10a37f",
};

export default function ChatGPTTaskNode() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState("chat"); // chat | tasks | wallet | context | profile
  const [profileTab, setProfileTab] = useState("private"); // private | public
  const [profilePublic, setProfilePublic] = useState(true);
  const [selectedTask, setSelectedTask] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [editingMsg, setEditingMsg] = useState(null); // index of user message being edited
  const [editDraft, setEditDraft] = useState("");
  const [activeChat, setActiveChat] = useState(null);
  const [profileMenu, setProfileMenu] = useState(false);
  const [plusMenu, setPlusMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [model, setModel] = useState("Private - Instant");
  const [contextSource, setContextSource] = useState("pft");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState("auto");
  const [input, setInput] = useState("");
  const [tasksTab, setTasksTab] = useState("outstanding");
  const [thread, setThread] = useState([]);

  const inputRef = useRef(null);
  const profileRef = useRef(null);
  const plusRef = useRef(null);
  const moreRef = useRef(null);
  const modelRef = useRef(null);

  // close menus on outside click
  useEffect(() => {
    function onClick(e) {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileMenu(false);
      }
      if (plusRef.current && !plusRef.current.contains(e.target)) {
        setPlusMenu(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target)) {
        setMoreMenu(false);
      }
      if (modelRef.current && !modelRef.current.contains(e.target)) {
        setModelMenu(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // close settings modal on Escape
  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(e) {
      if (e.key === "Escape") setSettingsOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  // close task modal on Escape
  useEffect(() => {
    if (!selectedTask) return;
    function onKey(e) {
      if (e.key === "Escape") setSelectedTask(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedTask]);

  // close share modal on Escape
  useEffect(() => {
    if (!shareOpen) return;
    function onKey(e) {
      if (e.key === "Escape") setShareOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shareOpen]);

  // close activity panel on Escape
  useEffect(() => {
    if (!activityOpen) return;
    function onKey(e) {
      if (e.key === "Escape") setActivityOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activityOpen]);

  function sendMessage() {
    const text = input.trim();
    if (!text) return;
    setThread((t) => [
      ...t,
      { role: "user", text },
      {
        role: "assistant",
        blocks: [
          {
            type: "p",
            text:
              "This is a UX clone, so I'm not wired up to a model \u2014 but if I were, your message would land here.",
          },
        ],
      },
    ]);
    setInput("");
    if (!activeChat) setActiveChat({ id: "new", title: text.slice(0, 40) });
  }

  function openRecent(chat) {
    setView("chat");
    setActiveChat(chat);
    if (chat.id === "building") {
      setThread(SAMPLE_THREAD);
    } else {
      setThread([
        { role: "user", text: `Tell me about "${chat.title}"` },
        {
          role: "assistant",
          blocks: [
            {
              type: "p",
              text:
                "Mock thread. In a real build this would hydrate from your conversation history.",
            },
          ],
        },
      ]);
    }
  }

  function newChat() {
    setView("chat");
    setActiveChat(null);
    setThread([]);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  // ---------- shared atoms ----------

  const SidebarBtn = ({ icon: Icon, label, active, onClick, badge }) => (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors"
      style={{
        background: active ? PALETTE.active : "transparent",
        color: PALETTE.text,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = PALETTE.hover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
      {sidebarOpen && <span className="flex-1 truncate">{label}</span>}
      {sidebarOpen && badge && (
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ background: "#0d0d0d", color: "white" }}
        >
          {badge}
        </span>
      )}
    </button>
  );

  // ---------- sidebar ----------

  const sidebarWidth = sidebarOpen ? 260 : 56;

  const Sidebar = (
    <aside
      className="flex h-full flex-col transition-all duration-200 ease-out"
      style={{
        width: sidebarWidth,
        background: PALETTE.sidebar,
        borderRight: `1px solid ${PALETTE.border}`,
      }}
    >
      {/* header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        {sidebarOpen ? (
          <>
            <span
              className="text-[17px] font-semibold tracking-tight"
              style={{ color: PALETTE.text }}
            >
              Task Node
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="rounded-md p-1.5 transition-colors"
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = PALETTE.hover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              title="Collapse sidebar"
            >
              <PanelLeft size={18} strokeWidth={1.75} />
            </button>
          </>
        ) : (
          <div className="flex w-full flex-col items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full"
              style={{ background: "#0d0d0d", color: "white" }}
            >
              <Sparkles size={14} strokeWidth={2} />
            </div>
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-md p-1.5 transition-colors"
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = PALETTE.hover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              title="Open sidebar"
            >
              <PanelLeft size={18} strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      {/* primary nav */}
      <nav className="flex flex-col gap-0.5 px-2 pt-1">
        <SidebarBtn
          icon={SquarePen}
          label="New chat"
          active={view === "chat" && !activeChat}
          onClick={newChat}
        />
        <SidebarBtn
          icon={Search}
          label="Search chats"
          onClick={() => {
            /* no-op placeholder */
          }}
        />
        <SidebarBtn
          icon={ListTodo}
          label="Tasks"
          active={view === "tasks"}
          onClick={() => setView("tasks")}
          badge={sidebarOpen ? TASKS.outstanding.length : null}
        />
        <SidebarBtn
          icon={Wallet}
          label="Wallet"
          active={view === "wallet"}
          onClick={() => setView("wallet")}
        />
        <SidebarBtn
          icon={BookOpen}
          label="Context"
          active={view === "context"}
          onClick={() => setView("context")}
        />
        <div className="relative" ref={moreRef}>
          <SidebarBtn
            icon={MoreHorizontal}
            label="More"
            active={moreMenu}
            onClick={() => setMoreMenu((s) => !s)}
          />
          {moreMenu && sidebarOpen && (
            <div
              className="absolute left-full top-0 z-30 ml-2 w-[240px] overflow-hidden rounded-2xl py-1.5"
              style={{
                background: "white",
                border: `1px solid ${PALETTE.border}`,
                boxShadow:
                  "0 10px 30px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)",
              }}
            >
              <MenuRow icon={Flame} label="Motivation" />
              <MenuRow icon={Lightbulb} label="Brainstorming" />
              <MenuRow icon={Wand2} label="Context Refine" />
              <MenuRow icon={PenLine} label="Context Rewrite" />
              <div
                className="my-1 h-px"
                style={{ background: PALETTE.border }}
              />
              <MenuRow icon={Bot} label="Agents" />
              <MenuRow
                icon={MessageSquare}
                label="Messages"
                trailing={
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: "#0d0d0d", color: "white" }}
                  >
                    1
                  </span>
                }
              />
            </div>
          )}
        </div>
      </nav>

      {/* recents */}
      {sidebarOpen && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className="px-4 pb-1 pt-2 text-[12px] font-semibold"
            style={{ color: PALETTE.text }}
          >
            Recents
          </div>
          <div className="flex flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {RECENTS.map((r) => (
              <button
                key={r.id}
                onClick={() => openRecent(r)}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors"
                style={{
                  background:
                    activeChat?.id === r.id ? PALETTE.active : "transparent",
                  color: PALETTE.text,
                }}
                onMouseEnter={(e) => {
                  if (activeChat?.id !== r.id)
                    e.currentTarget.style.background = PALETTE.hover;
                }}
                onMouseLeave={(e) => {
                  if (activeChat?.id !== r.id)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                {r.unread && (
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: "#2563eb" }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {!sidebarOpen && <div className="flex-1" />}

      {/* PFT balance pill (subtle Task Node integration) */}
      {sidebarOpen && (
        <button
          onClick={() => setView("wallet")}
          className="mx-2 mb-1 flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left transition-colors"
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = PALETTE.hover)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
          title="View wallet"
        >
          <div className="flex items-center gap-2">
            <Wallet size={14} strokeWidth={1.75} style={{ color: PALETTE.mute }} />
            <span
              className="text-[12.5px] font-medium tabular-nums"
              style={{ color: PALETTE.text }}
            >
              851,718
            </span>
            <span className="text-[11px]" style={{ color: PALETTE.mute }}>
              PFT
            </span>
          </div>
          <ChevronRight size={14} style={{ color: PALETTE.mute }} />
        </button>
      )}

      {/* profile */}
      <div className="relative px-2 pb-3 pt-1" ref={profileRef}>
        <button
          onClick={() => setProfileMenu((s) => !s)}
          className="flex w-full items-center gap-2 rounded-lg p-1.5 transition-colors"
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = PALETTE.hover)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
        >
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ background: PALETTE.brand }}
          >
            AG
          </div>
          {sidebarOpen && (
            <>
              <div className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                <span
                  className="truncate text-[13px] font-medium"
                  style={{ color: PALETTE.text }}
                >
                  Alex Good
                </span>
                <span className="text-[11px]" style={{ color: PALETTE.mute }}>
                  Pro · #16
                </span>
              </div>
              <div
                className="rounded-md p-1"
                title="Store"
                style={{ color: PALETTE.mute }}
              >
                <Store size={14} strokeWidth={1.75} />
              </div>
            </>
          )}
        </button>

        {profileMenu && sidebarOpen && (
          <div
            className="absolute z-30 overflow-hidden rounded-2xl"
            style={{
              bottom: "calc(100% + 4px)",
              left: 8,
              right: 8,
              background: "white",
              border: `1px solid ${PALETTE.border}`,
              boxShadow:
                "0 10px 30px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)",
            }}
          >
            <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-black/[0.03]">
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: PALETTE.brand }}
              >
                AG
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-[13px] font-medium">Alex Good</span>
                <span className="text-[11px]" style={{ color: PALETTE.mute }}>
                  Pro
                </span>
              </div>
              <ChevronRight
                size={16}
                className="ml-auto"
                style={{ color: PALETTE.mute }}
              />
            </button>
            <div
              className="my-1 h-px"
              style={{ background: PALETTE.border }}
            />
            <MenuRow
              icon={Network}
              label="Directory"
              trailing={
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ background: "#0d0d0d", color: "white" }}
                >
                  #16
                </span>
              }
            />
            <MenuRow
              icon={SettingsIcon}
              label="Settings"
              onClick={() => {
                setSettingsOpen(true);
                setProfileMenu(false);
              }}
            />
            <MenuRow
              icon={UserIcon}
              label="Profile"
              onClick={() => {
                setView("profile");
                setProfileMenu(false);
              }}
            />
            <MenuRow icon={LifeBuoy} label="Help" trailing={<ChevronRight size={14} />} />
            <div
              className="my-1 h-px"
              style={{ background: PALETTE.border }}
            />
            <MenuRow icon={LogOut} label="Log out" />
          </div>
        )}
      </div>
    </aside>
  );

  // ---------- main views ----------

  const ChatEmpty = (
    <div className="flex w-full max-w-[760px] flex-col items-center px-4">
      <h1
        className="mb-6 text-center text-[26px] font-normal tracking-tight"
        style={{ color: PALETTE.text }}
      >
        What are you working on?
      </h1>
      {InputBar()}
    </div>
  );

  const ChatThread = (
    <div className="relative flex w-full max-w-[760px] flex-1 flex-col px-4">
      <div className="flex-1 overflow-y-auto py-6">
        {thread.map((m, i) =>
          m.role === "user" ? (
            <UserMessage
              key={i}
              text={m.text || m.content}
              isEditing={editingMsg === i}
              draft={editDraft}
              onStartEdit={() => {
                setEditingMsg(i);
                setEditDraft(m.text || m.content || "");
              }}
              onCancelEdit={() => setEditingMsg(null)}
              onSaveEdit={() => {
                setThread((t) =>
                  t.map((row, idx) =>
                    idx === i ? { ...row, text: editDraft } : row,
                  ),
                );
                setEditingMsg(null);
              }}
              onDraftChange={setEditDraft}
              palette={PALETTE}
            />
          ) : (
            <AssistantMessage
              key={i}
              message={m}
              prev={thread[i - 1]}
              onOpenActivity={() => setActivityOpen(true)}
              palette={PALETTE}
            />
          ),
        )}
      </div>
      {/* scroll-to-bottom floating button */}
      <button
        onClick={(e) => {
          const list = e.currentTarget.parentElement.querySelector(
            ".overflow-y-auto",
          );
          if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
        }}
        className="absolute right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-md transition-colors"
        style={{
          border: `1px solid ${PALETTE.border}`,
          color: PALETTE.text,
          bottom: 96,
        }}
        title="Scroll to bottom"
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = PALETTE.hover)
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "white")}
      >
        <ArrowDown size={14} strokeWidth={2} />
      </button>
      <div className="pb-6">
        {InputBar()}
      </div>
    </div>
  );

  function InputBar() {
    return (
      <div className="relative w-full">
        <div
          className="flex items-center gap-1 rounded-[28px] bg-white px-2 py-1.5"
          style={{
            border: `1px solid ${PALETTE.border}`,
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
          }}
        >
          {/* plus button */}
          <div className="relative" ref={plusRef}>
            <button
              onClick={() => setPlusMenu((s) => !s)}
              className="flex h-9 w-9 items-center justify-center rounded-full transition-colors"
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = PALETTE.hover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              title="Add"
            >
              <Plus size={20} strokeWidth={1.75} />
            </button>

            {plusMenu && (
              <div
                className="absolute bottom-12 left-0 z-40 w-[260px] overflow-hidden rounded-2xl py-2"
                style={{
                  background: "white",
                  border: `1px solid ${PALETTE.border}`,
                  boxShadow:
                    "0 10px 30px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)",
                }}
              >
                <MenuRow icon={Paperclip} label="Upload photos & files" />
                <div
                  className="my-1 h-px"
                  style={{ background: PALETTE.border }}
                />
                <MenuRow icon={Flame} label="Motivation" />
                <MenuRow icon={Lightbulb} label="Brainstorming" />
                <MenuRow icon={Wand2} label="Context Refine" />
                <MenuRow icon={PenLine} label="Context Rewrite" />
                <MenuRow
                  icon={ListPlus}
                  label="Request a task"
                  onClick={() => {
                    setPlusMenu(false);
                    setView("tasks");
                  }}
                />
                <MenuRow
                  icon={MoreHorizontal}
                  label="More"
                  trailing={<ChevronRight size={14} />}
                />
              </div>
            )}
          </div>

          {/* text input */}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Ask anything"
            className="flex-1 bg-transparent px-1.5 py-2 text-[15px] outline-none placeholder:text-[#9a9a93]"
            style={{ color: PALETTE.text }}
          />

          {/* model picker */}
          <div className="relative" ref={modelRef}>
            <button
              onClick={() => setModelMenu((s) => !s)}
              className="hidden items-center gap-1 rounded-full px-3 py-1.5 text-[13px] transition-colors sm:flex"
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = PALETTE.hover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              style={{ color: PALETTE.mute }}
            >
              {model}
              <ChevronRight
                size={14}
                style={{ transform: "rotate(90deg)" }}
              />
            </button>

            {modelMenu && (
              <div
                className="absolute bottom-12 right-0 z-40 w-[240px] overflow-hidden rounded-2xl py-1.5"
                style={{
                  background: "white",
                  border: `1px solid ${PALETTE.border}`,
                  boxShadow:
                    "0 10px 30px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)",
                }}
              >
                <div
                  className="flex items-center justify-between px-3 pb-1 pt-1 text-[12.5px]"
                  style={{ color: PALETTE.mute }}
                >
                  <span>Latest</span>
                  <span className="tabular-nums">0.1.0</span>
                </div>
                <ModelOption
                  label="Private - Instant"
                  selected={model === "Private - Instant"}
                  onClick={() => {
                    setModel("Private - Instant");
                    setModelMenu(false);
                  }}
                />
                <ModelOption
                  label="Private - Thinking"
                  selected={model === "Private - Thinking"}
                  onClick={() => {
                    setModel("Private - Thinking");
                    setModelMenu(false);
                  }}
                />
                <ModelOption
                  label="Frontier - Instant"
                  selected={model === "Frontier - Instant"}
                  onClick={() => {
                    setModel("Frontier - Instant");
                    setModelMenu(false);
                  }}
                />
                <ModelOption
                  label="Frontier - Thinking"
                  selected={model === "Frontier - Thinking"}
                  onClick={() => {
                    setModel("Frontier - Thinking");
                    setModelMenu(false);
                  }}
                />
                <div
                  className="my-1 h-px"
                  style={{ background: PALETTE.border }}
                />
                <button
                  onClick={() => {
                    setModelMenu(false);
                    setSettingsOpen(true);
                  }}
                  className="flex w-full items-center px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-black/[0.04]"
                  style={{ color: PALETTE.text }}
                >
                  Configure\u2026
                </button>
              </div>
            )}
          </div>

          {/* send button — replaces mic + voice mode */}
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-full transition-all"
            style={{
              background: input.trim() ? "#0d0d0d" : "#e5e5e0",
              color: input.trim() ? "white" : "#a5a59e",
              cursor: input.trim() ? "pointer" : "default",
            }}
            title="Send"
          >
            <ArrowUp size={18} strokeWidth={2.25} />
          </button>
        </div>

        {/* footer fineprint when in thread */}
        {thread.length > 0 && (
          <div
            className="pt-2 text-center text-[11px]"
            style={{ color: PALETTE.mute }}
          >
            Task Node can make mistakes. Check important info.
          </div>
        )}
      </div>
    );
  }

  // Tasks view — Outstanding / Verification / Refused / Rewarded
  const TasksView = (
    <div className="mx-auto flex w-full max-w-[860px] flex-col px-5 py-10 sm:px-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="text-[28px] font-semibold tracking-tight"
            style={{ color: PALETTE.text }}
          >
            Tasks
          </h1>
          <p className="mt-1 text-[13.5px]" style={{ color: PALETTE.mute }}>
            Work proposed, accepted, and verified across the network.
          </p>
        </div>
        <button
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "#0d0d0d" }}
        >
          <Plus size={16} strokeWidth={2} />
          Request task
        </button>
      </div>

      {/* tabs — scrollable on narrow viewports */}
      <div
        className="mb-4 flex items-center gap-5 overflow-x-auto border-b text-[13.5px]"
        style={{
          borderColor: PALETTE.border,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      >
        {[
          { k: "outstanding", label: "Outstanding", count: TASKS.outstanding.length },
          { k: "verification", label: "Verification", count: TASKS.verification.length },
          { k: "refused", label: "Refused", count: TASKS.refused },
          { k: "rewarded", label: "Rewarded", count: TASKS.rewarded },
        ].map((t) => {
          const active = tasksTab === t.k;
          return (
            <button
              key={t.k}
              onClick={() => setTasksTab(t.k)}
              className="relative flex shrink-0 items-center gap-2 whitespace-nowrap pb-3 pt-2 transition-colors"
              style={{
                color: active ? PALETTE.text : PALETTE.mute,
                fontWeight: active ? 600 : 500,
              }}
            >
              {t.label}
              <span
                className="rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums"
                style={{
                  background: active ? "#0d0d0d" : "transparent",
                  color: active ? "white" : PALETTE.mute,
                  border: active ? "none" : `1px solid ${PALETTE.border}`,
                }}
              >
                {t.count}
              </span>
              {active && (
                <span
                  className="absolute -bottom-px left-0 right-0 h-[2px]"
                  style={{ background: "#0d0d0d" }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* task list */}
      {tasksTab === "outstanding" && (
        <div className="flex flex-col gap-2">
          {TASKS.outstanding.map((task) => (
            <button
              key={task.id}
              onClick={() => setSelectedTask(task)}
              className="group flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left transition-shadow hover:shadow-sm"
              style={{ border: `1px solid ${PALETTE.border}` }}
            >
              <div className="min-w-0 flex-1 pr-4">
                <div
                  className="truncate text-[14.5px] font-medium"
                  style={{ color: PALETTE.text }}
                >
                  {task.title}
                </div>
                <div
                  className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
                  style={{ color: PALETTE.mute }}
                >
                  <span>{task.kind}</span>
                  <StatusPill status={task.status} />
                  <span>·</span>
                  <span>{task.due}</span>
                  <span>·</span>
                  <span>{task.ago}</span>
                </div>
                <div
                  className="mt-1 flex items-center gap-1 text-[11px] tabular-nums"
                  style={{ color: PALETTE.mute }}
                >
                  <span>ID: {task.id}…</span>
                  <ArrowUpRight size={11} />
                </div>
              </div>
              <div
                className="text-[15px] font-semibold tabular-nums"
                style={{ color: PALETTE.text }}
              >
                {task.pft.toLocaleString()}{" "}
                <span
                  className="text-[11px] font-medium"
                  style={{ color: PALETTE.mute }}
                >
                  PFT
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {tasksTab === "verification" && (
        <EmptyState
          icon={Trophy}
          title="Nothing awaiting verification"
          desc="When a verifier picks up your submission it will appear here."
        />
      )}
      {tasksTab === "refused" && (
        <EmptyState
          icon={MoreHorizontal}
          title="62 refused tasks"
          desc="Historical refusals are summarized rather than expanded by default."
        />
      )}
      {tasksTab === "rewarded" && (
        <EmptyState
          icon={Trophy}
          title="92 rewarded tasks"
          desc="Open the wallet to see the resulting PFT transfers."
        />
      )}
    </div>
  );

  // Wallet view — hero balance + grouped activity
  const WalletView = (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 py-10 sm:px-8">
      {/* HERO BALANCE */}
      <section
        className="relative overflow-hidden rounded-2xl bg-white p-7"
        style={{ border: `1px solid ${PALETTE.border}` }}
      >
        {/* soft decorative orb */}
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full"
          style={{
            background:
              "radial-gradient(circle at center, rgba(16,163,127,0.18) 0%, rgba(16,163,127,0) 70%)",
          }}
        />
        <div
          className="pointer-events-none absolute -bottom-20 -left-20 h-48 w-48 rounded-full"
          style={{
            background:
              "radial-gradient(circle at center, rgba(13,13,13,0.05) 0%, rgba(13,13,13,0) 70%)",
          }}
        />

        <div className="relative">
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: PALETTE.mute }}
          >
            Available balance
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="text-[52px] font-semibold leading-none tabular-nums"
              style={{ color: PALETTE.text }}
            >
              851,718
            </span>
            <span
              className="text-[18px] font-medium"
              style={{ color: PALETTE.mute }}
            >
              PFT
            </span>
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[12.5px]">
            <span
              className="font-semibold tabular-nums"
              style={{ color: "#16a34a" }}
            >
              +8,400 PFT
            </span>
            <span style={{ color: PALETTE.mute }}>
              received in the last 24h
            </span>
          </div>

          {/* address chip */}
          <button
            className="mt-5 inline-flex items-center gap-2 rounded-full py-1.5 pl-3 pr-2 transition-colors"
            style={{ border: `1px solid ${PALETTE.border}` }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = PALETTE.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
            title="Copy address"
          >
            <span
              className="font-mono text-[12px] tabular-nums"
              style={{ color: PALETTE.text }}
            >
              rPo8GkCA9YMKzu…JHxNx
            </span>
            <Copy size={11} style={{ color: PALETTE.mute }} />
          </button>

          {/* actions */}
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              className="flex items-center gap-2 rounded-full px-5 py-2.5 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
              style={{ background: "#0d0d0d" }}
            >
              <Send size={15} strokeWidth={2} />
              Send
            </button>
            <button
              className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[13.5px] font-medium transition-colors"
              style={{
                border: `1px solid ${PALETTE.border}`,
                color: PALETTE.text,
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = PALETTE.hover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "white")
              }
            >
              <ArrowDownToLine size={15} strokeWidth={2} />
              Receive
            </button>
          </div>

          {/* footer flow line */}
          <div
            className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-4 text-[11.5px]"
            style={{
              borderColor: PALETTE.border,
              color: PALETTE.mute,
            }}
          >
            <span>
              <span
                className="font-semibold tabular-nums"
                style={{ color: "#16a34a" }}
              >
                +47,200
              </span>{" "}
              in this week
            </span>
            <span style={{ color: PALETTE.border }}>·</span>
            <span>
              <span
                className="font-semibold tabular-nums"
                style={{ color: PALETTE.text }}
              >
                −3,840
              </span>{" "}
              out
            </span>
            <span style={{ color: PALETTE.border }}>·</span>
            <span>
              <span
                className="font-semibold tabular-nums"
                style={{ color: PALETTE.text }}
              >
                12
              </span>{" "}
              transactions
            </span>
          </div>
        </div>
      </section>

      {/* ACTIVITY */}
      <ProfileCard
        title="Activity"
        subtitle="Your latest transactions"
        trailing={
          <button
            className="text-[12.5px] hover:underline"
            style={{ color: PALETTE.mute }}
          >
            View all
          </button>
        }
        palette={PALETTE}
      >
        <div className="flex flex-col">
          {ACTIVITY.map((group, gi) => (
            <div key={group.group}>
              <div
                className="mb-1 mt-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] first:mt-0"
                style={{ color: PALETTE.mute }}
              >
                {group.group}
              </div>
              <div className="flex flex-col">
                {group.items.map((tx, i) => (
                  <ActivityRow
                    key={`${gi}-${i}`}
                    tx={tx}
                    palette={PALETTE}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </ProfileCard>
    </div>
  );

  // Context view — Hive Mind / Directory / Agents / Messages
  // Context view — three connectable sources
  const ContextView = (
    <div className="mx-auto flex w-full max-w-[760px] flex-col px-5 py-10 sm:px-8">
      <h1
        className="text-[28px] font-semibold tracking-tight"
        style={{ color: PALETTE.text }}
      >
        Context
      </h1>
      <p className="mt-1 text-[13.5px]" style={{ color: PALETTE.mute }}>
        Choose where the assistant draws context from. You can connect more
        than one source.
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        {CONTEXT_SOURCES.map((src) => {
          const Icon = src.icon;
          const active = contextSource === src.key;
          return (
            <button
              key={src.key}
              onClick={() => setContextSource(src.key)}
              className="group flex items-center gap-4 rounded-2xl bg-white p-4 text-left transition-all"
              style={{
                border: `1.5px solid ${active ? "#0d0d0d" : PALETTE.border}`,
                boxShadow: active ? "0 0 0 3px rgba(13,13,13,0.06)" : "none",
              }}
            >
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                style={{
                  background: `${src.accent}14`,
                  color: src.accent,
                }}
              >
                <Icon size={20} strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-[14.5px] font-semibold"
                    style={{ color: PALETTE.text }}
                  >
                    {src.name}
                  </span>
                  {src.status === "connected" && (
                    <span
                      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        background: "#dcfce7",
                        color: "#166534",
                      }}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: "#16a34a" }}
                      />
                      Connected
                    </span>
                  )}
                </div>
                <div
                  className="mt-0.5 text-[12.5px] leading-relaxed"
                  style={{ color: PALETTE.mute }}
                >
                  {src.desc}
                </div>
              </div>
              {/* radio indicator */}
              <div
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                style={{
                  border: `1.5px solid ${active ? "#0d0d0d" : "#c9c4b3"}`,
                  background: active ? "#0d0d0d" : "transparent",
                }}
              >
                {active && (
                  <span
                    className="block h-2 w-2 rounded-full"
                    style={{ background: "white" }}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div
        className="mt-6 rounded-2xl px-4 py-3 text-[12px] leading-relaxed"
        style={{
          background: PALETTE.sidebar,
          color: PALETTE.mute,
          border: `1px solid ${PALETTE.border}`,
        }}
      >
        The active context source feeds the assistant alongside your prompt.
        Internal PFT Context is always available on Task Node; external
        connectors require authorization.
      </div>
    </div>
  );

  // Profile view — Private (you) / Public (what others see)
  const ProfileView = (
    <div className="mx-auto flex w-full max-w-[760px] flex-col px-5 py-8 sm:px-8">
      {/* header: tabs + publish toggle */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center rounded-full p-0.5"
          style={{ background: "#f0eee8" }}
        >
          {[
            { k: "private", label: "Private" },
            { k: "public", label: "Public" },
          ].map((t) => {
            const active = profileTab === t.k;
            return (
              <button
                key={t.k}
                onClick={() => setProfileTab(t.k)}
                className="rounded-full px-4 py-1.5 text-[13px] font-medium transition-all"
                style={{
                  background: active ? "white" : "transparent",
                  color: active ? PALETTE.text : PALETTE.mute,
                  boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setProfilePublic((s) => !s)}
          className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors"
          style={{
            background: profilePublic ? "#dcfce7" : PALETTE.sidebar,
            color: profilePublic ? "#166534" : PALETTE.mute,
            border: `1px solid ${profilePublic ? "transparent" : PALETTE.border}`,
          }}
        >
          {profilePublic ? <Eye size={13} /> : <EyeOff size={13} />}
          {profilePublic ? "Profile public" : "Profile hidden"}
        </button>
      </div>

      {profileTab === "private" && (
        <div className="flex flex-col gap-4">
          {/* Profile Studio */}
          <ProfileCard
            title="Profile Studio"
            subtitle="Generate the picture that represents you across the network"
            palette={PALETTE}
          >
            <div className="flex gap-4">
              <div
                className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl"
                style={{
                  background:
                    "conic-gradient(from 220deg, #0d0d0d, #4a4a44, #c9c4b3, #0d0d0d)",
                }}
              />
              <div className="min-w-0 flex-1">
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: PALETTE.mute }}
                >
                  Current picture
                </div>
                <div
                  className="mt-0.5 text-[14.5px] font-semibold"
                  style={{ color: PALETTE.text }}
                >
                  Network Verification Engineer
                </div>
                <div
                  className="mt-0.5 text-[12px]"
                  style={{ color: PALETTE.mute }}
                >
                  Today's gift NFT · minted May 13, 2026
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <PillButton icon={RefreshCw}>Regenerate</PillButton>
                  <PillButton icon={Sparkle} dark>
                    Mint as NFT
                  </PillButton>
                </div>
              </div>
            </div>
          </ProfileCard>

          {/* Today's airdrop */}
          <ProfileCard
            title="Today's airdrop"
            subtitle="Daily feedback on what the network would currently pay you"
            palette={PALETTE}
          >
            <div className="flex items-end gap-3">
              <div
                className="text-[40px] font-semibold leading-none tabular-nums"
                style={{ color: PALETTE.text }}
              >
                8,400
              </div>
              <div
                className="pb-1.5 text-[14px] font-medium"
                style={{ color: PALETTE.mute }}
              >
                PFT
              </div>
              <div
                className="ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ background: "#fef3c7", color: "#92400e" }}
              >
                Core 84 / 100
              </div>
            </div>
            <p
              className="mt-3 text-[13px] leading-relaxed"
              style={{ color: PALETTE.mute }}
            >
              Today's payout reflects high retained value from recent
              core-network shipping, balanced by still-limited proof of wider
              adoption impact.
            </p>
            <div
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3"
            >
              <MiniNote
                title="Raised today"
                body="Shipping core network fixes and automation around rewards and NFT generation."
                palette={PALETTE}
              />
              <MiniNote
                title="Kept it lower"
                body="The main limiter is recent product stabilization rather than measured network growth."
                palette={PALETTE}
              />
              <MiniNote
                title="To improve"
                body="Tie shipped fixes to visible user adoption and repeatable network growth loops."
                palette={PALETTE}
              />
            </div>
          </ProfileCard>

          {/* PFT Generation chart */}
          <ProfileCard
            title="PFT generation"
            subtitle="Last 28 days"
            palette={PALETTE}
          >
            <div style={{ height: 180, marginLeft: -8, marginRight: -8 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={PFT_GENERATION}
                  margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="pftFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0d0d0d" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="#0d0d0d" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="d"
                    interval={5}
                    tick={{ fontSize: 10, fill: "#9a958a" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis hide />
                  <Tooltip
                    cursor={{ stroke: "#c9c4b3", strokeDasharray: "3 3" }}
                    contentStyle={{
                      background: "white",
                      border: `1px solid ${PALETTE.border}`,
                      borderRadius: 10,
                      fontSize: 12,
                      padding: "6px 10px",
                    }}
                    labelStyle={{ color: PALETTE.mute, fontSize: 11 }}
                    formatter={(value) => [`${value.toLocaleString()} PFT`, ""]}
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="#0d0d0d"
                    strokeWidth={2}
                    fill="url(#pftFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div
              className="mt-2 grid grid-cols-3 gap-3 border-t pt-4"
              style={{ borderColor: PALETTE.border }}
            >
              {PFT_BREAKDOWN.map((b) => (
                <div key={b.label}>
                  <div
                    className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                    style={{ color: PALETTE.mute }}
                  >
                    {b.label}
                  </div>
                  <div
                    className="mt-0.5 text-[18px] font-semibold tabular-nums"
                    style={{ color: PALETTE.text }}
                  >
                    {b.value}
                  </div>
                </div>
              ))}
            </div>
          </ProfileCard>

          {/* NFT Gallery */}
          <ProfileCard
            title="NFT Gallery"
            subtitle={`${NFTS.length} minted`}
            trailing={
              <button
                className="text-[12.5px] hover:underline"
                style={{ color: PALETTE.mute }}
              >
                View all
              </button>
            }
            palette={PALETTE}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {NFTS.map((n) => (
                <div key={n.id} className="flex flex-col gap-1.5">
                  <div
                    className={`aspect-square rounded-xl bg-gradient-to-br ${n.g}`}
                  />
                  <div
                    className="truncate text-[12.5px] font-medium"
                    style={{ color: PALETTE.text }}
                  >
                    {n.title}
                  </div>
                  <div
                    className="truncate text-[11px]"
                    style={{ color: PALETTE.mute }}
                  >
                    {n.date}
                  </div>
                </div>
              ))}
            </div>
          </ProfileCard>

          {/* Recommended connections */}
          <ProfileCard
            title="Recommended connections"
            subtitle="Members who may be valuable collaborators"
            palette={PALETTE}
          >
            <div className="flex flex-col gap-3">
              {CONNECTIONS.map((c) => (
                <ConnectionRow key={c.handle} c={c} palette={PALETTE} />
              ))}
            </div>
          </ProfileCard>
        </div>
      )}

      {profileTab === "public" && (
        <div className="flex flex-col gap-4">
          {/* Wallet identity header */}
          <div
            className="overflow-hidden rounded-2xl bg-white"
            style={{ border: `1px solid ${PALETTE.border}` }}
          >
            <div className="flex flex-wrap items-start gap-4 p-5">
              <div
                className="h-16 w-16 shrink-0 rounded-2xl"
                style={{
                  background:
                    "conic-gradient(from 220deg, #0d0d0d, #4a4a44, #c9c4b3, #0d0d0d)",
                }}
              />
              <div className="min-w-0 flex-1">
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: PALETTE.mute }}
                >
                  Wallet
                </div>
                <div
                  className="mt-0.5 truncate text-[14px] font-mono tabular-nums"
                  style={{ color: PALETTE.text }}
                >
                  rPo8GkCA9YMKzuJGTHbj11kdVfPq5JHxNx
                </div>
                <div
                  className="mt-1 text-[12px]"
                  style={{ color: PALETTE.mute }}
                >
                  Last active 18 minutes ago
                </div>
              </div>
            </div>
            <div
              className="grid grid-cols-1 border-t sm:grid-cols-3"
              style={{ borderColor: PALETTE.border }}
            >
              <PublicStat
                label="Total rewards paid"
                value="552,308"
                unit="PFT"
                palette={PALETTE}
              />
              <PublicStat
                label="Sybil score"
                value="88"
                pill={{ text: "Low risk", bg: "#dcfce7", fg: "#166534" }}
                divider
                palette={PALETTE}
              />
              <PublicStat
                label="Alignment score"
                value="86"
                pill={{ text: "Active contributor", bg: "#fef3c7", fg: "#92400e" }}
                divider
                palette={PALETTE}
              />
            </div>
          </div>

          {/* About me */}
          <ProfileCard
            title="About me"
            trailing={
              <button
                className="flex items-center gap-1 text-[12.5px] hover:underline"
                style={{ color: PALETTE.mute }}
              >
                <Pencil size={11} />
                Edit
              </button>
            }
            palette={PALETTE}
          >
            <p
              className="text-[13px] italic"
              style={{ color: PALETTE.mute }}
            >
              Not specified yet.
            </p>
          </ProfileCard>

          {/* NFT Gallery (public view) */}
          <ProfileCard
            title="NFT Gallery"
            subtitle={`${NFTS.length} minted`}
            palette={PALETTE}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {NFTS.map((n) => (
                <div key={n.id} className="flex flex-col gap-1.5">
                  <div
                    className={`aspect-square rounded-xl bg-gradient-to-br ${n.g}`}
                  />
                  <div
                    className="truncate text-[12.5px] font-medium"
                    style={{ color: PALETTE.text }}
                  >
                    {n.title}
                  </div>
                  <div
                    className="truncate text-[11px]"
                    style={{ color: PALETTE.mute }}
                  >
                    {n.date}
                  </div>
                </div>
              ))}
            </div>
          </ProfileCard>

          {/* Post Fiat alignment */}
          <ProfileCard
            title="Post Fiat alignment"
            subtitle="Network contribution this month"
            palette={PALETTE}
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: PALETTE.mute }}
                >
                  Rewards earned
                </div>
                <div
                  className="mt-1 text-[24px] font-semibold tabular-nums"
                  style={{ color: PALETTE.text }}
                >
                  41,046.79{" "}
                  <span
                    className="text-[12px] font-medium"
                    style={{ color: PALETTE.mute }}
                  >
                    PFT
                  </span>
                </div>
              </div>
              <div>
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: PALETTE.mute }}
                >
                  Tasks completed
                </div>
                <div
                  className="mt-1 text-[24px] font-semibold tabular-nums"
                  style={{ color: PALETTE.text }}
                >
                  5
                </div>
              </div>
            </div>
          </ProfileCard>

          {/* Sybil detail */}
          <ProfileCard
            title="Sybil score"
            subtitle="System assessment of account authenticity"
            palette={PALETTE}
          >
            <div className="flex items-center gap-4">
              <SybilRing value={88} />
              <div className="min-w-0 flex-1">
                <div
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    background: "#dcfce7",
                    color: "#166534",
                    display: "inline-block",
                  }}
                >
                  Low risk
                </div>
                <p
                  className="mt-2 text-[12.5px] leading-relaxed"
                  style={{ color: PALETTE.mute }}
                >
                  This account shows strong signals of authentic activity
                  based on linked accounts, behavior patterns, and network
                  topology.
                </p>
              </div>
            </div>
            <div
              className="mt-4 flex flex-col gap-2 border-t pt-4"
              style={{ borderColor: PALETTE.border }}
            >
              <SybilSignal
                icon={UserCheck}
                label="Real accounts linked"
                hint="Verified external identities"
                value="3 / 4"
                tone="ok"
                palette={PALETTE}
              />
              <SybilSignal
                icon={AlertTriangle}
                label="Attempted gaming"
                hint="Manipulation detection signals"
                value="7 flagged"
                tone="warn"
                palette={PALETTE}
              />
              <SybilSignal
                icon={Activity}
                label="Network graph"
                hint="Interaction topology"
                value="28 connections · Organic"
                tone="ok"
                palette={PALETTE}
              />
            </div>
          </ProfileCard>
        </div>
      )}
    </div>
  );

  // ---------- top bar ----------

  const TopBar = (
    <div
      className="flex items-center justify-between px-4 pt-3"
      style={{ height: 48 }}
    >
      <div className="flex items-center gap-1">
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-2 transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = PALETTE.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
            title="Open sidebar"
          >
            <PanelLeft size={18} strokeWidth={1.75} />
          </button>
        )}
        <button
          className="rounded-md p-2 transition-colors"
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = PALETTE.hover)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
          title="New chat"
          onClick={newChat}
        >
          <SquarePen size={18} strokeWidth={1.75} />
        </button>
      </div>

      {/* in-thread actions, ChatGPT-style */}
      {view === "chat" && activeChat && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = PALETTE.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <Share size={14} />
            Share
          </button>
          <button
            className="rounded-md p-2 transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = PALETTE.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <MoreHorizontal size={18} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  );

  // ---------- render ----------

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{
        background: PALETTE.bg,
        color: PALETTE.text,
        fontFamily:
          '"Söhne", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif',
      }}
    >
      {Sidebar}

      <main className="relative flex min-w-0 flex-1 flex-col">
        {TopBar}

        <div className="flex min-h-0 flex-1 flex-col items-center">
          {view === "chat" &&
            (thread.length === 0 ? (
              <div className="flex flex-1 w-full items-center justify-center">
                {ChatEmpty}
              </div>
            ) : (
              <div className="flex w-full flex-1 justify-center">
                {ChatThread}
              </div>
            ))}
          {view === "tasks" && (
            <div className="w-full flex-1 overflow-y-auto">{TasksView}</div>
          )}
          {view === "wallet" && (
            <div className="w-full flex-1 overflow-y-auto">{WalletView}</div>
          )}
          {view === "context" && (
            <div className="w-full flex-1 overflow-y-auto">{ContextView}</div>
          )}
          {view === "profile" && (
            <div className="w-full flex-1 overflow-y-auto">{ProfileView}</div>
          )}
        </div>
      </main>

      {settingsOpen && (
        <SettingsModal
          theme={theme}
          setTheme={setTheme}
          onClose={() => setSettingsOpen(false)}
          palette={PALETTE}
        />
      )}

      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          palette={PALETTE}
        />
      )}

      {shareOpen && (
        <ShareModal
          title={activeChat?.title || "Untitled chat"}
          thread={thread}
          onClose={() => setShareOpen(false)}
          palette={PALETTE}
        />
      )}

      {activityOpen && (
        <ActivityPanel
          data={SAMPLE_ACTIVITY}
          onClose={() => setActivityOpen(false)}
          palette={PALETTE}
        />
      )}
    </div>
  );
}

// ---------- small bits ----------

function MenuRow({ icon: Icon, label, trailing, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-black/[0.04]"
    >
      <Icon size={16} strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function StatusPill({ status }) {
  const map = {
    Proposed: { bg: "#fef3c7", fg: "#92400e" },
    Accepted: { bg: "#dcfce7", fg: "#166534" },
  };
  const c = map[status] || { bg: "#e5e5e0", fg: "#0d0d0d" };
  return (
    <span
      className="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ background: c.bg, color: c.fg }}
    >
      {status}
    </span>
  );
}

function EmptyState({ icon: Icon, title, desc }) {
  return (
    <div
      className="flex flex-col items-center rounded-2xl bg-white px-6 py-12 text-center"
      style={{ border: "1px solid #e8e6df" }}
    >
      <div
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: "#faf9f6" }}
      >
        <Icon size={18} />
      </div>
      <div className="mt-3 text-[14.5px] font-semibold">{title}</div>
      <div className="mt-1 text-[12.5px] text-[#6b6b66]">{desc}</div>
    </div>
  );
}

function ActivityRow({ tx, palette }) {
  const isIn = tx.kind === "in";
  const sign = isIn ? "+" : "−";
  const amountColor = isIn ? "#16a34a" : palette.text;
  return (
    <div
      className="flex items-center gap-3 border-t py-3 first:border-t-0"
      style={{ borderTopColor: palette.border }}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{
          background: isIn ? "#dcfce7" : palette.sidebar,
          color: isIn ? "#16a34a" : palette.mute,
        }}
      >
        {isIn ? (
          <ArrowDownLeft size={15} strokeWidth={2} />
        ) : (
          <ArrowUpRight size={15} strokeWidth={2} />
        )}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div
          className="truncate text-[13.5px] font-medium"
          style={{ color: palette.text }}
        >
          {tx.title}
        </div>
        <div
          className="truncate text-[11.5px]"
          style={{ color: palette.mute }}
        >
          {isIn ? "From " : "To "}
          <span style={{ color: palette.text }}>{tx.party}</span>
          {tx.sub && <span> · {tx.sub}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right leading-tight">
        <div
          className="text-[13.5px] font-semibold tabular-nums"
          style={{ color: amountColor }}
        >
          {sign}
          {tx.amount.toLocaleString(undefined, {
            minimumFractionDigits: tx.amount === 0 ? 2 : 0,
          })}{" "}
          PFT
        </div>
        <div className="text-[11px]" style={{ color: palette.mute }}>
          {tx.time}
        </div>
      </div>
    </div>
  );
}

function ModelOption({ label, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-black/[0.04]"
    >
      <span>{label}</span>
      {selected && <Check size={14} strokeWidth={2.25} />}
    </button>
  );
}

// ---------- Settings modal ----------

const SETTINGS_PAGES = [
  { k: "general", label: "General", icon: SettingsIcon },
  { k: "security", label: "Security", icon: Shield },
  { k: "data", label: "Data controls", icon: Database },
  { k: "billing", label: "Billing", icon: CreditCard },
];

function SettingsModal({ theme, setTheme, onClose, palette }) {
  const [page, setPage] = useState("general");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      style={{ background: "rgba(13,13,13,0.5)" }}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[820px] flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        style={{ maxHeight: "88vh", minHeight: "min(560px, 80vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-0 flex-1">
          {/* left rail */}
          <aside
            className="flex w-[200px] shrink-0 flex-col py-3"
            style={{ borderRight: `1px solid ${palette.border}` }}
          >
            <div className="px-3 pb-2">
              <button
                onClick={onClose}
                className="rounded-full p-1.5 transition-colors"
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = palette.hover)
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
                aria-label="Close settings"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>
            <nav className="flex flex-col gap-0.5 px-2">
              {SETTINGS_PAGES.map((p) => {
                const Icon = p.icon;
                const active = page === p.k;
                return (
                  <button
                    key={p.k}
                    onClick={() => setPage(p.k)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors"
                    style={{
                      background: active ? palette.active : "transparent",
                      color: palette.text,
                    }}
                    onMouseEnter={(e) => {
                      if (!active)
                        e.currentTarget.style.background = palette.hover;
                    }}
                    onMouseLeave={(e) => {
                      if (!active)
                        e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                    <span>{p.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* right content */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              className="flex items-center px-7 py-4"
              style={{ borderBottom: `1px solid ${palette.border}` }}
            >
              <h2
                className="text-[18px] font-semibold tracking-tight"
                style={{ color: palette.text }}
              >
                {SETTINGS_PAGES.find((p) => p.k === page).label}
              </h2>
            </div>
            <div className="flex-1 overflow-y-auto px-7 py-5">
              {page === "general" && (
                <GeneralPage
                  theme={theme}
                  setTheme={setTheme}
                  palette={palette}
                />
              )}
              {page === "security" && <SecurityPage palette={palette} />}
              {page === "data" && <DataControlsPage palette={palette} />}
              {page === "billing" && <BillingPage palette={palette} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Settings pages ----------

function GeneralPage({ theme, setTheme, palette }) {
  const [mfaDismissed, setMfaDismissed] = useState(false);

  const themeLabelMap = {
    auto: "System",
    light: "Light",
    dark: "Dark",
  };

  return (
    <div className="flex flex-col">
      {!mfaDismissed && (
        <MFACallout
          onDismiss={() => setMfaDismissed(true)}
          palette={palette}
        />
      )}

      <div className="flex flex-col">
        <SettingsLineRow
          label="Appearance"
          right={
            <DropdownCycle
              value={theme}
              options={[
                { k: "auto", label: "System" },
                { k: "light", label: "Light" },
                { k: "dark", label: "Dark" },
              ]}
              onChange={setTheme}
              palette={palette}
              labelMap={themeLabelMap}
            />
          }
          palette={palette}
        />
        <SettingsLineRow
          label="Contrast"
          right={<StaticDropdown value="System" palette={palette} />}
          palette={palette}
        />
        <SettingsLineRow
          label="Accent color"
          right={
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: "#0d0d0d" }}
              />
              <StaticDropdown value="Black" palette={palette} />
            </div>
          }
          palette={palette}
        />
        <SettingsLineRow
          label="Language"
          right={<StaticDropdown value="Auto-detect" palette={palette} />}
          palette={palette}
        />
      </div>
    </div>
  );
}

function SecurityPage({ palette }) {
  return (
    <div className="flex flex-col">
      <MFACallout palette={palette} />
      <div className="flex flex-col">
        <SettingsLineRow
          label="Backup recovery phrase"
          desc="Write down or store your recovery phrase securely."
          right={<PillButton2 palette={palette}>Reveal</PillButton2>}
          palette={palette}
        />
        <SettingsLineRow
          label="Restore wallet"
          desc="Sign in with an existing recovery phrase."
          right={<PillButton2 palette={palette}>Restore</PillButton2>}
          palette={palette}
        />
        <SettingsLineRow
          label="Active sessions"
          desc="2 devices currently signed in."
          right={<PillButton2 palette={palette}>Manage</PillButton2>}
          palette={palette}
        />
        <SettingsLineRow
          label="Report issue"
          desc="Send a security or product report."
          right={<PillButton2 palette={palette}>Report</PillButton2>}
          palette={palette}
        />
      </div>
    </div>
  );
}

function DataControlsPage({ palette }) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-col">
        <SettingsLineRow
          label="Improve the model for everyone"
          desc="Allow your content to be used to improve Task Node."
          right={<ToggleSwitch initial palette={palette} />}
          palette={palette}
        />
        <SettingsLineRow
          label="Shared links"
          desc="Manage links you've shared from chats."
          right={<PillButton2 palette={palette}>Manage</PillButton2>}
          palette={palette}
        />
        <SettingsLineRow
          label="Export data"
          desc="Receive a copy of your conversations and PFT history."
          right={<PillButton2 palette={palette}>Export</PillButton2>}
          palette={palette}
        />
        <SettingsLineRow
          label="Privacy Policy"
          desc="How Task Node handles your data."
          right={
            <PillButton2 palette={palette}>
              View
              <ExternalLink size={11} />
            </PillButton2>
          }
          palette={palette}
        />
        <SettingsLineRow
          label="Delete account"
          desc="Permanently remove your account and all associated data."
          danger
          right={
            <PillButton2 palette={palette} danger>
              Delete
            </PillButton2>
          }
          palette={palette}
        />
      </div>
    </div>
  );
}

const PAYMENT_METHODS = [
  {
    k: "xrp",
    name: "XRP",
    chain: "XRP Ledger",
    accent: "#0d0d0d",
    letter: "X",
    connected: true,
    address: "rPo8Gk…HxNx",
  },
  {
    k: "eth",
    name: "Ether",
    chain: "Ethereum",
    accent: "#627eea",
    letter: "Ξ",
    connected: false,
  },
  {
    k: "btc",
    name: "Bitcoin",
    chain: "Bitcoin mainnet",
    accent: "#f7931a",
    letter: "₿",
    connected: false,
  },
  {
    k: "usdt",
    name: "USDT",
    chain: "Ethereum",
    accent: "#26a17b",
    letter: "₮",
    connected: false,
  },
  {
    k: "usdc",
    name: "USDC",
    chain: "Ethereum",
    accent: "#2775ca",
    letter: "$",
    connected: false,
  },
];

function BillingPage({ palette }) {
  return (
    <div className="flex flex-col gap-5">
      {/* balance / standing */}
      <div
        className="rounded-2xl p-5"
        style={{
          background: palette.sidebar,
          border: `1px solid ${palette.border}`,
        }}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: palette.mute }}
            >
              Account balance
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className="text-[28px] font-semibold tabular-nums"
                style={{ color: palette.text }}
              >
                851,718
              </span>
              <span
                className="text-[13px] font-medium"
                style={{ color: palette.mute }}
              >
                PFT
              </span>
            </div>
            <div
              className="mt-1 text-[12px]"
              style={{ color: palette.mute }}
            >
              Earned through verified network contribution.
            </div>
          </div>
          <button
            className="rounded-full px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: "#0d0d0d" }}
          >
            Top up
          </button>
        </div>
      </div>

      {/* Payment methods */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3
            className="text-[14px] font-semibold"
            style={{ color: palette.text }}
          >
            Payment methods
          </h3>
          <button
            className="text-[12.5px] hover:underline"
            style={{ color: palette.mute }}
          >
            + Add wallet
          </button>
        </div>
        <p
          className="mb-3 text-[12.5px] leading-relaxed"
          style={{ color: palette.mute }}
        >
          Connect a wallet to top up your Task Node account or pay for
          premium features. All transactions settle on-chain.
        </p>

        <div
          className="overflow-hidden rounded-2xl bg-white"
          style={{ border: `1px solid ${palette.border}` }}
        >
          {PAYMENT_METHODS.map((m) => (
            <CryptoMethodRow key={m.k} method={m} palette={palette} />
          ))}
        </div>
      </div>

      {/* Billing history */}
      <div>
        <h3
          className="mb-2 text-[14px] font-semibold"
          style={{ color: palette.text }}
        >
          Billing history
        </h3>
        <div
          className="rounded-2xl bg-white px-5 py-6 text-center"
          style={{ border: `1px solid ${palette.border}` }}
        >
          <div
            className="text-[13px] font-medium"
            style={{ color: palette.text }}
          >
            No payments yet
          </div>
          <div
            className="mt-1 text-[12px]"
            style={{ color: palette.mute }}
          >
            Top-ups and premium feature charges will appear here.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Settings sub-components ----------

function MFACallout({ onDismiss, palette }) {
  return (
    <div
      className="relative mb-6 rounded-2xl p-5"
      style={{ background: palette.sidebar }}
    >
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="absolute right-3 top-3 rounded-full p-1 transition-colors"
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = palette.hover)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
          aria-label="Dismiss"
        >
          <X size={14} strokeWidth={1.75} style={{ color: palette.mute }} />
        </button>
      )}
      <div
        className="relative flex h-9 w-9 items-center justify-center rounded-full"
        style={{ background: "white", border: `1px solid ${palette.border}` }}
      >
        <Shield size={16} strokeWidth={1.75} />
        <div
          className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full"
          style={{ background: "#0d0d0d", color: "white" }}
        >
          <Lock size={8} strokeWidth={2.5} />
        </div>
      </div>
      <div
        className="mt-3 text-[14.5px] font-semibold"
        style={{ color: palette.text }}
      >
        Secure your account
      </div>
      <p
        className="mt-1 text-[12.5px] leading-relaxed"
        style={{ color: palette.mute }}
      >
        Add multi-factor authentication (MFA), like a hardware key or
        authenticator app, to help protect your account when signing in.
      </p>
      <button
        className="mt-3 rounded-full bg-white px-4 py-1.5 text-[12.5px] font-medium transition-colors"
        style={{
          border: `1px solid ${palette.border}`,
          color: palette.text,
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = palette.hover)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "white")
        }
      >
        Set up MFA
      </button>
    </div>
  );
}

function SettingsLineRow({ label, desc, right, palette, danger }) {
  const color = danger ? "#b42318" : palette.text;
  return (
    <div
      className="flex items-center justify-between gap-4 border-t py-4 first:border-t-0"
      style={{ borderTopColor: palette.border }}
    >
      <div className="min-w-0">
        <div className="text-[14px]" style={{ color }}>
          {label}
        </div>
        {desc && (
          <div
            className="mt-0.5 text-[12px]"
            style={{ color: palette.mute }}
          >
            {desc}
          </div>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

function StaticDropdown({ value, palette }) {
  return (
    <button
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors"
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = palette.hover)
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
      style={{ color: palette.text }}
    >
      {value}
      <ChevronDown size={13} strokeWidth={1.75} />
    </button>
  );
}

function DropdownCycle({ value, options, onChange, labelMap, palette }) {
  function next() {
    const idx = options.findIndex((o) => o.k === value);
    const ni = (idx + 1) % options.length;
    onChange(options[ni].k);
  }
  return (
    <button
      onClick={next}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors"
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = palette.hover)
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
      style={{ color: palette.text }}
      title="Click to cycle"
    >
      {labelMap[value] || value}
      <ChevronDown size={13} strokeWidth={1.75} />
    </button>
  );
}

function PillButton2({ children, palette, danger }) {
  const fg = danger ? "#b42318" : palette.text;
  return (
    <button
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3.5 py-1.5 text-[12.5px] font-medium transition-colors"
      style={{
        border: `1px solid ${palette.border}`,
        color: fg,
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = palette.hover)
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "white")}
    >
      {children}
    </button>
  );
}

function ToggleSwitch({ initial, palette }) {
  const [on, setOn] = useState(!!initial);
  return (
    <button
      onClick={() => setOn((s) => !s)}
      className="relative h-[22px] w-[40px] rounded-full transition-colors"
      style={{
        background: on ? "#0d0d0d" : "#d6d2c4",
      }}
      aria-pressed={on}
    >
      <span
        className="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-all"
        style={{
          left: on ? 20 : 2,
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

function CryptoMethodRow({ method, palette }) {
  return (
    <div
      className="flex items-center gap-3 border-t px-4 py-3.5 first:border-t-0"
      style={{ borderTopColor: palette.border }}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white"
        style={{
          background: method.accent,
        }}
      >
        {method.letter}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div
          className="text-[13.5px] font-medium"
          style={{ color: palette.text }}
        >
          {method.name}
        </div>
        <div className="text-[11.5px]" style={{ color: palette.mute }}>
          {method.chain}
          {method.connected && method.address && (
            <>
              {" · "}
              <span className="font-mono tabular-nums">{method.address}</span>
            </>
          )}
        </div>
      </div>
      {method.connected ? (
        <span
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: "#dcfce7", color: "#166534" }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "#16a34a" }}
          />
          Connected
        </span>
      ) : (
        <button
          className="rounded-full px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "#0d0d0d" }}
        >
          Connect
        </button>
      )}
    </div>
  );
}

// ---------- Chat thread renderers ----------

function UserMessage({
  text,
  isEditing,
  draft,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDraftChange,
  palette,
}) {
  if (isEditing) {
    return (
      <div className="group mb-6 flex justify-end">
        <div
          className="flex w-full max-w-[80%] flex-col gap-2 rounded-3xl bg-white p-3"
          style={{ border: `1px solid ${palette.border}` }}
        >
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            className="min-h-[60px] w-full resize-none bg-transparent text-[15px] leading-[1.5] outline-none"
            style={{ color: palette.text }}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={onCancelEdit}
              className="rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = palette.hover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              style={{ color: palette.mute }}
            >
              Cancel
            </button>
            <button
              onClick={onSaveEdit}
              className="rounded-full px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
              style={{ background: "#0d0d0d" }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="group mb-2 flex flex-col items-end">
      <div
        className="max-w-[80%] rounded-3xl px-5 py-2.5 text-[15px] text-white"
        style={{ background: "#0d0d0d" }}
      >
        {text}
      </div>
      <div className="mt-1 flex h-7 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <ToolbarButton
          icon={Copy}
          label="Copy message"
          onClick={() => navigator?.clipboard?.writeText?.(text)}
          palette={palette}
        />
        <ToolbarButton
          icon={Pencil}
          label="Edit"
          onClick={onStartEdit}
          palette={palette}
        />
      </div>
    </div>
  );
}

function AssistantMessage({ message, prev, onOpenActivity, palette }) {
  return (
    <div className="mb-6 max-w-[100%]">
      {message.thinking && (
        <button
          onClick={onOpenActivity}
          className="mb-3 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] transition-colors hover:bg-black/[0.04]"
          style={{ color: palette.mute }}
        >
          {message.thinking.state === "stopped"
            ? "Stopped thinking"
            : `Thought for ${message.thinking.duration}`}
          <ChevronRight size={13} />
        </button>
      )}
      <div
        className="text-[15px] leading-[1.7]"
        style={{ color: palette.text }}
      >
        {message.blocks
          ? message.blocks.map((b, i) => (
              <BlockRenderer key={i} block={b} palette={palette} />
            ))
          : message.content}
      </div>
      <MessageToolbar
        palette={palette}
        onOpenSources={onOpenActivity}
      />
    </div>
  );
}

function BlockRenderer({ block, palette }) {
  switch (block.type) {
    case "p":
      return (
        <p className="mb-4 last:mb-0">
          {block.inline ? <Inline parts={block.inline} /> : block.text}
        </p>
      );
    case "h2":
      return (
        <h2
          className="mb-3 mt-6 text-[22px] font-semibold tracking-tight"
          style={{ color: palette.text }}
        >
          {block.text}
        </h2>
      );
    case "h3":
      return (
        <h3
          className="mb-2 mt-5 text-[17px] font-semibold tracking-tight"
          style={{ color: palette.text }}
        >
          {block.text}
        </h3>
      );
    case "quote":
      return (
        <blockquote
          className="my-3 border-l-2 py-0.5 pl-4 italic"
          style={{ borderColor: palette.border, color: palette.text }}
        >
          {block.text}
        </blockquote>
      );
    case "ul":
      return (
        <ul className="mb-4 ml-5 list-disc space-y-1.5 last:mb-0">
          {block.items.map((it, i) => (
            <li key={i}>
              {typeof it === "string" ? it : <Inline parts={it} />}
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mb-4 ml-5 list-decimal space-y-1.5 last:mb-0">
          {block.items.map((it, i) => (
            <li key={i} className="pl-1">
              {typeof it === "string" ? it : <Inline parts={it} />}
            </li>
          ))}
        </ol>
      );
    case "hr":
      return (
        <hr
          className="my-6 border-0"
          style={{ borderTop: `1px solid ${palette.border}` }}
        />
      );
    default:
      return null;
  }
}

function Inline({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.italic) return <em key={i}>{part.italic}</em>;
        if (part.bold) return <strong key={i}>{part.bold}</strong>;
        if (part.code)
          return (
            <code
              key={i}
              className="rounded px-1 py-0.5 text-[13.5px]"
              style={{ background: "rgba(0,0,0,0.05)", fontFamily: "ui-monospace, monospace" }}
            >
              {part.code}
            </code>
          );
        return <span key={i}>{part.text}</span>;
      })}
    </>
  );
}

function MessageToolbar({ palette, onOpenSources }) {
  return (
    <div className="mt-3 flex items-center gap-0.5">
      <ToolbarButton icon={Copy} label="Copy response" palette={palette} />
      <ToolbarButton icon={ArrowUp} label="Share" palette={palette} />
      <ToolbarButton icon={RefreshCw} label="Regenerate" palette={palette} />
      <ToolbarButton icon={MoreHorizontal} label="More" palette={palette} />
      <div className="mx-1.5 h-4 w-px" style={{ background: palette.border }} />
      <button
        onClick={onOpenSources}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-black/[0.04]"
        style={{ color: palette.mute }}
      >
        <BookOpen size={14} strokeWidth={1.75} />
        Sources
      </button>
    </div>
  );
}

function ToolbarButton({ icon: Icon, label, onClick, palette }) {
  const [hover, setHover] = useState(false);
  return (
    <span className="relative">
      <button
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-black/[0.04]"
        style={{ color: palette.mute }}
        aria-label={label}
      >
        <Icon size={14} strokeWidth={1.75} />
      </button>
      {hover && (
        <span
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[11.5px] text-white"
          style={{ background: "#0d0d0d" }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

// ---------- Task detail modal ----------

function TaskDetailModal({ task, onClose, palette }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      style={{ background: "rgba(13,13,13,0.5)" }}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: `1px solid ${palette.border}` }}
        >
          <div
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: palette.mute }}
          >
            <Flag size={12} strokeWidth={1.75} />
            {task.kind}
          </div>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = palette.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
            style={{ color: palette.mute }}
          >
            <X size={14} strokeWidth={1.75} />
            Close
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Title + ID */}
          <h2
            className="text-[20px] font-semibold leading-tight tracking-tight"
            style={{ color: palette.text }}
          >
            {task.title}
          </h2>
          <a
            className="mt-2 inline-flex items-center gap-1.5 text-[12px] tabular-nums hover:underline"
            style={{ color: palette.mute, fontFamily: "ui-monospace, monospace" }}
          >
            Task ID: {task.fullId}
            <ExternalLink size={11} />
          </a>

          {/* Status + Deadline */}
          <div
            className="mt-5 grid grid-cols-2 gap-0 rounded-xl"
            style={{ border: `1px solid ${palette.border}` }}
          >
            <div className="p-4">
              <div
                className="text-[10.5px] font-semibold uppercase tracking-[0.08em]"
                style={{ color: palette.mute }}
              >
                Status
              </div>
              <div className="mt-1.5">
                <StatusPill status={task.status} />
              </div>
            </div>
            <div
              className="p-4"
              style={{ borderLeft: `1px solid ${palette.border}` }}
            >
              <div
                className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.08em]"
                style={{ color: palette.mute }}
              >
                Deadline
                <HelpCircle size={11} />
              </div>
              <div
                className="mt-1.5 text-[13.5px]"
                style={{ color: palette.text }}
              >
                {task.fullDue}
              </div>
            </div>
          </div>

          {/* Description */}
          <TaskSection title="Description" palette={palette}>
            <p
              className="text-[13.5px] leading-relaxed"
              style={{ color: palette.text }}
            >
              {task.description}
            </p>
          </TaskSection>

          {/* Steps */}
          <TaskSection title="Steps" palette={palette}>
            <ol className="flex flex-col gap-3">
              {task.steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold tabular-nums"
                    style={{
                      background: palette.sidebar,
                      color: palette.text,
                      border: `1px solid ${palette.border}`,
                    }}
                  >
                    {i + 1}
                  </div>
                  <p
                    className="pt-0.5 text-[13.5px] leading-relaxed"
                    style={{ color: palette.text }}
                  >
                    {step}
                  </p>
                </li>
              ))}
            </ol>
          </TaskSection>

          {/* Verification */}
          <TaskSection title="Verification" palette={palette}>
            <div
              className="text-[14px] font-semibold"
              style={{ color: palette.text }}
            >
              {task.verification.title}
            </div>
            <p
              className="mt-1 text-[13.5px] leading-relaxed"
              style={{ color: palette.text }}
            >
              {task.verification.body}
            </p>
          </TaskSection>

          {/* Reward */}
          <TaskSection title="Reward" palette={palette} last>
            <div className="flex items-baseline gap-2">
              <span
                className="text-[24px] font-semibold tabular-nums"
                style={{ color: palette.text }}
              >
                {task.pft.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}
              </span>
              <span
                className="text-[13px] font-medium"
                style={{ color: palette.mute }}
              >
                PFT
              </span>
            </div>
          </TaskSection>
        </div>

        {/* footer actions */}
        <div
          className="flex gap-2 px-6 py-4"
          style={{ borderTop: `1px solid ${palette.border}` }}
        >
          <button
            className="flex flex-1 items-center justify-center rounded-full px-4 py-2.5 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: "#0d0d0d" }}
          >
            Submit evidence
          </button>
          <button
            className="flex flex-1 items-center justify-center rounded-full bg-white px-4 py-2.5 text-[13.5px] font-medium transition-colors"
            style={{
              border: `1px solid ${palette.border}`,
              color: palette.text,
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = palette.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "white")
            }
          >
            Discuss
          </button>
          <button
            className="flex flex-1 items-center justify-center rounded-full px-4 py-2.5 text-[13.5px] font-medium transition-colors"
            style={{ color: "#b42318" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "rgba(180,35,24,0.06)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Cancel task
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskSection({ title, children, palette, last }) {
  return (
    <div
      className={last ? "mt-5" : "mt-5 border-b pb-5"}
      style={{ borderColor: palette.border }}
    >
      <div
        className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: palette.mute }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

// ---------- Share modal ----------

function ShareModal({ title, thread, onClose, palette }) {
  const previewThread = (thread && thread.length ? thread : []).slice(0, 4);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      style={{ background: "rgba(13,13,13,0.5)" }}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-6 pb-3 pt-5"
          style={{ borderBottom: `1px solid ${palette.border}` }}
        >
          <h2
            className="text-[22px] font-semibold tracking-tight"
            style={{ color: palette.text }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = palette.hover)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
            aria-label="Close share"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="px-5 pt-4">
          {/* preview card */}
          <div
            className="relative overflow-hidden rounded-2xl bg-white p-5"
            style={{ border: `1px solid ${palette.border}` }}
          >
            <div
              className="pointer-events-none absolute right-4 bottom-4 text-[18px] font-semibold tracking-tight"
              style={{ color: palette.text }}
            >
              Task Node
            </div>
            <div
              className="max-h-[260px] overflow-hidden text-[14px] leading-[1.6]"
              style={{ color: palette.text, maskImage: "linear-gradient(to bottom, black 60%, transparent)" }}
            >
              {previewThread.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="mb-3 flex justify-end">
                    <div
                      className="max-w-[80%] rounded-3xl px-4 py-2 text-white"
                      style={{ background: "#0d0d0d" }}
                    >
                      {m.text || m.content}
                    </div>
                  </div>
                ) : (
                  <div
                    key={i}
                    className="mb-3"
                    style={{ color: palette.text }}
                  >
                    {m.blocks
                      ? m.blocks
                          .slice(0, 2)
                          .map((b, j) => (
                            <BlockRenderer key={j} block={b} palette={palette} />
                          ))
                      : m.content}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>

        {/* share targets */}
        <div className="flex justify-center gap-6 px-5 py-6">
          <ShareTarget icon={Link2} label="Copy link" />
          <ShareTarget label="X" symbol="X" />
          <ShareTarget icon={Linkedin} label="LinkedIn" />
          <ShareTarget label="Reddit" symbol="R" />
        </div>

        <div
          className="px-5 pb-5 text-center text-[12px]"
          style={{ color: palette.mute }}
        >
          Memory sources won&apos;t be shared with viewers.
        </div>
      </div>
    </div>
  );
}

function ShareTarget({ icon: Icon, symbol, label }) {
  return (
    <button className="flex flex-col items-center gap-2">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full text-white transition-transform hover:scale-105"
        style={{ background: "#0d0d0d" }}
      >
        {Icon ? (
          <Icon size={20} strokeWidth={1.75} />
        ) : (
          <span className="text-[18px] font-bold">{symbol}</span>
        )}
      </span>
      <span className="text-[12.5px]" style={{ color: "#0d0d0d" }}>
        {label}
      </span>
    </button>
  );
}

// ---------- Activity panel ----------

function ActivityPanel({ data, onClose, palette }) {
  const [showMoreMemory, setShowMoreMemory] = useState(false);
  return (
    <aside
      className="flex h-full w-[360px] shrink-0 flex-col bg-white"
      style={{
        borderLeft: `1px solid ${palette.border}`,
      }}
    >
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: `1px solid ${palette.border}` }}
      >
        <div className="flex items-baseline gap-2">
          <h3
            className="text-[16px] font-semibold tracking-tight"
            style={{ color: palette.text }}
          >
            Activity
          </h3>
          <span
            className="text-[12px]"
            style={{ color: palette.mute }}
          >
            · {data.duration}
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-full p-1.5 transition-colors"
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = palette.hover)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
          aria-label="Close activity"
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Thinking */}
        <div className="mb-7">
          <div
            className="mb-4 text-[14px] font-semibold"
            style={{ color: palette.text }}
          >
            Thinking
          </div>
          <div className="relative">
            {/* continuous vertical guide, masked by the icon backgrounds */}
            <div
              className="absolute"
              style={{
                background: palette.border,
                width: 1,
                left: 7,
                top: 14,
                bottom: 14,
              }}
            />
            {data.thinking.map((step, i) => (
              <div
                key={i}
                className="relative flex items-center gap-3 py-2"
              >
                <div
                  className="flex shrink-0 items-center justify-center"
                  style={{
                    background: "white",
                    width: 15,
                    height: 20,
                  }}
                >
                  {step.kind === "primary" ? (
                    <BookOpen
                      size={14}
                      strokeWidth={1.75}
                      style={{ color: palette.text }}
                    />
                  ) : (
                    <span
                      className="inline-block rounded-full"
                      style={{
                        width: 7,
                        height: 7,
                        background: palette.text,
                      }}
                    />
                  )}
                </div>
                <span
                  className="text-[13.5px]"
                  style={{
                    color: palette.text,
                    fontWeight: step.kind === "primary" ? 500 : 400,
                  }}
                >
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Memory */}
        <div className="mb-6">
          <div
            className="mb-4 text-[14px] font-semibold"
            style={{ color: palette.text }}
          >
            Memory ·{" "}
            <span style={{ color: palette.mute, fontWeight: 400 }}>
              {data.memory.length + (data.memoryMore || 0)}
            </span>
          </div>
          <div className="flex flex-col gap-5">
            {(showMoreMemory ? data.memory : data.memory.slice(0, 4)).map(
              (m, i) => (
                <div key={i}>
                  <div
                    className="flex items-center gap-1.5 text-[12px]"
                    style={{ color: palette.mute }}
                  >
                    <MessageCircle size={12} strokeWidth={1.75} />
                    Past chat
                  </div>
                  <div
                    className="mt-1.5 text-[14px] font-semibold leading-snug"
                    style={{ color: palette.text }}
                  >
                    {m.title}
                  </div>
                  <div
                    className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed"
                    style={{ color: palette.mute }}
                  >
                    {m.preview}
                  </div>
                </div>
              ),
            )}
            {!showMoreMemory && data.memoryMore > 0 && (
              <button
                onClick={() => setShowMoreMemory(true)}
                className="flex items-center gap-1 text-left text-[12.5px]"
                style={{ color: palette.mute }}
              >
                {data.memoryMore} more
                <ChevronDown size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Files */}
        {data.files && data.files.length > 0 && (
          <div>
            <div
              className="mb-4 text-[14px] font-semibold"
              style={{ color: palette.text }}
            >
              Files ·{" "}
              <span style={{ color: palette.mute, fontWeight: 400 }}>
                {data.files.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {data.files.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl p-3"
                  style={{ border: `1px solid ${palette.border}` }}
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                    style={{
                      background: palette.sidebar,
                      color: palette.mute,
                    }}
                  >
                    <FileText size={15} strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0">
                    <div
                      className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                      style={{ color: palette.mute }}
                    >
                      {f.type}
                    </div>
                    <div
                      className="truncate text-[13px] font-medium"
                      style={{ color: palette.text }}
                    >
                      {f.name}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------- Profile helpers ----------

function ProfileCard({ title, subtitle, trailing, children, palette }) {
  return (
    <section
      className="overflow-hidden rounded-2xl bg-white p-5"
      style={{ border: `1px solid ${palette.border}` }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: palette.mute }}
          >
            {title}
          </h3>
          {subtitle && (
            <div
              className="mt-0.5 text-[12.5px]"
              style={{ color: palette.mute }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function PillButton({ icon: Icon, children, dark }) {
  return (
    <button
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-opacity hover:opacity-90"
      style={{
        background: dark ? "#0d0d0d" : "white",
        color: dark ? "white" : "#0d0d0d",
        border: dark ? "none" : "1px solid #e8e6df",
      }}
    >
      {Icon && <Icon size={13} strokeWidth={1.75} />}
      {children}
    </button>
  );
}

function MiniNote({ title, body, palette }) {
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{ background: palette.sidebar }}
    >
      <div
        className="text-[10.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: palette.mute }}
      >
        {title}
      </div>
      <div
        className="mt-1 text-[12px] leading-relaxed"
        style={{ color: palette.text }}
      >
        {body}
      </div>
    </div>
  );
}

function ConnectionRow({ c, palette }) {
  return (
    <div
      className="rounded-xl p-3"
      style={{ border: `1px solid ${palette.border}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div
            className="h-7 w-7 shrink-0 rounded-full"
            style={{
              background: `conic-gradient(from ${c.match * 3.6}deg, #c9c4b3, #6b6b66, #0d0d0d, #c9c4b3)`,
            }}
          />
          <span
            className="text-[13px] font-mono tabular-nums"
            style={{ color: palette.text }}
          >
            {c.handle}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="text-[11px] font-semibold tabular-nums"
            style={{ color: palette.mute }}
          >
            Match
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums"
            style={{ background: "#0d0d0d", color: "white" }}
          >
            {c.match}%
          </span>
        </div>
      </div>
      <p
        className="mt-2 text-[12.5px] leading-relaxed"
        style={{ color: palette.text }}
      >
        {c.summary}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {c.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full px-2 py-0.5 text-[10.5px]"
            style={{
              background: palette.sidebar,
              color: palette.mute,
              border: `1px solid ${palette.border}`,
            }}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

function PublicStat({ label, value, unit, pill, divider, palette }) {
  return (
    <div
      className="p-5"
      style={{
        borderLeft: divider ? `1px solid ${palette.border}` : "none",
      }}
    >
      <div
        className="text-[11px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: palette.mute }}
      >
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className="text-[24px] font-semibold tabular-nums"
          style={{ color: palette.text }}
        >
          {value}
        </span>
        {unit && (
          <span
            className="text-[12px] font-medium"
            style={{ color: palette.mute }}
          >
            {unit}
          </span>
        )}
        {pill && (
          <span
            className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
            style={{ background: pill.bg, color: pill.fg }}
          >
            {pill.text}
          </span>
        )}
      </div>
    </div>
  );
}

function SybilRing({ value }) {
  const radius = 28;
  const c = 2 * Math.PI * radius;
  const offset = c - (value / 100) * c;
  return (
    <div className="relative h-[72px] w-[72px] shrink-0">
      <svg width={72} height={72} viewBox="0 0 72 72">
        <circle
          cx={36}
          cy={36}
          r={radius}
          fill="none"
          stroke="#e8e6df"
          strokeWidth={6}
        />
        <circle
          cx={36}
          cy={36}
          r={radius}
          fill="none"
          stroke="#16a34a"
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 36 36)"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[18px] font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}

function SybilSignal({ icon: Icon, label, hint, value, tone, palette }) {
  const toneColor =
    tone === "warn" ? "#b45309" : tone === "bad" ? "#b42318" : "#166534";
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: palette.sidebar, color: palette.mute }}
      >
        <Icon size={14} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div
          className="text-[13px] font-medium"
          style={{ color: palette.text }}
        >
          {label}
        </div>
        <div className="text-[11px]" style={{ color: palette.mute }}>
          {hint}
        </div>
      </div>
      <div
        className="text-[12.5px] font-semibold tabular-nums"
        style={{ color: toneColor }}
      >
        {value}
      </div>
    </div>
  );
}

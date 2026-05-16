import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowDown,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpRight,
  Activity,
  AlertTriangle,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  CreditCard,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Flag,
  Flame,
  Github,
  HelpCircle,
  LifeBuoy,
  Lightbulb,
  ListPlus,
  ListTodo,
  Lock,
  LogOut,
  Link2,
  Linkedin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelLeft,
  Paperclip,
  PenLine,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  Share,
  Shield,
  Sparkle,
  Sparkles,
  SquarePen,
  Store,
  Trophy,
  User as UserIcon,
  UserCheck,
  Wand2,
  Wallet,
  X,
} from "lucide-react";
import { fetchAppState, fetchRuntimeConfig, requestJson } from "./api";
import "./styles.css";

const fallbackConfig = window.__TASKNODE_CONFIG__ || {};

const PALETTE = {
  bg: "#faf9f6",
  sidebar: "#f4f3ee",
  border: "#e8e6df",
  hover: "rgba(0, 0, 0, 0.05)",
  active: "rgba(0, 0, 0, 0.08)",
  text: "#0d0d0d",
  mute: "#6b6b66",
  brand: "#10a37f",
};

const RECENT_CHAT_MOCKS = [
  { id: "building", title: "Building Discussion" },
  { id: "greeting", title: "Greeting exchange", unread: true },
  { id: "sj-brainstorm", title: "Steve Jobs Brainstorming Principles", unread: true },
  { id: "sj-motivation", title: "Steve Jobs Motivation Principles" },
  { id: "sj-essence", title: "Steve Jobs Essence" },
  { id: "sj-speech", title: "Steve Jobs Speech Guide" },
  { id: "sj-iphone", title: "Steve Jobs iPhone Launch" },
  { id: "sj-ipod", title: "Steve Jobs iPod Strategy" },
  { id: "sj-biz-1", title: "Steve Jobs Business Principles" },
  { id: "sj-biz-2", title: "Steve Jobs Business Insights" },
  { id: "caucasian", title: "Caucasian Quant Trader" },
  { id: "hamburger", title: "Hamburger Affordability Comparison" },
  { id: "logitcoin", title: "Logitcoin Research Packet" },
];

const SAMPLE_THREAD = [
  { role: "user", text: "hi" },
  {
    role: "assistant",
    blocks: [{ type: "p", inline: [{ text: "Hey - what are we building today?" }] }],
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
        inline: [
          {
            text:
              "Not another wrapper. Not another dashboard. Something where the first reaction is:",
          },
        ],
      },
      { type: "quote", inline: [{ text: "Wait... are people allowed to do that?" }] },
      {
        type: "p",
        inline: [
          {
            text:
              "You are already circling the right territory with Logitcoin: turning AI inference itself into a consensus primitive is exactly the kind of different-game thinking that matters.",
          },
        ],
      },
      { type: "hr" },
      { type: "h2", inline: [{ text: "1. The AI Native Operating System Layer" }] },
      { type: "p", inline: [{ text: "Everyone is building AI apps." }] },
      { type: "p", inline: [{ text: "Almost nobody is building:" }] },
      {
        type: "ul",
        items: [
          [{ text: "deterministic identity for agents" }],
          [{ text: "persistent memory" }],
          [{ text: "economic coordination" }],
          [{ text: "verifiable cognition" }],
          [{ text: "long-lived autonomous workflows" }],
          [{ text: "agent-to-agent markets" }],
          [{ text: "runtime governance" }],
        ],
      },
      {
        type: "p",
        inline: [
          {
            text:
              "The teams who win this layer set the rules for the next decade. The useful version is not merely a dashboard; it is a new category vocabulary.",
          },
        ],
      },
      { type: "hr" },
      {
        type: "p",
        inline: [
          { text: "If I were ranking the strongest directions, I would start here:" },
        ],
      },
      {
        type: "ol",
        items: [
          [{ text: "AI infrastructure with cryptographic, consensus, and verification properties" }],
          [{ text: "Taste, cognition, and strategic-intelligence tooling" }],
          [{ text: "Autonomous agent coordination systems" }],
          [{ text: "New economic primitives around inference and cognition" }],
          [{ text: "Tools that teach people how legendary operators think" }],
        ],
      },
      { type: "p", inline: [{ text: "The key is: do not build something merely useful." }] },
      {
        type: "p",
        inline: [{ text: "Build something that creates a new category vocabulary." }],
      },
    ],
  },
];

const SAMPLE_ACTIVITY = {
  duration: "7s",
  thinking: [
    { kind: "primary", label: "Personalizing" },
    { kind: "dot", label: "Tracking your projects" },
    { kind: "dot", label: "Identifying your interests" },
    { kind: "dot", label: "Exploring your goals" },
    { kind: "dot", label: "Matching key domains" },
  ],
  memory: [
    {
      title: "Steve Jobs Motivation Principles",
      preview:
        "Today - step into the role of Steve Jobs and teach the operator mindset with plain English examples.",
    },
    {
      title: "Steve Jobs Essence",
      preview:
        "Today - give the essence of Steve Jobs in ten pages or less: taste, focus, craft, and consequence.",
    },
    {
      title: "Steve Jobs Business Principles",
      preview:
        "Today - summarize the business lessons in detail, with emphasis on product quality and category creation.",
    },
    {
      title: "Logitcoin Research Packet",
      preview:
        "May 10, 2026 - Logitcoin Qwen proof-of-logits external research packet and implementation notes.",
    },
    {
      title: "OpenAI Jobs Brainstorm",
      preview:
        "Jobs repeatedly frames technology as a human amplifier and builds the frame before revealing the product.",
    },
    {
      title: "Steve Jobs Style Guide",
      preview:
        "Imitate the reasoning pattern, not the catchphrases: product judgment, human consequence, and proof.",
    },
  ],
  memoryMore: 5,
  files: [{ name: "Pasted text.txt", type: "TXT" }],
};

const MOCK_TASKS = {
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

const ACTIVITY_GROUPS = [
  {
    group: "Today",
    items: [
      { kind: "in", title: "Daily airdrop", party: "Task Verifier", amount: 8400, time: "11:15 AM" },
      {
        kind: "in",
        title: "Task reward",
        sub: "Ship A 90 Percent Task Node Surface Cut",
        party: "Task Verifier",
        amount: 3600,
        time: "10:42 AM",
      },
      { kind: "out", title: "Verification fee", party: "Task Verifier", amount: 0, time: "11:15 AM" },
      { kind: "out", title: "Verification fee", party: "Task Verifier", amount: 0, time: "11:03 AM" },
    ],
  },
  {
    group: "Yesterday",
    items: [
      { kind: "in", title: "Daily airdrop", party: "Task Verifier", amount: 6200, time: "9:18 AM" },
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
      { kind: "in", title: "Daily airdrop", party: "Task Verifier", amount: 7800, time: "9:24 AM" },
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

const PFT_GENERATION = [
  1800, 2200, 1900, 2400, 2100, 1700, 2600, 2300, 1850, 2900, 2100, 1950, 2400, 2800,
  2200, 2050, 2700, 1900, 2300, 2500, 2100, 2400, 2200, 2800, 36000, 3200, 2400, 2200,
];

const PFT_BREAKDOWN = [
  { label: "Personal", value: "42,900" },
  { label: "Network", value: "52,555.4" },
  { label: "Alpha", value: "10,000" },
];

const NFTS = [
  {
    id: "1",
    title: "Network Reliability Engineer",
    date: "May 13, 2026",
    gradient: "linear-gradient(135deg, #bbf7d0, #10b981)",
  },
  {
    id: "2",
    title: "NFT 2026-05-12",
    date: "May 12, 2026",
    gradient: "linear-gradient(135deg, #d6d3d1, #44403c)",
  },
  {
    id: "3",
    title: "Alpha Brief Analyst",
    date: "May 7, 2026",
    gradient: "linear-gradient(135deg, #fde68a, #d97706)",
  },
  {
    id: "4",
    title: "Alpha Brief Analyst",
    date: "May 7, 2026",
    gradient: "linear-gradient(135deg, #bae6fd, #0284c7)",
  },
];

const CONNECTIONS = [
  {
    handle: "rDVKRN...tyjB",
    match: 95,
    summary:
      "Strong synergy between your deterministic reward composers and their deterministic task-generation parser and verification policy fixes.",
    tags: ["Task-generation parser", "Verification policy", "DB-backed constraints"],
  },
  {
    handle: "rDep8S...EQKu",
    match: 88,
    summary:
      "Direct alignment in building deterministic Python reducers and handling task-generation logic with regression-style scoring.",
    tags: ["Python reducers", "Dependency-light validators", "Prompt escaping"],
  },
  {
    handle: "rGu432...Dcw9",
    match: 85,
    summary:
      "Overlap in deterministic tools and verification workflows with CLI-first JSON scoring and auditable triage.",
    tags: ["CLI JSON scoring", "Triage packet design", "Sim engineering"],
  },
];

const PAYMENT_METHODS = [
  { k: "xrp", name: "XRP", chain: "XRP Ledger", accent: "#0d0d0d", letter: "X", connected: true, address: "rPo8Gk...HxNx" },
  { k: "eth", name: "Ether", chain: "Ethereum", accent: "#627eea", letter: "E", connected: false },
  { k: "btc", name: "Bitcoin", chain: "Bitcoin mainnet", accent: "#f7931a", letter: "B", connected: false },
  { k: "usdt", name: "USDT", chain: "Ethereum", accent: "#26a17b", letter: "T", connected: false },
  { k: "usdc", name: "USDC", chain: "Ethereum", accent: "#2775ca", letter: "$", connected: false },
];

const SETTINGS_PAGES = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "security", label: "Security", icon: Shield },
  { key: "data", label: "Data controls", icon: Database },
  { key: "billing", label: "Billing", icon: CreditCard },
];

const APP_VIEWS = new Set(["chat", "tasks", "wallet", "context", "profile"]);

function viewFromLocation() {
  if (typeof window === "undefined") return "chat";
  const hashView = window.location.hash.replace(/^#\/?/, "").trim().toLowerCase();
  return APP_VIEWS.has(hashView) ? hashView : "chat";
}

function writeViewLocation(nextView, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
  const url = new URL(window.location.href);
  url.hash = normalizedView === "chat" ? "" : normalizedView;

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (currentPath === nextPath) return;

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ tasknodeView: normalizedView }, "", nextPath);
}

function App() {
  const [view, setView] = useState(() => viewFromLocation());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState("auto");
  const [profileTab, setProfileTab] = useState("private");
  const [profilePublic, setProfilePublic] = useState(true);
  const [selectedTask, setSelectedTask] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [chatResetKey, setChatResetKey] = useState(0);
  const [chatSelectionKey, setChatSelectionKey] = useState(0);
  const [chatShareRequestKey, setChatShareRequestKey] = useState(0);
  const [runtimeConfig, setRuntimeConfig] = useState(fallbackConfig);
  const [appState, setAppState] = useState(null);
  const [loadError, setLoadError] = useState("");
  const profileRef = useRef(null);
  const moreRef = useRef(null);

  useEffect(() => {
    let active = true;

    Promise.all([fetchRuntimeConfig(), fetchAppState()])
      .then(([config, state]) => {
        if (!active) return;
        setRuntimeConfig(config);
        setAppState(state);
      })
      .catch((error) => {
        if (active) setLoadError(error?.message || "Failed to load app state");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function closeMenus(event) {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setProfileMenuOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(event.target)) {
        setMoreMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);

  useEffect(() => {
    if (!settingsOpen && !selectedTask) return undefined;

    function closeModal(event) {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSelectedTask(null);
      }
    }

    document.addEventListener("keydown", closeModal);
    return () => document.removeEventListener("keydown", closeModal);
  }, [settingsOpen, selectedTask]);

  const recentChats = buildRecentChats(appState?.chat?.recents || []);
  const pftBalance = formatDrops(appState?.wallet?.pftBalanceDrops || 0);
  const chatCredit = formatUsd(appState?.usage?.availableCreditUsd || 0);
  const session = appState?.session;
  const signedIn = isSignedInSession(session);
  const profileName = profileDisplayName(session);
  const profileInitials = profileAvatarText(session);
  const profileSubtext = profileSessionText(session);

  const navigateToView = useCallback((nextView, options = {}) => {
    const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
    setView(normalizedView);
    setMoreMenuOpen(false);
    setProfileMenuOpen(false);
    setSettingsOpen(false);
    setSelectedTask(null);
    setLoginOpen(false);
    writeViewLocation(normalizedView, { replace: options.replace === true });
  }, []);

  const startNewChat = useCallback(() => {
    setActiveChat(null);
    setChatResetKey((key) => key + 1);
    navigateToView("chat");
  }, [navigateToView]);

  const openRecentChat = useCallback(
    (chat) => {
      setActiveChat(chat);
      setChatSelectionKey((key) => key + 1);
      navigateToView("chat");
    },
    [navigateToView]
  );

  useEffect(() => {
    writeViewLocation(viewFromLocation(), { replace: true });

    function syncViewFromLocation() {
      setView(viewFromLocation());
      setMoreMenuOpen(false);
      setProfileMenuOpen(false);
      setSettingsOpen(false);
      setSelectedTask(null);
      setLoginOpen(false);
    }

    window.addEventListener("popstate", syncViewFromLocation);
    window.addEventListener("hashchange", syncViewFromLocation);
    return () => {
      window.removeEventListener("popstate", syncViewFromLocation);
      window.removeEventListener("hashchange", syncViewFromLocation);
    };
  }, []);

  async function refreshAppState() {
    try {
      const state = await fetchAppState();
      setAppState(state);
      setLoadError("");
      return state;
    } catch (error) {
      setLoadError(error?.message || "Failed to load app state");
      return null;
    }
  }

  async function logOut() {
    await requestJson("/api/auth/logout", { method: "POST" });
    await refreshAppState();
    setProfileMenuOpen(false);
  }

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-header">
          {sidebarOpen ? (
            <button
              className="sidebar-title"
              onClick={() => navigateToView("chat")}
              type="button"
            >
              Task Node
            </button>
          ) : (
            <button
              className="brand-button"
              onClick={() => navigateToView("chat")}
              title="Home"
              type="button"
            >
              <BrandDot />
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            type="button"
          >
            <PanelLeft size={18} strokeWidth={1.75} />
          </button>
        </div>

        <nav className="nav-list">
          <SidebarButton
            active={view === "chat" && !activeChat}
            icon={SquarePen}
            label="New chat"
            onClick={startNewChat}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton icon={Search} label="Search chats" sidebarOpen={sidebarOpen} />
          <SidebarButton
            active={view === "tasks"}
            badge={appState?.tasks?.outstanding?.length}
            icon={ListTodo}
            label="Tasks"
            onClick={() => navigateToView("tasks")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "wallet"}
            icon={Wallet}
            label="Wallet"
            onClick={() => navigateToView("wallet")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "context"}
            icon={BookOpen}
            label="Context"
            onClick={() => navigateToView("context")}
            sidebarOpen={sidebarOpen}
          />
          <div className="sidebar-menu-anchor" ref={moreRef}>
            <SidebarButton
              active={moreMenuOpen}
              icon={MoreHorizontal}
              label="More"
              onClick={() => setMoreMenuOpen((open) => !open)}
              sidebarOpen={sidebarOpen}
            />
            {moreMenuOpen && sidebarOpen && (
              <div className="sidebar-popout">
                <ToolMenuRow icon={Flame} label="Motivation" />
                <ToolMenuRow icon={Lightbulb} label="Brainstorming" />
                <ToolMenuRow icon={Wand2} label="Context Refine" />
                <ToolMenuRow icon={PenLine} label="Context Rewrite" />
                <div className="menu-divider" />
                <ToolMenuRow icon={Bot} label="Agents" />
                <ToolMenuRow
                  icon={MessageSquare}
                  label="Messages"
                  trailing={<span className="menu-count">1</span>}
                />
              </div>
            )}
          </div>
        </nav>

        {sidebarOpen && (
          <section className="recents" aria-label="Recent chats">
            <div className="section-label">Recents</div>
            {recentChats.length > 0 ? (
              recentChats.map((item) => (
                <button
                  className={activeChat?.id === item.id ? "active" : ""}
                  key={item.id}
                  onClick={() => openRecentChat(item)}
                  type="button"
                >
                  <span>{item.title}</span>
                  {item.unread && <i aria-hidden="true" />}
                </button>
              ))
            ) : (
              <div className="sidebar-note">No chats yet</div>
            )}
          </section>
        )}

        <div className="sidebar-footer">
          {sidebarOpen && (
            <button className="balance-pill" onClick={() => navigateToView("wallet")} type="button">
              <span className="balance-stack">
                <span className="balance-row">
                  <Wallet size={14} strokeWidth={1.75} />
                  <strong>{pftBalance}</strong>
                  <span>PFT</span>
                </span>
                <span className="balance-row">
                  <CreditCard size={14} strokeWidth={1.75} />
                  <strong>{chatCredit}</strong>
                  <span>chat</span>
                </span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} />
            </button>
          )}
          <div className="profile-anchor" ref={profileRef}>
          <button
            className="profile-button"
            aria-label={signedIn ? `${profileName}, ${profileSubtext}` : "Log in or sign up"}
            onClick={() => setProfileMenuOpen((open) => !open)}
            type="button"
          >
            <ProfileAvatar initials={profileInitials} signedIn={signedIn} />
            {sidebarOpen && (
              <>
                <span className="profile-copy">
                  <strong>{profileName}</strong>
                  <small>{profileSubtext}</small>
                </span>
                {signedIn ? (
                  <Check className="profile-state-icon" size={14} strokeWidth={2} />
                ) : (
                  <Store size={14} strokeWidth={1.75} />
                )}
              </>
            )}
          </button>
          {profileMenuOpen && sidebarOpen && (
            <div className="profile-menu">
              <button
                className="profile-menu-header"
                onClick={() => {
                  if (signedIn) {
                    navigateToView("profile");
                  } else {
                    setLoginOpen(true);
                  }
                  setProfileMenuOpen(false);
                }}
                type="button"
              >
                <ProfileAvatar initials={profileInitials} signedIn={signedIn} />
                <span className="profile-copy">
                  <strong>{profileName}</strong>
                  <small>{profileSubtext}</small>
                </span>
                <ChevronRight size={16} strokeWidth={1.75} />
              </button>
              {signedIn && (
                <div className="profile-session-state">
                  <Check size={13} strokeWidth={2} />
                  <span>Signed in</span>
                </div>
              )}
              <div className="menu-divider" />
              <ToolMenuRow
                icon={Network}
                label="Directory"
                trailing={<span className="menu-count">#16</span>}
              />
              <ToolMenuRow
                icon={SettingsIcon}
                label="Settings"
                onClick={() => {
                  setSettingsOpen(true);
                  setProfileMenuOpen(false);
                }}
              />
              <ToolMenuRow
                icon={UserIcon}
                label="Profile"
                onClick={() => {
                  navigateToView("profile");
                }}
              />
              <ToolMenuRow icon={LifeBuoy} label="Help" trailing={<ChevronRight size={14} />} />
              <div className="menu-divider" />
              <ToolMenuRow icon={LogOut} label="Log out" onClick={logOut} />
            </div>
          )}
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && (
              <button className="icon-button" onClick={() => setSidebarOpen(true)} type="button">
                <PanelLeft size={18} strokeWidth={1.75} />
              </button>
            )}
            <button className="icon-button" onClick={startNewChat} title="New chat" type="button">
              <SquarePen size={18} strokeWidth={1.75} />
            </button>
          </div>
          {view === "chat" && activeChat && (
            <div className="thread-actions">
              <button onClick={() => setChatShareRequestKey((key) => key + 1)} type="button">
                <Share size={14} strokeWidth={1.75} />
                Share
              </button>
              <button type="button" aria-label="More thread actions">
                <MoreHorizontal size={18} strokeWidth={1.75} />
              </button>
            </div>
          )}
        </header>

        {loadError && <StatusBanner tone="error">{loadError}</StatusBanner>}
        {!appState && !loadError && <StatusBanner>Loading product state</StatusBanner>}

        {view === "chat" && (
          <ChatSurface
            activeChat={activeChat}
            chatResetKey={chatResetKey}
            chatSelectionKey={chatSelectionKey}
            chatShareRequestKey={chatShareRequestKey}
            chat={appState?.chat}
            onActiveChatChange={setActiveChat}
            onChatSettled={refreshAppState}
            onNavigate={navigateToView}
            usage={appState?.usage}
          />
        )}
        {view === "tasks" && <TasksView onSelectTask={setSelectedTask} />}
        {view === "wallet" && (
          <WalletView wallet={appState?.wallet} usage={appState?.usage} />
        )}
        {view === "context" && <ContextView context={appState?.context} />}
        {view === "profile" && (
          <ProfileView
            profilePublic={profilePublic}
            profileTab={profileTab}
            setProfilePublic={setProfilePublic}
            setProfileTab={setProfileTab}
          />
        )}
      </section>

      {loginOpen && (
        <LoginDialog
          onSessionChange={refreshAppState}
          session={session}
          onClose={() => setLoginOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          session={session}
          setTheme={setTheme}
          theme={theme}
        />
      )}
      {selectedTask && (
        <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </main>
  );
}

function titleForView(view) {
  if (view === "tasks") return "Tasks";
  if (view === "wallet") return "Wallet";
  if (view === "context") return "Context";
  return "What are we executing?";
}

function ChatSurface({
  activeChat,
  chat,
  chatResetKey,
  chatSelectionKey,
  chatShareRequestKey,
  onActiveChatChange,
  onChatSettled,
  onNavigate,
  usage,
}) {
  const modes = chat?.modes || [];
  const messages = chat?.seedMessages || [];
  const defaultMode = chat?.defaultMode || "Private Instant";
  const [turns, setTurns] = useState(() => normalizeChatMessages(messages));
  const [selectedMode, setSelectedMode] = useState(defaultMode);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [actualUsage, setActualUsage] = useState(null);
  const [statusTone, setStatusTone] = useState("muted");
  const [sending, setSending] = useState(false);
  const [editingMsg, setEditingMsg] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const plusRef = useRef(null);
  const modelRef = useRef(null);
  const inputRef = useRef(null);
  const messageListRef = useRef(null);
  const resetSeenRef = useRef(0);
  const shareSeenRef = useRef(chatShareRequestKey);
  const clearedChatRef = useRef(false);

  useEffect(() => {
    setSelectedMode(defaultMode);
  }, [defaultMode]);

  useEffect(() => {
    if (clearedChatRef.current) return;
    if (activeChat?.source === "mock" || activeChat?.source === "server") return;
    setTurns(normalizeChatMessages(messages));
  }, [activeChat?.source, messages]);

  useEffect(() => {
    if (chatResetKey === 0 || resetSeenRef.current === chatResetKey) return;
    resetSeenRef.current = chatResetKey;
    clearedChatRef.current = true;
    setTurns([]);
    setInput("");
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setEditingMsg(null);
    setShareOpen(false);
    setActivityOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [chatResetKey]);

  useEffect(() => {
    if (!activeChat || activeChat.source === "live") return;
    clearedChatRef.current = false;

    if (activeChat.id === "building") {
      setTurns(SAMPLE_THREAD);
      return;
    }

    if (activeChat.source === "server") {
      const hydrated = normalizeChatMessages(messages);
      setTurns(
        hydrated.length > 0
          ? hydrated
          : createRecentPlaceholderThread(activeChat.title)
      );
      return;
    }

    setTurns(createRecentPlaceholderThread(activeChat.title));
  }, [activeChat, chatSelectionKey, messages]);

  useEffect(() => {
    if (shareSeenRef.current === chatShareRequestKey) return;
    shareSeenRef.current = chatShareRequestKey;
    if (turns.length > 0) setShareOpen(true);
  }, [chatShareRequestKey, turns.length]);

  useEffect(() => {
    if (!shareOpen && !activityOpen) return undefined;

    function closeOverlay(event) {
      if (event.key === "Escape") {
        setShareOpen(false);
        setActivityOpen(false);
      }
    }

    document.addEventListener("keydown", closeOverlay);
    return () => document.removeEventListener("keydown", closeOverlay);
  }, [activityOpen, shareOpen]);

  useEffect(() => {
    function closeMenus(event) {
      if (plusRef.current && !plusRef.current.contains(event.target)) {
        setPlusMenuOpen(false);
      }
      if (modelRef.current && !modelRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);

  async function submitMessage(event) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    clearedChatRef.current = false;
    setSending(true);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");

    try {
      const result = await requestJson(usage?.chatSendPath || "/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, mode: selectedMode }),
      });
      setActualUsage(result.body?.usage || null);

      if (result.ok && result.body?.assistant) {
        setTurns((current) => [
          ...current,
          normalizeChatMessage(result.body.user || { role: "user", body: message }, current.length),
          normalizeChatMessage(result.body.assistant, current.length + 1),
        ]);
        if (!activeChat) {
          onActiveChatChange?.({
            id: "current",
            source: "live",
            title: chatTitleFromPrompt(message),
          });
        }
        setInput("");
        setSendMessage(result.body.message || "Chat response generated.");
        setStatusTone("muted");
        await onChatSettled?.();
      } else {
        setSendMessage(
          result.body?.message ||
            result.body?.actionRequired ||
            `Chat returned HTTP ${result.status}.`
        );
        setStatusTone("error");
      }
    } catch (error) {
      setSendMessage(error?.message || "Chat execution is unavailable.");
      setStatusTone("error");
    } finally {
      setSending(false);
    }
  }

  const composerStatus = chatComposerStatus({
    actualUsage,
    message: sendMessage,
    sending,
    tone: statusTone,
    turns,
  });

  const chatTitle = activeChat?.title || titleFromTurns(turns);
  const composer = (
    <div className="composer-shell">
      <form className="composer" onSubmit={submitMessage}>
        <div className="plus-picker" ref={plusRef}>
          <button
            className="composer-icon"
            onClick={() => {
              setModelMenuOpen(false);
              setPlusMenuOpen((open) => !open);
            }}
            type="button"
            aria-label="Add"
          >
            <Plus size={20} strokeWidth={1.75} />
          </button>
          {plusMenuOpen && (
            <div className="plus-menu">
              <ToolMenuRow icon={Paperclip} label="Upload photos & files" />
              <div className="menu-divider" />
              <ToolMenuRow icon={Flame} label="Motivation" />
              <ToolMenuRow icon={Lightbulb} label="Brainstorming" />
              <ToolMenuRow icon={Wand2} label="Context Refine" />
              <ToolMenuRow icon={PenLine} label="Context Rewrite" />
              <ToolMenuRow
                icon={ListPlus}
                label="Request a task"
                onClick={() => {
                  setPlusMenuOpen(false);
                  onNavigate?.("tasks");
                }}
              />
              <ToolMenuRow
                icon={MoreHorizontal}
                label="More"
                trailing={<ChevronRight size={14} strokeWidth={1.75} />}
              />
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          aria-label="Ask anything"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask anything"
          value={input}
        />
        <div className="model-picker" ref={modelRef}>
          <button
            className="model-button"
            onClick={() => {
              setPlusMenuOpen(false);
              setModelMenuOpen((open) => !open);
            }}
            type="button"
          >
            {formatModeLabel(selectedMode)}
            <ChevronRight size={14} strokeWidth={1.75} />
          </button>
          {modelMenuOpen && (
            <div className="model-menu">
              <div className="model-latest">
                <span>Latest</span>
                <span>0.1.0</span>
              </div>
              <ModelGroup label="Private" />
              {modes
                .filter((mode) => mode.label.startsWith("Private"))
                .map((mode) => (
                  <ModelOption
                    key={mode.label}
                    mode={mode}
                    selected={mode.label === selectedMode}
                    onClick={() => {
                      setSelectedMode(mode.label);
                      setModelMenuOpen(false);
                    }}
                  />
                ))}
              <div className="menu-divider" />
              <ModelGroup label="Frontier" />
              {modes
                .filter((mode) => mode.label.startsWith("Frontier"))
                .map((mode) => (
                  <ModelOption
                    key={mode.label}
                    mode={mode}
                    selected={mode.label === selectedMode}
                    onClick={() => {
                      setSelectedMode(mode.label);
                      setModelMenuOpen(false);
                    }}
                  />
                ))}
              <div className="menu-divider" />
              <ToolMenuRow icon={SettingsIcon} label="Configure" />
            </div>
          )}
        </div>
        <button className="send-button" disabled={!input.trim() || sending} type="submit" aria-label="Send">
          <ArrowUp size={18} strokeWidth={2.25} />
        </button>
      </form>
      {composerStatus && (
        <div className={`chat-composer-note ${composerStatus.tone}`}>
          {composerStatus.text}
        </div>
      )}
    </div>
  );

  return (
    <div className={turns.length === 0 ? "chat-surface empty" : "chat-surface"}>
      {turns.length === 0 ? (
        <div className="chat-empty">
          <h1>What are you working on?</h1>
          {composer}
        </div>
      ) : (
        <div className="chat-thread-shell">
          <div className="message-list" ref={messageListRef} aria-live="polite">
            {turns.map((message, index) => {
              if (message.role === "user") {
                return (
                  <UserMessage
                    draft={editDraft}
                    isEditing={editingMsg === index}
                    key={message.id || `user-${index}`}
                    onCancelEdit={() => setEditingMsg(null)}
                    onDraftChange={setEditDraft}
                    onSaveEdit={() => {
                      setTurns((current) =>
                        current.map((row, rowIndex) =>
                          rowIndex === index ? { ...row, text: editDraft } : row
                        )
                      );
                      setEditingMsg(null);
                    }}
                    onStartEdit={() => {
                      setEditingMsg(index);
                      setEditDraft(message.text || "");
                    }}
                    text={message.text}
                  />
                );
              }

              return (
                <AssistantMessage
                  key={message.id || `assistant-${index}`}
                  message={message}
                  onOpenActivity={() => setActivityOpen(true)}
                  onShare={() => setShareOpen(true)}
                />
              );
            })}
          </div>
          <button
            className="scroll-bottom-button"
            onClick={() => {
              messageListRef.current?.scrollTo({
                top: messageListRef.current.scrollHeight,
                behavior: "smooth",
              });
            }}
            title="Scroll to bottom"
            type="button"
          >
            <ArrowDown size={14} strokeWidth={2} />
          </button>
          <div className="composer-dock">{composer}</div>
        </div>
      )}
      {shareOpen && (
        <ShareModal
          onClose={() => setShareOpen(false)}
          thread={turns}
          title={chatTitle}
        />
      )}
      {activityOpen && (
        <ActivityPanel data={SAMPLE_ACTIVITY} onClose={() => setActivityOpen(false)} />
      )}
    </div>
  );
}

function chatComposerStatus({ actualUsage, message, sending, tone, turns }) {
  if (sending) return { tone: "muted", text: "Thinking..." };
  if (actualUsage) {
    return {
      tone: "muted",
      text: `Billed ${formatUsageUsd(actualUsage.costUsd)} · ${actualUsage.totalTokens} tokens`,
    };
  }
  if (message && tone === "error") return { tone: "error", text: message };
  if (turns.length > 0) {
    return { tone: "muted", text: "Task Node can make mistakes. Check important info." };
  }
  return null;
}

function buildRecentChats(serverRecents) {
  const rows = [];
  const seen = new Set();

  for (const title of serverRecents) {
    if (!title || seen.has(title)) continue;
    seen.add(title);
    rows.push({
      id: `server-${slugify(title) || rows.length}`,
      source: "server",
      title,
    });
  }

  for (const chat of RECENT_CHAT_MOCKS) {
    if (seen.has(chat.title)) continue;
    seen.add(chat.title);
    rows.push({ ...chat, source: "mock" });
  }

  return rows;
}

function normalizeChatMessages(messages) {
  return (messages || [])
    .map((message, index) => normalizeChatMessage(message, index))
    .filter(Boolean);
}

function normalizeChatMessage(message, index = 0) {
  if (!message) return null;
  const role = message.role === "user" ? "user" : "assistant";
  const text = String(message.text || message.content || message.body || "");

  if (role === "user") {
    return {
      id: message.id || `user-${index}`,
      role,
      text,
    };
  }

  return {
    id: message.id || `assistant-${index}`,
    role,
    thinking: message.thinking,
    blocks: Array.isArray(message.blocks) ? message.blocks : markdownToBlocks(text),
  };
}

function markdownToBlocks(input) {
  const text = String(input || "").trim();
  if (!text) return [{ type: "p", inline: [{ text: "" }] }];

  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\s+(\d+\.\s+\*\*)/g, "$1\n$2")
    .replace(/([^\n])\s+(\d+\.\s+[A-Z])/g, "$1\n$2");
  const lines = normalized.split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "p", inline: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  function pushList(type, rawItem) {
    flushParagraph();
    if (!list || list.type !== type) {
      flushList();
      list = { type, items: [] };
    }
    list.items.push(parseInline(rawItem.trim()));
  }

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) {
      flushParagraph();
      flushList();
      continue;
    }

    const h2 = raw.match(/^##\s+(.+)/);
    const h3 = raw.match(/^###\s+(.+)/);
    const quote = raw.match(/^>\s+(.+)/);
    const ul = raw.match(/^[-*]\s+(.+)/);
    const ol = raw.match(/^\d+[.)]\s+(.+)/);

    if (/^---+$/.test(raw)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "hr" });
    } else if (h3) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h3", inline: parseInline(h3[1]) });
    } else if (h2) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h2", inline: parseInline(h2[1]) });
    } else if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", inline: parseInline(quote[1]) });
    } else if (ul) {
      pushList("ul", ul[1]);
    } else if (ol) {
      pushList("ol", ol[1]);
    } else {
      paragraph.push(raw);
    }
  }

  flushParagraph();
  flushList();
  return blocks.length > 0 ? blocks : [{ type: "p", inline: [{ text }] }];
}

function parseInline(input) {
  const text = String(input || "");
  const parts = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith("`")) {
      parts.push({ code: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      parts.push({ bold: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      parts.push({ italic: token.slice(1, -1) });
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ text }];
}

function createRecentPlaceholderThread(title) {
  return [
    { role: "user", text: `Open ${title}` },
    {
      role: "assistant",
      blocks: [
        {
          type: "p",
          inline: [
            {
              text:
                "This chat frame is wired. Conversation-specific history will hydrate here when the app server exposes per-thread loading.",
            },
          ],
        },
      ],
    },
  ];
}

function chatTitleFromPrompt(prompt) {
  const title = String(prompt || "").trim().replace(/\s+/g, " ").slice(0, 48);
  return title || "New chat";
}

function titleFromTurns(turns) {
  const firstUser = turns.find((turn) => turn.role === "user" && turn.text);
  return chatTitleFromPrompt(firstUser?.text || "Untitled chat");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function plainTextFromBlocks(blocks) {
  return (blocks || [])
    .map((block) => {
      if (block.type === "ul" || block.type === "ol") {
        return (block.items || [])
          .map((item) => inlineToText(Array.isArray(item) ? item : [{ text: item }]))
          .join("\n");
      }
      return inlineToText(block.inline || [{ text: block.text || "" }]);
    })
    .filter(Boolean)
    .join("\n\n");
}

function inlineToText(parts) {
  return (parts || [])
    .map((part) => part.text || part.bold || part.italic || part.code || "")
    .join("");
}

function copyText(text) {
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function UserMessage({
  draft,
  isEditing,
  onCancelEdit,
  onDraftChange,
  onSaveEdit,
  onStartEdit,
  text,
}) {
  if (isEditing) {
    return (
      <article className="user-message editing">
        <div className="user-edit-card">
          <textarea
            autoFocus
            onChange={(event) => onDraftChange(event.target.value)}
            value={draft}
          />
          <div className="user-edit-actions">
            <button onClick={onCancelEdit} type="button">
              Cancel
            </button>
            <button className="dark" onClick={onSaveEdit} type="button">
              Send
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="user-message">
      <div className="user-bubble">{text}</div>
      <div className="user-message-tools">
        <ToolbarButton icon={Copy} label="Copy message" onClick={() => copyText(text)} />
        <ToolbarButton icon={Pencil} label="Edit" onClick={onStartEdit} />
      </div>
    </article>
  );
}

function AssistantMessage({ message, onOpenActivity, onShare }) {
  const body = plainTextFromBlocks(message.blocks);

  return (
    <article className="assistant-message">
      {message.thinking && (
        <button className="thinking-row" onClick={onOpenActivity} type="button">
          {message.thinking.state === "stopped"
            ? "Stopped thinking"
            : `Thought for ${message.thinking.duration}`}
          <ChevronRight size={13} strokeWidth={1.75} />
        </button>
      )}
      <div className="assistant-body">
        {(message.blocks || []).map((block, index) => (
          <BlockRenderer block={block} key={index} />
        ))}
      </div>
      <MessageToolbar
        onCopy={() => copyText(body)}
        onOpenSources={onOpenActivity}
        onShare={onShare}
      />
    </article>
  );
}

function BlockRenderer({ block }) {
  if (!block) return null;

  switch (block.type) {
    case "p":
      return (
        <p>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </p>
      );
    case "h2":
      return (
        <h2>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </h2>
      );
    case "h3":
      return (
        <h3>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </h3>
      );
    case "quote":
      return (
        <blockquote>
          <Inline parts={block.inline || [{ text: block.text || "" }]} />
        </blockquote>
      );
    case "ul":
      return (
        <ul>
          {(block.items || []).map((item, index) => (
            <li key={index}>
              <Inline parts={Array.isArray(item) ? item : [{ text: item }]} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol>
          {(block.items || []).map((item, index) => (
            <li key={index}>
              <Inline parts={Array.isArray(item) ? item : [{ text: item }]} />
            </li>
          ))}
        </ol>
      );
    case "hr":
      return <hr />;
    default:
      return null;
  }
}

function Inline({ parts }) {
  return (
    <>
      {(parts || []).map((part, index) => {
        if (part.bold) return <strong key={index}>{part.bold}</strong>;
        if (part.italic) return <em key={index}>{part.italic}</em>;
        if (part.code) return <code key={index}>{part.code}</code>;
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

function MessageToolbar({ onCopy, onOpenSources, onShare }) {
  return (
    <div className="message-toolbar">
      <ToolbarButton icon={Copy} label="Copy response" onClick={onCopy} />
      <ToolbarButton icon={ArrowUp} label="Share" onClick={onShare} />
      <ToolbarButton icon={RefreshCw} label="Regenerate" />
      <ToolbarButton icon={MoreHorizontal} label="More" />
      <span className="toolbar-divider" />
      <button className="sources-button" onClick={onOpenSources} type="button">
        <BookOpen size={14} strokeWidth={1.75} />
        Sources
      </button>
    </div>
  );
}

function ToolbarButton({ icon: Icon, label, onClick }) {
  const [hover, setHover] = useState(false);

  return (
    <span className="toolbar-button-wrap">
      <button
        aria-label={label}
        className="toolbar-button"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        type="button"
      >
        <Icon size={14} strokeWidth={1.75} />
      </button>
      {hover && <span className="toolbar-tip">{label}</span>}
    </span>
  );
}

function ShareModal({ onClose, thread, title }) {
  const previewThread = (thread || []).slice(0, 4);

  return (
    <div className="modal-backdrop share-backdrop" onClick={onClose} role="presentation">
      <section
        aria-labelledby="share-title"
        aria-modal="true"
        className="share-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="share-title">{title || "Untitled chat"}</h2>
          <button
            aria-label="Close share"
            className="share-modal-close"
            onClick={onClose}
            type="button"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="share-preview">
          <strong>Task Node</strong>
          <div>
            {previewThread.map((message, index) =>
              message.role === "user" ? (
                <div className="share-preview-user" key={index}>
                  <span>{message.text}</span>
                </div>
              ) : (
                <div className="share-preview-assistant" key={index}>
                  {(message.blocks || []).slice(0, 2).map((block, blockIndex) => (
                    <BlockRenderer block={block} key={blockIndex} />
                  ))}
                </div>
              )
            )}
          </div>
        </div>
        <div className="share-targets">
          <ShareTarget icon={Link2} label="Copy link" />
          <ShareTarget label="X" symbol="X" />
          <ShareTarget icon={Linkedin} label="LinkedIn" />
          <ShareTarget label="Reddit" symbol="R" />
        </div>
        <p>Memory sources won't be shared with viewers.</p>
      </section>
    </div>
  );
}

function ShareTarget({ icon: Icon, label, symbol }) {
  return (
    <button className="share-target" type="button">
      <span>{Icon ? <Icon size={20} strokeWidth={1.75} /> : symbol}</span>
      {label}
    </button>
  );
}

function ActivityPanel({ data, onClose }) {
  const [showMoreMemory, setShowMoreMemory] = useState(false);
  const memoryRows = showMoreMemory ? data.memory : data.memory.slice(0, 4);

  return (
    <aside className="activity-panel" aria-label="Activity">
      <header>
        <div>
          <h3>Activity</h3>
          <span>{data.duration}</span>
        </div>
        <button
          aria-label="Close activity"
          className="activity-panel-close"
          onClick={onClose}
          type="button"
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </header>
      <div className="activity-panel-body">
        <section>
          <h4>Thinking</h4>
          <div className="thinking-list">
            {data.thinking.map((step, index) => (
              <div className="thinking-step" key={`${step.label}-${index}`}>
                <span>
                  {step.kind === "primary" ? (
                    <BookOpen size={14} strokeWidth={1.75} />
                  ) : (
                    <i />
                  )}
                </span>
                {step.label}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h4>
            Memory <span>{data.memory.length + (data.memoryMore || 0)}</span>
          </h4>
          <div className="memory-list">
            {memoryRows.map((memory, index) => (
              <div className="memory-item" key={`${memory.title}-${index}`}>
                <small>
                  <MessageCircle size={12} strokeWidth={1.75} />
                  Past chat
                </small>
                <strong>{memory.title}</strong>
                <p>{memory.preview}</p>
              </div>
            ))}
            {!showMoreMemory && data.memoryMore > 0 && (
              <button onClick={() => setShowMoreMemory(true)} type="button">
                {data.memoryMore} more
                <ChevronDown size={12} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </section>
        {data.files?.length > 0 && (
          <section>
            <h4>
              Files <span>{data.files.length}</span>
            </h4>
            <div className="activity-file-list">
              {data.files.map((file) => (
                <div className="activity-file" key={file.name}>
                  <span>
                    <FileText size={15} strokeWidth={1.75} />
                  </span>
                  <div>
                    <small>{file.type}</small>
                    <strong>{file.name}</strong>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

function SidebarButton({ active, badge, icon: Icon, label, onClick, sidebarOpen }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} type="button">
      <Icon size={18} strokeWidth={1.75} />
      {sidebarOpen && <span>{label}</span>}
      {sidebarOpen && badge ? <small>{badge}</small> : null}
    </button>
  );
}

function BrandDot() {
  return (
    <span className="brand-dot">
      <Sparkles size={14} strokeWidth={2} />
    </span>
  );
}

function ModelGroup({ label }) {
  return <div className="model-group">{label}</div>;
}

function ModelOption({ mode, onClick, selected }) {
  return (
    <button className={selected ? "selected" : ""} onClick={onClick} type="button">
      <span>{formatModeLabel(mode.label)}</span>
      <small>{mode.enabled ? "Ready" : mode.configured ? "Disabled" : "Needs config"}</small>
    </button>
  );
}

function ToolMenuRow({ icon: Icon, label, onClick, trailing }) {
  return (
    <button className="tool-menu-row" onClick={onClick} type="button">
      <Icon size={16} strokeWidth={1.75} />
      <span>{label}</span>
      {trailing}
    </button>
  );
}

function formatModeLabel(label) {
  return label.replace("Private ", "Private - ").replace("Frontier ", "Frontier - ");
}

function isSignedInSession(session) {
  return session?.status === "signed_in";
}

function profileDisplayName(session) {
  if (session?.displayName) return session.displayName;
  return "Log in or sign up";
}

function profileAvatarText(session) {
  if (!session?.displayName) return "TN";
  return session.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function profileSessionText(session) {
  if (!isSignedInSession(session)) return "Account";
  const provider = sessionProviderLabel(session);
  return provider ? `Signed in with ${provider}` : "Signed in";
}

function sessionProviderLabel(session) {
  const providerId = session?.primaryProvider;
  const linked = (session?.linkedProviders || []).find((item) => item?.id === providerId);
  if (linked?.label) return linked.label;
  if (providerId === "github") return "GitHub";
  if (providerId === "email") return "Email";
  if (providerId === "dev") return "Dev";
  if (providerId === "x") return "X";
  if (providerId === "telegram") return "Telegram";
  if (providerId === "discord") return "Discord";
  return "";
}

function ProfileAvatar({ initials, signedIn }) {
  return (
    <span className={`profile-avatar ${signedIn ? "signed-in" : "signed-out"}`}>
      {initials}
      {signedIn && (
        <span className="profile-check" aria-hidden="true">
          <Check size={9} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

function TasksView({ onSelectTask }) {
  const [tasksTab, setTasksTab] = useState("outstanding");
  const tabs = [
    { key: "outstanding", label: "Outstanding", count: MOCK_TASKS.outstanding.length },
    { key: "verification", label: "Verification", count: MOCK_TASKS.verification.length },
    { key: "refused", label: "Refused", count: MOCK_TASKS.refused },
    { key: "rewarded", label: "Rewarded", count: MOCK_TASKS.rewarded },
  ];

  return (
    <div className="route-scroll">
      <div className="tasks-view">
        <div className="route-heading">
          <div>
            <h1>Tasks</h1>
            <p>Work proposed, accepted, and verified across the network.</p>
          </div>
          <button className="dark-pill" type="button">
            <Plus size={16} strokeWidth={2} />
            Request task
          </button>
        </div>

        <div className="tab-row">
          {tabs.map((tab) => {
            const active = tasksTab === tab.key;
            return (
              <button
                className={active ? "active" : ""}
                key={tab.key}
                onClick={() => setTasksTab(tab.key)}
                type="button"
              >
                {tab.label}
                <span>{tab.count}</span>
              </button>
            );
          })}
        </div>

        {tasksTab === "outstanding" && (
          <div className="task-list">
            {MOCK_TASKS.outstanding.map((task) => (
              <TaskRow key={task.id} onClick={() => onSelectTask(task)} task={task} />
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
    </div>
  );
}

function TaskRow({ onClick, task }) {
  return (
    <button className="task-row" onClick={onClick} type="button">
      <div className="task-row-main">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <span>{task.kind}</span>
          <StatusPill status={task.status} />
          <span>.</span>
          <span>{task.due}</span>
          <span>.</span>
          <span>{task.ago}</span>
        </div>
        <div className="task-id">
          <span>ID: {task.id}...</span>
          <ArrowUpRight size={11} strokeWidth={1.75} />
        </div>
      </div>
      <div className="task-reward">
        {task.pft.toLocaleString()} <span>PFT</span>
      </div>
    </button>
  );
}

function WalletView({ wallet, usage }) {
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const actions = wallet?.actions || [];
  const linkAction = actions.find((action) => action.id === "link_start");
  const pftBalance = formatDrops(wallet?.pftBalanceDrops || 0);

  async function startWalletAction(action) {
    if (!action) return;

    setPendingAction(action.id);
    setMessage("");

    try {
      const result = await requestJson(action.path, { method: action.method || "POST" });
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${action.label} returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${action.label} is unavailable.`);
    } finally {
      setPendingAction("");
    }
  }

  return (
    <div className="route-scroll">
      <div className="wallet-view">
        <section className="wallet-hero">
          <div className="eyebrow">Available balance</div>
          <div className="wallet-balance">
            <span>{pftBalance}</span>
            <small>PFT</small>
          </div>
          <div className="wallet-delta">
            <strong>+8,400 PFT</strong>
            <span>received in the last 24h</span>
          </div>
          <button className="address-chip" type="button">
            <span>rPo8GkCA9YMKzu...JHxNx</span>
            <Copy size={11} strokeWidth={1.75} />
          </button>
          <div className="wallet-actions">
            <button
              className="dark-pill"
              onClick={() => startWalletAction(linkAction)}
              type="button"
            >
              <Send size={15} strokeWidth={2} />
              Send
            </button>
            <button className="light-pill" type="button">
              <ArrowDownToLine size={15} strokeWidth={2} />
              Receive
            </button>
          </div>
          <div className="wallet-flow">
            <span><strong>+47,200</strong> in this week</span>
            <span className="dot">.</span>
            <span><strong>-3,840</strong> out</span>
            <span className="dot">.</span>
            <span><strong>12</strong> transactions</span>
          </div>
        </section>

        {message && <div className="inline-message">{message}</div>}

        <ProfileCard
          subtitle="Your latest transactions"
          title="Activity"
          trailing={<button className="link-button" type="button">View all</button>}
        >
          <div className="activity-groups">
            {ACTIVITY_GROUPS.map((group) => (
              <div key={group.group}>
                <div className="activity-group-label">{group.group}</div>
                <div>
                  {group.items.map((tx, index) => (
                    <ActivityRow key={`${group.group}-${index}`} tx={tx} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ProfileCard>

        <div className="wallet-config-strip">
          {actions.map((action) => (
            <button key={action.id} onClick={() => startWalletAction(action)} type="button">
              <span>{action.label}</span>
              <small>{pendingAction === action.id ? "Checking" : action.configured ? "Config ready" : "Needs config"}</small>
            </button>
          ))}
        </div>
        <div className="wallet-usage-note">
          Chat credit {formatUsd(wallet?.chatCreditUsd || 0)}. Billing is{" "}
          {usage?.billingModel === "usage_based" ? "usage based" : "not ready"}.
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ tx }) {
  const isIn = tx.kind === "in";

  return (
    <div className="activity-row">
      <div className={isIn ? "activity-icon in" : "activity-icon out"}>
        {isIn ? <ArrowDownLeft size={15} strokeWidth={2} /> : <ArrowUpRight size={15} strokeWidth={2} />}
      </div>
      <div className="activity-copy">
        <strong>{tx.title}</strong>
        <small>
          {isIn ? "From " : "To "}
          <span>{tx.party}</span>
          {tx.sub ? ` . ${tx.sub}` : ""}
        </small>
      </div>
      <div className={isIn ? "activity-amount in" : "activity-amount"}>
        {isIn ? "+" : "-"}
        {tx.amount.toLocaleString(undefined, {
          minimumFractionDigits: tx.amount === 0 ? 2 : 0,
        })}{" "}
        PFT
        <small>{tx.time}</small>
      </div>
    </div>
  );
}

function ContextView() {
  const [contextSource, setContextSource] = useState("pft");

  return (
    <div className="route-scroll">
      <div className="context-view">
        <div className="route-heading compact">
          <div>
            <h1>Context</h1>
            <p>Choose where the assistant draws context from. You can connect more than one source.</p>
          </div>
        </div>

        <div className="context-source-list">
          {CONTEXT_SOURCES.map((source) => {
            const Icon = source.icon;
            const active = contextSource === source.key;
            return (
              <button
                className={active ? "context-source active" : "context-source"}
                key={source.key}
                onClick={() => setContextSource(source.key)}
                type="button"
              >
                <span className="context-source-icon" style={{ background: `${source.accent}14`, color: source.accent }}>
                  <Icon size={20} strokeWidth={1.75} />
                </span>
                <span className="context-source-copy">
                  <span>
                    <strong>{source.name}</strong>
                    {source.status === "connected" && <em>Connected</em>}
                  </span>
                  <small>{source.desc}</small>
                </span>
                <span className="radio-mark">{active && <span />}</span>
              </button>
            );
          })}
        </div>

        <div className="context-note">
          The active context source feeds the assistant alongside your prompt.
          Internal PFT Context is always available on Task Node; external
          connectors require authorization.
        </div>
      </div>
    </div>
  );
}

function ProfileView({ profilePublic, profileTab, setProfilePublic, setProfileTab }) {
  return (
    <div className="route-scroll">
      <div className="profile-view">
        <div className="profile-tabs-bar">
          <div className="segmented">
            {[
              { key: "private", label: "Private" },
              { key: "public", label: "Public" },
            ].map((tab) => (
              <button
                className={profileTab === tab.key ? "active" : ""}
                key={tab.key}
                onClick={() => setProfileTab(tab.key)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            className={profilePublic ? "visibility-pill public" : "visibility-pill"}
            onClick={() => setProfilePublic((value) => !value)}
            type="button"
          >
            {profilePublic ? <Eye size={13} /> : <EyeOff size={13} />}
            {profilePublic ? "Profile public" : "Profile hidden"}
          </button>
        </div>

        {profileTab === "private" ? <PrivateProfile /> : <PublicProfile />}
      </div>
    </div>
  );
}

function PrivateProfile() {
  return (
    <div className="profile-stack">
      <ProfileCard title="Profile Studio" subtitle="Generate the picture that represents you across the network">
        <div className="profile-studio">
          <div className="profile-art" />
          <div>
            <div className="eyebrow">Current picture</div>
            <h3>Network Verification Engineer</h3>
            <p>Today's gift NFT . minted May 13, 2026</p>
            <div className="button-row">
              <PillButton icon={RefreshCw}>Regenerate</PillButton>
              <PillButton dark icon={Sparkle}>Mint as NFT</PillButton>
            </div>
          </div>
        </div>
      </ProfileCard>

      <ProfileCard title="Today's airdrop" subtitle="Daily feedback on what the network would currently pay you">
        <div className="airdrop-line">
          <span>8,400</span>
          <small>PFT</small>
          <em>Core 84 / 100</em>
        </div>
        <p className="soft-copy">
          Today's payout reflects high retained value from recent core-network
          shipping, balanced by still-limited proof of wider adoption impact.
        </p>
        <div className="mini-note-grid">
          <MiniNote title="Raised today" body="Shipping core network fixes and automation around rewards and NFT generation." />
          <MiniNote title="Kept it lower" body="The main limiter is recent product stabilization rather than measured network growth." />
          <MiniNote title="To improve" body="Tie shipped fixes to visible user adoption and repeatable network growth loops." />
        </div>
      </ProfileCard>

      <ProfileCard title="PFT generation" subtitle="Last 28 days">
        <Sparkline values={PFT_GENERATION} />
        <div className="pft-breakdown">
          {PFT_BREAKDOWN.map((item) => (
            <div key={item.label}>
              <small>{item.label}</small>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </ProfileCard>

      <NftGallery />

      <ProfileCard title="Recommended connections" subtitle="Members who may be valuable collaborators">
        <div className="connection-list">
          {CONNECTIONS.map((connection) => (
            <ConnectionRow connection={connection} key={connection.handle} />
          ))}
        </div>
      </ProfileCard>
    </div>
  );
}

function PublicProfile() {
  return (
    <div className="profile-stack">
      <section className="public-wallet-card">
        <div className="public-wallet-header">
          <div className="profile-art small" />
          <div>
            <div className="eyebrow">Wallet</div>
            <div className="mono-line">rPo8GkCA9YMKzuJGTHbj11kdVfPq5JHxNx</div>
            <p>Last active 18 minutes ago</p>
          </div>
        </div>
        <div className="public-stats">
          <PublicStat label="Total rewards paid" value="552,308" unit="PFT" />
          <PublicStat label="Sybil score" value="88" pill="Low risk" />
          <PublicStat label="Alignment score" value="86" pill="Active contributor" />
        </div>
      </section>

      <ProfileCard
        title="About me"
        trailing={<button className="link-button icon-link" type="button"><Pencil size={11} /> Edit</button>}
      >
        <p className="soft-copy italic">Not specified yet.</p>
      </ProfileCard>

      <NftGallery />

      <ProfileCard title="Post Fiat alignment" subtitle="Network contribution this month">
        <div className="alignment-grid">
          <div>
            <small>Rewards earned</small>
            <strong>41,046.79 <span>PFT</span></strong>
          </div>
          <div>
            <small>Tasks completed</small>
            <strong>5</strong>
          </div>
        </div>
      </ProfileCard>

      <ProfileCard title="Sybil score" subtitle="System assessment of account authenticity">
        <div className="sybil-card">
          <SybilRing value={88} />
          <div>
            <span className="green-pill">Low risk</span>
            <p>
              This account shows strong signals of authentic activity based on
              linked accounts, behavior patterns, and network topology.
            </p>
          </div>
        </div>
        <div className="sybil-signals">
          <SybilSignal icon={UserCheck} label="Real accounts linked" hint="Verified external identities" value="3 / 4" />
          <SybilSignal icon={AlertTriangle} label="Attempted gaming" hint="Manipulation detection signals" tone="warn" value="7 flagged" />
          <SybilSignal icon={Activity} label="Network graph" hint="Interaction topology" value="28 connections . Organic" />
        </div>
      </ProfileCard>
    </div>
  );
}

function StatusPill({ status }) {
  const tone = {
    Proposed: { background: "#fef3c7", color: "#92400e" },
    Accepted: { background: "#dcfce7", color: "#166534" },
  }[status] || { background: "#e5e5e0", color: "#0d0d0d" };

  return (
    <span className="status-pill" style={tone}>
      {status}
    </span>
  );
}

function EmptyState({ icon: Icon, title, desc }) {
  return (
    <div className="empty-state">
      <span>
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <strong>{title}</strong>
      <p>{desc}</p>
    </div>
  );
}

function ProfileCard({ children, subtitle, title, trailing }) {
  return (
    <section className="profile-card">
      <div className="profile-card-heading">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function PillButton({ children, dark, icon: Icon }) {
  return (
    <button className={dark ? "pill-button dark" : "pill-button"} type="button">
      {Icon && <Icon size={13} strokeWidth={1.75} />}
      {children}
    </button>
  );
}

function MiniNote({ body, title }) {
  return (
    <div className="mini-note">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function Sparkline({ values }) {
  const width = 720;
  const height = 180;
  const max = Math.max(...values);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / max) * (height - 20) - 10;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PFT generation chart">
      <polyline fill="none" points={points} stroke="#0d0d0d" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function NftGallery() {
  return (
    <ProfileCard title="NFT Gallery" subtitle={`${NFTS.length} minted`} trailing={<button className="link-button" type="button">View all</button>}>
      <div className="nft-grid">
        {NFTS.map((nft) => (
          <div className="nft-item" key={nft.id}>
            <span style={{ background: nft.gradient }} />
            <strong>{nft.title}</strong>
            <small>{nft.date}</small>
          </div>
        ))}
      </div>
    </ProfileCard>
  );
}

function ConnectionRow({ connection }) {
  return (
    <div className="connection-row">
      <div className="connection-top">
        <div>
          <span className="connection-avatar" />
          <strong>{connection.handle}</strong>
        </div>
        <span className="match-pill">Match {connection.match}%</span>
      </div>
      <p>{connection.summary}</p>
      <div className="tag-row">
        {connection.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
    </div>
  );
}

function PublicStat({ label, pill, unit, value }) {
  return (
    <div className="public-stat">
      <small>{label}</small>
      <strong>
        {value}
        {unit && <span>{unit}</span>}
        {pill && <em>{pill}</em>}
      </strong>
    </div>
  );
}

function SybilRing({ value }) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  return (
    <div className="sybil-ring">
      <svg height="72" viewBox="0 0 72 72" width="72">
        <circle cx="36" cy="36" fill="none" r={radius} stroke="#e8e6df" strokeWidth="6" />
        <circle
          cx="36"
          cy="36"
          fill="none"
          r={radius}
          stroke="#16a34a"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth="6"
          transform="rotate(-90 36 36)"
        />
      </svg>
      <span>{value}</span>
    </div>
  );
}

function SybilSignal({ hint, icon: Icon, label, tone = "ok", value }) {
  return (
    <div className="sybil-signal">
      <span>
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <div>
        <strong>{label}</strong>
        <small>{hint}</small>
      </div>
      <em className={tone}>{value}</em>
    </div>
  );
}

function SettingsModal({ onClose, session, setTheme, theme }) {
  const [page, setPage] = useState("general");
  const activePage = SETTINGS_PAGES.find((item) => item.key === page) || SETTINGS_PAGES[0];

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="settings-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-rail">
          <button className="settings-close" onClick={onClose} type="button" aria-label="Close settings">
            <X size={18} strokeWidth={1.75} />
          </button>
          <nav>
            {SETTINGS_PAGES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={page === item.key ? "active" : ""}
                  key={item.key}
                  onClick={() => setPage(item.key)}
                  type="button"
                >
                  <Icon size={16} strokeWidth={1.75} />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </aside>
        <div className="settings-content">
          <header>
            <h2 id="settings-title">{activePage.label}</h2>
          </header>
          <div className="settings-page">
            {page === "general" && <GeneralSettings setTheme={setTheme} theme={theme} />}
            {page === "security" && <SecuritySettings session={session} />}
            {page === "data" && <DataSettings />}
            {page === "billing" && <BillingSettings />}
          </div>
        </div>
      </section>
    </div>
  );
}

function GeneralSettings({ setTheme, theme }) {
  return (
    <>
      <MfaCallout />
      <SettingsLine label="Appearance" right={<CycleButton onClick={() => setTheme(nextTheme(theme))} value={themeLabel(theme)} />} />
      <SettingsLine label="Contrast" right={<StaticButton value="System" />} />
      <SettingsLine label="Accent color" right={<StaticButton value="Black" />} />
      <SettingsLine label="Language" right={<StaticButton value="Auto-detect" />} />
    </>
  );
}

function SecuritySettings({ session }) {
  const signedIn = isSignedInSession(session);
  const linkedProviders = session?.linkedProviders || [];
  const providers = (session?.accountLinks || []).filter((provider) =>
    ["github", "telegram", "discord", "x"].includes(provider.id)
  );
  const linkedProviderCount = linkedProviders.filter((item) =>
    providers.some((provider) => provider.id === item?.id)
  ).length;
  const [message, setMessage] = useState("");
  const [pendingProvider, setPendingProvider] = useState("");

  async function startProviderLink(provider) {
    if (!signedIn) {
      setMessage("Sign in before linking accounts.");
      return;
    }

    setPendingProvider(provider.id);
    setMessage("");

    try {
      const result = await requestJson(`${provider.startPath}?redirect=/`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${provider.label} returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${provider.label} is unavailable.`);
    } finally {
      setPendingProvider("");
    }
  }

  return (
    <>
      <MfaCallout />
      {providers.length > 0 && (
        <section className="connected-accounts">
          <div className="connected-heading">
            <strong>Connected accounts</strong>
            <span>{linkedProviderCount} linked</span>
          </div>
          {providers.map((provider) => (
            <ConnectedAccountRow
              key={provider.id}
              linkedProviders={linkedProviders}
              onLink={startProviderLink}
              pending={pendingProvider === provider.id}
              provider={provider}
              signedIn={signedIn}
            />
          ))}
          {message && <div className="inline-message">{message}</div>}
        </section>
      )}
      <SettingsLine desc="Write down or store your recovery phrase securely." label="Backup recovery phrase" right={<SmallPill>Reveal</SmallPill>} />
      <SettingsLine desc="Sign in with an existing recovery phrase." label="Restore wallet" right={<SmallPill>Restore</SmallPill>} />
      <SettingsLine desc="2 devices currently signed in." label="Active sessions" right={<SmallPill>Manage</SmallPill>} />
      <SettingsLine desc="Send a security or product report." label="Report issue" right={<SmallPill>Report</SmallPill>} />
    </>
  );
}

function ConnectedAccountRow({ linkedProviders, onLink, pending, provider, signedIn }) {
  const linkedProvider = linkedProviders.find((item) => item?.id === provider.id);
  const linked = Boolean(linkedProvider);
  const status = linked
    ? linkedAccountStatus(linkedProvider)
    : provider.enabled
      ? "Available"
      : provider.configured
        ? "Disabled"
        : "Needs config";

  return (
    <div className="connected-account-row">
      <span className="connected-provider-icon">
        <ProviderIcon id={provider.id} />
      </span>
      <div>
        <strong>{provider.label}</strong>
        <small>{status}</small>
      </div>
      {linked ? (
        <em>Linked</em>
      ) : (
        <button
          disabled={!signedIn || !provider.enabled || pending}
          onClick={() => onLink(provider)}
          type="button"
        >
          {pending ? "Checking" : "Connect"}
        </button>
      )}
    </div>
  );
}

function linkedAccountStatus(provider) {
  if (provider.username) return `@${provider.username}`;
  if (provider.maskedEmail) return provider.maskedEmail;
  if (provider.email) return provider.email;
  return "Linked";
}

function DataSettings() {
  return (
    <>
      <SettingsLine desc="Allow your content to be used to improve Task Node." label="Improve the model for everyone" right={<ToggleSwitch initial />} />
      <SettingsLine desc="Manage links you've shared from chats." label="Shared links" right={<SmallPill>Manage</SmallPill>} />
      <SettingsLine desc="Receive a copy of your conversations and PFT history." label="Export data" right={<SmallPill>Export</SmallPill>} />
      <SettingsLine desc="How Task Node handles your data." label="Privacy Policy" right={<SmallPill>View <ExternalLink size={11} /></SmallPill>} />
      <SettingsLine danger desc="Permanently remove your account and all associated data." label="Delete account" right={<SmallPill danger>Delete</SmallPill>} />
    </>
  );
}

function BillingSettings() {
  const [ledger, setLedger] = useState(null);
  const [ledgerError, setLedgerError] = useState("");

  useEffect(() => {
    let active = true;

    requestJson("/api/usage/ledger")
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setLedger(result.body);
          setLedgerError("");
        } else {
          setLedgerError(result.body?.message || `Billing history returned HTTP ${result.status}.`);
        }
      })
      .catch((error) => {
        if (active) setLedgerError(error?.message || "Billing history is unavailable.");
      });

    return () => {
      active = false;
    };
  }, []);

  const entries = ledger?.entries || [];

  return (
    <div className="billing-settings">
      <section>
        <div>
          <small>Account balance</small>
          <strong>{formatUsd(ledger?.availableCreditUsd || 0)} <span>credit</span></strong>
          <p>{formatUsd(ledger?.currentCreditUsd || 0)} credited - {formatUsageUsd(ledger?.currentSpendUsd || 0)} spent</p>
        </div>
        <button className="dark-pill" type="button">Top up</button>
      </section>
      <div>
        <div className="billing-heading">
          <h3>Payment methods</h3>
          <button type="button">+ Add wallet</button>
        </div>
        <p>Connect a wallet to top up your Task Node account or pay for premium features. All transactions settle on-chain.</p>
        <div className="payment-methods">
          {PAYMENT_METHODS.map((method) => (
            <CryptoMethodRow key={method.k} method={method} />
          ))}
        </div>
      </div>
      <div>
        <h3>Billing history</h3>
        {ledgerError && <div className="inline-message">{ledgerError}</div>}
        {!ledgerError && entries.length > 0 ? (
          <div className="billing-ledger">
            {entries.map((entry) => (
              <LedgerEntryRow entry={entry} key={entry.id} />
            ))}
          </div>
        ) : (
          <div className="empty-billing">
            <strong>No payments yet</strong>
            <p>Top-ups and premium feature charges will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function LedgerEntryRow({ entry }) {
  const credit = ["account_credit", "reward_credit", "refund_credit"].includes(entry.kind);
  const amount = Number(entry.amountUsd || 0);
  const timestamp = entry.createdAt ? new Date(entry.createdAt) : null;
  const dateLabel =
    timestamp && !Number.isNaN(timestamp.valueOf())
      ? timestamp.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : "Pending";

  return (
    <div className="ledger-row">
      <span className={credit ? "ledger-dot credit" : "ledger-dot debit"} />
      <div>
        <strong>{ledgerTitle(entry)}</strong>
        <small>{ledgerMeta(entry, dateLabel)}</small>
      </div>
      <em className={credit ? "credit" : "debit"}>
        {credit ? "+" : "-"}
        {formatUsageUsd(amount)}
      </em>
    </div>
  );
}

function ledgerTitle(entry) {
  if (entry.kind === "chat_debit") return "Chat response";
  if (entry.kind === "reward_credit") return "Task reward credit";
  if (entry.kind === "refund_credit") return "Refund";
  return "Account credit";
}

function ledgerMeta(entry, dateLabel) {
  if (entry.provider && entry.model) return `${entry.provider} - ${entry.model} - ${dateLabel}`;
  if (entry.source) return `${entry.source.replace(/_/g, " ")} - ${dateLabel}`;
  return dateLabel;
}

function MfaCallout() {
  return (
    <section className="mfa-callout">
      <span>
        <Shield size={16} strokeWidth={1.75} />
        <i><Lock size={8} strokeWidth={2.5} /></i>
      </span>
      <strong>Secure your account</strong>
      <p>Add multi-factor authentication (MFA), like a hardware key or authenticator app, to help protect your account when signing in.</p>
      <button type="button">Set up MFA</button>
    </section>
  );
}

function SettingsLine({ danger, desc, label, right }) {
  return (
    <div className={danger ? "settings-line danger" : "settings-line"}>
      <div>
        <strong>{label}</strong>
        {desc && <p>{desc}</p>}
      </div>
      {right}
    </div>
  );
}

function StaticButton({ value }) {
  return (
    <button className="static-button" type="button">
      {value}
      <ChevronRight size={13} strokeWidth={1.75} />
    </button>
  );
}

function CycleButton({ onClick, value }) {
  return (
    <button className="static-button" onClick={onClick} type="button">
      {value}
      <ChevronRight size={13} strokeWidth={1.75} />
    </button>
  );
}

function SmallPill({ children, danger }) {
  return (
    <button className={danger ? "small-pill danger" : "small-pill"} type="button">
      {children}
    </button>
  );
}

function ToggleSwitch({ initial }) {
  const [on, setOn] = useState(Boolean(initial));
  return (
    <button className={on ? "toggle-switch on" : "toggle-switch"} onClick={() => setOn((value) => !value)} type="button" aria-pressed={on}>
      <span />
    </button>
  );
}

function CryptoMethodRow({ method }) {
  return (
    <div className="crypto-method">
      <span style={{ background: method.accent }}>{method.letter}</span>
      <div>
        <strong>{method.name}</strong>
        <small>
          {method.chain}
          {method.connected && method.address ? ` . ${method.address}` : ""}
        </small>
      </div>
      {method.connected ? <em>Connected</em> : <button type="button">Connect</button>}
    </div>
  );
}

function TaskDetailModal({ onClose, task }) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="task-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="task-title">
        <header>
          <div>
            <Flag size={12} strokeWidth={1.75} />
            {task.kind}
          </div>
          <button onClick={onClose} type="button">
            <X size={14} strokeWidth={1.75} />
            Close
          </button>
        </header>
        <div className="task-modal-body">
          <h2 id="task-title">{task.title}</h2>
          <a>
            Task ID: {task.fullId}
            <ExternalLink size={11} strokeWidth={1.75} />
          </a>
          <div className="task-modal-stats">
            <div>
              <small>Status</small>
              <StatusPill status={task.status} />
            </div>
            <div>
              <small>
                Deadline
                <HelpCircle size={11} strokeWidth={1.75} />
              </small>
              <span>{task.fullDue}</span>
            </div>
          </div>
          <TaskSection title="Description">
            <p>{task.description}</p>
          </TaskSection>
          <TaskSection title="Steps">
            <ol>
              {task.steps.map((step, index) => (
                <li key={step}>
                  <span>{index + 1}</span>
                  <p>{step}</p>
                </li>
              ))}
            </ol>
          </TaskSection>
          <TaskSection title="Verification">
            <strong>{task.verification.title}</strong>
            <p>{task.verification.body}</p>
          </TaskSection>
          <TaskSection last title="Reward">
            <div className="modal-reward">
              {task.pft.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              <span>PFT</span>
            </div>
          </TaskSection>
        </div>
        <footer>
          <button className="dark-pill" type="button">Submit evidence</button>
          <button className="light-pill" type="button">Discuss</button>
          <button className="danger-text" type="button">Cancel task</button>
        </footer>
      </section>
    </div>
  );
}

function TaskSection({ children, last, title }) {
  return (
    <section className={last ? "task-section last" : "task-section"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function nextTheme(theme) {
  if (theme === "auto") return "light";
  if (theme === "light") return "dark";
  return "auto";
}

function themeLabel(theme) {
  if (theme === "auto") return "System";
  return theme[0].toUpperCase() + theme.slice(1);
}

function LoginDialog({ session, onClose, onSessionChange }) {
  const providers = (session?.accountLinks || []).filter((provider) =>
    ["telegram", "discord", "x", "github"].includes(provider.id)
  );
  const emailProvider = (session?.accountLinks || []).find((provider) => provider.id === "email");
  const devAuth = session?.devAuth;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailStep, setEmailStep] = useState("email");
  const [challenge, setChallenge] = useState(null);
  const [message, setMessage] = useState("");
  const [pendingProvider, setPendingProvider] = useState("");

  async function startProvider(provider) {
    setPendingProvider(provider.id);
    setMessage("");

    try {
      const result = await requestJson(provider.startPath);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${provider.label} login returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${provider.label} login is unavailable.`);
    } finally {
      setPendingProvider("");
    }
  }

  async function continueEmail() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setMessage("Enter an email address.");
      return;
    }

    setPendingProvider("email");
    setMessage("");

    if (emailProvider?.enabled) {
      try {
        const result = await requestJson(emailProvider.startPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail }),
        });

        if (result.ok) {
          setChallenge(result.body);
          setEmailStep("code");
          setCode("");
          setMessage(result.body?.message || "Enter the sign-in code.");
        } else {
          setMessage(
            result.body?.message ||
              result.body?.actionRequired ||
              `Email login returned HTTP ${result.status}.`
          );
        }
      } catch (error) {
        setMessage(error?.message || "Email login is unavailable.");
      } finally {
        setPendingProvider("");
      }
      return;
    }

    if (!devAuth?.enabled) {
      setMessage(
        emailProvider?.actionRequired ||
          "Email login needs a transactional email provider and code callback."
      );
      setPendingProvider("");
      return;
    }

    try {
      const result = await requestJson(devAuth.startPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail }),
      });

      if (result.ok) {
        await onSessionChange?.();
        onClose();
      } else {
        setMessage(
          result.body?.message ||
            result.body?.actionRequired ||
            `Email login returned HTTP ${result.status}.`
        );
      }
    } catch (error) {
      setMessage(error?.message || "Email login is unavailable.");
    } finally {
      setPendingProvider("");
    }
  }

  async function verifyEmailCode() {
    const trimmedCode = code.trim().replace(/\s+/g, "");
    if (!trimmedCode) {
      setMessage("Enter the sign-in code.");
      return;
    }

    if (!challenge?.challengeId || !emailProvider?.verifyPath) {
      setMessage("Request a new sign-in code.");
      return;
    }

    setPendingProvider("email");
    setMessage("");

    try {
      const result = await requestJson(emailProvider.verifyPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          code: trimmedCode,
        }),
      });

      if (result.ok) {
        await onSessionChange?.();
        onClose();
      } else {
        setMessage(
          result.body?.message ||
            result.body?.actionRequired ||
            `Email verification returned HTTP ${result.status}.`
        );
      }
    } catch (error) {
      setMessage(error?.message || "Email verification is unavailable.");
    } finally {
      setPendingProvider("");
    }
  }

  function editEmail() {
    setEmailStep("email");
    setCode("");
    setChallenge(null);
    setMessage("");
  }

  const devCode = challenge?.delivery?.devCode || "";

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close">
          <X size={18} strokeWidth={2} />
        </button>
        <h2 id="login-title">Log in or sign up</h2>
        <p>You'll get smarter responses and can upload files, images, and more.</p>
        {providers.map((provider) => (
          <button
            key={provider.id}
            className="provider-row"
            type="button"
            onClick={() => startProvider(provider)}
          >
            <ProviderIcon id={provider.id} />
            <span>Continue with {provider.label}</span>
            {pendingProvider === provider.id && <small>Checking</small>}
          </button>
        ))}
        {message && <div className="dialog-message">{message}</div>}
        <div className="divider">OR</div>
        {emailStep === "email" ? (
          <>
            <input
              type="email"
              placeholder="Email address"
              aria-label="Email address"
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") continueEmail();
              }}
              value={email}
            />
            <button
              className="continue-button"
              type="button"
              onClick={continueEmail}
            >
              {pendingProvider === "email" ? "Checking" : "Continue"}
            </button>
          </>
        ) : (
          <div className="email-code-step">
            <div className="email-code-target">
              <span>{challenge?.maskedEmail || email}</span>
              <button type="button" onClick={editEmail}>Edit</button>
            </div>
            {devCode && (
              <div className="dev-code-note">
                Development code: <strong>{devCode}</strong>
              </div>
            )}
            <input
              type="text"
              inputMode="numeric"
              placeholder="Code"
              aria-label="Sign-in code"
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") verifyEmailCode();
              }}
              value={code}
            />
            <button
              className="continue-button"
              type="button"
              onClick={verifyEmailCode}
            >
              {pendingProvider === "email" ? "Checking" : "Continue"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ProviderIcon({ id }) {
  if (id === "github") return <Github size={20} strokeWidth={1.9} />;
  if (id === "telegram") return <span className="provider-icon telegram">T</span>;
  if (id === "discord") return <span className="provider-icon discord">D</span>;
  return <span className="provider-icon x-provider">X</span>;
}

function StatusBanner({ children, tone = "default" }) {
  return <div className={`status-banner ${tone}`}>{children}</div>;
}

function formatDrops(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsageUsd(value) {
  const numeric = Number(value || 0);
  if (numeric > 0 && numeric < 0.01) return "<$0.01";
  return formatUsd(numeric);
}

createRoot(document.getElementById("root")).render(<App />);

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowDown,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Activity,
  AlertTriangle,
  BookOpen,
  Bot,
  Bold,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  CreditCard,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Flag,
  Flame,
  Github,
  Heading2,
  Heading3,
  Italic,
  LifeBuoy,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListPlus,
  ListTodo,
  Lock,
  LogOut,
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
  ShieldCheck,
  Sparkle,
  SquarePen,
  Store,
  Table,
  Trash2,
  Trophy,
  Unlock,
  Unlink,
  User as UserIcon,
  UserCheck,
  Wand2,
  Wallet,
  X,
} from "lucide-react";
import { fetchAppState, fetchRuntimeConfig, requestEventStream, requestJson } from "./api";
import "./styles.css";

const fallbackConfig = window.__TASKNODE_CONFIG__ || {};
const CHAT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_ATTACHMENT_MAX_COUNT = 4;
const CHAT_ATTACHMENT_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
].join(",");

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
  { k: "eth", name: "Ether", chain: "Ethereum mainnet", accent: "#627eea", letter: "E" },
  { k: "usdt", name: "USDT", chain: "Ethereum ERC-20", accent: "#26a17b", letter: "T" },
  { k: "usdc", name: "USDC", chain: "Ethereum ERC-20", accent: "#2775ca", letter: "$" },
];

const SETTINGS_PAGES = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "security", label: "Security", icon: Shield },
  { key: "data", label: "Data controls", icon: Database },
  { key: "billing", label: "Billing", icon: CreditCard },
];

const APP_VIEWS = new Set(["chat", "tasks", "wallet", "context", "profile"]);
const EMPTY_WALLET_VAULT_STATUS = {
  available: false,
  unlocked: false,
  accountId: null,
  address: null,
  publicKey: null,
  lastUnlockedAt: null,
};
const WALLET_BALANCE_REFRESH_MS = 15000;
const WALLET_TX_REFRESH_MS = 60000;

function walletVaultDisplayState(walletVault = {}, linkedWalletAddress = "") {
  const hasLinkedWallet = Boolean(String(linkedWalletAddress || walletVault?.address || "").trim());
  if (walletVault?.unlocked) {
    return {
      tone: "unlocked",
      label: "Unlocked",
      detail: "Local seed vault is unlocked for this browser session.",
    };
  }
  if (walletVault?.available) {
    return {
      tone: "locked",
      label: "Locked",
      detail: "Encrypted local seed vault is saved on this device.",
    };
  }
  if (hasLinkedWallet) {
    return {
      tone: "missing",
      label: "Vault missing",
      detail: "Wallet ownership is linked, but no encrypted local seed vault is saved in this browser.",
    };
  }
  return {
    tone: "missing",
    label: "No wallet",
    detail: "Link a seed wallet before restoring encrypted historical context.",
  };
}

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
  const [chatActionMenu, setChatActionMenu] = useState(null);
  const [chatRenameTarget, setChatRenameTarget] = useState(null);
  const [chatDeleteTarget, setChatDeleteTarget] = useState(null);
  const [runtimeConfig, setRuntimeConfig] = useState(fallbackConfig);
  const [appState, setAppState] = useState(null);
  const [walletVaultStatus, setWalletVaultStatus] = useState(EMPTY_WALLET_VAULT_STATUS);
  const [loadError, setLoadError] = useState("");
  const profileRef = useRef(null);
  const moreRef = useRef(null);
  const chatActionRef = useRef(null);
  const walletSecretRef = useRef(null);

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
      if (chatActionRef.current && !chatActionRef.current.contains(event.target)) {
        setChatActionMenu(null);
      }
    }

    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);

  useEffect(() => {
    if (!settingsOpen && !selectedTask && !chatActionMenu) return undefined;

    function closeModal(event) {
      if (event.key === "Escape") {
        setChatActionMenu(null);
        setSettingsOpen(false);
        setSelectedTask(null);
      }
    }

    document.addEventListener("keydown", closeModal);
    return () => document.removeEventListener("keydown", closeModal);
  }, [settingsOpen, selectedTask, chatActionMenu]);

  const recentChats = buildRecentChats(appState?.chat?.recents || []);
  const activeChatId = activeChat?.conversationId || activeChat?.id || "";
  const pftBalance = formatPftBalance(appState?.wallet);
  const chatCredit = formatCreditUsd(appState?.usage?.availableCreditUsd || 0);
  const session = appState?.session;
  const signedIn = isSignedInSession(session);
  const profileName = profileDisplayName(session);
  const profileInitials = profileAvatarText(session);
  const profileSubtext = profileSessionText(session);
  const walletAccountId = signedIn ? session?.accountId || "" : "";
  const linkedWalletAddress =
    signedIn && appState?.wallet?.pftWallet?.status === "linked"
      ? appState.wallet.pftWallet.address || ""
      : "";
  const vaultDisplay = walletVaultDisplayState(walletVaultStatus, linkedWalletAddress);

  const lockWalletVault = useCallback(() => {
    walletSecretRef.current = null;
    setWalletVaultStatus((current) => ({
      ...current,
      unlocked: false,
      lastUnlockedAt: null,
    }));
  }, []);

  const refreshWalletVaultStatus = useCallback(
    async ({ preserveUnlock = false, accountId = "" } = {}) => {
      const effectiveAccountId = accountId || walletAccountId;
      if (!effectiveAccountId) {
        walletSecretRef.current = null;
        setWalletVaultStatus(EMPTY_WALLET_VAULT_STATUS);
        return EMPTY_WALLET_VAULT_STATUS;
      }

      try {
        const walletCore = await import("./wallet-core");
        const nextStatus = walletCore.localWalletVaultStatus({ accountId: effectiveAccountId });
        setWalletVaultStatus((current) => {
          const keepUnlocked =
            preserveUnlock &&
            Boolean(current.unlocked) &&
            current.accountId === effectiveAccountId &&
            current.address === nextStatus.address &&
            walletSecretRef.current?.accountId === effectiveAccountId &&
            walletSecretRef.current?.address === nextStatus.address;

          if (!keepUnlocked) {
            walletSecretRef.current = null;
          }

          return {
            ...nextStatus,
            unlocked: keepUnlocked,
            lastUnlockedAt: keepUnlocked ? current.lastUnlockedAt : null,
          };
        });
        return nextStatus;
      } catch {
        walletSecretRef.current = null;
        setWalletVaultStatus({
          ...EMPTY_WALLET_VAULT_STATUS,
          accountId: effectiveAccountId,
        });
        return null;
      }
    },
    [walletAccountId]
  );

  const handleWalletVaultUnlocked = useCallback(
    (unlock) => {
      if (!walletAccountId || !unlock?.mnemonic || !unlock?.address) return;
      walletSecretRef.current = {
        accountId: walletAccountId,
        address: unlock.address,
        publicKey: unlock.publicKey || null,
        derivationPath: unlock.derivationPath || null,
        mnemonic: unlock.mnemonic,
        unlockedAt: unlock.unlockedAt || new Date().toISOString(),
      };
      setWalletVaultStatus((current) => ({
        ...current,
        available: true,
        accountId: walletAccountId,
        address: unlock.address,
        publicKey: unlock.publicKey || current.publicKey || null,
        derivationPath: unlock.derivationPath || current.derivationPath || null,
        unlocked: true,
        lastUnlockedAt: unlock.unlockedAt || new Date().toISOString(),
      }));
    },
    [walletAccountId]
  );

  const hydrateContextPointer = useCallback(
    async (pointer) => {
      const secret = walletSecretRef.current;
      if (!walletAccountId || !secret?.mnemonic || secret.accountId !== walletAccountId) {
        throw new Error("Unlock the local seed vault first.");
      }
      const cid = String(pointer?.cid || "").trim();
      if (!cid) {
        throw new Error("No context CID is selected.");
      }

      const fetched = await requestJson(`/api/context/history/ipfs/${encodeURIComponent(cid)}`);
      if (!fetched.ok || !fetched.body?.payload) {
        throw new Error(fetched.body?.message || "Context CID could not be fetched.");
      }

      const walletCore = await import("./wallet-core");
      const hydrated = await walletCore.hydrateTaskNodeFetchedPayload({
        payload: fetched.body.payload,
        mnemonic: secret.mnemonic,
      });
      const extracted = extractHydratedContext(hydrated.payload, hydrated.plaintext);
      return {
        ...extracted,
        cid,
        pointer,
        decrypted: hydrated.decrypted,
        gateway: fetched.body.gateway || "",
        fetchedAt: new Date().toISOString(),
      };
    },
    [walletAccountId]
  );

  const navigateToView = useCallback((nextView, options = {}) => {
    const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
    setView(normalizedView);
    setChatActionMenu(null);
    setMoreMenuOpen(false);
    setProfileMenuOpen(false);
    setSettingsOpen(false);
    setSelectedTask(null);
    setLoginOpen(false);
    writeViewLocation(normalizedView, { replace: options.replace === true });
  }, []);

  const startNewChat = useCallback(() => {
    setActiveChat(null);
    setChatActionMenu(null);
    setChatResetKey((key) => key + 1);
    navigateToView("chat");
  }, [navigateToView]);

  const openRecentChat = useCallback(
    (chat) => {
      setActiveChat(chat);
      setChatActionMenu(null);
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

  useEffect(() => {
    refreshWalletVaultStatus({ preserveUnlock: true });
  }, [refreshWalletVaultStatus]);

  useEffect(() => {
    if (!signedIn || !linkedWalletAddress) return undefined;

    let active = true;

    async function refreshWalletBalance({ force = false } = {}) {
      setAppState((current) => markWalletBalanceChecking(current, linkedWalletAddress));

      try {
        const result = await requestJson(`/api/wallet/balance${force ? "?force=1" : ""}`);
        if (!active) return;
        setAppState((current) => applyWalletBalanceResult(current, linkedWalletAddress, result));
      } catch (error) {
        if (!active) return;
        setAppState((current) =>
          applyWalletBalanceError(current, linkedWalletAddress, error?.message || "Balance read failed.")
        );
      }
    }

    refreshWalletBalance({ force: true });
    const timer = window.setInterval(() => refreshWalletBalance(), WALLET_BALANCE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [signedIn, linkedWalletAddress]);

  async function refreshAppState() {
    try {
      const state = await fetchAppState();
      setAppState(state);
      const nextAccountId = isSignedInSession(state?.session) ? state.session.accountId || "" : "";
      await refreshWalletVaultStatus({ preserveUnlock: true, accountId: nextAccountId });
      setLoadError("");
      return state;
    } catch (error) {
      setLoadError(error?.message || "Failed to load app state");
      return null;
    }
  }

  async function logOut() {
    lockWalletVault();
    await requestJson("/api/auth/logout", { method: "POST" });
    await refreshAppState();
    setProfileMenuOpen(false);
  }

  async function renameRecentChat(chat, title) {
    const conversationId = chat?.conversationId || chat?.id || "";
    const result = await requestJson("/api/chat/conversation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, title }),
    });

    if (!result.ok || !result.body?.ok) {
      throw new Error(result.body?.error || result.body?.message || "Could not rename this chat.");
    }

    const nextTitle = result.body.conversation?.title || title;
    setActiveChat((current) =>
      current && (current.conversationId || current.id) === conversationId
        ? { ...current, title: nextTitle }
        : current
    );
    setChatRenameTarget(null);
    setChatActionMenu(null);
    await refreshAppState();
  }

  async function deleteRecentChat(chat) {
    const conversationId = chat?.conversationId || chat?.id || "";
    const result = await requestJson("/api/chat/conversation", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });

    if (!result.ok || !result.body?.ok) {
      throw new Error(result.body?.error || result.body?.message || "Could not delete this chat.");
    }

    if (activeChatId === conversationId) {
      setActiveChat(null);
      setChatResetKey((key) => key + 1);
      navigateToView("chat");
    }
    setChatDeleteTarget(null);
    setChatActionMenu(null);
    await refreshAppState();
  }

  function toggleSidebar() {
    setSidebarOpen((open) => {
      if (open) {
        setChatActionMenu(null);
        setMoreMenuOpen(false);
        setProfileMenuOpen(false);
      }
      return !open;
    });
  }

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-header">
          {sidebarOpen && (
            <button
              className="sidebar-brand"
              onClick={() => navigateToView("chat")}
              type="button"
            >
              <PostFiatLogo />
              <span>Task Node</span>
            </button>
          )}
          <button
            aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            className="icon-button sidebar-toggle"
            data-tooltip={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            onClick={toggleSidebar}
            type="button"
          >
            {sidebarOpen ? (
              <PanelLeft size={18} strokeWidth={1.75} />
            ) : (
              <PostFiatLogo />
            )}
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
            tooltip={`Wallet · ${vaultDisplay.label}`}
            trailing={
              <small className={`nav-vault-state is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                {vaultDisplay.tone === "unlocked" ? <Unlock size={10} strokeWidth={2} /> : <Lock size={10} strokeWidth={2} />}
                {vaultDisplay.label}
              </small>
            }
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
              onClick={() => {
                if (!sidebarOpen) {
                  setSidebarOpen(true);
                  return;
                }
                setMoreMenuOpen((open) => !open);
              }}
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
          <section className="recents" aria-label="Recent chats" onScroll={() => setChatActionMenu(null)}>
            <div className="section-label">Recents</div>
            {recentChats.length > 0 ? (
              recentChats.map((item) => {
                const itemId = item.conversationId || item.id;
                const menuOpen = chatActionMenu?.id === item.id;
                return (
                  <div
                    className={activeChatId === itemId ? "recent-chat-row active" : "recent-chat-row"}
                    key={item.id}
                  >
                    <button
                      className="recent-chat-open"
                      onClick={() => openRecentChat(item)}
                      title={item.title}
                      type="button"
                    >
                      <span>{item.title}</span>
                      {item.unread && <i aria-hidden="true" />}
                    </button>
                    <button
                      aria-label={`Chat actions for ${item.title}`}
                      className="recent-chat-more"
                      onClick={(event) => {
                        event.stopPropagation();
                        setChatActionMenu(
                          menuOpen
                            ? null
                            : {
                                ...item,
                                menuPosition: chatActionMenuPosition(event.currentTarget),
                              }
                        );
                      }}
                      title="Chat actions"
                      type="button"
                    >
                      <MoreHorizontal size={16} strokeWidth={1.75} />
                    </button>
                  </div>
                );
              })
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
                <span className={`balance-vault-state is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                  {vaultDisplay.tone === "unlocked" ? <Unlock size={11} strokeWidth={2} /> : <Lock size={11} strokeWidth={2} />}
                  <span>{vaultDisplay.label}</span>
                </span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} />
            </button>
          )}
          {sidebarOpen && (
            <div className="profile-anchor" ref={profileRef}>
              <button
                className="profile-button"
                aria-label={signedIn ? `${profileName}, ${profileSubtext}` : "Log in or sign up"}
                onClick={() => {
                  setProfileMenuOpen((open) => !open);
                }}
                type="button"
              >
                <ProfileAvatar initials={profileInitials} signedIn={signedIn} />
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
              </button>
              {profileMenuOpen && (
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
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
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
          <WalletView
            onAppStateChange={refreshAppState}
            onLoginRequired={() => setLoginOpen(true)}
            onWalletVaultChange={() => refreshWalletVaultStatus({ preserveUnlock: true })}
            onWalletVaultLock={lockWalletVault}
            onWalletVaultUnlocked={handleWalletVaultUnlocked}
            session={appState?.session}
            wallet={appState?.wallet}
            walletVault={walletVaultStatus}
            usage={appState?.usage}
          />
        )}
        {view === "context" && (
          <ContextView
            context={appState?.context}
            linkedWalletAddress={linkedWalletAddress}
            onContextChange={refreshAppState}
            onHydrateContext={hydrateContextPointer}
            walletVault={walletVaultStatus}
          />
        )}
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
      {chatActionMenu && sidebarOpen && (
        <ChatItemActionMenu
          menuRef={chatActionRef}
          onDelete={() => {
            setChatDeleteTarget(chatActionMenu);
            setChatActionMenu(null);
          }}
          onRename={() => {
            setChatRenameTarget(chatActionMenu);
            setChatActionMenu(null);
          }}
          style={chatActionMenu.menuPosition}
        />
      )}
      {chatRenameTarget && (
        <RenameChatModal
          chat={chatRenameTarget}
          onClose={() => setChatRenameTarget(null)}
          onSave={(title) => renameRecentChat(chatRenameTarget, title)}
        />
      )}
      {chatDeleteTarget && (
        <DeleteChatModal
          chat={chatDeleteTarget}
          onClose={() => setChatDeleteTarget(null)}
          onDelete={() => deleteRecentChat(chatDeleteTarget)}
        />
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
  const [attachments, setAttachments] = useState([]);
  const [draftConversationId, setDraftConversationId] = useState(() => newClientConversationId());
  const [editingMsg, setEditingMsg] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const plusRef = useRef(null);
  const modelRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const messageListRef = useRef(null);
  const resetSeenRef = useRef(0);
  const shareSeenRef = useRef(chatShareRequestKey);
  const clearedChatRef = useRef(false);

  useEffect(() => {
    setSelectedMode(defaultMode);
  }, [defaultMode]);

  useEffect(() => {
    if (clearedChatRef.current) return;
    if (activeChat?.source === "mock" || activeChat?.source === "server" || activeChat?.source === "live") return;
    setTurns(normalizeChatMessages(messages));
  }, [activeChat?.source, messages]);

  useEffect(() => {
    if (chatResetKey === 0 || resetSeenRef.current === chatResetKey) return;
    resetSeenRef.current = chatResetKey;
    clearedChatRef.current = true;
    setTurns([]);
    setInput("");
    setAttachments([]);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setDraftConversationId(newClientConversationId());
    setEditingMsg(null);
    setShareOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [chatResetKey]);

  useEffect(() => {
    if (!activeChat || activeChat.source === "live") return undefined;
    clearedChatRef.current = false;
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");

    if (activeChat.source !== "server") {
      setTurns(createRecentPlaceholderThread(activeChat.title));
      return undefined;
    }

    let cancelled = false;
    const conversationId = activeChat.conversationId || activeChat.id;
    const historyPath = chat?.historyPath || "/api/chat/history";
    setTurns([]);

    requestJson(`${historyPath}?conversationId=${encodeURIComponent(conversationId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.body?.message || `History returned HTTP ${result.status}.`);
        }
        const hydrated = normalizeChatMessages(result.body?.messages || []);
        setTurns(hydrated);
      })
      .catch((error) => {
        if (cancelled) return;
        setStatusTone("error");
        setSendMessage(error?.message || "Could not load this conversation.");
        setTurns([
          createErrorAssistantTurn(
            `history-error-${Date.now()}`,
            "Could not load this conversation.",
            Date.now()
          ),
        ]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeChat, chatSelectionKey, chat?.historyPath]);

  useEffect(() => {
    if (shareSeenRef.current === chatShareRequestKey) return;
    shareSeenRef.current = chatShareRequestKey;
    if (turns.length > 0) setShareOpen(true);
  }, [chatShareRequestKey, turns.length]);

  useEffect(() => {
    if (!shareOpen) return undefined;

    function closeOverlay(event) {
      if (event.key === "Escape") {
        setShareOpen(false);
      }
    }

    document.addEventListener("keydown", closeOverlay);
    return () => document.removeEventListener("keydown", closeOverlay);
  }, [shareOpen]);

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

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns.length]);

  async function submitMessage(event) {
    event.preventDefault();
    const message = input.trim();
    if (!message && attachments.length === 0) return;

    clearedChatRef.current = false;
    const startedAt = Date.now();
    const requestedConversationId = activeChat?.conversationId || activeChat?.id || draftConversationId;
    const pendingId = `assistant-pending-${startedAt}`;
    const submittedAttachments = attachments;
    setSending(true);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setInput("");
    setAttachments([]);
    setTurns((current) => [
      ...current,
      createUserTurn(message || "Review the attached file.", `user-local-${startedAt}`, submittedAttachments),
      createPendingAssistantTurn(pendingId, startedAt),
    ]);
    if (!activeChat) {
      onActiveChatChange?.({
        id: requestedConversationId,
        conversationId: requestedConversationId,
        source: "live",
        title: chatTitleFromPrompt(message),
      });
    }

    try {
      const chatPayload = {
        message: message || "Please review the attached file.",
        mode: selectedMode,
        conversationId: requestedConversationId,
        attachments: submittedAttachments.map(({ name, mimeType, size, dataUrl }) => ({
          name,
          mimeType,
          size,
          dataUrl,
        })),
      };
      const result = usage?.chatStreamPath
        ? await requestEventStream(
            usage.chatStreamPath,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(chatPayload),
            },
            ({ event, body }) => {
              if (event === "delta" && body?.delta) {
                setTurns((current) =>
                  appendAssistantDelta(current, pendingId, body.delta, startedAt)
                );
              }
            }
          )
        : await requestJson(usage?.chatSendPath || "/api/chat/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(chatPayload),
          });
      setActualUsage(result.body?.usage || null);

      if (result.ok && result.body?.assistant) {
        const settledConversationId = result.body?.conversationId || requestedConversationId;
        const assistantTurn = normalizeChatMessage(
          {
            ...result.body.assistant,
            thinking: result.body.assistant.thinking || {
              state: "finished",
              duration: formatElapsedSeconds(Date.now() - startedAt),
            },
          },
          pendingId
        );
        setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        setSendMessage(result.body.message || "Chat response generated.");
        setStatusTone("muted");
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          title: activeChat?.title || chatTitleFromPrompt(message),
        });
        await onChatSettled?.();
      } else {
        const failureMessage =
          result.body?.message ||
          result.body?.actionRequired ||
          `Chat returned HTTP ${result.status}.`;
        setTurns((current) =>
          replaceTurnById(
            current,
            pendingId,
            createErrorAssistantTurn(pendingId, failureMessage, startedAt)
          )
        );
        setSendMessage(
          failureMessage
        );
        setStatusTone("error");
      }
    } catch (error) {
      const failureMessage = error?.message || "Chat execution is unavailable.";
      setTurns((current) =>
        replaceTurnById(
          current,
          pendingId,
          createErrorAssistantTurn(pendingId, failureMessage, startedAt)
        )
      );
      setSendMessage(failureMessage);
      setStatusTone("error");
    } finally {
      setSending(false);
    }
  }

  async function handleAttachmentSelection(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;

    const remainingSlots = Math.max(0, CHAT_ATTACHMENT_MAX_COUNT - attachments.length);
    const selectedFiles = files.slice(0, remainingSlots);
    if (selectedFiles.length === 0) {
      setSendMessage(`Attach up to ${CHAT_ATTACHMENT_MAX_COUNT} files at a time.`);
      setStatusTone("error");
      return;
    }

    try {
      const nextAttachments = [];
      for (const file of selectedFiles) {
        if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.name} is larger than ${formatFileSize(CHAT_ATTACHMENT_MAX_BYTES)}.`);
        }
        const dataUrl = await readFileAsDataUrl(file);
        nextAttachments.push({
          id: `att-${Date.now()}-${nextAttachments.length}-${file.name}`,
          name: file.name || "attachment",
          mimeType: file.type || mimeTypeFromFilename(file.name),
          size: file.size,
          dataUrl,
        });
      }

      setAttachments((current) => [...current, ...nextAttachments].slice(0, CHAT_ATTACHMENT_MAX_COUNT));
      setSendMessage("");
      setStatusTone("muted");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (error) {
      setSendMessage(error?.message || "Could not attach that file.");
      setStatusTone("error");
    }
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  const composerStatus = chatComposerStatus({
    actualUsage,
    message: sendMessage,
    sending,
    tone: statusTone,
    turns,
  });

  const chatTitle = activeChat?.title || titleFromTurns(turns);
  const hasPromptInput = input.trim().length > 0 || attachments.length > 0;
  const composer = (
    <div className="composer-shell">
      {attachments.length > 0 && (
        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
      )}
      <input
        ref={fileInputRef}
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="chat-file-input"
        multiple
        onChange={handleAttachmentSelection}
        type="file"
      />
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
              <ToolMenuRow
                icon={Paperclip}
                label="Upload photos & files"
                onClick={() => {
                  setPlusMenuOpen(false);
                  fileInputRef.current?.click();
                }}
              />
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
            <ChevronDown className={modelMenuOpen ? "is-open" : ""} size={14} strokeWidth={1.75} />
          </button>
          {modelMenuOpen && (
            <div className="model-menu">
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
            </div>
          )}
        </div>
        <button className="send-button" disabled={!hasPromptInput || sending} type="submit" aria-label="Send">
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
                    attachments={message.attachments || []}
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
    </div>
  );
}

function chatComposerStatus({ actualUsage, message, sending, tone, turns }) {
  if (sending && turns.length === 0) return { tone: "muted", text: "Thinking..." };
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

  for (const [index, item] of (serverRecents || []).entries()) {
    const recent =
      typeof item === "string"
        ? { title: item }
        : item && typeof item === "object"
          ? item
          : null;
    if (!recent) continue;

    const conversationId = String(recent.conversationId || recent.id || "").trim();
    const title = String(recent.title || recent.lastMessagePreview || "New chat").trim();
    const key = conversationId || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: conversationId || `server-${slugify(title) || index}`,
      conversationId: conversationId || "",
      source: "server",
      title,
      lastMessagePreview: recent.lastMessagePreview || "",
      messageCount: recent.messageCount || 0,
      updatedAt: recent.updatedAt || recent.lastMessageAt || "",
    });
  }

  return rows;
}

function chatActionMenuPosition(anchor) {
  const rect = anchor?.getBoundingClientRect?.();
  if (!rect || typeof window === "undefined") return { left: 248, top: 96 };

  const menuWidth = 228;
  const menuHeight = 134;
  const viewportPadding = 8;
  const sidebarRight =
    document.querySelector(".sidebar")?.getBoundingClientRect?.().right || rect.right;
  const left = Math.min(
    Math.max(viewportPadding, rect.right + 4, sidebarRight + 4),
    window.innerWidth - menuWidth - viewportPadding
  );
  const top = Math.min(
    Math.max(viewportPadding, rect.top - 8),
    window.innerHeight - menuHeight - viewportPadding
  );

  return { left, top };
}

function ChatItemActionMenu({ menuRef, onRename, onDelete, style }) {
  return (
    <div className="chat-action-menu" ref={menuRef} role="menu" style={style}>
      <button
        aria-disabled="true"
        className="chat-action-menu-item is-muted"
        onClick={(event) => event.preventDefault()}
        role="menuitem"
        type="button"
      >
        <Share size={17} strokeWidth={1.75} />
        <span>Share</span>
        <small>Coming soon</small>
      </button>
      <button className="chat-action-menu-item" onClick={onRename} role="menuitem" type="button">
        <Pencil size={17} strokeWidth={1.75} />
        <span>Rename</span>
      </button>
      <div className="chat-action-menu-divider" />
      <button className="chat-action-menu-item danger" onClick={onDelete} role="menuitem" type="button">
        <Trash2 size={17} strokeWidth={1.75} />
        <span>Delete</span>
      </button>
    </div>
  );
}

function RenameChatModal({ chat, onClose, onSave }) {
  const [title, setTitle] = useState(chat?.title || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submitRename(event) {
    event.preventDefault();
    const nextTitle = title.trim().replace(/\s+/g, " ");
    if (!nextTitle) {
      setError("Name the chat before saving.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onSave(nextTitle);
    } catch (saveError) {
      setError(saveError?.message || "Could not rename this chat.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <form
        aria-labelledby="rename-chat-title"
        aria-modal="true"
        className="chat-edit-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submitRename}
        role="dialog"
      >
        <header>
          <h2 id="rename-chat-title">Rename chat</h2>
          <button aria-label="Close rename" className="chat-edit-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <input
          aria-label="Chat name"
          autoFocus
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
        {error && <p className="chat-edit-error">{error}</p>}
        <footer>
          <button className="ghost-button" disabled={saving} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="solid-button" disabled={saving} type="submit">
            <Check size={16} strokeWidth={2} />
            Save
          </button>
        </footer>
      </form>
    </div>
  );
}

function DeleteChatModal({ chat, onClose, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function submitDelete() {
    setDeleting(true);
    setError("");
    try {
      await onDelete();
    } catch (deleteError) {
      setError(deleteError?.message || "Could not delete this chat.");
      setDeleting(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <section
        aria-labelledby="delete-chat-title"
        aria-modal="true"
        className="chat-edit-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="delete-chat-title">Delete chat?</h2>
          <button aria-label="Close delete" className="chat-edit-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <p className="chat-delete-copy">
          This removes <strong>{chat?.title || "this chat"}</strong> from your chat history.
        </p>
        {error && <p className="chat-edit-error">{error}</p>}
        <footer>
          <button className="ghost-button" disabled={deleting} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="danger-button" disabled={deleting} onClick={submitDelete} type="button">
            <Trash2 size={16} strokeWidth={2} />
            Delete
          </button>
        </footer>
      </section>
    </div>
  );
}

function newClientConversationId() {
  const entropy =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `chat_${Date.now().toString(36)}_${entropy}`;
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
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
    };
  }

  return {
    id: message.id || `assistant-${index}`,
    role,
    thinking: message.thinking,
    blocks: Array.isArray(message.blocks) ? message.blocks : markdownToBlocks(text),
  };
}

function createUserTurn(text, id, attachments = []) {
  return {
    id,
    role: "user",
    text,
    attachments: redactAttachmentData(attachments),
  };
}

function createPendingAssistantTurn(id, startedAt) {
  return {
    id,
    role: "assistant",
    pending: true,
    thinking: {
      state: "running",
      startedAt,
    },
    blocks: [],
  };
}

function createErrorAssistantTurn(id, message, startedAt) {
  return {
    id,
    role: "assistant",
    error: true,
    thinking: {
      state: "stopped",
      duration: formatElapsedSeconds(Date.now() - startedAt),
    },
    blocks: [
      {
        type: "p",
        inline: [{ text: message || "Chat execution is unavailable." }],
      },
    ],
  };
}

function redactAttachmentData(attachments = []) {
  return attachments.map(({ id, name, mimeType, size }) => ({
    id,
    name,
    mimeType,
    size,
  }));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes) {
  const numeric = Number(bytes || 0);
  if (numeric >= 1024 * 1024) return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
  if (numeric >= 1024) return `${Math.round(numeric / 1024)} KB`;
  return `${Math.max(0, numeric)} B`;
}

function mimeTypeFromFilename(name = "") {
  const filename = String(name || "").toLowerCase();
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (filename.endsWith(".doc")) return "application/msword";
  if (filename.endsWith(".md")) return "text/markdown";
  if (filename.endsWith(".csv")) return "text/csv";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".gif")) return "image/gif";
  return "text/plain";
}

function replaceTurnById(turns, id, replacement) {
  return turns.map((turn) => (turn.id === id ? replacement : turn));
}

function appendAssistantDelta(turns, id, delta, startedAt) {
  return turns.map((turn) => {
    if (turn.id !== id) return turn;
    const text = `${turn.text || plainTextFromBlocks(turn.blocks)}${delta}`;
    return {
      ...turn,
      pending: true,
      text,
      thinking: turn.thinking || {
        state: "running",
        startedAt,
      },
      blocks: markdownToBlocks(text),
    };
  });
}

function formatElapsedSeconds(ms) {
  const seconds = Math.max(1, Math.round(Number(ms || 0) / 1000));
  return `${seconds}s`;
}

function markdownToBlocks(input) {
  const text = String(input || "").trim();
  if (!text) return [{ type: "p", inline: [{ text: "" }] }];

  let normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\s+(\d+\.\s+\*\*)/g, "$1\n$2")
    .replace(/([^\n])\s+(\d+\.\s+[A-Z])/g, "$1\n$2");
  if (looksLikeMarkdownTable(normalized)) {
    normalized = normalizeCompactMarkdownTables(normalized);
  }
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const raw = line.trim();
    if (!raw) {
      flushParagraph();
      flushList();
      continue;
    }

    const nextRaw = (lines[lineIndex + 1] || "").trim();
    if (isMarkdownTableRow(raw) && isMarkdownTableSeparatorRow(nextRaw)) {
      const headers = splitMarkdownTableRow(raw);
      const alignments = splitMarkdownTableRow(nextRaw).map(tableColumnAlignment);
      const rows = [];

      lineIndex += 2;
      while (lineIndex < lines.length) {
        const rowRaw = lines[lineIndex].trim();
        if (!isMarkdownTableRow(rowRaw) || isMarkdownTableSeparatorRow(rowRaw)) break;
        rows.push(normalizeTableCells(splitMarkdownTableRow(rowRaw), headers.length));
        lineIndex += 1;
      }
      lineIndex -= 1;

      flushParagraph();
      flushList();
      blocks.push({
        type: "table",
        headers: headers.map((cell) => parseInline(cell)),
        alignments: normalizeTableCells(alignments, headers.length, "left"),
        rows: rows.map((row) => row.map((cell) => parseInline(cell))),
      });
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

function looksLikeMarkdownTable(input) {
  return /\|\s*:?-{3,}:?\s*\|/.test(String(input || ""));
}

function normalizeCompactMarkdownTables(input) {
  return String(input || "")
    .split("\n")
    .map((line) => {
      const parts = line.split(/\|\s+\|/);
      if (parts.length < 3) return line;

      const rows = parts.map((part, index) => {
        if (index === 0) return `${part}|`;
        if (index === parts.length - 1) return `|${part}`;
        return `|${part}|`;
      });
      return isMarkdownTableRow(rows[0]) && isMarkdownTableSeparatorRow(rows[1])
        ? rows.join("\n")
        : line;
    })
    .join("\n");
}

function isMarkdownTableRow(line) {
  const raw = String(line || "").trim();
  return raw.startsWith("|") && raw.endsWith("|") && splitMarkdownTableRow(raw).length >= 2;
}

function isMarkdownTableSeparatorRow(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableRow(line) {
  const raw = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  return raw.split("|").map((cell) => cell.trim());
}

function tableColumnAlignment(cell) {
  const value = String(cell || "").trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function normalizeTableCells(cells, count, fallback = "") {
  return Array.from({ length: Math.max(0, count) }, (_, index) => cells[index] || fallback);
}

function parseInline(input) {
  const text = String(input || "");
  const parts = [];
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        parts.push({ link: linkMatch[1], href: linkMatch[2] });
      } else {
        parts.push({ text: token });
      }
    } else if (token.startsWith("`")) {
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
                "This chat row could not be hydrated from the app server.",
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

function transcriptTextFromThread(thread, title = "Untitled chat") {
  const rows = [title || "Untitled chat"];

  for (const message of thread || []) {
    if (message.role === "user") {
      rows.push(`User: ${message.text || ""}`.trim());
      continue;
    }

    const text = plainTextFromBlocks(message.blocks || []);
    if (text) rows.push(`Task Node: ${text}`);
  }

  return rows.filter(Boolean).join("\n\n");
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
      if (block.type === "table") {
        const header = (block.headers || []).map(inlineToText).join(" | ");
        const rows = (block.rows || []).map((row) => row.map(inlineToText).join(" | "));
        return [header, ...rows].filter(Boolean).join("\n");
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

async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to a temporary textarea for browsers that block Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function UserMessage({
  attachments = [],
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
      {attachments.length > 0 && <MessageAttachmentList attachments={attachments} />}
      <div className="user-bubble">{text}</div>
      <div className="user-message-tools">
        <ToolbarButton
          doneLabel="Copied"
          icon={Copy}
          label="Copy message"
          onClick={() => copyText(text)}
        />
        <ToolbarButton icon={Pencil} label="Edit" onClick={onStartEdit} />
      </div>
    </article>
  );
}

function AttachmentTray({ attachments = [], onRemove }) {
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-tray">
      {attachments.map((attachment) => (
        <div className="attachment-chip" key={attachment.id || attachment.name}>
          <Paperclip size={13} strokeWidth={1.8} />
          <span>{attachment.name}</span>
          <small>{formatFileSize(attachment.size)}</small>
          <button
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove?.(attachment.id)}
            type="button"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

function MessageAttachmentList({ attachments = [] }) {
  if (attachments.length === 0) return null;

  return (
    <div className="message-attachment-list">
      {attachments.map((attachment) => (
        <span className="message-attachment-chip" key={attachment.id || attachment.name}>
          <Paperclip size={12} strokeWidth={1.8} />
          {attachment.name}
        </span>
      ))}
    </div>
  );
}

function AssistantMessage({ message, onShare }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const body = plainTextFromBlocks(message.blocks);
  const hasThinking = Boolean(message.thinking);
  const showToolbar = !message.pending && !message.error;

  return (
    <article
      className={[
        "assistant-message",
        message.pending ? "pending" : "",
        message.error ? "error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasThinking && (
        <div className="thinking-toggle-wrap">
          <button
            className={message.pending ? "thinking-row pending" : "thinking-row"}
            onClick={() => setThinkingOpen((open) => !open)}
            type="button"
          >
            {message.pending && <span className="thinking-pulse" aria-hidden="true" />}
            {thinkingLabel(message.thinking)}
            {thinkingOpen ? (
              <ChevronDown size={13} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} />
            )}
          </button>
          {thinkingOpen && (
            <div className="thinking-details">
              {thinkingSteps(message).map((step) => (
                <span key={step}>{step}</span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="assistant-body">
        {(message.blocks || []).map((block, index) => (
          <BlockRenderer block={block} key={index} />
        ))}
      </div>
      {message.error && <div className="assistant-error">Response failed</div>}
      {showToolbar && (
        <MessageToolbar
          onCopy={() => copyText(body)}
          onShare={onShare}
        />
      )}
    </article>
  );
}

function thinkingLabel(thinking) {
  if (thinking?.state === "running") return "Thinking";
  if (thinking?.state === "stopped") return "Stopped thinking";
  return `Thought for ${thinking?.duration || "1s"}`;
}

function thinkingSteps(message) {
  if (message.pending) {
    return ["Reading context", "Selecting the execution route", "Drafting response"];
  }
  if (message.error) {
    return ["Request started", "Provider did not complete", "Kept your message in the thread"];
  }
  return ["Read the prompt", "Checked available context", "Composed the response"];
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
    case "table":
      return (
        <div className="assistant-table-wrap">
          <table className="assistant-table">
            <thead>
              <tr>
                {(block.headers || []).map((cell, index) => (
                  <th
                    className={`align-${block.alignments?.[index] || "left"}`}
                    key={index}
                    scope="col"
                  >
                    <Inline parts={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(block.rows || []).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      className={`align-${block.alignments?.[cellIndex] || "left"}`}
                      key={cellIndex}
                    >
                      <Inline parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        if (part.link) {
          return (
            <a href={part.href} key={index} rel="noreferrer" target="_blank">
              {part.link}
            </a>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

function MessageToolbar({ onCopy, onShare }) {
  return (
    <div className="message-toolbar">
      <ToolbarButton doneLabel="Copied" icon={Copy} label="Copy response" onClick={onCopy} />
      <ToolbarButton icon={ArrowUp} label="Share" onClick={onShare} />
    </div>
  );
}

function ToolbarButton({ doneLabel = "", icon: Icon, label, onClick }) {
  const [hover, setHover] = useState(false);
  const [done, setDone] = useState(false);

  async function handleClick() {
    const result = await onClick?.();
    if (!doneLabel || result === false) return;
    setDone(true);
    window.setTimeout(() => setDone(false), 1200);
  }

  return (
    <span className="toolbar-button-wrap">
      <button
        aria-label={done ? doneLabel : label}
        className="toolbar-button"
        onClick={handleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        type="button"
      >
        <Icon size={14} strokeWidth={1.75} />
      </button>
      {(hover || done) && <span className="toolbar-tip">{done ? doneLabel : label}</span>}
    </span>
  );
}

function ShareModal({ onClose, thread, title }) {
  const [copied, setCopied] = useState(false);
  const previewThread = (thread || []).slice(0, 4);
  const transcript = transcriptTextFromThread(thread, title);

  async function copyTranscript() {
    const ok = await copyText(transcript);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

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
          <button className="share-target" onClick={copyTranscript} type="button">
            <span><Copy size={20} strokeWidth={1.75} /></span>
            {copied ? "Copied" : "Copy transcript"}
          </button>
        </div>
        <p>Only visible messages are included.</p>
      </section>
    </div>
  );
}

function SidebarButton({ active, badge, icon: Icon, label, onClick, sidebarOpen, tooltip, trailing }) {
  return (
    <button
      aria-label={label}
      className={active ? "active" : ""}
      data-tooltip={sidebarOpen ? undefined : tooltip || label}
      onClick={onClick}
      type="button"
    >
      <Icon size={18} strokeWidth={1.75} />
      {sidebarOpen && <span>{label}</span>}
      {sidebarOpen && trailing}
      {sidebarOpen && badge ? <small>{badge}</small> : null}
      {!sidebarOpen && badge ? <small className="rail-badge">{badge}</small> : null}
    </button>
  );
}

function PostFiatLogo() {
  return (
    <svg
      aria-hidden="true"
      className="post-fiat-logo"
      fill="none"
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M40 40 160 160m0-120L40 160"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="20"
      />
      <line
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="20"
        x1="40"
        x2="160"
        y1="160"
        y2="160"
      />
    </svg>
  );
}

function ModelGroup({ label }) {
  return <div className="model-group">{label}</div>;
}

function ModelOption({ mode, onClick, selected }) {
  return (
    <button className={`model-option${selected ? " selected" : ""}`} onClick={onClick} type="button">
      <span>
        <strong>{formatModeLabel(mode.label)}</strong>
        <small>{modeDescription(mode)}</small>
      </span>
      {selected && <Check size={15} strokeWidth={2} />}
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
  return String(label || "").trim();
}

function modeDescription(mode = {}) {
  const label = String(mode.label || "");
  if (label === "Private Instant") return "ZDR. Open Source. Fast.";
  if (label === "Private Thinking") return "ZDR. Open Source. More reasoning.";
  if (label === "Frontier Instant") return "Fast frontier model";
  if (label === "Frontier Thinking") return "Deeper frontier reasoning";
  return mode.latency || mode.privacy || "";
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
  const outstandingCount = MOCK_TASKS.outstanding.length;
  const totalPft = MOCK_TASKS.outstanding.reduce((sum, task) => sum + task.pft, 0);
  const tabs = [
    { key: "outstanding", label: "Outstanding", count: MOCK_TASKS.outstanding.length },
    { key: "verification", label: "Verification", count: MOCK_TASKS.verification.length },
    { key: "refused", label: "Refused", count: MOCK_TASKS.refused },
    { key: "rewarded", label: "Rewarded", count: MOCK_TASKS.rewarded },
  ];

  return (
    <div className="route-scroll">
      <div className="tasks-view tasks-copy-surface">
        <div className="tasks-copy-header">
          <div>
            <h1>Tasks</h1>
            <p>
              <strong>{outstandingCount} outstanding</strong>
              <span aria-hidden="true">.</span>
              <span className="task-in-flight">{totalPft.toLocaleString()} PFT in flight</span>
            </p>
          </div>
          <button className="dark-pill task-request-button" type="button">
            <Plus size={16} strokeWidth={2} />
            Request task
          </button>
        </div>

        <div className="tab-row tasks-copy-tabs">
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
          <div className="task-list task-entry-list">
            {MOCK_TASKS.outstanding.map((task, index) => (
              <TaskRow
                isFirst={index === 0}
                key={task.id}
                onClick={() => onSelectTask(task)}
                task={task}
              />
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

function TaskDot() {
  return <span className="task-dot" aria-hidden="true" />;
}

function TaskRow({ isFirst, onClick, task }) {
  return (
    <button className={`task-row task-entry${isFirst ? " is-first" : ""}`} onClick={onClick} type="button">
      <span className="task-entry-signal">
        <TaskStatusGlyph status={task.status} />
      </span>
      <span className="task-entry-main">
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          <strong>{task.kind}</strong>
          <TaskDot />
          <span className="task-status-text" style={{ color: taskStatusColor(task.status) }}>
            {task.status}
          </span>
          <TaskDot />
          <span>{task.fullDue}</span>
          <TaskDot />
          <span>{task.ago}</span>
        </span>
      </span>
      <span className="task-reward">
        <strong>{task.pft.toLocaleString()}</strong>
        <span>PFT</span>
      </span>
    </button>
  );
}

function shortWalletAddress(address) {
  const text = String(address || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function normalizeSeedInput(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function seedWordCount(value) {
  const normalized = normalizeSeedInput(value);
  return normalized ? normalized.split(" ").length : 0;
}

function WalletView({
  onAppStateChange,
  onLoginRequired,
  onWalletVaultChange,
  onWalletVaultLock,
  onWalletVaultUnlocked,
  session,
  wallet,
  walletVault,
  usage,
}) {
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [hideBalance, setHideBalance] = useState(false);
  const [hoveredTx, setHoveredTx] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [walletProofAction, setWalletProofAction] = useState(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [delinkOpen, setDelinkOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpState, setTopUpState] = useState({
    status: wallet?.ethereumDeposit ? "ready" : "idle",
    data: wallet?.ethereumDeposit ? { depositAccount: wallet.ethereumDeposit } : null,
    message: "",
  });
  const [txFeed, setTxFeed] = useState({
    status: "idle",
    transactions: [],
    message: "",
    fetchedAt: null,
    scannedTransactions: 0,
    complete: true,
  });
  const actions = wallet?.actions || [];
  const linkAction = actions.find((action) => action.id === "link_start");
  const relinkAction = actions.find((action) => action.id === "relink_start");
  const delinkAction = actions.find((action) => action.id === "delink");
  const fundingActions = usage?.fundingActions || [];
  const topUpAction = fundingActions.find((action) => action.id === "top_up_start");
  const linkedWallet = wallet?.pftWallet || {};
  const walletLinked = linkedWallet.status === "linked";
  const vaultAvailable = Boolean(walletVault?.available && walletVault?.address === linkedWallet.address);
  const vaultUnlocked = Boolean(vaultAvailable && walletVault?.unlocked);
  const vaultDisplay = walletVaultDisplayState(walletVault, linkedWallet.address);
  const signedIn = isSignedInSession(session);
  const pftBalance = formatPftBalance(wallet);
  const balanceStatusLabel = walletLinked ? walletBalanceStatusLabel(wallet) : "";
  const balanceError = walletLinked && wallet?.pftBalanceError;
  const txGroups = groupWalletTransactions(txFeed.transactions);
  const txLoading = txFeed.status === "loading";
  const txRefreshing = txFeed.status === "refreshing";
  const txError = txFeed.status === "error";
  const networkLabel = !walletLinked
    ? "No wallet"
    : wallet?.pftBalanceStatus === "error" || txError
      ? "Network issue"
      : wallet?.pftBalanceStatus === "checking"
        ? "Checking"
        : "Network live";
  const networkTone = networkLabel === "Network live" ? "live" : networkLabel === "Network issue" ? "error" : "muted";
  const walletAddressLabel = walletLinked ? shortWalletAddress(linkedWallet.address) : "No wallet linked";
  const vaultStatusLabel = vaultUnlocked ? "Unlocked" : vaultAvailable ? "Locked" : walletLinked ? "Not saved" : "Seed not linked";
  const primaryActionLabel = !walletLinked || !vaultAvailable ? "Link wallet" : vaultUnlocked ? "Lock" : "Unlock";

  useEffect(() => {
    if (!signedIn) return;
    setMessage((current) =>
      current === "Sign in before linking a seed wallet." ? "" : current
    );
  }, [signedIn]);

  useEffect(() => {
    if (!wallet?.ethereumDeposit) return;
    setTopUpState((current) => ({
      ...current,
      status: current.status === "loading" ? current.status : "ready",
      data: {
        ...(current.data || {}),
        depositAccount: wallet.ethereumDeposit,
      },
    }));
  }, [wallet?.ethereumDeposit]);

  function requireSignedInForWalletLink() {
    if (signedIn) return true;
    if (!session?.status) {
      setMessage("Wallet actions are still loading.");
      return false;
    }
    setMessage("Sign in before linking a seed wallet.");
    onLoginRequired?.();
    return false;
  }

  function openVaultControl() {
    if (vaultUnlocked) {
      onWalletVaultLock?.();
      return;
    }
    if (vaultAvailable) {
      setUnlockOpen(true);
      return;
    }
    if (requireSignedInForWalletLink()) {
      setMessage("");
      setWalletProofAction(linkAction);
      setLinkOpen(true);
    }
  }

  async function openTopUpFlow() {
    if (!signedIn) {
      setMessage("Sign in before topping up.");
      onLoginRequired?.();
      return;
    }

    setTopUpOpen(true);
    setTopUpState((current) => ({
      ...current,
      status: current.data?.depositAccount ? "ready" : "loading",
      message: "",
    }));

    try {
      const result = await requestJson(topUpAction?.path || "/api/usage/top-up/start", {
        method: topUpAction?.method || "POST",
      });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.actionRequired || "Top-up is unavailable.");
      }
      setTopUpState({
        status: "ready",
        data: result.body,
        message: result.body.message || "",
      });
      await onAppStateChange?.();
    } catch (error) {
      setTopUpState({
        status: "error",
        data: null,
        message: error?.message || "Top-up is unavailable.",
      });
    }
  }

  async function refreshTopUpDeposits() {
    const syncPath = topUpState.data?.syncPath || "/api/usage/top-up/sync";
    setTopUpState((current) => ({
      ...current,
      status: "syncing",
      message: "",
    }));

    try {
      const result = await requestJson(syncPath, { method: "POST" });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.actionRequired || "Deposit refresh failed.");
      }
      setTopUpState((current) => ({
        status: "ready",
        data: {
          ...(current.data || {}),
          ...result.body,
          depositAccount: result.body.depositAccount || current.data?.depositAccount,
        },
        message: result.body.message || "",
      }));
      await onAppStateChange?.();
    } catch (error) {
      setTopUpState((current) => ({
        ...current,
        status: "ready",
        message: error?.message || "Deposit refresh failed.",
      }));
    }
  }

  async function startWalletAction(action) {
    if (!action) {
      setMessage("Wallet actions are still loading.");
      return;
    }
    if (action.id === "link_start") {
      if (!requireSignedInForWalletLink()) return;
      setMessage("");
      if (!walletLinked || !vaultAvailable) {
        setWalletProofAction(linkAction);
        setLinkOpen(true);
      } else if (vaultUnlocked) {
        onWalletVaultLock?.();
        setMessage("Vault locked.");
      } else {
        setUnlockOpen(true);
      }
      return;
    }
    if (action.id === "relink_start") {
      if (!requireSignedInForWalletLink()) return;
      setMessage("");
      setWalletProofAction(action);
      setLinkOpen(true);
      return;
    }
    if (action.id === "delink") {
      if (!requireSignedInForWalletLink()) return;
      if (!walletLinked) {
        setMessage("No active wallet is linked to this account.");
        return;
      }
      setMessage("");
      setDelinkOpen(true);
      return;
    }
    if (action.id === "unlock_start" && walletLinked && vaultAvailable && !vaultUnlocked) {
      setUnlockOpen(true);
      return;
    }

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

  const refreshWalletTransactions = useCallback(async ({ force = false } = {}) => {
    if (!signedIn || !walletLinked || !linkedWallet.address) {
      setTxFeed({
        status: walletLinked ? "idle" : "not_linked",
        transactions: [],
        message: "",
        fetchedAt: null,
        scannedTransactions: 0,
        complete: true,
      });
      return;
    }

    const path = wallet?.pftTransactionsPath || "/api/wallet/transactions";
    setTxFeed((current) => ({
      ...current,
      status: current.transactions.length ? "refreshing" : "loading",
      message: "",
    }));

    try {
      const query = `limit=50${force ? "&force=1" : ""}`;
      const result = await requestJson(`${path}?${query}`);
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Transaction feed unavailable.");
      }
      setTxFeed({
        status: "ready",
        transactions: Array.isArray(result.body.transactions) ? result.body.transactions : [],
        message: "",
        fetchedAt: result.body.fetchedAt || new Date().toISOString(),
        scannedTransactions: Number(result.body.scannedTransactions || 0),
        complete: result.body.complete !== false,
      });
    } catch (error) {
      setTxFeed((current) => ({
        ...current,
        status: "error",
        message: error?.message || "Transaction feed unavailable.",
      }));
    }
  }, [linkedWallet.address, signedIn, wallet?.pftTransactionsPath, walletLinked]);

  useEffect(() => {
    if (!signedIn || !walletLinked || !linkedWallet.address) {
      setTxFeed({
        status: walletLinked ? "idle" : "not_linked",
        transactions: [],
        message: "",
        fetchedAt: null,
        scannedTransactions: 0,
        complete: true,
      });
      return undefined;
    }

    refreshWalletTransactions({ force: true });
    const timer = window.setInterval(() => refreshWalletTransactions(), WALLET_TX_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [linkedWallet.address, refreshWalletTransactions, signedIn, walletLinked]);

  async function copyWalletAddress() {
    if (!walletLinked || !linkedWallet.address) return;
    try {
      await navigator.clipboard?.writeText(linkedWallet.address);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 1400);
    } catch {
      setMessage("Address copy failed.");
    }
  }

  return (
    <div className="route-scroll">
      <div className="wallet-view wallet-redesign">
        <header className="wallet-page-head">
          <div>
            <div className="wallet-page-kicker">Task Node</div>
            <h1>Wallet</h1>
          </div>
          <button
            className="wallet-hide-button"
            onClick={() => setHideBalance((value) => !value)}
            type="button"
          >
            {hideBalance ? <Eye size={14} strokeWidth={1.8} /> : <EyeOff size={14} strokeWidth={1.8} />}
            {hideBalance ? "Show" : "Hide"} balance
          </button>
        </header>

        <section className="wallet-balance-card">
          <div className="wallet-balance-inner">
            <div className="wallet-balance-top">
              <span>Available balance</span>
              <span className={`wallet-network-state is-${networkTone}`}>
                <span aria-hidden="true" />
                {networkLabel}
              </span>
            </div>

            <div className="wallet-balance-display">
              <strong>{hideBalance ? "••••" : pftBalance}</strong>
              <span>PFT</span>
            </div>

            <div className="wallet-identity-row">
              <button
                className="address-chip wallet-address-chip"
                disabled={!walletLinked}
                onClick={copyWalletAddress}
                type="button"
              >
                <span className={walletLinked ? "wallet-address-dot is-linked" : "wallet-address-dot"} />
                <span>{walletAddressLabel}</span>
                {copiedAddress ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
              </button>
              <span className={`wallet-vault-chip is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                <ShieldCheck size={14} strokeWidth={1.8} />
                {vaultStatusLabel}
              </span>
            </div>

            <p className="wallet-balance-note">
              {walletLinked
                ? vaultUnlocked
                  ? "Encrypted vault unlocked for this browser session. Your seed never leaves this device."
                  : vaultAvailable
                    ? "Encrypted seed vault saved locally. Unlock before wallet-bound signing actions."
                    : "Ownership proof is linked. Save an encrypted local vault before wallet-bound actions."
                : "Link a 24-word recovery phrase locally. Your seed never leaves your device."}
            </p>

            <div className="wallet-actions">
              <button className="wallet-primary-action" onClick={() => startWalletAction(linkAction)} type="button">
                {vaultUnlocked ? <Lock size={16} strokeWidth={2} /> : walletLinked && vaultAvailable ? <Unlock size={16} strokeWidth={2} /> : <Link2 size={16} strokeWidth={2} />}
                {primaryActionLabel}
              </button>
              <button
                className="wallet-secondary-action"
                disabled={!walletLinked}
                onClick={copyWalletAddress}
                type="button"
              >
                <Download size={16} strokeWidth={2} />
                Receive
              </button>
              <button className="wallet-secondary-action" disabled type="button">
                <Send size={16} strokeWidth={2} />
                Send
              </button>
            </div>
          </div>
        </section>

        {(balanceStatusLabel || balanceError || message) && (
          <div className="wallet-inline-status" role="status">
            {message || [balanceStatusLabel, balanceError].filter(Boolean).join(" · ")}
          </div>
        )}

        <section className="wallet-management-grid" aria-label="Wallet management">
          <WalletManagementCard
            icon={ShieldCheck}
            label="Local seed vault"
            onClick={openVaultControl}
            status={vaultUnlocked ? "Unlocked" : vaultAvailable ? "Locked" : "Not saved"}
          />
          <WalletManagementCard
            disabled={!walletLinked || pendingAction === "delink"}
            icon={Unlink}
            label="Delink wallet"
            onClick={() => startWalletAction(delinkAction)}
            status={pendingAction === "delink" ? "Working" : walletLinked ? "Ready" : "No wallet"}
          />
          <WalletManagementCard
            active={walletLinked}
            disabled={pendingAction === "relink_start"}
            icon={Link2}
            label="Relink wallet"
            onClick={() => startWalletAction(relinkAction)}
            status={pendingAction === "relink_start" ? "Working" : signedIn ? "Ready" : "Sign in"}
          />
        </section>

        <div className="wallet-usage-note wallet-credit-note">
          <span>
            Chat credit <strong>{formatCreditUsd(wallet?.chatCreditUsd || 0)}</strong>. Billing is{" "}
            {usage?.billingModel === "usage_based" ? "usage-based" : "not ready"}.
          </span>
          <button
            className="wallet-mini-action"
            disabled={!signedIn || topUpState.status === "loading" || topUpState.status === "syncing"}
            onClick={openTopUpFlow}
            type="button"
          >
            <Plus size={13} strokeWidth={2} />
            Top up
          </button>
        </div>

        <section className="wallet-activity-section">
          <header className="wallet-activity-head">
            <div>
              <span>Activity</span>
              <h2>Your latest transactions</h2>
            </div>
            <button
              className="wallet-link-action"
              disabled={!walletLinked || txLoading || txRefreshing}
              onClick={() => refreshWalletTransactions({ force: true })}
              type="button"
            >
              {txRefreshing ? "Refreshing" : "Refresh"} <ChevronRight size={14} strokeWidth={1.8} />
            </button>
          </header>

          <div className="wallet-activity-card">
            {!walletLinked && (
              <WalletFeedEmpty
                title="No wallet linked"
                body="Link a wallet to read PFTL account history."
              />
            )}
            {walletLinked && txLoading && (
              <WalletFeedEmpty title="Loading transaction history" body="Reading PFTL account transactions." />
            )}
            {walletLinked && txError && (
              <WalletFeedEmpty title="Transaction feed unavailable" body={txFeed.message || "Try refreshing again."} />
            )}
            {walletLinked && !txLoading && !txError && txGroups.length === 0 && (
              <WalletFeedEmpty title="No PFTL transactions found" body="This wallet has no readable recent PFTL payments yet." />
            )}
            {walletLinked && !txLoading && !txError && txGroups.map((group) => (
              <div className="wallet-tx-group" key={group.group}>
                <div className="wallet-tx-group-label">
                  <span>{group.group}</span>
                  <span aria-hidden="true" />
                </div>
                <ul>
                  {group.items.map((tx, index) => (
                    <WalletTransactionRow
                      hovered={hoveredTx === tx.id}
                      key={tx.id || `${group.group}-${index}`}
                      onHover={setHoveredTx}
                      tx={tx}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {walletLinked && !txLoading && !txError && txGroups.length > 0 && (
              <footer className="wallet-activity-foot">
                <span>
                  Showing {txFeed.transactions.length} of {txFeed.scannedTransactions || txFeed.transactions.length} scanned transactions
                </span>
                <button
                  disabled={txRefreshing}
                  onClick={() => refreshWalletTransactions({ force: true })}
                  type="button"
                >
                  {txRefreshing ? "Refreshing" : "Load latest"} <ChevronRight size={14} strokeWidth={1.8} />
                </button>
              </footer>
            )}
          </div>
        </section>
      </div>
      {linkOpen && (
        <WalletLinkModal
          action={walletProofAction || linkAction}
          onAppStateChange={onAppStateChange}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultUnlocked={onWalletVaultUnlocked}
          onClose={() => {
            setLinkOpen(false);
            setWalletProofAction(null);
          }}
          session={session}
        />
      )}
      {delinkOpen && (
        <WalletDelinkModal
          action={delinkAction}
          linkedWallet={linkedWallet}
          onAppStateChange={onAppStateChange}
          onClose={() => setDelinkOpen(false)}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultLock={onWalletVaultLock}
          session={session}
        />
      )}
      {unlockOpen && (
        <WalletUnlockModal
          linkedWallet={linkedWallet}
          onClose={() => setUnlockOpen(false)}
          onWalletVaultChange={onWalletVaultChange}
          onWalletVaultUnlocked={(unlock) => {
            setMessage("");
            onWalletVaultUnlocked?.(unlock);
          }}
          session={session}
        />
      )}
      {topUpOpen && (
        <EthereumTopUpModal
          onClose={() => setTopUpOpen(false)}
          onRefresh={refreshTopUpDeposits}
          state={topUpState}
        />
      )}
    </div>
  );
}

function WalletManagementCard({ active = false, disabled = false, icon: Icon, label, onClick, status }) {
  return (
    <button
      className={`wallet-management-card${active ? " is-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>
        {Icon && <Icon size={16} strokeWidth={1.8} />}
        {label}
      </span>
      <small>{status}</small>
      <ChevronRight size={16} strokeWidth={1.8} />
    </button>
  );
}

function EthereumTopUpModal({ onClose, onRefresh, state }) {
  const [copied, setCopied] = useState(false);
  const deposit = state?.data?.depositAccount || null;
  const assets = deposit?.assets || [];
  const busy = state?.status === "loading" || state?.status === "syncing";
  const error = state?.status === "error";

  async function copyDepositAddress() {
    if (!deposit?.address) return;
    try {
      await navigator.clipboard?.writeText(deposit.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <div
        aria-label="Top up account"
        aria-modal="true"
        className="wallet-link-modal eth-topup-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2>Top up</h2>
            <p>Send ETH, USDC, or USDT on Ethereum mainnet to your account deposit address.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close top up">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {busy && !deposit && (
          <div className="eth-topup-loading">
            <RefreshCw size={16} strokeWidth={2} />
            Preparing deposit address
          </div>
        )}

        {error && (
          <div className="wallet-link-warning">
            {state?.message || "Top-up is unavailable."}
          </div>
        )}

        {deposit && (
          <>
            <div className="eth-topup-address">
              <span>Ethereum mainnet address</span>
              <button onClick={copyDepositAddress} type="button">
                <strong>{deposit.address}</strong>
                {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
              </button>
            </div>

            <div className="eth-topup-assets" aria-label="Supported top-up assets">
              {assets.map((asset) => (
                <div className="eth-topup-asset" key={asset.symbol}>
                  <span>{asset.symbol}</span>
                  <div>
                    <strong>{asset.label || asset.symbol}</strong>
                    <small>
                      {asset.kind === "native"
                        ? "Native ETH"
                        : shortEthereumAddress(asset.contractAddress)}
                    </small>
                  </div>
                  <em className={deposit?.pendingBalances?.[asset.symbol] ? "pending" : ""}>
                    {formatDepositAssetBalance(deposit, asset.symbol)}
                  </em>
                </div>
              ))}
            </div>

            <div className="wallet-link-warning">
              This address is controlled by Task Node for account funding. It is not a user wallet,
              withdrawals are not available, and wrong-chain deposits may not be recoverable.
            </div>

            {state?.message && <div className="eth-topup-status">{state.message}</div>}
          </>
        )}

        <footer>
          <button className="ghost-button" onClick={onClose} type="button">
            Done
          </button>
          <button className="solid-button" disabled={!deposit || busy} onClick={onRefresh} type="button">
            {state?.status === "syncing" ? "Refreshing" : "Refresh deposits"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function shortEthereumAddress(address = "") {
  const text = String(address || "").trim();
  if (!text) return "";
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatDepositAssetBalance(deposit, symbol) {
  const balance = deposit?.observedBalances?.[symbol];
  const pending = deposit?.pendingBalances?.[symbol];
  if (balance?.amount && Number(balance.amount) > 0) {
    return formatDepositAmount(balance.amount, symbol);
  }
  if (pending?.amount && Number(pending.amount) > 0) {
    return `Pending ${formatDepositAmount(pending.amount, symbol)}`;
  }
  return "Not seen";
}

function formatDepositAmount(value, symbol) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${symbol}`;
  const options = symbol === "ETH"
    ? { maximumFractionDigits: 8 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 6 };
  return `${amount.toLocaleString(undefined, options)} ${symbol}`;
}

function WalletFeedEmpty({ body, title }) {
  return (
    <div className="wallet-feed-empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function WalletTransactionRow({ hovered = false, onHover, tx }) {
  const isIn = tx.type === "in";
  const isSelf = tx.type === "self";
  const note = tx.note ? truncateWalletNote(tx.note) : "";

  return (
    <li
      className={`wallet-tx-row${hovered ? " is-hovered" : ""}`}
      onMouseEnter={() => onHover?.(tx.id)}
      onMouseLeave={() => onHover?.("")}
    >
      <div className={`wallet-tx-icon${isIn ? " is-in" : ""}${isSelf ? " is-self" : ""}`}>
        {isIn ? <ArrowDownLeft size={16} strokeWidth={2} /> : <ArrowUpRight size={16} strokeWidth={2} />}
      </div>
      <div className="wallet-tx-copy">
        <strong>{tx.label || (isIn ? "Received PFT" : "Sent PFT")}</strong>
        <small>
          {isIn ? "From" : isSelf ? "Self" : "To"} {tx.counterpartyLabel || shortWalletAddress(tx.counterparty)}
          {note && (
            <>
              <span aria-hidden="true"> · </span>
              <span>{note}</span>
            </>
          )}
        </small>
      </div>
      <div className={`wallet-tx-amount${isIn ? " is-in" : ""}`}>
        <strong>{formatWalletTransactionAmount(tx)} PFT</strong>
        <small>{formatWalletTransactionTime(tx.createdAt)}</small>
      </div>
    </li>
  );
}

function WalletLinkModal({
  action,
  onAppStateChange,
  onWalletVaultChange,
  onWalletVaultUnlocked,
  onClose,
  session,
}) {
  const isRelink = action?.id === "relink_start";
  const [walletCore, setWalletCore] = useState(null);
  const [mnemonic, setMnemonic] = useState("");
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [linking, setLinking] = useState(false);
  const normalized = walletCore?.normalizeMnemonic?.(mnemonic) || normalizeSeedInput(mnemonic);
  const wordCount = walletCore?.mnemonicWordCount?.(mnemonic) || seedWordCount(mnemonic);
  const valid = walletCore?.isValidTaskNodeMnemonic?.(mnemonic) || false;
  const passwordReady = vaultPassword.length >= 10;
  const passwordsMatch = Boolean(vaultPassword) && vaultPassword === vaultPasswordConfirm;
  const vaultStatus = !vaultPassword
    ? "Required"
    : !passwordReady
      ? "10+ chars"
      : !vaultPasswordConfirm
        ? "Confirm"
        : !passwordsMatch
          ? "Mismatch"
          : "Ready";
  let walletSummary = null;

  useEffect(() => {
    let active = true;
    import("./wallet-core")
      .then((module) => {
        if (active) setWalletCore(module);
      })
      .catch(() => {
        if (active) setMessage("Wallet tools could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, []);

  if (valid) {
    try {
      walletSummary = walletCore.deriveWalletSummary(normalized);
    } catch {
      walletSummary = null;
    }
  }

  async function resolveSignedInSession() {
    if (isSignedInSession(session)) return session;
    const nextState = await onAppStateChange?.();
    return isSignedInSession(nextState?.session) ? nextState.session : null;
  }

  async function linkWallet() {
    if (!walletCore) {
      setMessage("Wallet tools are still loading.");
      return;
    }

    const activeSession = await resolveSignedInSession();
    if (!activeSession) {
      setMessage("Sign in before linking a seed wallet.");
      return;
    }

    if (!valid || !walletSummary) {
      setMessage("Enter a valid 24-word recovery phrase.");
      return;
    }
    if (!passwordReady) {
      setMessage("Set a wallet password of at least 10 characters.");
      return;
    }
    if (!vaultPasswordConfirm) {
      setMessage("Confirm the wallet password.");
      return;
    }
    if (!passwordsMatch) {
      setMessage("Wallet passwords do not match.");
      return;
    }

    setLinking(true);
    setMessage("");

    try {
      const start = await requestJson(action?.path || "/api/wallet/link/start", {
        method: action?.method || "POST",
      });
      if (!start.ok || !start.body?.challenge?.message) {
        setMessage(start.body?.message || start.body?.actionRequired || "Wallet link could not start.");
        setLinking(false);
        return;
      }

      const proof = walletCore.signWalletChallenge(normalized, start.body.challenge.message);
      const verify = await requestJson(start.body.verifyPath || "/api/wallet/link/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: start.body.challenge.id,
          address: proof.address,
          publicKey: proof.publicKey,
          signature: proof.signature,
        }),
      });

      if (!verify.ok) {
        setMessage(verify.body?.message || verify.body?.actionRequired || "Wallet proof did not verify.");
        setLinking(false);
        return;
      }

      let unlockedAt = new Date().toISOString();
      try {
        await walletCore.saveEncryptedMnemonicVault({
          accountId: activeSession.accountId,
          mnemonic: normalized,
          password: vaultPassword,
        });
        await onWalletVaultChange?.();
        onWalletVaultUnlocked?.({
          ...walletSummary,
          accountId: activeSession.accountId,
          mnemonic: normalized,
          unlockedAt,
        });
      } catch {
        await onAppStateChange?.();
        setMessage("Wallet linked, but the encrypted vault could not be saved on this device.");
        setLinking(false);
        return;
      }

      setMnemonic("");
      setVaultPassword("");
      setVaultPasswordConfirm("");
      setMessage(verify.body?.message || (isRelink ? "Wallet relinked." : "Wallet linked."));
      await onAppStateChange?.();
      onClose();
    } catch (error) {
      setMessage(error?.message || "Wallet link failed.");
      setLinking(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal" role="dialog" aria-modal="true" aria-label="Link seed wallet">
        <header>
          <div>
            <h2>{isRelink ? "Relink Seed Wallet" : "Link Seed Wallet"}</h2>
            <p>
              {isRelink
                ? "Prove wallet ownership again. The recovery phrase stays in this browser."
                : "Validate and sign locally. Your recovery phrase is never sent to Task Node."}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet link">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <label className="wallet-seed-field">
          <span>24-word recovery phrase</span>
          <textarea
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            onChange={(event) => {
              setMnemonic(event.target.value);
              setMessage("");
            }}
            placeholder="word one word two ..."
            spellCheck={false}
            value={mnemonic}
          />
        </label>
        <div className="wallet-password-grid">
          <label className="wallet-seed-field compact">
            <span>Wallet password</span>
            <input
              aria-label="Wallet password"
              autoComplete="new-password"
              onChange={(event) => {
                setVaultPassword(event.target.value);
                setMessage("");
              }}
              type="password"
              value={vaultPassword}
            />
          </label>
          <label className="wallet-seed-field compact">
            <span>Confirm password</span>
            <input
              aria-label="Confirm wallet password"
              autoComplete="new-password"
              onChange={(event) => {
                setVaultPasswordConfirm(event.target.value);
                setMessage("");
              }}
              type="password"
              value={vaultPasswordConfirm}
            />
          </label>
        </div>
        <div className="wallet-proof-summary">
          <span>
            <strong>{wordCount}/24</strong>
            Words
          </span>
          <span>
            <strong>{valid ? "Valid" : "Pending"}</strong>
            Mnemonic
          </span>
          <span>
            <strong>{walletSummary?.address ? shortWalletAddress(walletSummary.address) : "Not derived"}</strong>
            Address
          </span>
          <span>
            <strong>{vaultStatus}</strong>
            Local vault
          </span>
        </div>
        <div className="wallet-link-warning">
          The encrypted vault is saved only in this browser. Task Node never receives the phrase or password.
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="dark-pill" disabled={linking} onClick={linkWallet} type="button">
            {linking ? (isRelink ? "Relinking" : "Linking") : isRelink ? "Relink wallet" : "Link wallet"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function WalletDelinkModal({
  action,
  linkedWallet,
  onAppStateChange,
  onClose,
  onWalletVaultChange,
  onWalletVaultLock,
  session,
}) {
  const [message, setMessage] = useState("");
  const [delinking, setDelinking] = useState(false);

  async function delinkWallet() {
    if (delinking) return;
    if (!session?.accountId) {
      setMessage("Sign in before delinking a wallet.");
      return;
    }
    if (!linkedWallet?.address) {
      setMessage("No active wallet is linked to this account.");
      return;
    }

    setDelinking(true);
    setMessage("");
    try {
      const result = await requestJson(action?.path || "/api/wallet/delink", {
        method: action?.method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmAddress: linkedWallet.address,
          reason: "user_requested",
        }),
      });

      if (!result.ok) {
        setMessage(result.body?.message || result.body?.actionRequired || "Wallet could not be delinked.");
        setDelinking(false);
        return;
      }

      onWalletVaultLock?.();
      try {
        const walletCore = await import("./wallet-core");
        walletCore.removeLocalWalletVault({ accountId: session.accountId });
      } catch {
        // Server delink succeeded. A local vault cleanup failure should not
        // restore server wallet ownership.
      }
      await onWalletVaultChange?.();
      await onAppStateChange?.();
      onClose();
    } catch (error) {
      setMessage(error?.message || "Wallet delink failed.");
      setDelinking(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal" role="dialog" aria-modal="true" aria-label="Delink wallet">
        <header>
          <div>
            <h2>Delink Wallet</h2>
            <p>Detach this wallet from the app account. Chain history and PFT balance are untouched.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet delink">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="wallet-proof-summary single">
          <span>
            <strong>{shortWalletAddress(linkedWallet?.address)}</strong>
            Linked wallet
          </span>
        </div>
        <div className="wallet-link-warning">
          Delinking clears the active server wallet link for this account and removes the encrypted local vault from this browser. Relinking requires a fresh signed wallet proof.
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" disabled={delinking} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="dark-pill" disabled={delinking} onClick={delinkWallet} type="button">
            {delinking ? "Delinking" : "Delink wallet"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function WalletUnlockModal({
  linkedWallet,
  onClose,
  onWalletVaultChange,
  onWalletVaultUnlocked,
  session,
}) {
  const [walletCore, setWalletCore] = useState(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  useEffect(() => {
    let active = true;
    import("./wallet-core")
      .then((module) => {
        if (active) setWalletCore(module);
      })
      .catch(() => {
        if (active) setMessage("Wallet tools could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, []);

  async function unlockVault() {
    if (!walletCore || unlocking) return;
    if (!session?.accountId) {
      setMessage("Sign in before unlocking a wallet.");
      return;
    }

    setUnlocking(true);
    setMessage("");
    try {
      const unlocked = await walletCore.unlockEncryptedMnemonicVault({
        accountId: session.accountId,
        password,
        expectedAddress: linkedWallet?.address || "",
      });
      onWalletVaultUnlocked?.(unlocked);
      setPassword("");
      onClose();
    } catch {
      setMessage("Wallet password did not unlock this vault.");
      setUnlocking(false);
    }
  }

  async function forgetVault() {
    if (!walletCore || forgetting || !session?.accountId) return;
    setForgetting(true);
    setMessage("");
    try {
      walletCore.removeLocalWalletVault({ accountId: session.accountId });
      await onWalletVaultChange?.();
      onClose();
    } catch {
      setMessage("Local vault could not be removed.");
      setForgetting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="wallet-link-modal" role="dialog" aria-modal="true" aria-label="Unlock seed wallet">
        <header>
          <div>
            <h2>Unlock Seed Wallet</h2>
            <p>Decrypt the local vault for this browser session.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close wallet unlock">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="wallet-proof-summary single">
          <span>
            <strong>{shortWalletAddress(linkedWallet?.address)}</strong>
            Linked wallet
          </span>
        </div>
        <label className="wallet-seed-field compact">
          <span>Wallet password</span>
          <input
            aria-label="Wallet unlock password"
            autoComplete="current-password"
            autoFocus
            onChange={(event) => {
              setPassword(event.target.value);
              setMessage("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") unlockVault();
            }}
            type="password"
            value={password}
          />
        </label>
        <div className="wallet-link-warning">
          Unlocking keeps the decrypted phrase in memory only. Lock the vault or log out to clear it.
        </div>
        {message && <div className="inline-message">{message}</div>}
        <footer>
          <button className="light-pill" disabled={forgetting} onClick={forgetVault} type="button">
            {forgetting ? "Forgetting" : "Forget local vault"}
          </button>
          <button className="dark-pill" disabled={!walletCore || !password || unlocking} onClick={unlockVault} type="button">
            {unlocking ? "Unlocking" : "Unlock"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function pickContextText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => pickContextText(entry)).filter(Boolean).join("\n\n");
  }
  if (typeof value !== "object") return "";

  const directFields = [
    "body",
    "content",
    "context",
    "contextDocument",
    "context_doc",
    "markdown",
    "text",
    "plaintext",
  ];
  for (const field of directFields) {
    const text = pickContextText(value[field]);
    if (text) return text;
  }

  return "";
}

function pickContextTitle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Historical PFT Context";
  const title = value.title || value.name || value.contextTitle || value.context_title;
  return String(title || "Historical PFT Context").trim().slice(0, 120) || "Historical PFT Context";
}

function extractHydratedContext(payload, plaintext) {
  const parsedPlaintext = (() => {
    if (typeof plaintext !== "string") return null;
    try {
      return JSON.parse(plaintext);
    } catch {
      return null;
    }
  })();
  const source = parsedPlaintext || payload;
  const text = (pickContextText(source) || (typeof plaintext === "string" ? plaintext : "")).trim();
  return {
    title: pickContextTitle(source),
    text: text.slice(0, 50000),
    rawPayload: source,
  };
}

function formatContextTimestamp(value) {
  if (!value) return "Not saved yet";

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "Not saved yet";
  }
}

function formatRelativeShort(value, now = Date.now()) {
  if (!value) return "not saved";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "not saved";
  const diff = Math.max(0, now - then);
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function escapeContextHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ""));
}

function contextTextToHtml(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listType = "";

  function closeList() {
    if (!listType) return;
    html += `</${listType}>`;
    listType = "";
  }

  function openList(nextType) {
    if (listType === nextType) return;
    closeList();
    listType = nextType;
    html += `<${listType}>`;
  }

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      return;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      html += `<h${level}>${escapeContextHtml(heading[2])}</h${level}>`;
      return;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      openList("ul");
      html += `<li>${escapeContextHtml(unordered[1])}</li>`;
      return;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (ordered) {
      openList("ol");
      html += `<li>${escapeContextHtml(ordered[1])}</li>`;
      return;
    }

    closeList();
    html += `<p>${escapeContextHtml(trimmed)}</p>`;
  });

  closeList();
  return html || "<p><br></p>";
}

function contextBodyToHtml(value) {
  const text = String(value || "");
  return looksLikeHtml(text) ? text : contextTextToHtml(text);
}

function stripContextHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contextWordCount(value) {
  const text = stripContextHtml(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function truncateCid(cid) {
  const text = String(cid || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function buildContextVersions(documentState = {}, history = {}) {
  const versions = [];
  const currentHtml = contextBodyToHtml(documentState.body || "");
  versions.push({
    key: `current-${documentState.revision || 0}`,
    type: "current",
    rev: documentState.revision || 0,
    cid: "",
    at: documentState.updatedAt || documentState.createdAt,
    words: contextWordCount(currentHtml),
    preview: stripContextHtml(currentHtml).slice(0, 220),
    current: true,
  });

  (history.contextUpdates || []).forEach((pointer, index) => {
    versions.push({
      key: pointer.cid || `pointer-${index}`,
      type: "pointer",
      rev: pointer.version || Math.max((history.contextUpdateCount || 0) - index, 1),
      cid: pointer.cid || "",
      at: pointer.createdAt,
      words: Number(pointer.wordCount || 0),
      preview: pointer.cid
        ? `Historical context pointer ${truncateCid(pointer.cid)}`
        : "Historical context pointer",
      current: false,
      pointer,
    });
  });

  return versions;
}

function ContextToolButton({ active, children, disabled = false, onMouseDown, title }) {
  return (
    <button
      aria-label={title}
      aria-pressed={active ? "true" : "false"}
      className={`ctx-tool-btn${active ? " is-active" : ""}`}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
        if (!disabled) onMouseDown?.(event);
      }}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function ContextView({ context, linkedWalletAddress = "", onContextChange, onHydrateContext, walletVault }) {
  const initialDocument = context?.document || {};
  const savePath = context?.savePath || initialDocument.savePath || "/api/context/edit/save";
  const history = context?.history || {};
  const [documentState, setDocumentState] = useState(initialDocument);
  const [title, setTitle] = useState(initialDocument.title || "Task Node Context");
  const [savedTitle, setSavedTitle] = useState(initialDocument.title || "Task Node Context");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedCid, setCopiedCid] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    h2: false,
    h3: false,
    ul: false,
    ol: false,
  });
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ rows: 0, cols: 0 });
  const [hydratedContext, setHydratedContext] = useState(null);
  const [hydratedPreviewByCid, setHydratedPreviewByCid] = useState({});
  const [restoringVersionKey, setRestoringVersionKey] = useState("");
  const [previewHydration, setPreviewHydration] = useState({
    active: false,
    loaded: 0,
    total: 0,
    error: "",
  });
  const [hydrateMessage, setHydrateMessage] = useState("");
  const [discoveringHistory, setDiscoveringHistory] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState("");
  const editorRef = useRef(null);
  const savedRangeRef = useRef(null);
  const tableWrapRef = useRef(null);
  const previewHydrationRunRef = useRef(0);
  const lastSavedHtmlRef = useRef(contextBodyToHtml(initialDocument.body || ""));

  useEffect(() => {
    const nextDocument = context?.document || {};
    const nextTitle = nextDocument.title || "Task Node Context";
    const nextHtml = contextBodyToHtml(nextDocument.body || "");
    setDocumentState(nextDocument);
    setTitle(nextTitle);
    setSavedTitle(nextTitle);
    lastSavedHtmlRef.current = nextHtml;
    if (editorRef.current) editorRef.current.innerHTML = nextHtml;
    setDirty(false);
    setSaveMessage("");
  }, [context?.document?.id, context?.document?.revision, context?.document?.updatedAt]);

  useEffect(() => {
    setHydratedContext(null);
    setHydrateMessage("");
    setRestoringVersionKey("");
    setHydratedPreviewByCid({});
    setDiscoverMessage("");
  }, [history?.revision, history?.latestContextPointer?.cid, linkedWalletAddress]);

  const canEdit = Boolean(documentState.canEdit);
  const activeWalletAddress = String(linkedWalletAddress || "").trim();
  const historyWalletAddress = String(history?.walletAddress || "").trim();
  const walletHistoryActive = Boolean(activeWalletAddress && historyWalletAddress && historyWalletAddress === activeWalletAddress);
  const visibleHistory = walletHistoryActive ? history : {};
  const versions = buildContextVersions(documentState, visibleHistory);
  const historyPreviewTargets = versions
    .filter((version) => version.pointer?.cid)
    .map((version) => ({
      key: version.key,
      cid: String(version.pointer.cid || "").trim(),
      pointer: version.pointer,
    }))
    .filter((version) => version.cid);
  const historyPreviewTargetKey = historyPreviewTargets.map((version) => `${version.key}:${version.cid}`).join("|");
  const manifestAction = (context?.actions || []).find((action) => action.id === "ink_manifest");
  const rpcHistoryAction = (context?.actions || []).find((action) => action.id === "hydrate_rpc_history");
  const rpcHistoryPath =
    context?.historyRpcImportPath ||
    history?.rpcImportPath ||
    rpcHistoryAction?.path ||
    "/api/context/history/rpc/import";
  const canDiscoverHistory = Boolean(
    activeWalletAddress &&
    history?.canHydrate &&
    (rpcHistoryAction?.enabled ?? context?.historyRpcReady ?? true)
  );
  const vaultDisplay = walletVaultDisplayState(walletVault, linkedWalletAddress);
  const restoringAnyVersion = Boolean(restoringVersionKey);
  const previewedHistoryCount = historyPreviewTargets.filter((version) => hydratedPreviewByCid[version.cid]?.text).length;
  const historyPreviewTotal = historyPreviewTargets.length;
  const historyPointerCount = walletHistoryActive ? Number(history?.pointerCount || 0) : 0;
  const historySubtitle = !activeWalletAddress
    ? "Current account context is available without a wallet. Wallet history appears after linking."
    : historyPointerCount
      ? `${historyPointerCount} wallet historical pointer${historyPointerCount === 1 ? "" : "s"} available.`
      : "No historical PFT pointers imported for the linked wallet yet.";

  const recomputeDirty = useCallback(() => {
    const currentHtml = editorRef.current?.innerHTML || "";
    setDirty(currentHtml !== lastSavedHtmlRef.current || title !== savedTitle);
  }, [title, savedTitle]);

  useEffect(() => {
    recomputeDirty();
  }, [recomputeDirty]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, []);

  const updateActiveFormats = useCallback(() => {
    try {
      const block = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      setActiveFormats({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        h2: block === "h2" || block === "<h2>",
        h3: block === "h3" || block === "<h3>",
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      });
    } catch {
      // Selection state is best-effort editor chrome.
    }
  }, []);

  useEffect(() => {
    function handleSelectionChange() {
      if (document.activeElement === editorRef.current) updateActiveFormats();
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [updateActiveFormats]);

  useEffect(() => {
    if (!tablePickerOpen) return undefined;

    function handleMouseDown(event) {
      if (tableWrapRef.current && !tableWrapRef.current.contains(event.target)) {
        setTablePickerOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setTablePickerOpen(false);
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [tablePickerOpen]);

  const saveSelection = useCallback(() => {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || !editorRef.current) return;
    const range = selection.getRangeAt(0);
    if (editorRef.current.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const range = savedRangeRef.current;
    const selection = window.getSelection?.();
    if (!range || !selection || !editorRef.current) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  const exec = useCallback(
    (command, value = null) => {
      if (!canEdit) return;
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      updateActiveFormats();
      recomputeDirty();
    },
    [canEdit, recomputeDirty, updateActiveFormats]
  );

  const toggleHeading = useCallback(
    (level) => {
      if (!canEdit) return;
      editorRef.current?.focus();
      const block = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      const target = `h${level}`;
      document.execCommand(
        "formatBlock",
        false,
        block === target || block === `<${target}>` ? "<p>" : `<${target}>`
      );
      updateActiveFormats();
      recomputeDirty();
    },
    [canEdit, recomputeDirty, updateActiveFormats]
  );

  const insertTable = useCallback(
    (rows, cols) => {
      if (!canEdit || !editorRef.current || rows < 1 || cols < 1) return;
      editorRef.current.focus();
      const restored = restoreSelection();
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");

      for (let col = 0; col < cols; col += 1) {
        const th = document.createElement("th");
        th.innerHTML = "<br>";
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (let row = 1; row < rows; row += 1) {
        const tr = document.createElement("tr");
        for (let col = 0; col < cols; col += 1) {
          const td = document.createElement("td");
          td.innerHTML = "<br>";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      const trailing = document.createElement("p");
      trailing.innerHTML = "<br>";

      if (restored && savedRangeRef.current) {
        const range = savedRangeRef.current;
        range.deleteContents();
        range.insertNode(trailing);
        range.insertNode(table);
      } else {
        editorRef.current.appendChild(table);
        editorRef.current.appendChild(trailing);
      }
      recomputeDirty();
    },
    [canEdit, recomputeDirty, restoreSelection]
  );

  const saveContext = useCallback(async () => {
    if (!canEdit || saving || !editorRef.current) return false;

    setSaving(true);
    setSaveMessage("");
    const body = editorRef.current.innerHTML;

    let result;
    try {
      result = await requestJson(savePath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
    } catch {
      setSaveMessage("Context could not be saved.");
      setSaving(false);
      return false;
    }

    if (!result.ok || !result.body?.document) {
      setSaveMessage(result.body?.message || "Context could not be saved.");
      setSaving(false);
      return false;
    }

    setDocumentState(result.body.document);
    setTitle(result.body.document.title || "Task Node Context");
    setSavedTitle(result.body.document.title || "Task Node Context");
    lastSavedHtmlRef.current = contextBodyToHtml(result.body.document.body || "");
    setSaveMessage("Saved just now");
    setDirty(false);
    setSaving(false);
    return true;
  }, [canEdit, savePath, saving, title]);

  useEffect(() => {
    if (!dirty || saving || !canEdit) return undefined;
    const timeout = window.setTimeout(() => {
      saveContext();
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [canEdit, dirty, saveContext, saving]);

  const handleEditorInput = () => {
    setSaveMessage("");
    recomputeDirty();
  };

  const handleEditorKeyDown = (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "b") {
      event.preventDefault();
      exec("bold");
    }
    if (key === "i") {
      event.preventDefault();
      exec("italic");
    }
  };

  const handleEditorPaste = (event) => {
    if (!canEdit) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined || text === null) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
    recomputeDirty();
  };

  const cacheHydratedPreview = useCallback((cid, contextResult) => {
    const normalizedCid = String(cid || contextResult?.cid || "").trim();
    if (!normalizedCid || !contextResult?.text) return;

    setHydratedPreviewByCid((current) => ({
      ...current,
      [normalizedCid]: {
        title: contextResult.title,
        text: contextResult.text,
        decrypted: contextResult.decrypted,
        fetchedAt: contextResult.fetchedAt || new Date().toISOString(),
      },
    }));
  }, []);

  const hydrateContextPointer = async (pointer, versionKey) => {
    const cid = String(pointer?.cid || "").trim();
    if (!cid || restoringAnyVersion) return false;
    if (!walletVault?.unlocked) {
      setHydrateMessage("Unlock the local seed vault before restoring a historical version.");
      setVersionsOpen(true);
      return false;
    }

    const nextRestoringKey = versionKey || cid;
    setRestoringVersionKey(nextRestoringKey);
    setHydrateMessage("");
    try {
      const result = await onHydrateContext?.(pointer);
      if (!result?.text) {
        setHydrateMessage("Context CID was fetched, but no readable context text was found.");
        setHydratedContext(null);
      } else {
        const nextHydratedContext = { ...result, cid: result.cid || cid };
        setHydratedContext(nextHydratedContext);
        cacheHydratedPreview(cid, nextHydratedContext);
        setHydrateMessage(result.decrypted ? "Historical context decrypted." : "Historical context fetched.");
        setVersionsOpen(true);
      }
      return Boolean(result?.text);
    } catch (error) {
      setHydrateMessage(error?.message || "Context could not be hydrated.");
      setHydratedContext(null);
      return false;
    } finally {
      setRestoringVersionKey("");
    }
  };

  useEffect(() => {
    if (!versionsOpen || !walletVault?.unlocked || !historyPreviewTargetKey) {
      previewHydrationRunRef.current += 1;
      setPreviewHydration((current) =>
        current.active
          ? { active: false, loaded: 0, total: 0, error: "" }
          : current
      );
      return undefined;
    }

    const targets = historyPreviewTargets.filter((version) => !hydratedPreviewByCid[version.cid]?.text);
    if (targets.length === 0) {
      setPreviewHydration({
        active: false,
        loaded: historyPreviewTargets.length,
        total: historyPreviewTargets.length,
        error: "",
      });
      return undefined;
    }

    const runId = previewHydrationRunRef.current + 1;
    previewHydrationRunRef.current = runId;
    let cancelled = false;
    setPreviewHydration({ active: true, loaded: 0, total: targets.length, error: "" });

    async function hydratePreviewRows() {
      let loaded = 0;
      let firstError = "";

      for (const version of targets) {
        if (cancelled || previewHydrationRunRef.current !== runId) return;

        try {
          const result = await onHydrateContext?.(version.pointer);
          if (result?.text) {
            cacheHydratedPreview(version.cid, { ...result, cid: result.cid || version.cid });
          }
        } catch (error) {
          firstError ||= error?.message || "Some previews could not be loaded.";
          if (String(firstError).toLowerCase().includes("unlock")) break;
        } finally {
          loaded += 1;
          if (!cancelled && previewHydrationRunRef.current === runId) {
            setPreviewHydration({
              active: true,
              loaded,
              total: targets.length,
              error: firstError,
            });
          }
        }
      }

      if (!cancelled && previewHydrationRunRef.current === runId) {
        setPreviewHydration({
          active: false,
          loaded,
          total: targets.length,
          error: firstError,
        });
      }
    }

    hydratePreviewRows();
    return () => {
      cancelled = true;
    };
  }, [cacheHydratedPreview, historyPreviewTargetKey, onHydrateContext, versionsOpen, walletVault?.unlocked]);

  const discoverHistoricalContext = async () => {
    if (discoveringHistory) return;
    if (!activeWalletAddress) {
      setDiscoverMessage("Link a wallet before finding wallet-owned PFT history.");
      return;
    }
    if (!history?.canHydrate) {
      setDiscoverMessage("Sign in before finding historical context.");
      return;
    }

    setDiscoveringHistory(true);
    setDiscoverMessage("");
    try {
      const result = await requestJson(rpcHistoryPath, { method: "POST" });
      setDiscoverMessage(result.body?.message || (result.ok ? "Historical context checked." : "Historical context could not be checked."));
      if (result.ok) {
        await onContextChange?.();
      }
    } catch (error) {
      setDiscoverMessage(error?.message || "Historical context could not be checked.");
    } finally {
      setDiscoveringHistory(false);
    }
  };

  const applyHydratedContext = useCallback(() => {
    if (!hydratedContext?.text) return;
    setTitle(hydratedContext.title || "Historical PFT Context");
    if (editorRef.current) editorRef.current.innerHTML = contextTextToHtml(hydratedContext.text);
    setHydratedContext(null);
    setHydrateMessage("Historical version loaded into the editor. It will autosave as the current context document.");
    setVersionsOpen(true);
    setSaveMessage("Historical version loaded");
    setDirty(true);
  }, [hydratedContext]);

  const closeHydratedPreview = useCallback(() => {
    setHydratedContext(null);
    setHydrateMessage("");
    setVersionsOpen(true);
  }, []);

  useEffect(() => {
    if (!hydratedContext?.text) return undefined;

    function handleHydratedPreviewKeyDown(event) {
      if (event.key === "Escape") closeHydratedPreview();
    }

    document.addEventListener("keydown", handleHydratedPreviewKeyDown);
    return () => document.removeEventListener("keydown", handleHydratedPreviewKeyDown);
  }, [closeHydratedPreview, hydratedContext?.text]);

  const copyEditorText = async () => {
    const text = editorRef.current?.innerText?.trim() || "";
    const composed = `${title}\n\n${text}`.trim();
    if (!composed) return;

    try {
      await navigator.clipboard?.writeText(composed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setSaveMessage("Copy failed.");
    }
  };

  const copyCid = async (cid) => {
    if (!cid) return;
    try {
      await navigator.clipboard?.writeText(cid);
      setCopiedCid(cid);
      window.setTimeout(() => setCopiedCid((current) => (current === cid ? "" : current)), 1600);
    } catch {
      setSaveMessage("CID copy failed.");
    }
  };

  const restoreVersion = async (version) => {
    if (restoringAnyVersion) return;
    if (version.type === "current") {
      setTitle(savedTitle);
      if (editorRef.current) editorRef.current.innerHTML = lastSavedHtmlRef.current;
      setDirty(false);
      setHydratedContext(null);
      setHydrateMessage("");
      setVersionsOpen(true);
      setSaveMessage("Restored current saved draft");
      return;
    }

    if (version.pointer) {
      await hydrateContextPointer(version.pointer, version.key);
    }
  };

  const publishContext = async () => {
    if (publishing) return;
    if (dirty) {
      const saved = await saveContext();
      if (!saved) return;
    }

    if (!manifestAction?.enabled) {
      setSaveMessage("Publishing is not enabled yet.");
      return;
    }

    setPublishing(true);
    try {
      const result = await requestJson(manifestAction.path, { method: manifestAction.method || "POST" });
      setSaveMessage(result.body?.message || (result.ok ? "Published" : "Publishing is unavailable."));
    } catch (error) {
      setSaveMessage(error?.message || "Publishing is unavailable.");
    } finally {
      setPublishing(false);
    }
  };

  const statusText = (() => {
    if (!canEdit) return "Sign in to save context";
    if (publishing) return "Publishing";
    if (saving) return "Saving";
    if (dirty) return "Editing";
    if (saveMessage) return saveMessage;
    return `Saved ${formatRelativeShort(documentState.updatedAt, now)}`;
  })();

  return (
    <div className="route-scroll">
      <div className="context-view context-wireframe">
        <section className="ctx-card" aria-label="Context document">
          <div className="ctx-toolbar" role="toolbar" aria-label="Formatting">
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.h2} disabled={!canEdit} onMouseDown={() => toggleHeading(2)} title="Heading">
                <Heading2 size={16} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.h3} disabled={!canEdit} onMouseDown={() => toggleHeading(3)} title="Subheading">
                <Heading3 size={16} strokeWidth={2} />
              </ContextToolButton>
            </div>
            <span className="ctx-toolbar-sep" />
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.bold} disabled={!canEdit} onMouseDown={() => exec("bold")} title="Bold">
                <Bold size={15} strokeWidth={2.2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.italic} disabled={!canEdit} onMouseDown={() => exec("italic")} title="Italic">
                <Italic size={15} strokeWidth={2.2} />
              </ContextToolButton>
            </div>
            <span className="ctx-toolbar-sep" />
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.ul} disabled={!canEdit} onMouseDown={() => exec("insertUnorderedList")} title="Bulleted list">
                <List size={15} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.ol} disabled={!canEdit} onMouseDown={() => exec("insertOrderedList")} title="Numbered list">
                <ListOrdered size={15} strokeWidth={2} />
              </ContextToolButton>
            </div>
            <span className="ctx-toolbar-sep" />
            <div className="ctx-toolbar-group ctx-table-wrap" ref={tableWrapRef}>
              <button
                aria-expanded={tablePickerOpen ? "true" : "false"}
                aria-haspopup="dialog"
                aria-label="Insert table"
                className={`ctx-tool-btn ctx-tool-combo${tablePickerOpen ? " is-active" : ""}`}
                disabled={!canEdit}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!canEdit) return;
                  if (!tablePickerOpen) saveSelection();
                  setTablePickerOpen((open) => !open);
                  setTableHover({ rows: 0, cols: 0 });
                }}
                title="Insert table"
                type="button"
              >
                <Table size={15} strokeWidth={2} />
                <ChevronDown size={12} strokeWidth={2} />
              </button>
              {tablePickerOpen && (
                <div className="ctx-table-picker" role="dialog" aria-label="Insert table">
                  <div className="ctx-table-grid" onMouseLeave={() => setTableHover({ rows: 0, cols: 0 })}>
                    {Array.from({ length: 8 }).map((_, rowIndex) => (
                      <div className="ctx-table-row" key={rowIndex}>
                        {Array.from({ length: 8 }).map((__, colIndex) => {
                          const active = rowIndex < tableHover.rows && colIndex < tableHover.cols;
                          return (
                            <button
                              aria-label={`Insert ${rowIndex + 1} by ${colIndex + 1} table`}
                              className={`ctx-table-cell${active ? " is-active" : ""}`}
                              key={colIndex}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                insertTable(rowIndex + 1, colIndex + 1);
                                setTablePickerOpen(false);
                              }}
                              onMouseEnter={() => setTableHover({ rows: rowIndex + 1, cols: colIndex + 1 })}
                              type="button"
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className="ctx-table-readout">
                    {tableHover.rows > 0 ? `${tableHover.rows} x ${tableHover.cols}` : "Insert table"}
                  </div>
                </div>
              )}
            </div>
            <div className="ctx-toolbar-spacer" />
            <button className="ctx-tool-text" onClick={copyEditorText} type="button">
              {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>

          <div className="ctx-writing-surface">
            <input
              aria-label="Document title"
              className="ctx-title-input"
              disabled={!canEdit}
              maxLength={120}
              onChange={(event) => {
                setTitle(event.target.value);
                setSaveMessage("");
              }}
              placeholder="Untitled context"
              value={title}
            />
            <div
              aria-disabled={!canEdit}
              aria-label="Context document body"
              aria-multiline="true"
              className="ctx-editor"
              contentEditable={canEdit}
              data-placeholder="Add stable preferences, active projects, constraints, and working notes."
              onClick={updateActiveFormats}
              onFocus={updateActiveFormats}
              onInput={handleEditorInput}
              onKeyDown={handleEditorKeyDown}
              onKeyUp={updateActiveFormats}
              onPaste={handleEditorPaste}
              ref={editorRef}
              role="textbox"
              spellCheck
              suppressContentEditableWarning
            />
          </div>

          <footer className="ctx-card-foot">
            <span className={`ctx-status${dirty ? " is-dirty" : ""}${saving || publishing ? " is-saving" : ""}`} role="status">
              <span className="ctx-status-dot" aria-hidden="true" />
              {statusText}
            </span>
            <div className="ctx-foot-actions">
              <button
                aria-expanded={versionsOpen ? "true" : "false"}
                className={`ctx-ghost${versionsOpen ? " is-active" : ""}`}
                onClick={() => setVersionsOpen((open) => !open)}
                type="button"
              >
                Versions
                <span className="ctx-ghost-count">{versions.length}</span>
              </button>
              <span className="ctx-tip">
                <button
                  className="ctx-ghost ctx-ghost-accent"
                  disabled={publishing}
                  onClick={publishContext}
                  type="button"
                >
                  <ArrowUp size={13} strokeWidth={2} />
                  {publishing ? "Publishing" : "Publish to PFT"}
                </button>
                <span className="ctx-tip-card" role="tooltip">
                  Portable publishing will write an immutable context pointer when manifest signing is enabled.
                </span>
              </span>
            </div>
          </footer>
        </section>

        {versionsOpen && (
          <section className="ctx-versions" aria-label="Context versions">
            <header className="ctx-versions-head">
              <div>
                <span className="ctx-versions-title">Revision history</span>
                <span className="ctx-versions-sub">{historySubtitle}</span>
              </div>
              <div className="ctx-versions-actions">
                {activeWalletAddress && historyPreviewTotal > 0 && (
                  <>
                    <span className={`ctx-vault-state is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                      {vaultDisplay.tone === "unlocked" ? <Unlock size={12} strokeWidth={2} /> : <Lock size={12} strokeWidth={2} />}
                      {vaultDisplay.label}
                    </span>
                    <span className={`ctx-preview-state${previewHydration.active ? " is-active" : ""}`}>
                      {previewHydration.active
                        ? `Loading previews ${previewHydration.loaded}/${previewHydration.total}`
                        : walletVault?.unlocked
                          ? `${previewedHistoryCount}/${historyPreviewTotal} previews`
                          : "Unlock for previews"}
                    </span>
                  </>
                )}
                {activeWalletAddress && (
                  <button
                    className="ctx-version-restore"
                    disabled={!canDiscoverHistory || discoveringHistory}
                    onClick={discoverHistoricalContext}
                    type="button"
                  >
                    {discoveringHistory ? "Finding" : "Find PFT history"}
                  </button>
                )}
                {!activeWalletAddress && (
                  <span className="ctx-preview-state">
                    Account context only
                  </span>
                )}
                <span className="ctx-versions-count">{versions.length} versions</span>
              </div>
            </header>
            {discoverMessage && <div className="ctx-discover-message">{discoverMessage}</div>}
            {previewHydration.error && !previewHydration.active && (
              <div className="ctx-discover-message">{previewHydration.error}</div>
            )}
            {hydrateMessage && !hydratedContext?.text && <div className="ctx-discover-message">{hydrateMessage}</div>}
            <ol className="ctx-versions-list">
              {versions.map((version, index) => {
                const isCidCopied = copiedCid === version.cid;
                const cachedPreview = version.cid ? hydratedPreviewByCid[version.cid] : null;
                const isPreviewing = Boolean(hydratedContext?.cid && version.cid && hydratedContext.cid === version.cid);
                const isRestoring = restoringVersionKey === version.key;
                const previewText =
                  cachedPreview?.text ||
                  (version.type === "pointer"
                    ? walletVault?.unlocked
                      ? "Encrypted historical context preview is loading."
                      : "Unlock the local seed vault to load this encrypted context preview."
                    : version.preview);
                const wordCount = cachedPreview?.text ? contextWordCount(cachedPreview.text) : version.words || 0;
                return (
                  <li className={`ctx-version${version.current ? " is-current" : ""}${isPreviewing ? " is-previewing" : ""}`} key={version.key}>
                    <div className="ctx-version-marker" aria-hidden="true">
                      <span className="ctx-version-dot" />
                      {index < versions.length - 1 && <span className="ctx-version-line" />}
                    </div>
                    <div className="ctx-version-body">
                      <div className="ctx-version-top">
                        <span className="ctx-version-rev">Rev {version.rev}</span>
                        <span className="ctx-version-meta">{formatContextTimestamp(version.at)}</span>
                        <span className="ctx-version-meta ctx-version-words">{wordCount} words</span>
                        <span className="ctx-version-spacer" />
                        {version.current ? (
                          <span className="ctx-version-current">
                            <span className="ctx-version-current-dot" aria-hidden="true" />
                            Current
                          </span>
                        ) : (
                          <button
                            aria-busy={isRestoring ? "true" : undefined}
                            className={`ctx-version-restore${isRestoring ? " is-restoring" : ""}${isPreviewing ? " is-selected" : ""}`}
                            disabled={restoringAnyVersion || isPreviewing}
                            onClick={() => restoreVersion(version)}
                            type="button"
                          >
                            {isRestoring ? "Loading preview" : isPreviewing ? "Previewing" : "Restore"}
                          </button>
                        )}
                      </div>
                      {previewText && <p className="ctx-version-preview">{previewText}</p>}
                      {version.cid && (
                        <div className="ctx-version-foot">
                          <code className="ctx-version-cid" title={version.cid}>
                            {truncateCid(version.cid)}
                          </code>
                          <button
                            aria-label={isCidCopied ? "Copied CID" : "Copy CID"}
                            className="ctx-version-copy"
                            onClick={() => copyCid(version.cid)}
                            title={isCidCopied ? "Copied" : "Copy CID"}
                            type="button"
                          >
                            {isCidCopied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {!canEdit && (
          <div className="context-note">
            Sign in to edit and save the native context document.
          </div>
        )}
      </div>

      {hydratedContext?.text && (
        <div
          className="ctx-restore-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeHydratedPreview();
          }}
          role="presentation"
        >
          <section
            aria-labelledby="ctx-restore-title"
            aria-modal="true"
            className="ctx-restore-dialog"
            role="dialog"
          >
            <header className="ctx-restore-head">
              <div className="ctx-restore-heading">
                <span>Historical context preview</span>
                <strong id="ctx-restore-title">{hydratedContext.title}</strong>
                {hydratedContext.cid && <code>{truncateCid(hydratedContext.cid)}</code>}
              </div>
              <div className="ctx-restore-actions">
                <button className="dark-pill" disabled={!canEdit} onClick={applyHydratedContext} type="button">
                  Use as draft
                </button>
                <button
                  aria-label="Close historical context preview"
                  className="icon-button"
                  onClick={closeHydratedPreview}
                  type="button"
                >
                  <X size={18} strokeWidth={1.8} />
                </button>
              </div>
            </header>
            <div className="ctx-restore-warning">
              <AlertTriangle size={15} strokeWidth={2} />
              <span>
                Use as draft replaces the editor contents with this historical version. The editor autosaves it as the current context document.
              </span>
            </div>
            {hydrateMessage && <div className="ctx-restore-state">{hydrateMessage}</div>}
            <pre className="ctx-restore-preview">{hydratedContext.text}</pre>
            <footer className="ctx-restore-foot">
              <span>{hydratedContext.decrypted ? "Decrypted locally from your unlocked vault." : "Fetched historical context."}</span>
              <button className="ctx-version-restore" onClick={closeHydratedPreview} type="button">
                Keep browsing versions
              </button>
            </footer>
          </section>
        </div>
      )}
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
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpState, setTopUpState] = useState({ status: "idle", data: null, message: "" });

  const loadLedger = useCallback(() => {
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

  useEffect(() => loadLedger(), [loadLedger]);

  async function openBillingTopUp() {
    setTopUpOpen(true);
    setTopUpState((current) => ({
      ...current,
      status: current.data?.depositAccount ? "ready" : "loading",
      message: "",
    }));

    try {
      const result = await requestJson("/api/usage/top-up/start", { method: "POST" });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.actionRequired || "Top-up is unavailable.");
      }
      setTopUpState({ status: "ready", data: result.body, message: result.body.message || "" });
    } catch (error) {
      setTopUpState({ status: "error", data: null, message: error?.message || "Top-up is unavailable." });
    }
  }

  async function refreshBillingTopUp() {
    setTopUpState((current) => ({ ...current, status: "syncing", message: "" }));

    try {
      const result = await requestJson("/api/usage/top-up/sync", { method: "POST" });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.actionRequired || "Deposit refresh failed.");
      }
      setTopUpState((current) => ({
        status: "ready",
        data: {
          ...(current.data || {}),
          ...result.body,
          depositAccount: result.body.depositAccount || current.data?.depositAccount,
        },
        message: result.body.message || "",
      }));
      loadLedger();
    } catch (error) {
      setTopUpState((current) => ({
        ...current,
        status: "ready",
        message: error?.message || "Deposit refresh failed.",
      }));
    }
  }

  const entries = ledger?.entries || [];

  return (
    <div className="billing-settings">
      <section>
        <div>
          <small>Account balance</small>
          <strong>{formatCreditUsd(ledger?.availableCreditUsd || 0)} <span>credit</span></strong>
          <p>{formatCreditUsd(ledger?.currentCreditUsd || 0)} credited - {formatUsageUsd(ledger?.currentSpendUsd || 0)} spent</p>
        </div>
        <button className="dark-pill" onClick={openBillingTopUp} type="button">Top up</button>
      </section>
      <div>
        <div className="billing-heading">
          <h3>Payment methods</h3>
          <button onClick={openBillingTopUp} type="button">Top up</button>
        </div>
        <p>Send ETH, USDT, or USDC to your account deposit address. No wallet connection or signature is required.</p>
        <div className="payment-methods">
          {PAYMENT_METHODS.map((method) => (
            <CryptoMethodRow key={method.k} method={method} onTopUp={openBillingTopUp} />
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
      {topUpOpen && (
        <EthereumTopUpModal
          onClose={() => setTopUpOpen(false)}
          onRefresh={refreshBillingTopUp}
          state={topUpState}
        />
      )}
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

function CryptoMethodRow({ method, onTopUp }) {
  return (
    <div className="crypto-method">
      <span style={{ background: method.accent }}>{method.letter}</span>
      <div>
        <strong>{method.name}</strong>
        <small>
          {method.chain}
        </small>
      </div>
      <button onClick={onTopUp} type="button">Use</button>
    </div>
  );
}

function TaskDetailModal({ onClose, task }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="task-modal-layer">
      <div
        className={`task-modal-wash${mounted ? " is-mounted" : ""}`}
        onClick={onClose}
        role="presentation"
      />
      <section
        className={`task-modal${mounted ? " is-mounted" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-title"
      >
        <header className="task-modal-header">
          <div className="task-modal-kicker">
            <Flag size={12} strokeWidth={1.75} />
            {task.kind}
          </div>
          <button className="task-modal-close" onClick={onClose} type="button">
            <X size={14} strokeWidth={1.75} />
            Close
          </button>
        </header>
        <div className="task-modal-body">
          <h2 id="task-title">{task.title}</h2>
          <a className="task-id-link">
            {task.fullId}
            <ExternalLink size={11} strokeWidth={1.75} />
          </a>
          <div className="task-modal-stats">
            <div>
              <small>Status</small>
              <span className="task-status-inline">
                <TaskStatusGlyph status={task.status} />
                <strong style={{ color: taskStatusColor(task.status) }}>{task.status}</strong>
              </span>
            </div>
            <div>
              <small>Deadline</small>
              <span>{task.fullDue}</span>
            </div>
            <div>
              <small>Reward</small>
              <span className="task-modal-reward">
                {task.pft.toLocaleString()}
                <em>PFT</em>
              </span>
            </div>
          </div>
          <div className="task-modal-divider" />
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
          <TaskSection last title="Verification">
            <strong>{task.verification.title}</strong>
            <p>{task.verification.body}</p>
          </TaskSection>
        </div>
        <footer className="task-modal-footer">
          <button className="danger-text" type="button">Cancel task</button>
          <div className="task-modal-actions">
            <button className="light-pill" type="button">Discuss</button>
            <button className="dark-pill" type="button">
              Submit evidence
              <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function TaskStatusGlyph({ status }) {
  if (status === "Refused") {
    return (
      <svg className="task-status-x" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
        <path d="M2 2 L9 9 M9 2 L2 9" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className={`task-status-glyph is-${String(status || "unknown").toLowerCase()}`} aria-hidden="true" />;
}

function taskStatusColor(status) {
  return {
    Proposed: "#7a5a1f",
    Accepted: "#4a5934",
    Refused: "#7c3c2e",
    Rewarded: "#6e5223",
  }[status] || "#3d3d38";
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

function sameLinkedWallet(current, address) {
  return current?.wallet?.pftWallet?.status === "linked" && current.wallet.pftWallet.address === address;
}

function markWalletBalanceChecking(current, address) {
  if (!sameLinkedWallet(current, address)) return current;

  return {
    ...current,
    wallet: {
      ...current.wallet,
      pftBalanceStatus: current.wallet.pftBalanceDrops == null ? "checking" : current.wallet.pftBalanceStatus,
      pftBalanceError: "",
    },
  };
}

function applyWalletBalanceResult(current, address, result) {
  if (!sameLinkedWallet(current, address)) return current;

  if (!result?.ok || !result.body?.ok) {
    return applyWalletBalanceError(
      current,
      address,
      result?.body?.message || result?.body?.error || "Balance read failed."
    );
  }

  return {
    ...current,
    wallet: {
      ...current.wallet,
      pftBalanceDrops: result.body.balanceDrops,
      pftBalanceStatus: "ready",
      pftBalanceSource: result.body.source || "",
      pftBalanceFetchedAt: result.body.fetchedAt || new Date().toISOString(),
      pftBalanceAccountExists: result.body.accountExists !== false,
      pftBalanceError: "",
    },
  };
}

function applyWalletBalanceError(current, address, message) {
  if (!sameLinkedWallet(current, address)) return current;

  return {
    ...current,
    wallet: {
      ...current.wallet,
      pftBalanceStatus: "error",
      pftBalanceError: message,
    },
  };
}

function formatPftBalance(wallet) {
  const drops = wallet?.pftBalanceDrops;
  if (drops === null || drops === undefined || drops === "") {
    if (wallet?.pftBalanceStatus === "error") return "Unavailable";
    if (wallet?.pftBalanceStatus === "checking") return "Checking";
    return "0";
  }

  return formatDrops(drops);
}

function walletBalanceStatusLabel(wallet) {
  if (wallet?.pftBalanceStatus === "checking") return "Checking balance";
  if (wallet?.pftBalanceStatus === "error") return "Balance unavailable";
  if (wallet?.pftBalanceStatus === "ready") return "";
  return "Balance unavailable";
}

function formatDrops(value) {
  const numeric = Number(value || 0) / 1_000_000;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric);
}

function formatWalletTransactionAmount(tx) {
  const drops = Number(tx?.amountDrops || 0);
  const pft = Math.abs(drops) / 1_000_000;
  const sign = tx?.type === "in" ? "+" : tx?.type === "out" ? "-" : "";
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 0,
    maximumFractionDigits: pft > 0 && pft < 0.01 ? 6 : 2,
  }).format(pft);
  return `${sign}${formatted}`;
}

function formatWalletTransactionTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatWalletTransactionGroup(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Unknown";

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfTxDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfTxDay) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function groupWalletTransactions(transactions = []) {
  const groups = [];
  const byLabel = new Map();
  for (const tx of transactions) {
    const group = formatWalletTransactionGroup(tx?.createdAt);
    if (!byLabel.has(group)) {
      const nextGroup = { group, items: [] };
      byLabel.set(group, nextGroup);
      groups.push(nextGroup);
    }
    byLabel.get(group).items.push(tx);
  }
  return groups;
}

function truncateWalletNote(value) {
  const text = String(value || "").trim();
  if (text.length <= 46) return text;
  return `${text.slice(0, 22)}...${text.slice(-12)}`;
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCreditUsd(value) {
  const numeric = Number(value || 0);
  const digits = Math.abs(numeric) < 10 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(numeric);
}

function formatUsageUsd(value) {
  const numeric = Number(value || 0);
  if (numeric > 0 && numeric < 0.01) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 6,
      maximumFractionDigits: 6,
    }).format(numeric);
  }
  return formatUsd(numeric);
}

createRoot(document.getElementById("root")).render(<App />);

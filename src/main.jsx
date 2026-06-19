import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  AlertTriangle,
  Activity,
  BookOpen,
  Bold,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  CreditCard,
  Database,
  ExternalLink,
  FileText,
  Flag,
  Github,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  LifeBuoy,
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
  Pencil,
  Plus,
  Search,
  Send,
  Settings as SettingsIcon,
  Share,
  Shield,
  SquarePen,
  Store,
  Table,
  Trash2,
  Trophy,
  Unlock,
  User as UserIcon,
  Wand2,
  Wallet,
  X,
} from "lucide-react";
import { fetchAppState, fetchRuntimeConfig, requestEventStream, requestJson } from "./api";
import {
  byteSize,
  createPastedTextAttachment,
  formatFileSize,
  mimeTypeFromFilename,
  promptForAttachments,
  readFileAsDataUrl,
  textFromAttachment,
} from "./chat-attachments";
import {
  AgentMessage,
  AssistantMessage,
  AttachmentTray,
  copyText,
  UserMessage,
} from "./features/chat/ChatMessages.jsx";
import {
  appendAssistantDelta,
  chatTitleFromPrompt,
  createErrorAssistantTurn,
  createPendingAssistantTurn,
  createRecentPlaceholderThread,
  createUserTurn,
  formatElapsedSeconds,
  newClientConversationId,
  newClientCorrelationId,
  normalizeChatMessage,
  normalizeChatMessages,
  replaceTurnById,
  titleFromTurns,
  transcriptTextFromThread,
} from "./features/chat/chat-turns";
import { plainTextFromBlocks } from "./features/chat/chat-markdown";
import { chatSurfaceDisplayState, loginProviderDisplayState } from "./features/chat/chat-ui-state.js";
import { BillingSettings } from "./features/billing/BillingSettings";
import { IdentityHandleDialog, IdentitySettings } from "./features/identity/IdentityControls.jsx";
import {
  applyContextEditProposal,
  CONTEXT_EDIT_MODE,
  CONTEXT_EDIT_PLACEHOLDER,
  patchContextEditProposalTurn,
  rejectContextEditProposal,
} from "./features/context/context-edit-client";
import { publishContextToPft } from "./features/context/context-publish";
import {
  ContextToolButton,
  contextWordCount,
  stripContextHtml,
  truncateCid,
} from "./features/context/context-view-utils.jsx";
import { PostFiatLogo, SidebarButton, ToolMenuRow } from "./features/shell/ShellControls";
import { NetworkTaskEligibilityPanel } from "./features/tasks/NetworkTaskEligibilityPanel.jsx";
import { TaskDetailModal } from "./features/tasks/TaskDetailModal.jsx";
import { TaskRequestModal } from "./features/tasks/TaskRequestModal.jsx";
import { TaskRequestQueue } from "./features/tasks/TaskRequestQueue.jsx";
import { TaskRow } from "./features/tasks/TaskRow.jsx";
import {
  settledTaskRequestHasVisibleOutstanding,
  shouldRevealSettledOutstandingTask,
  shouldStartTaskRequestSettle,
  taskRequestSettleDeadline,
} from "./features/tasks/task-refresh-policy.js";
import {
  appendTaskActionReceipt,
  loadTaskActionReceipts,
  saveTaskActionReceipts,
} from "./features/tasks/task-action-receipts.js";
import {
  findTaskById,
  mergeTaskStateWithActionReceipts,
  reconcileTaskVisibleState,
} from "./features/tasks/task-visible-state.js";
import { mergeAppStateWithMonotonicTasks } from "./features/tasks/task-app-state-refresh.js";
import { publishTaskRequest } from "./features/tasks/task-request-actions.js";
import { evaluateTaskRequestUnlockPolicy } from "./features/tasks/task-request-unlock-policy.js";
import {
  applyWalletBalanceError,
  applyWalletBalanceResult,
  formatPftBalance,
  markWalletBalanceChecking,
  mergeAppStateWithClientWalletBalance,
  walletVaultDisplayState,
} from "./features/wallet/wallet-state";
import {
  clearAllUnlockedWalletSessions,
  clearOtherUnlockedWalletSessions,
  clearUnlockedWalletSession,
  readUnlockedWalletSession,
  saveUnlockedWalletSession,
  touchWalletUnlockActivity,
  walletUnlockIdleLockMs,
  walletUnlockIdleRemainingMs,
} from "./features/wallet/wallet-unlocked-session.js";
import { WalletUnlockModal } from "./features/wallet/WalletUnlockModal";
import { ChatSearchModal } from "./features/chat/ChatSearchModal";
import { formatCreditUsd, formatUsageUsd } from "./formatters";
import { isSignedInSession } from "./session";
import { escapeContextHtml, looksLikeContextHtml, sanitizeContextHtml } from "../shared/context-html";
import { contextBodyText, contextLineCount as countContextLines } from "../shared/context-line-map.js";
import { CONTEXT_DOCUMENT_MAX_CHARS, contextBudgetMetrics, TASKGEN_CONTEXT_MAX_CHARS } from "../shared/context-budget.js";
import "./styles.css";
import "./features/context/context.css";

const WalletView = lazy(() => import("./features/wallet/WalletView").then((module) => ({ default: module.WalletView })));
const MemoryView = lazy(() => import("./features/memory/MemoryView").then((module) => ({ default: module.MemoryView })));
const DocsView = lazy(() => import("./features/docs/DocsView").then((module) => ({ default: module.DocsView })));
const HiveView = lazy(() => import("./features/hive/HiveView").then((module) => ({ default: module.HiveView })));
const ProfilePage = lazy(() => import("./features/profile/ProfileView").then((module) => ({ default: module.ProfileView })));
const MemberProfilePage = lazy(() => import("./features/profile/ProfileView").then((module) => ({ default: module.MemberProfileView })));
const DirectoryView = lazy(() => import("./features/directory/DirectoryView").then((module) => ({ default: module.DirectoryView })));

const fallbackConfig = window.__TASKNODE_CONFIG__ || {};
const CHAT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_ATTACHMENT_MAX_COUNT = 4;
const CHAT_PASTE_ATTACHMENT_THRESHOLD = 200;
const CHAT_COMPOSER_MAX_HEIGHT = 220;
const CHAT_SCROLL_BOTTOM_THRESHOLD = 96;
const TASK_REQUEST_CANONICAL_TEXT =
  "Request a task using my current context document, account memory, recent messages, and the additional task details I just provided.";
const TASK_REQUEST_PLACEHOLDER = "Add any relevant details for your task request";
const HIVE_CHAT_PLACEHOLDER = "Talk to Hive Chat";
const HIVE_CHAT_TITLE = "Hive Chat";
const CHAT_STARTER_PROMPTS = [
  "Help me build my context document",
  "Give me my first task",
  "How do I earn PFT?",
  "What should I do first?",
];
const SIGNED_OUT_HELP_HISTORY_LIMIT = 10;
const SIGNED_OUT_HELP_HISTORY_CHARS = 4000;
const HIVE_CHAT_NOTIFICATION_REFRESH_MS = 20000;
const ROUTE_CHUNK_RELOAD_COOLDOWN_MS = 30_000;
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
const serializeChatAttachments = (items = []) =>
  items.map(({ name, mimeType, size, source, dataUrl }) => ({ name, mimeType, size, source, dataUrl }));

function textFromVisibleTurn(turn = {}) {
  if (turn.role === "user") return String(turn.text || "").trim();
  if (turn.role === "assistant") {
    return String(turn.text || plainTextFromBlocks(turn.blocks || []) || "").trim();
  }
  return "";
}

function clientHistoryPayloadFromTurns(turns = []) {
  return (turns || [])
    .filter((turn) => !turn.pending && !turn.error && (turn.role === "user" || turn.role === "assistant"))
    .map((turn) => {
      const body = textFromVisibleTurn(turn).slice(0, SIGNED_OUT_HELP_HISTORY_CHARS).trim();
      if (!body) return null;
      return { role: turn.role, body };
    })
    .filter(Boolean)
    .slice(-SIGNED_OUT_HELP_HISTORY_LIMIT);
}

function routeLoadErrorText(error) {
  return `${error?.name || ""} ${error?.message || error || ""}`.toLowerCase();
}

function isRouteChunkLoadError(error) {
  const text = routeLoadErrorText(error);
  return (
    text.includes("chunkloaderror") ||
    text.includes("failed to fetch dynamically imported module") ||
    text.includes("error loading dynamically imported module") ||
    text.includes("importing a module script failed") ||
    text.includes("loading chunk")
  );
}

function shouldReloadForRouteChunkError() {
  if (typeof window === "undefined") return false;
  try {
    const key = "tasknode_route_chunk_reload_at";
    const lastReloadAt = Number(window.sessionStorage?.getItem(key) || 0);
    const now = Date.now();
    if (Number.isFinite(lastReloadAt) && now - lastReloadAt < ROUTE_CHUNK_RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage?.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

class RouteErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (isRouteChunkLoadError(error) && shouldReloadForRouteChunkError()) {
      window.location.reload();
      return;
    }
    console.error("Task Node route render failed", error, info);
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return <RouteErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

function RouteErrorFallback({ error }) {
  const staleChunk = isRouteChunkLoadError(error);
  return (
    <div className="route-error-panel">
      <StatusBanner tone="error">
        {staleChunk
          ? "This page needs the latest Task Node bundle. Refresh the app and try the page again."
          : "This page hit a client error instead of rendering."}
      </StatusBanner>
      <button className="route-error-action" onClick={() => window.location.reload()} type="button">
        Refresh app
      </button>
    </div>
  );
}

function profileNftImageCandidates(nft = {}) {
  const record = nft || {};
  const candidates = [record.imageDataUrl];
  if (record.imageCid) {
    candidates.push(`/api/profile/nft/image/${encodeURIComponent(record.imageCid)}`);
  } else {
    candidates.push(record.imageGatewayUrl);
  }
  return candidates
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

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

const EMPTY_TASKS = {
  outstanding: [],
  verification: [],
  refused: [],
  rewarded: [],
  sync: { status: "loading", projectionCount: 0 },
};

function recordClientObservabilityEvent(payload = {}) {
  requestJson("/api/user-observability/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

const SETTINGS_PAGES = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "security", label: "Security", icon: Shield },
  { key: "data", label: "Data controls", icon: Database },
  { key: "billing", label: "Billing", icon: CreditCard },
];

const APP_VIEWS = new Set(["chat", "tasks", "wallet", "context", "hive", "directory", "profile", "memory", "docs"]);
const EMPTY_WALLET_VAULT_STATUS = {
  available: false,
  unlocked: false,
  accountId: null,
  address: null,
  publicKey: null,
  lastUnlockedAt: null,
  persistence: "unknown",
};
const WALLET_BALANCE_REFRESH_MS = 1000;
const WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS = 0;
const WALLET_ACTIVITY_EVENT_NAME = "tasknode:wallet-activity";
const TASK_ACTION_RECEIPTS_STORAGE_KEY = "tasknode_task_action_receipts";
const AUTH_SESSION_HINT_STORAGE_KEY = "tasknode_auth_session_hint";
const AUTH_SESSION_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function viewFromLocation() {
  if (typeof window === "undefined") return "chat";
  const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
  const hashView = hashPath.split("?")[0].split("/")[0].toLowerCase();
  return APP_VIEWS.has(hashView) ? hashView : "chat";
}

function readAuthSessionHint(storage) {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(AUTH_SESSION_HINT_STORAGE_KEY) || "null");
    const updatedAtMs = Date.parse(parsed?.updatedAt || "");
    if (!parsed?.accountId || !Number.isFinite(updatedAtMs)) return null;
    if (Date.now() - updatedAtMs > AUTH_SESSION_HINT_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAuthSessionHint(storage, session = null) {
  if (!storage || !isSignedInSession(session)) return;
  try {
    storage.setItem(
      AUTH_SESSION_HINT_STORAGE_KEY,
      JSON.stringify({
        accountId: session.accountId || "",
        displayName: session.displayName || "",
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    // Session hint only prevents signed-out flicker; auth still comes from the HttpOnly cookie.
  }
}

function clearAuthSessionHint(storage) {
  if (!storage) return;
  try {
    storage.removeItem(AUTH_SESSION_HINT_STORAGE_KEY);
  } catch {
    // Ignore blocked storage.
  }
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchAppStateWithSessionRetry(options = {}) {
  const state = await fetchAppState(options);
  if (isSignedInSession(state?.session) || typeof window === "undefined") return state;
  const hint = readAuthSessionHint(window.sessionStorage);
  if (!hint) return state;

  await delay(350);
  const retry = await fetchAppState(options);
  if (isSignedInSession(retry?.session)) return retry;
  clearAuthSessionHint(window.sessionStorage);
  return retry;
}

function taskIdFromLocation() {
  if (typeof window === "undefined") return "";
  const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
  const [pathPart, queryPart = ""] = hashPath.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  if ((parts[0] || "").toLowerCase() !== "tasks") return "";
  const queryTaskId = new URLSearchParams(queryPart).get("taskId") || "";
  const rawTaskId = queryTaskId || parts.slice(1).join("/");
  try {
    return decodeURIComponent(rawTaskId);
  } catch {
    return rawTaskId;
  }
}

function memberProfileAccountIdFromLocation(hashValue = null) {
  if (typeof window === "undefined" && hashValue === null) return "";
  const rawHash = hashValue === null ? window.location.hash : hashValue;
  const hashPath = String(rawHash || "").replace(/^#\/?/, "").trim();
  const [pathPart, queryPart = ""] = hashPath.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  if ((parts[0] || "").toLowerCase() !== "profile") return "";
  const rawAccountId = new URLSearchParams(queryPart).get("account") || "";
  try {
    return decodeURIComponent(rawAccountId).trim();
  } catch {
    return rawAccountId.trim();
  }
}

function writeViewLocation(nextView, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
  const url = new URL(window.location.href);
  if (normalizedView === "chat") {
    url.hash = "";
  } else if (normalizedView === "docs") {
    const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
    url.hash = hashPath.toLowerCase().startsWith("docs/") ? hashPath : "docs";
  } else {
    url.hash = normalizedView;
  }

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (currentPath === nextPath) return;

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ tasknodeView: normalizedView }, "", nextPath);
}

function writeTaskLocation(taskId, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return;
  const url = new URL(window.location.href);
  url.hash = `tasks/${encodeURIComponent(normalizedTaskId)}`;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (currentPath === nextPath) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ tasknodeView: "tasks", taskId: normalizedTaskId }, "", nextPath);
}

function taskSelectionFingerprint(task = {}) {
  return [
    task?.taskId || task?.fullId || task?.id || "",
    task?.statusKey || task?.status || "",
    task?.updatedAt || "",
    task?.lastEventAt || "",
    task?.txHash || "",
    task?.metadata?.eventCount || "",
  ].join("|");
}

function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
}

function initialSidebarOpen() {
  return !isMobileViewport();
}

function App() {
  const [view, setView] = useState(() => viewFromLocation());
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [loginOpen, setLoginOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [logoutConfirming, setLogoutConfirming] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [identityPromptDismissed, setIdentityPromptDismissed] = useState(false);
  const [profileAuthMessage, setProfileAuthMessage] = useState("");
  const [profilePendingProvider, setProfilePendingProvider] = useState("");
  const [theme, setTheme] = useState("auto");
  const [profileTab, setProfileTab] = useState("private");
  const [profilePublic, setProfilePublic] = useState(true);
  const [locationHash, setLocationHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  const [selectedTask, setSelectedTask] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [chatResetKey, setChatResetKey] = useState(0);
  const [chatSelectionKey, setChatSelectionKey] = useState(0);
  const [chatShareRequestKey, setChatShareRequestKey] = useState(0);
  const [contextRefinePending, setContextRefinePending] = useState(false);
  const [chatActionMenu, setChatActionMenu] = useState(null);
  const [chatRenameTarget, setChatRenameTarget] = useState(null);
  const [chatDeleteTarget, setChatDeleteTarget] = useState(null);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [walletUnlockOpen, setWalletUnlockOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState(fallbackConfig);
  const [appState, setAppState] = useState(null);
  const [taskActionReceipts, setTaskActionReceipts] = useState(() =>
    loadTaskActionReceipts(typeof window === "undefined" ? null : window.sessionStorage, TASK_ACTION_RECEIPTS_STORAGE_KEY)
  );
  const [profileAvatarNft, setProfileAvatarNft] = useState(null);
  const [walletVaultStatus, setWalletVaultStatus] = useState(EMPTY_WALLET_VAULT_STATUS);
  const [loadError, setLoadError] = useState("");
  const profileRef = useRef(null);
  const moreRef = useRef(null);
  const chatActionRef = useRef(null);
  const walletSecretRef = useRef(null);
  const taskRefreshSequenceRef = useRef({ applied: 0, started: 0 });

  useEffect(() => {
    let active = true;

    Promise.all([fetchRuntimeConfig(), fetchAppStateWithSessionRetry()])
      .then(([config, state]) => {
        if (!active) return;
        setRuntimeConfig(config);
        applyFetchedAppState(state);
      })
      .catch((error) => {
        if (active) setLoadError(error?.message || "Failed to load app state");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (view !== "tasks") return undefined;

    refreshAppState({ errorMessage: "Failed to load task state", taskProjectionRefresh: true })
      .then(() => null)
      .catch(() => null);

    return undefined;
  }, [view]);

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
    if (!profileMenuOpen) setLogoutConfirming(false);
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!settingsOpen && !selectedTask && !chatActionMenu && !walletUnlockOpen) return undefined;

    function closeModal(event) {
      if (event.key === "Escape") {
        if (walletUnlockOpen) {
          setWalletUnlockOpen(false);
          return;
        }
        setChatActionMenu(null);
        setSettingsOpen(false);
        setSelectedTask(null);
      }
    }

    document.addEventListener("keydown", closeModal);
    return () => document.removeEventListener("keydown", closeModal);
  }, [settingsOpen, selectedTask, chatActionMenu, walletUnlockOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const query = window.matchMedia("(max-width: 760px)");
    const syncSidebarForViewport = (event = query) => {
      setSidebarOpen(!event.matches);
      setMoreMenuOpen(false);
      setProfileMenuOpen(false);
      setChatActionMenu(null);
    };

    syncSidebarForViewport(query);
    query.addEventListener("change", syncSidebarForViewport);
    return () => query.removeEventListener("change", syncSidebarForViewport);
  }, []);

  const recentChats = buildRecentChats(appState?.chat?.recents || []);
  const activeChatId = activeChat?.conversationId || activeChat?.id || "";
  const hiveUnreadCount = hiveUnreadCountFromAppState(appState);
  const pftBalance = formatPftBalance(appState?.wallet);
  const chatCredit = formatCreditUsd(appState?.usage?.availableCreditUsd || 0);
  const appStateLoading = !appState && !loadError;
  const canRenderWorkspaceContent = Boolean(appState);
  const session = appState?.session;
  const signedIn = canRenderWorkspaceContent && isSignedInSession(session);
  const profileName = appStateLoading ? "Checking session" : profileDisplayName(session);
  const profileInitials = appStateLoading ? "TN" : profileAvatarText(session);
  const profileAvatarImages = profileNftImageCandidates(profileAvatarNft);
  const profileSubtext = appStateLoading ? "Loading account" : profileSessionText(session);
  const walletAccountId = signedIn ? session?.accountId || "" : "";
  const linkedWallet =
    signedIn && appState?.wallet?.pftWallet?.status === "linked"
      ? appState.wallet.pftWallet
      : null;
  const linkedWalletAddress = linkedWallet?.address || "";
  const memberProfileAccountId = view === "profile" ? memberProfileAccountIdFromLocation(locationHash) : "";
  const taskVisibleState = useMemo(() => reconcileTaskVisibleState({
    accountId: walletAccountId,
    linkedWalletAddress,
    receipts: taskActionReceipts,
    tasks: appState?.tasks || EMPTY_TASKS,
  }), [appState?.tasks, linkedWalletAddress, taskActionReceipts, walletAccountId]);
  const visibleTasks = taskVisibleState.tasks;
  const selectedTaskId = selectedTask?.taskId || selectedTask?.fullId || selectedTask?.id || "";
  const selectedVisibleTask = selectedTaskId ? findTaskById(visibleTasks, selectedTaskId) : null;
  const selectedTaskForModal = selectedVisibleTask || selectedTask;
  const walletVaultAvailable = Boolean(walletVaultStatus?.available && walletVaultStatus?.address === linkedWalletAddress);
  const walletVaultUnlocked = Boolean(walletVaultAvailable && walletVaultStatus?.unlocked);
  const vaultDisplay = walletVaultDisplayState(walletVaultStatus, linkedWalletAddress);
  const identityHandleRequired = signedIn && session?.identityProfile?.handleRequired === true;
  const telegramProvider = accountLinkProvider(session, "telegram");
  const linkedTelegramProvider = linkedProviderById(session, "telegram");

  useEffect(() => {
    if (view !== "tasks") return;
    const taskId = taskIdFromLocation();
    if (!taskId) return;
    const task = findTaskById(visibleTasks, taskId);
    if (task) {
      setSelectedTask((current) => (
        taskSelectionFingerprint(current) === taskSelectionFingerprint(task) ? current : task
      ));
    }
  }, [view, visibleTasks]);

  useEffect(() => {
    if (!appState?.tasks) return;
    setTaskActionReceipts((current) => {
      const pruned = reconcileTaskVisibleState({
        accountId: walletAccountId,
        linkedWalletAddress,
        receipts: current,
        tasks: appState.tasks,
      }).prunedReceipts;
      if (pruned.length === current.length) return current;
      saveTaskActionReceipts(
        typeof window === "undefined" ? null : window.sessionStorage,
        pruned,
        TASK_ACTION_RECEIPTS_STORAGE_KEY
      );
      return pruned;
    });
  }, [appState?.tasks, linkedWalletAddress, walletAccountId]);

  useEffect(() => {
    setIdentityPromptDismissed(false);
  }, [session?.accountId]);

  const lockWalletVault = useCallback(() => {
    walletSecretRef.current = null;
    clearAllUnlockedWalletSessions();
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
        // Any persisted unlock entry that does not belong to the current
        // account is stale by definition; sweep them on every refresh so a
        // prior account's session can never linger after an account switch.
        clearOtherUnlockedWalletSessions({ keepAccountId: effectiveAccountId });
        if (!preserveUnlock) clearUnlockedWalletSession({ accountId: effectiveAccountId });
        const walletCore = await import("./wallet-core");
        const nextStatus = typeof walletCore.localWalletVaultStatusAsync === "function"
          ? await walletCore.localWalletVaultStatusAsync({ accountId: effectiveAccountId })
          : walletCore.localWalletVaultStatus({ accountId: effectiveAccountId });
        const persistence = typeof walletCore.walletVaultPersistence === "function"
          ? await walletCore.walletVaultPersistence()
          : nextStatus?.persistence || "unknown";
        const nextStatusWithPersistence = {
          ...nextStatus,
          persistence: nextStatus?.persistence && nextStatus.persistence !== "unknown" ? nextStatus.persistence : persistence,
        };
        const currentSecret = walletSecretRef.current;
        const canRestoreUnlock = Boolean(preserveUnlock && nextStatusWithPersistence?.available && nextStatusWithPersistence?.address);
        const inMemorySecretMatches =
          canRestoreUnlock &&
          currentSecret?.accountId === effectiveAccountId &&
          currentSecret?.address === nextStatusWithPersistence.address &&
          currentSecret?.mnemonic;
        const sessionSecret = inMemorySecretMatches
          ? null
          : canRestoreUnlock
            ? await readUnlockedWalletSession({
              accountId: effectiveAccountId,
              expectedAddress: nextStatusWithPersistence.address,
            })
            : null;
        const activeSecret = inMemorySecretMatches ? currentSecret : sessionSecret;

        if (activeSecret) {
          walletSecretRef.current = activeSecret;
        } else {
          walletSecretRef.current = null;
          clearUnlockedWalletSession({ accountId: effectiveAccountId });
        }

        setWalletVaultStatus((current) => ({
          ...nextStatusWithPersistence,
          unlocked: Boolean(activeSecret),
          lastUnlockedAt: activeSecret ? activeSecret.unlockedAt || current.lastUnlockedAt : null,
        }));
        return nextStatusWithPersistence;
      } catch {
        walletSecretRef.current = null;
        clearUnlockedWalletSession({ accountId: effectiveAccountId });
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
      void saveUnlockedWalletSession(walletSecretRef.current);
      touchWalletUnlockActivity();
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

  useEffect(() => {
    if (!walletVaultStatus?.unlocked) return undefined;
    const idleLockMs = walletUnlockIdleLockMs();
    let lastTouchMs = 0;
    const onActivity = () => {
      const nowMs = Date.now();
      if (nowMs - lastTouchMs < 5000) return;
      lastTouchMs = nowMs;
      touchWalletUnlockActivity();
    };
    const lockIfIdle = () => {
      const remaining = walletUnlockIdleRemainingMs({ idleLockMs });
      if (remaining !== null && remaining <= 0) lockWalletVault();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") lockIfIdle();
    };
    const activityEvents = ["pointerdown", "keydown", "wheel", "touchstart"];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", onVisibilityChange);
    onActivity();
    const interval = window.setInterval(lockIfIdle, 30_000);
    return () => {
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, onActivity));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [walletVaultStatus?.unlocked, lockWalletVault]);

  const hydrateContextPointer = useCallback(
    async (pointer) => {
      const secret = walletSecretRef.current;
      if (!walletAccountId || !secret?.mnemonic || secret.accountId !== walletAccountId) {
        const error = new Error("Unlock the local seed vault first.");
        error.code = "wallet_vault_locked";
        throw error;
      }
      const cid = String(pointer?.cid || "").trim();
      if (!cid) {
        const error = new Error("No context CID is selected.");
        error.code = "context_cid_missing";
        throw error;
      }

      const fetched = await requestJson(`/api/context/history/ipfs/${encodeURIComponent(cid)}`);
      if (!fetched.ok || !fetched.body?.payload) {
        const error = new Error(fetched.body?.message || "Context CID could not be fetched.");
        error.code = fetched.body?.error || "context_cid_fetch_failed";
        throw error;
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

  async function publishContextPointer({
    title = "Task Node Context",
    body = "",
    revision = 0,
    wordCount = 0,
    path = "/api/context/manifest/ink",
  } = {}) {
    return publishContextToPft({
      accountId: walletAccountId,
      linkedWalletAddress,
      walletSecret: walletSecretRef.current,
      path,
      context: { title, body, revision, wordCount },
      onPublished: refreshAppState,
    });
  }

  const navigateToView = useCallback((nextView, options = {}) => {
    const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
    setView(normalizedView);
    setChatActionMenu(null);
    setMoreMenuOpen(false);
    setProfileMenuOpen(false);
    setSettingsOpen(false);
    setSelectedTask(null);
    setLoginOpen(false);
    setWalletUnlockOpen(false);
    if (isMobileViewport()) {
      setSidebarOpen(false);
    }
    writeViewLocation(normalizedView, { replace: options.replace === true });
    if (typeof window !== "undefined") setLocationHash(window.location.hash);
  }, []);

  const openTaskDetail = useCallback((task) => {
    const taskId = task?.taskId || task?.fullId || task?.id || "";
    setSelectedTask(task);
    setView("tasks");
    if (taskId) writeTaskLocation(taskId);
  }, []);

  const closeTaskDetail = useCallback(() => {
    setSelectedTask(null);
    if (view === "tasks" && taskIdFromLocation()) {
      writeViewLocation("tasks", { replace: true });
    }
    if (view === "tasks") {
      void refreshAppState({ taskProjectionRefresh: true });
    }
  }, [view]);

  const openWalletVaultControl = useCallback(() => {
    setProfileMenuOpen(false);
    setMoreMenuOpen(false);
    if (!signedIn) {
      setLoginOpen(true);
      return;
    }
    if (!linkedWalletAddress) {
      navigateToView("wallet");
      return;
    }
    if (walletVaultUnlocked) {
      navigateToView("wallet");
      return;
    }
    if (walletVaultAvailable) {
      setWalletUnlockOpen(true);
      return;
    }
    navigateToView("wallet");
  }, [
    linkedWalletAddress,
    navigateToView,
    signedIn,
    walletVaultAvailable,
    walletVaultUnlocked,
  ]);

  const openWalletSummary = useCallback(() => {
    if (walletVaultAvailable && !walletVaultUnlocked) {
      openWalletVaultControl();
      return;
    }
    navigateToView("wallet");
  }, [navigateToView, openWalletVaultControl, walletVaultAvailable, walletVaultUnlocked]);

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

  const openContextRefine = useCallback(() => {
    setMoreMenuOpen(false);
    if (!signedIn) {
      setLoginOpen(true);
      return;
    }
    setContextRefinePending(true);
    navigateToView("chat");
  }, [navigateToView, signedIn]);

  useEffect(() => {
    const initialTaskId = taskIdFromLocation();
    if (initialTaskId) {
      writeTaskLocation(initialTaskId, { replace: true });
    } else {
      writeViewLocation(viewFromLocation(), { replace: true });
    }
    setLocationHash(window.location.hash);

    function syncViewFromLocation() {
      setLocationHash(window.location.hash);
      setView(viewFromLocation());
      setMoreMenuOpen(false);
      setProfileMenuOpen(false);
      setSettingsOpen(false);
      setSelectedTask(null);
      setLoginOpen(false);
      setWalletUnlockOpen(false);
      setChatSearchOpen(false);
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

  const refreshWalletBalance = useCallback(
    async ({ force = false, address = linkedWalletAddress } = {}) => {
      if (!signedIn || !address) return null;
      setAppState((current) => markWalletBalanceChecking(current, address));

      try {
        const result = await requestJson(`/api/wallet/balance${force ? "?force=1" : ""}`);
        setAppState((current) => applyWalletBalanceResult(current, address, result));
        return result;
      } catch (error) {
        setAppState((current) =>
          applyWalletBalanceError(current, address, error?.message || "Balance read failed.")
        );
        return null;
      }
    },
    [linkedWalletAddress, signedIn]
  );

  useEffect(() => {
    if (!signedIn || !linkedWalletAddress) return undefined;

    refreshWalletBalance({ force: true, address: linkedWalletAddress });
    const timer = window.setInterval(
      () => refreshWalletBalance({ force: true, address: linkedWalletAddress }),
      WALLET_BALANCE_REFRESH_MS
    );

    return () => {
      window.clearInterval(timer);
    };
  }, [signedIn, linkedWalletAddress, refreshWalletBalance]);

  useEffect(() => {
    if (!signedIn || !linkedWalletAddress || typeof window === "undefined" || !window.EventSource) {
      return undefined;
    }

    const events = new window.EventSource("/api/events");
    let refreshTimer = null;

    function scheduleWalletRefresh(payload = {}) {
      const walletAddress = String(payload.walletAddress || "").trim();
      if (walletAddress && walletAddress !== linkedWalletAddress) return;
      window.dispatchEvent(new CustomEvent(WALLET_ACTIVITY_EVENT_NAME, { detail: payload }));
      window.clearTimeout(refreshTimer);
      if (WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS <= 0) {
        refreshWalletBalance({ force: true, address: linkedWalletAddress });
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshWalletBalance({ force: true, address: linkedWalletAddress });
      }, WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS);
    }

    function handleWalletActivity(event) {
      try {
        scheduleWalletRefresh(JSON.parse(event.data || "{}"));
      } catch {
        scheduleWalletRefresh({});
      }
    }

    events.addEventListener("wallet_activity", handleWalletActivity);
    return () => {
      window.clearTimeout(refreshTimer);
      events.removeEventListener("wallet_activity", handleWalletActivity);
      events.close();
    };
  }, [signedIn, linkedWalletAddress, refreshWalletBalance]);

  useEffect(() => {
    if (!signedIn || !session?.accountId) return undefined;
    let active = true;
    const hiveChatOpen = view === "chat" && activeChat?.kind === "hive";

    async function refreshHiveNotificationState() {
      try {
        const result = await requestJson("/api/hive/chat", {
          method: hiveChatOpen ? "PATCH" : "GET",
        });
        if (!active || !result.ok || !result.body?.ok) return;
        setAppState((current) =>
          mergeHiveConversationIntoAppState(current, result.body.conversation)
        );
      } catch {
        // Hive notifications are non-blocking; app-state will surface hard failures.
      }
    }

    refreshHiveNotificationState();
    const timer = window.setInterval(refreshHiveNotificationState, HIVE_CHAT_NOTIFICATION_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeChat?.kind, activeChatId, session?.accountId, signedIn, view]);

  useEffect(() => {
    let active = true;
    if (!signedIn || !walletAccountId) {
      setProfileAvatarNft(null);
      return () => {
        active = false;
      };
    }

    requestJson("/api/profile/public")
      .then((result) => {
        if (!active) return;
        if (result.ok && result.body?.ok) {
          setProfileAvatarNft(result.body.profile?.heroNft || null);
        }
      })
      .catch(() => {
        if (active) setProfileAvatarNft(null);
      });

    return () => {
      active = false;
    };
  }, [signedIn, walletAccountId]);

  async function refreshAppState({
    allowSignedOutSession = false,
    errorMessage = "Failed to load app state",
    taskProjectionRefresh = false,
  } = {}) {
    const taskRefreshSequence = taskProjectionRefresh
      ? taskRefreshSequenceRef.current.started + 1
      : 0;
    if (taskProjectionRefresh) {
      taskRefreshSequenceRef.current.started = taskRefreshSequence;
    }

    try {
      const state = await fetchAppStateWithSessionRetry({ taskProjectionRefresh });
      if (
        !allowSignedOutSession &&
        isSignedInSession(appState?.session) &&
        !isSignedInSession(state?.session)
      ) {
        setLoadError("");
        return appState;
      }
      if (
        taskProjectionRefresh &&
        taskRefreshSequence < taskRefreshSequenceRef.current.applied
      ) {
        return state;
      }
      applyFetchedAppState(state);
      if (taskProjectionRefresh) {
        taskRefreshSequenceRef.current.applied = Math.max(
          taskRefreshSequenceRef.current.applied,
          taskRefreshSequence
        );
      }
      const nextAccountId = isSignedInSession(state?.session) ? state.session.accountId || "" : "";
      await refreshWalletVaultStatus({ preserveUnlock: true, accountId: nextAccountId });
      setLoadError("");
      return state;
    } catch (error) {
      setLoadError(error?.message || errorMessage);
      return null;
    }
  }

  function applyFetchedAppState(state) {
    const storage = typeof window === "undefined" ? null : window.sessionStorage;
    if (isSignedInSession(state?.session)) {
      writeAuthSessionHint(storage, state.session);
    }
    setAppState((current) =>
      mergeAppStateWithMonotonicTasks(current, state, {
        mergeBase: mergeAppStateWithClientWalletBalance,
      })
    );
  }

  const recordTaskActionReceipt = useCallback((receipt) => {
    if (!receipt?.taskId || !receipt?.expectedStatusKey) return;
    // A duplicate receipt returns the same array reference; skip both state
    // updates and the session-storage write so observed-receipt emissions from
    // task detail polling cannot re-render the app at network round-trip rate.
    if (appendTaskActionReceipt(taskActionReceipts, receipt) === taskActionReceipts) return;
    setTaskActionReceipts((current) => {
      const next = appendTaskActionReceipt(current, receipt);
      if (next === current) return current;
      saveTaskActionReceipts(
        typeof window === "undefined" ? null : window.sessionStorage,
        next,
        TASK_ACTION_RECEIPTS_STORAGE_KEY
      );
      return next;
    });
    setAppState((current) => {
      if (!current?.tasks) return current;
      return {
        ...current,
        tasks: mergeTaskStateWithActionReceipts(current.tasks, [receipt], {
          accountId: receipt.accountId || walletAccountId,
          walletAddress: receipt.walletAddress || linkedWalletAddress,
        }),
      };
    });
  }, [linkedWalletAddress, taskActionReceipts, walletAccountId]);

  async function logOut() {
    lockWalletVault();
    await requestJson("/api/auth/logout", { method: "POST" });
    clearAuthSessionHint(typeof window === "undefined" ? null : window.sessionStorage);
    await refreshAppState({ allowSignedOutSession: true });
    setProfileMenuOpen(false);
  }

  async function startTelegramLinkFromProfileMenu() {
    if (!signedIn) {
      setLoginOpen(true);
      setProfileMenuOpen(false);
      return;
    }

    if (linkedTelegramProvider) {
      setProfileAuthMessage("Telegram is linked. Open Telegram and message the Task Node bot.");
      return;
    }

    if (!telegramProvider?.enabled) {
      setProfileAuthMessage(
        telegramProvider?.actionRequired ||
          telegramProvider?.message ||
          "Telegram linking is not available in this environment."
      );
      return;
    }

    setProfilePendingProvider("telegram");
    setProfileAuthMessage("");

    try {
      const result = await requestJson(`${telegramProvider.startPath}?redirect=/`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setProfileAuthMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `Telegram returned HTTP ${result.status}.`
      );
    } catch (error) {
      setProfileAuthMessage(error?.message || "Telegram linking is unavailable.");
    } finally {
      setProfilePendingProvider("");
    }
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
    <main className={`app-shell view-${view} ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      {sidebarOpen && (
        <button
          aria-label="Close navigation"
          className="mobile-sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      )}
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
              <>
                <PanelLeft className="desktop-sidebar-toggle-icon" size={18} strokeWidth={1.75} />
                <X className="mobile-sidebar-close-icon" size={20} strokeWidth={1.9} />
              </>
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
          <SidebarButton
            icon={Search}
            label="Search chats"
            onClick={() => setChatSearchOpen(true)}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "tasks"}
            badge={appState?.tasks?.outstanding?.length}
            icon={ListTodo}
            label="Tasks"
            onClick={() => navigateToView("tasks")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "hive"}
            badge={hiveUnreadCount > 0 ? formatUnreadCount(hiveUnreadCount) : undefined}
            icon={Activity}
            label="Hive"
            onClick={() => navigateToView("hive")}
            sidebarOpen={sidebarOpen}
            trailing={sidebarOpen ? <small className="nav-live-state">live</small> : null}
          />
          <SidebarButton
            active={view === "wallet"}
            icon={Wallet}
            label="Wallet"
            onClick={openWalletSummary}
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
                <ToolMenuRow icon={Wand2} label="Context Refine" onClick={openContextRefine} />
                <div className="menu-divider" />
                <ToolMenuRow
                  icon={MessageSquare}
                  label="Memory"
                  onClick={() => navigateToView("memory")}
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
                const rowClassName = [
                  "recent-chat-row",
                  activeChatId === itemId ? "active" : "",
                  item.kind === "hive" ? "is-hive" : "",
                  item.unread ? "has-unread" : "",
                ].filter(Boolean).join(" ");
                return (
                  <div
                    className={rowClassName}
                    key={item.id}
                  >
                    <button
                      className="recent-chat-open"
                      onClick={() => openRecentChat(item)}
                      title={item.title}
                      type="button"
                    >
                      {item.kind === "hive" && <Network size={13} strokeWidth={1.8} />}
                      <span>{item.title}</span>
                      {item.unread && (
                        <small
                          aria-label={`${item.unreadCount || 1} unread Hive message${(item.unreadCount || 1) === 1 ? "" : "s"}`}
                          className="recent-chat-unread-badge"
                        >
                          {formatUnreadCount(item.unreadCount || 1)}
                        </small>
                      )}
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
            <button className="balance-pill" onClick={openWalletSummary} type="button">
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
                disabled={appStateLoading}
                onClick={() => {
                  if (appStateLoading) return;
                  setProfileMenuOpen((open) => !open);
                }}
                type="button"
              >
                <ProfileAvatar imageCandidates={profileAvatarImages} initials={profileInitials} signedIn={signedIn} />
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
                    <ProfileAvatar imageCandidates={profileAvatarImages} initials={profileInitials} signedIn={signedIn} />
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
                  {signedIn && linkedWalletAddress && (
                    <ToolMenuRow
                      icon={vaultDisplay.tone === "unlocked" ? Unlock : Lock}
                      label={`Wallet ${vaultDisplay.label}`}
                      onClick={openWalletVaultControl}
                      trailing={<ChevronRight size={14} strokeWidth={1.75} />}
                    />
                  )}
                  <div className="menu-divider" />
                  {signedIn ? (
                    <>
                      <ToolMenuRow
                        icon={Network}
                        label="Directory"
                        onClick={() => {
                          navigateToView("directory");
                          setProfileMenuOpen(false);
                        }}
                        trailing={<ChevronRight size={14} strokeWidth={1.75} />}
                      />
                      <TelegramProfileMenuRow
                        linkedProvider={linkedTelegramProvider}
                        onClick={startTelegramLinkFromProfileMenu}
                        pending={profilePendingProvider === "telegram"}
                        provider={telegramProvider}
                        signedIn={signedIn}
                      />
                      {profileAuthMessage && <div className="profile-menu-message">{profileAuthMessage}</div>}
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
                      <ToolMenuRow icon={LifeBuoy} label="Help" onClick={() => navigateToView("docs")} trailing={<ChevronRight size={14} />} />
                      <div className="menu-divider" />
                      {logoutConfirming ? (
                        <div className="profile-menu-logout-confirm">
                          <span>Log out? Your wallet vault will lock.</span>
                          <div>
                            <button className="pill-button" onClick={() => setLogoutConfirming(false)} type="button">
                              Cancel
                            </button>
                            <button className="pill-button dark" onClick={logOut} type="button">
                              Log out
                            </button>
                          </div>
                        </div>
                      ) : (
                        <ToolMenuRow icon={LogOut} label="Log out" onClick={() => setLogoutConfirming(true)} />
                      )}
                    </>
                  ) : (
                    <>
                      <ToolMenuRow
                        icon={Store}
                        label="Log in or sign up"
                        onClick={() => {
                          setLoginOpen(true);
                          setProfileMenuOpen(false);
                        }}
                        trailing={<ChevronRight size={14} />}
                      />
                      <ToolMenuRow icon={LifeBuoy} label="Help" onClick={() => navigateToView("docs")} trailing={<ChevronRight size={14} />} />
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button topbar-new-chat" onClick={startNewChat} title="New chat" type="button">
              <SquarePen size={18} strokeWidth={1.75} />
            </button>
            <button
              className="mobile-brand-button"
              onClick={() => {
                setSidebarOpen(true);
                setMoreMenuOpen(false);
                setProfileMenuOpen(false);
                setChatActionMenu(null);
              }}
              type="button"
            >
              <PostFiatLogo />
              <span>Task Node</span>
            </button>
          </div>
          {view === "chat" && activeChat && (
            <div className="thread-actions">
              <button aria-label="Share chat" onClick={() => setChatShareRequestKey((key) => key + 1)} title="Share" type="button">
                <Share size={14} strokeWidth={1.75} />
                <span>Share</span>
              </button>
            </div>
          )}
          {signedIn && view !== "chat" && (
            <button className="mobile-topbar-action" onClick={startNewChat} title="New chat" type="button">
              <Pencil size={22} strokeWidth={1.75} />
            </button>
          )}
        </header>

        {loadError && <StatusBanner tone="error">{loadError}</StatusBanner>}
        {appStateLoading && <StatusBanner>Loading product state</StatusBanner>}

        {canRenderWorkspaceContent && (
        <RouteErrorBoundary resetKey={view}>
          {view === "chat" && (
            <ChatSurface
              accountId={walletAccountId}
              activeChat={activeChat}
              chatResetKey={chatResetKey}
              chatSelectionKey={chatSelectionKey}
              chatShareRequestKey={chatShareRequestKey}
              chat={appState?.chat}
              contextRefinePending={contextRefinePending}
              linkedWalletAddress={linkedWalletAddress}
              onActiveChatChange={setActiveChat}
              onChatSettled={refreshAppState}
              onContextRefineHandled={() => setContextRefinePending(false)}
              onWalletUnlock={openWalletVaultControl}
              usage={appState?.usage}
              walletSecret={walletSecretRef.current}
              walletUnlockPending={walletUnlockOpen}
              walletVault={walletVaultStatus}
            />
          )}
          {view === "tasks" && (
            <TasksView
              accountId={walletAccountId}
              linkedWalletAddress={linkedWalletAddress}
              onRequestSettled={refreshAppState}
              onSelectTask={openTaskDetail}
              onWalletUnlock={openWalletVaultControl}
              tasks={visibleTasks}
              walletSecret={walletSecretRef.current}
              walletUnlockPending={walletUnlockOpen}
              walletVault={walletVaultStatus}
            />
          )}
          {view === "hive" && (
            <Suspense fallback={<StatusBanner>Loading hive</StatusBanner>}>
              <HiveView />
            </Suspense>
          )}
          {view === "directory" && (
            <Suspense fallback={<StatusBanner>Loading directory</StatusBanner>}>
              <DirectoryView />
            </Suspense>
          )}
          {view === "wallet" && (
            <Suspense fallback={<StatusBanner>Loading wallet</StatusBanner>}>
              <WalletView
                onAppStateChange={refreshAppState}
                onWalletBalanceRefresh={() => refreshWalletBalance({ force: true })}
                onLoginRequired={() => setLoginOpen(true)}
                onWalletVaultChange={() => refreshWalletVaultStatus({ preserveUnlock: true })}
                onWalletVaultLock={lockWalletVault}
                onWalletVaultUnlocked={handleWalletVaultUnlocked}
                session={appState?.session}
                wallet={appState?.wallet}
                walletSecret={walletSecretRef.current}
                walletVault={walletVaultStatus}
                usage={appState?.usage}
              />
            </Suspense>
          )}
          {view === "context" && (
            <ContextView
              context={appState?.context}
              linkedWalletAddress={linkedWalletAddress}
              onContextChange={refreshAppState}
              onHydrateContext={hydrateContextPointer}
              onPublishContext={publishContextPointer}
              walletVault={walletVaultStatus}
            />
          )}
          {view === "profile" && memberProfileAccountId && (
            <Suspense fallback={<StatusBanner>Loading profile</StatusBanner>}>
              <MemberProfilePage
                accountId={memberProfileAccountId}
                onBack={() => navigateToView("directory")}
              />
            </Suspense>
          )}
          {view === "profile" && !memberProfileAccountId && (
            <Suspense fallback={<StatusBanner>Loading profile</StatusBanner>}>
              <ProfilePage
                accountId={walletAccountId}
                linkedWalletAddress={linkedWalletAddress}
                onProfileAvatarChange={setProfileAvatarNft}
                onProfileIdentityChange={refreshAppState}
                onWalletUnlock={openWalletVaultControl}
                pftlExplorerUrl={runtimeConfig?.pftlExplorerUrl || ""}
                profilePublic={profilePublic}
                profileTab={profileTab}
                session={appState?.session}
                setProfilePublic={setProfilePublic}
                setProfileTab={setProfileTab}
                walletSecret={walletSecretRef.current}
                walletVault={walletVaultStatus}
              />
            </Suspense>
          )}
          {view === "memory" && (
            <Suspense fallback={<StatusBanner>Loading memory</StatusBanner>}>
              <MemoryView session={appState?.session} />
            </Suspense>
          )}
          {view === "docs" && (
            <Suspense fallback={<StatusBanner>Loading docs</StatusBanner>}>
              <DocsView />
            </Suspense>
          )}
        </RouteErrorBoundary>
        )}
      </section>

      {loginOpen && (
        <LoginDialog
          authLoading={appStateLoading}
          onSessionChange={refreshAppState}
          session={session}
          onClose={() => setLoginOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          chat={appState?.chat}
          onAppStateChange={refreshAppState}
          onClose={() => setSettingsOpen(false)}
          session={session}
          setTheme={setTheme}
          theme={theme}
        />
      )}
      {identityHandleRequired && !identityPromptDismissed && !loginOpen && (
        <IdentityHandleDialog
          onClose={() => setIdentityPromptDismissed(true)}
          onSaved={refreshAppState}
          session={session}
        />
      )}
      {selectedTaskForModal && (
        <TaskDetailModal
          accountId={walletAccountId}
          escapeDisabled={walletUnlockOpen}
          linkedWalletAddress={linkedWalletAddress}
          onClose={closeTaskDetail}
          onTaskActionReceipt={recordTaskActionReceipt}
          onTaskChanged={refreshAppState}
          onWalletUnlock={openWalletVaultControl}
          task={selectedTaskForModal}
          walletSecret={walletSecretRef.current}
          walletUnlockPending={walletUnlockOpen}
          walletVault={walletVaultStatus}
        />
      )}
      {chatSearchOpen && (
        <ChatSearchModal
          onClose={() => setChatSearchOpen(false)}
          onOpenChat={(item) => {
            setChatSearchOpen(false);
            openRecentChat(item);
          }}
          recentChats={recentChats}
          signedIn={signedIn}
        />
      )}
      {walletUnlockOpen && linkedWallet && (
        <WalletUnlockModal
          linkedWallet={linkedWallet}
          onClose={() => setWalletUnlockOpen(false)}
          onWalletVaultChange={() => refreshWalletVaultStatus({ preserveUnlock: false })}
          onWalletVaultUnlocked={handleWalletVaultUnlocked}
          session={session}
        />
      )}
      {chatActionMenu && sidebarOpen && (
        <ChatItemActionMenu
          chat={chatActionMenu}
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

function ChatSurface({
  accountId = "", activeChat, chat, chatResetKey, chatSelectionKey, chatShareRequestKey,
  contextRefinePending = false, linkedWalletAddress = "", onActiveChatChange, onChatSettled,
  onContextRefineHandled, onWalletUnlock, usage,
  walletSecret = null, walletUnlockPending = false, walletVault = {},
}) {
  const signedOut = !accountId;
  const allModes = chat?.modes || [];
  const modes = signedOut ? allModes.filter((mode) => mode.label === "Help") : allModes;
  const messages = chat?.seedMessages || [];
  const defaultMode = signedOut
    ? modes.find((mode) => mode.label === "Help" && mode.enabled)?.label || "Help"
    : chat?.defaultMode || "Private Instant";
  const isHiveChat = activeChat?.kind === "hive";
  const [turns, setTurns] = useState(() => normalizeChatMessages(messages));
  const [selectedMode, setSelectedMode] = useState(defaultMode);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [taskRequestMode, setTaskRequestMode] = useState(false);
  const [contextEditMode, setContextEditMode] = useState(false);
  const [contextEditSavingId, setContextEditSavingId] = useState("");
  const [input, setInput] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [actualUsage, setActualUsage] = useState(null);
  const [statusTone, setStatusTone] = useState("muted");
  const [sending, setSending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [draftConversationId, setDraftConversationId] = useState(() => newClientConversationId());
  const [editingMsg, setEditingMsg] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const taskRequestUnlockPolicy = evaluateTaskRequestUnlockPolicy({
    accountId,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const walletReady = taskRequestUnlockPolicy.allowed;
  const plusRef = useRef(null);
  const modelRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerDragDepthRef = useRef(0);
  const messageListRef = useRef(null);
  const resetSeenRef = useRef(0);
  const shareSeenRef = useRef(chatShareRequestKey);
  const clearedChatRef = useRef(false);
  const scrollNearBottomRef = useRef(true);
  const updateScrollBottomVisibility = useCallback(() => {
    const list = messageListRef.current;
    if (!list) {
      setShowScrollBottom(false);
      scrollNearBottomRef.current = true;
      return;
    }
    const overflow = list.scrollHeight - list.clientHeight > CHAT_SCROLL_BOTTOM_THRESHOLD;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = !overflow || distanceFromBottom <= CHAT_SCROLL_BOTTOM_THRESHOLD;
    scrollNearBottomRef.current = nearBottom;
    setShowScrollBottom(overflow && !nearBottom);
  }, []);
  const loadConversationHistory = useCallback(async (
    conversationId,
    { showLoading = true, shouldApply = () => true } = {}
  ) => {
    const normalizedConversationId = String(conversationId || "").trim();
    if (!normalizedConversationId) return [];
    const historyPath = chat?.historyPath || "/api/chat/history";
    if (showLoading && shouldApply()) {
      setTurns([]);
      setHistoryLoading(true);
    }
    try {
      const result = await requestJson(`${historyPath}?conversationId=${encodeURIComponent(normalizedConversationId)}`);
      if (!shouldApply()) return [];
      if (!result.ok) {
        throw new Error(result.body?.message || `History returned HTTP ${result.status}.`);
      }
      const hydrated = normalizeChatMessages(result.body?.messages || []);
      setTurns(hydrated);
      if (showLoading) setHistoryLoading(false);
      return hydrated;
    } catch (error) {
      if (showLoading && shouldApply()) setHistoryLoading(false);
      throw error;
    }
  }, [chat?.historyPath]);

  useEffect(() => {
    setSelectedMode(defaultMode);
  }, [defaultMode]);

  useEffect(() => {
    if (!signedOut) return;
    setTaskRequestMode(false);
    setContextEditMode(false);
    setSelectedMode("Help");
    setPlusMenuOpen(false);
    setHistoryLoading(false);
  }, [signedOut]);

  useEffect(() => {
    if (clearedChatRef.current) return;
    if (activeChat?.source === "mock" || activeChat?.source === "server" || activeChat?.source === "live") return;
    setHistoryLoading(false);
    setTurns(normalizeChatMessages(messages));
  }, [activeChat?.source, messages]);

  useEffect(() => {
    if (chatResetKey === 0 || resetSeenRef.current === chatResetKey) return;
    resetSeenRef.current = chatResetKey;
    clearedChatRef.current = true;
    setTurns([]);
    setInput("");
    setAttachments([]);
    setTaskRequestMode(false);
    setContextEditMode(false);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setHistoryLoading(false);
    setDraftConversationId(newClientConversationId());
    setEditingMsg(null);
    setShareOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [chatResetKey]);

  useEffect(() => {
    if (!activeChat || activeChat.source === "live") {
      setHistoryLoading(false);
      return undefined;
    }
    clearedChatRef.current = false;
    setTaskRequestMode(false);
    setContextEditMode(false);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");

    if (activeChat.source !== "server") {
      setHistoryLoading(false);
      setTurns(createRecentPlaceholderThread(activeChat.title));
      return undefined;
    }

    const conversationId = activeChat.conversationId || activeChat.id;
    let cancelled = false;

    loadConversationHistory(conversationId, { shouldApply: () => !cancelled })
      .then(() => {
        if (cancelled) return;
      })
      .catch((error) => {
        if (cancelled) return;
        setStatusTone("error");
        setSendMessage(error?.message || "Could not load this conversation.");
        setHistoryLoading(false);
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
  }, [activeChat, chatSelectionKey, loadConversationHistory]);

  useEffect(() => {
    if (shareSeenRef.current === chatShareRequestKey) return;
    shareSeenRef.current = chatShareRequestKey;
    if (turns.length > 0) setShareOpen(true);
  }, [chatShareRequestKey, turns.length]);

  useEffect(() => {
    if (!contextRefinePending) return;
    onContextRefineHandled?.();
    if (signedOut) return;
    setTaskRequestMode(false);
    setContextEditMode(true);
    setSendMessage("");
    setStatusTone("muted");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [contextRefinePending, onContextRefineHandled, signedOut]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, CHAT_COMPOSER_MAX_HEIGHT)}px`;
  }, [input]);

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
    const frame = window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (!list) {
        setShowScrollBottom(false);
        return;
      }
      if (scrollNearBottomRef.current) {
        list.scrollTo({
          top: list.scrollHeight,
          behavior: "auto",
        });
        setShowScrollBottom(false);
        return;
      }
      updateScrollBottomVisibility();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [turns, input, sending, updateScrollBottomVisibility]);

  async function submitMessage(event) {
    event.preventDefault();
    if (sending) return;
    const message = input.trim();
    if (!message && attachments.length === 0) return;

    clearedChatRef.current = false;
    const startedAt = Date.now();
    const requestedConversationId = activeChat?.conversationId || activeChat?.id || draftConversationId;
    const isTaskRequest = taskRequestMode;
    const isContextEdit = contextEditMode && !isTaskRequest;
    const isHiveContext = isHiveChat && !isTaskRequest && !isContextEdit;
    const requestId = isTaskRequest ? newClientCorrelationId("req") : "";
    const bundleId = isTaskRequest ? newClientCorrelationId("bundle") : "";
    const taskRequestMessageId = requestId ? `msg_${requestId}_request_user`.slice(0, 180) : "";
    const taskRequestAssistantId = requestId ? `msg_${requestId}_request_assistant`.slice(0, 180) : "";
    const hiveContextMessageId = isHiveContext ? `msg_${newClientCorrelationId("hive")}_user`.slice(0, 180) : "";
    const hiveContextAssistantId = isHiveContext ? `${hiveContextMessageId}_assistant`.slice(0, 180) : "";
    const pendingId = taskRequestAssistantId || hiveContextAssistantId || `assistant-pending-${startedAt}`;
    const submittedAttachments = attachments;
    const fallbackPrompt = promptForAttachments(submittedAttachments);
    const submittedText = message || fallbackPrompt;
    const taskRequestMetadata = isTaskRequest
      ? {
          schema: "pf.task.request_intent.v1",
          kind: "task_request_intent",
          requestId,
          bundleId,
          conversationId: requestedConversationId,
          taskRequestMessageId,
          requestText: TASK_REQUEST_CANONICAL_TEXT,
          userDetailText: submittedText,
          requestedTaskKind: "personal",
          source: "user_chat",
          sourceConversationTitle: activeChat?.title || titleFromTurns(turns) || "New chat",
          status: "intent_pending",
        }
      : undefined;
    const contextEditMetadata = isContextEdit ? { kind: CONTEXT_EDIT_MODE } : undefined;
    const hiveContextMetadata = isHiveContext
      ? {
          kind: "hive_context_entry",
          source: "hive_chat",
          conversationId: requestedConversationId,
          sourceConversationTitle: HIVE_CHAT_TITLE,
      }
      : undefined;
    const turnMetadata = taskRequestMetadata || contextEditMetadata || hiveContextMetadata;

    if (isTaskRequest && !walletReady) {
      if (["unlock", "open_wallet"].includes(taskRequestUnlockPolicy.action)) onWalletUnlock?.();
      setSendMessage(taskRequestUnlockPolicy.message);
      setStatusTone("error");
      return;
    }

    setSending(true);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setInput("");
    setAttachments([]);
    const submittedUserTurn = createUserTurn(
        submittedText,
        taskRequestMessageId || hiveContextMessageId || `user-local-${startedAt}`,
        submittedAttachments,
        turnMetadata
      );
    setTurns((current) => (
      [...current, submittedUserTurn, createPendingAssistantTurn(pendingId, startedAt, turnMetadata)]
    ));
    if (!activeChat) {
      onActiveChatChange?.({
        id: requestedConversationId,
        conversationId: requestedConversationId,
        source: "live",
        kind: isHiveContext ? "hive" : undefined,
        title: isTaskRequest ? "Task request" : isHiveContext ? HIVE_CHAT_TITLE : chatTitleFromPrompt(message),
      });
    }

    try {
      if (isTaskRequest) {
        const result = await publishTaskRequest({
          accountId,
          linkedWalletAddress,
          walletSecret,
          requestId,
          bundleId,
          conversationId: requestedConversationId,
          userDetailText: submittedText,
          requestedTaskKind: "personal",
          source: "user_chat",
          sourceConversationTitle: activeChat?.title || titleFromTurns(turns) || "New chat",
          attachments: serializeChatAttachments(submittedAttachments),
          onProgress: (label) => {
            setSendMessage(label);
            setStatusTone("muted");
          },
        });

        const receipt = `Task request published to PFT. Transaction ${String(result.txHash || "").slice(0, 12)}...`;
        const assistantTurn = normalizeChatMessage(
          {
            id: taskRequestAssistantId,
            role: "assistant",
            body: receipt,
            metadata: {
              ...taskRequestMetadata,
              status: "pftl_request_published",
              requestEventCid: result.cid,
              requestBundleCid: result.bundleCid,
              txHash: result.txHash,
            },
          },
          pendingId
        );
        setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        setTaskRequestMode(false);
        setSendMessage("Task request published to PFT.");
        setStatusTone("muted");
        setDraftConversationId(requestedConversationId);
        onActiveChatChange?.({
          id: requestedConversationId,
          conversationId: requestedConversationId,
          source: "live",
          title: activeChat?.title || "Task request",
        });
        await onChatSettled?.({ taskProjectionRefresh: true });
        return;
      }

      if (isHiveContext) {
        const result = await requestJson("/api/hive/context", {
          method: "POST",
          headers: { "content-type": "application/json" },
            body: JSON.stringify({
              body: submittedText,
              conversationId: requestedConversationId,
              conversationTitle: HIVE_CHAT_TITLE,
              attachments: serializeChatAttachments(submittedAttachments),
              userMessageId: hiveContextMessageId,
              assistantMessageId: hiveContextAssistantId,
          }),
        });

        if (!result.ok || !result.body?.entry) {
          throw new Error(result.body?.message || `Hive Context returned HTTP ${result.status}.`);
        }

        if (result.body.user) {
          const userTurn = normalizeChatMessage(result.body.user, 0);
          if (userTurn) {
            setTurns((current) => replaceTurnById(current, hiveContextMessageId, userTurn));
          }
        }

        if (result.body.assistant) {
          const assistantTurn = normalizeChatMessage(result.body.assistant, pendingId);
          setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        } else {
          setTurns((current) => replaceTurnById(
            current,
            pendingId,
            {
              id: `hive-status-${result.body.entry.id || startedAt}`,
              role: "assistant",
              metadata: { kind: "hive_context_status", hiveContextEntryId: result.body.entry.id },
              blocks: [
                {
                  type: "p",
                  inline: [{ text: result.body.message || "Saved to Hive Context. Hive may respond here if useful." }],
                },
              ],
            }
          ));
        }
        setSendMessage("");
        setStatusTone("muted");
        const settledConversationId = result.body?.user?.conversationId || requestedConversationId;
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          kind: "hive",
          title: HIVE_CHAT_TITLE,
        });
        if (result.body.assistant) {
          await loadConversationHistory(settledConversationId, { showLoading: false }).catch(() => null);
        }
        await onChatSettled?.();
        return;
      }

      const chatPayload = {
        message: submittedText,
        mode: isContextEdit ? "Frontier Thinking" : signedOut ? "Help" : selectedMode,
        contextMode: isContextEdit ? CONTEXT_EDIT_MODE : undefined,
        conversationId: requestedConversationId,
        attachments: serializeChatAttachments(submittedAttachments),
        clientHistory: signedOut && !isContextEdit ? clientHistoryPayloadFromTurns(turns) : undefined,
      };
      const result = usage?.chatStreamPath && !isContextEdit
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
            thinking: {
              state: "finished",
              duration: formatElapsedSeconds(Date.now() - startedAt),
              ...(result.body.assistant.metadata?.thinking || {}),
              ...(result.body.assistant.thinking || {}),
            },
          },
          pendingId
        );
        setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        setSendMessage(result.body.message || (isContextEdit ? "Context edit response generated." : "Chat response generated."));
        setStatusTone("muted");
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          title: activeChat?.title || chatTitleFromPrompt(submittedText),
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
      if (isTaskRequest || isContextEdit || isHiveContext) {
        setInput(message);
        setAttachments(submittedAttachments);
      }
      setSendMessage(failureMessage);
      setStatusTone("error");
    } finally {
      setSending(false);
    }
  }

  async function attachFiles(fileList, { source = "upload" } = {}) {
    const files = Array.from(fileList || []);
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
          source,
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

  async function handleAttachmentSelection(event) {
    await attachFiles(event.target.files, { source: "upload" });
    event.target.value = "";
  }

  function dataTransferHasFiles(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    if (types.includes("Files")) return true;
    return Array.from(dataTransfer?.items || []).some((item) => item.kind === "file");
  }

  function handleComposerDragEnter(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDragActive(true);
  }

  function handleComposerDragOver(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  }

  function handleComposerDragLeave(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDragActive(false);
  }

  async function handleComposerDrop(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
    await attachFiles(event.dataTransfer.files, { source: "drag_drop" });
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function handleComposerPaste(event) {
    const pasted = event.clipboardData?.getData("text/plain") || "";
    if (pasted.length <= CHAT_PASTE_ATTACHMENT_THRESHOLD) return;

    const pastedSize = byteSize(pasted);
    if (pastedSize > CHAT_ATTACHMENT_MAX_BYTES || attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) return;

    event.preventDefault();
    const attachment = createPastedTextAttachment(pasted, pastedSize);
    setAttachments((current) => [...current, attachment].slice(0, CHAT_ATTACHMENT_MAX_COUNT));
    setSendMessage("");
    setStatusTone("muted");
  }

  function showAttachmentInTextField(attachment) {
    const text = textFromAttachment(attachment);
    if (!text) return;
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    setInput((current) => (current ? `${current}\n${text}` : text));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function handleContextEditApply(proposal) {
    if (!proposal?.id || contextEditSavingId) return;
    setContextEditSavingId(proposal.id);
    try {
      const result = await applyContextEditProposal(proposal.id);
      if (result.ok && result.body?.proposal) {
        setTurns((current) => patchContextEditProposalTurn(current, proposal.id, result.body.proposal));
        setSendMessage(result.body.message || "Context updated.");
        setStatusTone("muted");
        await onChatSettled?.();
      } else {
        throw new Error(result.body?.message || "Context edit could not be applied.");
      }
    } catch (error) {
      const errorText = error?.message || "Context edit could not be applied.";
      setTurns((current) => patchContextEditProposalTurn(current, proposal.id, { error: errorText }));
      setSendMessage(errorText);
      setStatusTone("error");
    } finally {
      setContextEditSavingId("");
    }
  }

  async function handleContextEditReject(proposal) {
    if (!proposal?.id || contextEditSavingId) return;
    setContextEditSavingId(proposal.id);
    try {
      const result = await rejectContextEditProposal(proposal.id);
      if (!result.ok || !result.body?.proposal) {
        throw new Error(result.body?.message || "Context edit could not be rejected.");
      }
      setTurns((current) => patchContextEditProposalTurn(current, proposal.id, result.body.proposal));
      setSendMessage("Context edit rejected.");
      setStatusTone("muted");
    } catch (error) {
      setSendMessage(error?.message || "Context edit could not be rejected.");
      setStatusTone("error");
    } finally {
      setContextEditSavingId("");
    }
  }

  function handleContextEditRevise(proposal) {
    setContextEditMode(true);
    setInput(`Revise this context edit: ${proposal?.rationale || ""}`.trim());
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  const composerStatus = chatComposerStatus({
    actualUsage,
    message: sendMessage,
    sending,
    tone: statusTone,
    turns,
  });
  const showComposerStatus =
    composerStatus &&
    !(isHiveChat && composerStatus.text === "Task Node can make mistakes. Check important info.");

  const chatTitle = activeChat?.title || titleFromTurns(turns);
  const displayState = chatSurfaceDisplayState({ activeChat, turns, historyLoading });
  const hasPromptInput = input.trim().length > 0 || attachments.length > 0;
  const composerExpanded = input.length > 0;
  const composerPlaceholder = taskRequestMode
    ? TASK_REQUEST_PLACEHOLDER
    : contextEditMode
      ? CONTEXT_EDIT_PLACEHOLDER
      : isHiveChat
        ? HIVE_CHAT_PLACEHOLDER
        : "Ask anything";
  const composerClassName = [
    "composer",
    composerDragActive ? "is-drag-active" : "",
    taskRequestMode ? "is-task-request" : "",
    contextEditMode ? "is-context-edit" : "",
    isHiveChat ? "is-hive-input" : "",
  ].filter(Boolean).join(" ");
  const modelPickerDisabled = contextEditMode || isHiveChat;
  const modelPickerLabel = contextEditMode
    ? "Thinking carefully"
    : isHiveChat
      ? HIVE_CHAT_TITLE
      : formatModeLabel(selectedMode);
  const composer = (
    <div className="composer-shell">
      <input
        ref={fileInputRef}
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="chat-file-input"
        multiple
        onChange={handleAttachmentSelection}
        type="file"
      />
      <form
        className={composerClassName}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
        onSubmit={submitMessage}
      >
        {attachments.length > 0 && (
          <AttachmentTray
            attachments={attachments}
            onRemove={removeAttachment}
            onShowInText={showAttachmentInTextField}
          />
        )}
        {contextEditMode && (
          <div className="composer-mode-chip">
            <Wand2 size={13} strokeWidth={1.9} />
            <span>Context Refine</span>
            <button aria-label="Exit Context Refine" onClick={() => setContextEditMode(false)} type="button">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {isHiveChat && (
          <div className="composer-mode-chip">
            <Network size={13} strokeWidth={1.9} />
            <span>{HIVE_CHAT_TITLE}</span>
          </div>
        )}
        <div className={composerExpanded ? "composer-grid is-expanded" : "composer-grid is-compact"}>
          <div className="plus-picker composer-plus" ref={plusRef}>
            <button
              className="composer-icon"
              disabled={signedOut}
              onClick={() => {
                if (signedOut) return;
                setModelMenuOpen(false);
                setPlusMenuOpen((open) => !open);
              }}
              type="button"
              aria-label={signedOut ? "Sign in for app actions" : "Add"}
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
                <ToolMenuRow
                  icon={Wand2}
                  label="Context Refine"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setTaskRequestMode(false);
                    setContextEditMode(true);
                    setSendMessage("");
                    setStatusTone("muted");
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                />
                <ToolMenuRow
                  icon={ListPlus}
                  label="Request a task"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setTaskRequestMode(true);
                    setContextEditMode(false);
                    setSendMessage("");
                    setStatusTone("muted");
                    window.setTimeout(() => inputRef.current?.focus(), 0);
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
          <textarea
            ref={inputRef}
            aria-label={composerPlaceholder}
            className="composer-input"
            onChange={(event) => setInput(event.target.value)}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                submitMessage(event);
              }
            }}
            placeholder={composerExpanded ? "" : composerPlaceholder}
            rows={1}
            style={{ maxHeight: CHAT_COMPOSER_MAX_HEIGHT }}
            value={input}
          />
          <div className="composer-tools">
            <div className="model-picker" ref={modelRef}>
              <button
                className="model-button"
                disabled={modelPickerDisabled}
                onClick={() => {
                  if (modelPickerDisabled) return;
                  setPlusMenuOpen(false);
                  setModelMenuOpen((open) => !open);
                }}
                type="button"
              >
                {modelPickerLabel}
                <ChevronDown className={modelMenuOpen ? "is-open" : ""} size={14} strokeWidth={1.75} />
              </button>
              {modelMenuOpen && !modelPickerDisabled && (
                <div className="model-menu">
                  {modes.map((mode) => (
                    <ModelOption
                      disabled={!mode.enabled}
                      key={mode.label}
                      mode={mode}
                      selected={mode.label === selectedMode}
                      onClick={() => {
                        if (!mode.enabled) return;
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
          </div>
        </div>
      </form>
      {showComposerStatus && (
        <div className={`chat-composer-note ${composerStatus.tone}${isHiveChat ? " is-hive-note" : ""}`}>
          {isHiveChat ? <em>{composerStatus.text}</em> : composerStatus.text}
        </div>
      )}
    </div>
  );

  return (
    <div className={displayState === "empty" ? "chat-surface empty" : `chat-surface ${displayState}`}>
      {displayState === "loading" ? (
        <div className="chat-loading-panel" aria-live="polite">
          <span>Loading chat</span>
          <strong>{chatTitle || "Conversation"}</strong>
        </div>
      ) : displayState === "empty" ? (
        <div className="chat-empty">
          <h1>{isHiveChat ? HIVE_CHAT_TITLE : "What are you working on?"}</h1>
          {composer}
          {!signedOut && !isHiveChat && (
            <div className="chat-starter-prompts">
              {CHAT_STARTER_PROMPTS.map((prompt) => (
                <button
                  className="pill-button"
                  key={prompt}
                  onClick={() => {
                    setInput(prompt);
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  type="button"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="chat-thread-shell">
          <div
            className="message-list"
            ref={messageListRef}
            aria-live="polite"
            onScroll={updateScrollBottomVisibility}
          >
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

              if (message.role === "agent") {
                return (
                  <AgentMessage
                    agentClient={message.agentClient}
                    agentLabel={message.agentLabel}
                    attachments={message.attachments || []}
                    key={message.id || `agent-${index}`}
                    text={message.text}
                  />
                );
              }

              return (
                <AssistantMessage
                  contextEditSavingId={contextEditSavingId}
                  key={message.id || `assistant-${index}`}
                  message={message}
                  onContextEditApply={handleContextEditApply}
                  onContextEditReject={handleContextEditReject}
                  onContextEditRevise={handleContextEditRevise}
                  onShare={() => setShareOpen(true)}
                />
              );
            })}
          </div>
          {showScrollBottom && (
            <button
              aria-label="Scroll to latest message"
              className="scroll-bottom-button"
              onClick={() => {
                const list = messageListRef.current;
                if (!list) return;
                list.scrollTo({
                  top: list.scrollHeight,
                  behavior: "auto",
                });
                scrollNearBottomRef.current = true;
                setShowScrollBottom(false);
              }}
              title="Scroll to bottom"
              type="button"
            >
              <ArrowDown size={14} strokeWidth={2} />
            </button>
          )}
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
  if (message) return { tone: tone === "error" ? "error" : "muted", text: message };
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
    const unreadCount = Math.max(0, Math.round(Number(recent.unreadCount || 0)));
    const key = conversationId || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: conversationId || `server-${slugify(title) || index}`,
      conversationId: conversationId || "",
      kind: recent.kind || "",
      virtual: Boolean(recent.virtual),
      source: "server",
      title,
      lastMessagePreview: recent.lastMessagePreview || "",
      messageCount: recent.messageCount || 0,
      updatedAt: recent.updatedAt || recent.lastMessageAt || "",
      unreadCount,
      unread: Boolean(recent.unread || unreadCount > 0),
    });
  }

  return rows;
}

function formatUnreadCount(count = 0) {
  const normalized = Math.max(0, Math.round(Number(count) || 0));
  if (normalized > 99) return "99+";
  return String(normalized);
}

function hiveUnreadCountFromAppState(state) {
  const direct = Number(state?.chat?.hiveConversation?.unreadCount || 0);
  if (direct > 0) return Math.round(direct);
  const recentHive = (state?.chat?.recents || []).find((item) => item?.kind === "hive");
  return Math.max(0, Math.round(Number(recentHive?.unreadCount || 0)));
}

function mergeHiveConversationIntoAppState(current, conversation) {
  if (!current?.chat || !conversation) return current;
  const normalizedConversation = {
    ...conversation,
    unreadCount: Math.max(0, Math.round(Number(conversation.unreadCount || 0))),
    unread: Boolean(conversation.unread || Number(conversation.unreadCount || 0) > 0),
  };
  const hiveId = normalizedConversation.conversationId || normalizedConversation.id;
  const existingRecents = Array.isArray(current.chat.recents) ? current.chat.recents : [];
  let found = false;
  const nextRecents = existingRecents
    .map((item) => {
      const itemId = item?.conversationId || item?.id || "";
      const itemIsHive = item?.kind === "hive" || (hiveId && itemId === hiveId);
      if (!itemIsHive) return item;
      found = true;
      return {
        ...item,
        ...normalizedConversation,
      };
    })
    .filter((item) => item?.kind !== "hive" || normalizedConversation.disabled !== true);

  if (!found && normalizedConversation.disabled !== true) {
    nextRecents.unshift(normalizedConversation);
  }

  return {
    ...current,
    chat: {
      ...current.chat,
      hiveConversation: normalizedConversation,
      recents: nextRecents,
    },
  };
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

function ChatItemActionMenu({ chat, menuRef, onRename, onDelete, style }) {
  const isHive = chat?.kind === "hive";
  return (
    <div className="chat-action-menu" ref={menuRef} role="menu" style={style}>
      {!isHive && (
        <>
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
        </>
      )}
      <button className="chat-action-menu-item danger" onClick={onDelete} role="menuitem" type="button">
        <Trash2 size={17} strokeWidth={1.75} />
        <span>{isHive ? "Disable Hive Chat" : "Delete"}</span>
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
  const isHive = chat?.kind === "hive";

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
          <h2 id="delete-chat-title">{isHive ? "Disable Hive Chat?" : "Delete chat?"}</h2>
          <button aria-label="Close delete" className="chat-edit-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <p className="chat-delete-copy">
          {isHive ? (
            <>
              This permanently removes your ability to talk to <strong>Hive Chat</strong> from the sidebar
              unless you re-enable it in Settings. Existing Hive Context entries stay saved.
            </>
          ) : (
            <>
              This removes <strong>{chat?.title || "this chat"}</strong> from your chat history.
            </>
          )}
        </p>
        {error && <p className="chat-edit-error">{error}</p>}
        <footer>
          <button className="ghost-button" disabled={deleting} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="danger-button" disabled={deleting} onClick={submitDelete} type="button">
            <Trash2 size={16} strokeWidth={2} />
            {isHive ? "Disable Hive Chat" : "Delete"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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
              ) : message.role === "agent" ? (
                <div className="share-preview-agent" key={index}>
                  <strong>{message.agentLabel || "Orc agent"}</strong>
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

function ModelOption({ disabled = false, mode, onClick, selected }) {
  return (
    <button
      className={`model-option${selected ? " selected" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>
        <strong>{formatModeLabel(mode.label)}</strong>
        <small>{modeDescription(mode)}</small>
      </span>
      {selected && <Check size={15} strokeWidth={2} />}
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
  if (label === "Discount Thinking") return "DeepSeek API Direct";
  if (label === "Frontier Instant") return "Fast frontier model";
  if (label === "Help") return "Plain-English app guide";
  if (label === "Frontier Thinking") return "Deeper frontier reasoning";
  return mode.latency || mode.privacy || "";
}

function profileDisplayName(session) {
  if (session?.identityProfile?.displayName) return session.identityProfile.displayName;
  if (session?.hiveHandle) return `@${session.hiveHandle}`;
  if (session?.displayName) return session.displayName;
  return "Log in or sign up";
}

function profileAvatarText(session) {
  const displayName = profileDisplayName(session);
  if (!displayName || displayName === "Log in or sign up") return "TN";
  return displayName
    .replace(/^@+/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function profileSessionText(session) {
  if (!isSignedInSession(session)) return "Account";
  if (session?.hiveHandle) return `@${session.hiveHandle}`;
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

function ProfileAvatar({ imageCandidates = [], initials, signedIn }) {
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = signedIn ? imageCandidates[imageIndex] || "" : "";
  const imageKey = imageCandidates.join("|");

  useEffect(() => {
    setImageIndex(0);
  }, [imageKey]);

  return (
    <span className={`profile-avatar ${signedIn ? "signed-in" : "signed-out"} ${imageSrc ? "has-image" : ""}`}>
      {imageSrc ? (
        <img
          alt="Profile NFT"
          onError={() => setImageIndex((index) => index + 1)}
          src={imageSrc}
        />
      ) : (
        initials
      )}
      {signedIn && !imageSrc && (
        <span className="profile-check" aria-hidden="true">
          <Check size={9} strokeWidth={2.5} />
        </span>
      )}
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

function TasksView({
  accountId = "",
  linkedWalletAddress = "",
  onRequestSettled,
  onSelectTask,
  onWalletUnlock,
  tasks = EMPTY_TASKS,
  walletSecret = null,
  walletUnlockPending = false,
  walletVault = {},
}) {
  const [tasksTab, setTasksTab] = useState("outstanding");
  const [taskRequestOpen, setTaskRequestOpen] = useState(false);
  const [taskRequestSettleUntilMs, setTaskRequestSettleUntilMs] = useState(0);
  const [taskReadFailureCount, setTaskReadFailureCount] = useState(0);
  const didAutoSelectTaskTabRef = useRef(false);
  const lastTaskFocusRefreshRef = useRef(0);
  const lastTaskHandoffKeyRef = useRef("");
  const lastTaskProjectionCountRef = useRef(null);
  const lastTaskSyncWarningEventRef = useRef("");
  const previousActiveRequestCountRef = useRef(0);
  // Stateful exponential-backoff counter for temporary task-read failures.
  // The pure policy modules stay stateless; each consecutive failing snapshot
  // increments the counter and the first healthy snapshot resets it.
  useEffect(() => {
    const syncStatus = String(tasks?.sync?.status || "");
    const readFailing = syncStatus === "database_error" || syncStatus === "integrity_unavailable";
    setTaskReadFailureCount((current) => (readFailing ? Math.min(current + 1, 6) : 0));
  }, [tasks]);

  const visibleState = useMemo(() => reconcileTaskVisibleState({
    accountId,
    linkedWalletAddress,
    taskReadFailureCount,
    taskRequestSettleUntilMs,
    tasks,
    tasksTab,
  }), [accountId, linkedWalletAddress, taskReadFailureCount, taskRequestSettleUntilMs, tasks, tasksTab]);
  const {
    activeRequests,
    activeRequestCount,
    attentionRequests,
    counts,
    currentTabTasks,
    outstanding,
    polling,
    processingRequests,
    rewarded,
    sync: taskSync,
    tabs,
    taskSyncNotice,
    totalPftInFlight,
    verification,
  } = visibleState;
  const {
    shouldForceTaskProjection,
    shouldRefreshTaskState,
    taskRefreshMs,
    taskRequestSettling,
  } = polling;
  const outstandingCount = counts.outstanding;
  const taskRequestHandoff = taskSync?.handoff || {};

  useEffect(() => {
    const syncStatus = String(taskSync?.status || "");
    const warningVisible = Boolean(taskSyncNotice) || attentionRequests.length > 0;
    if (!warningVisible) {
      lastTaskSyncWarningEventRef.current = "";
      return;
    }
    const reasonCode = taskSyncNotice
      ? syncStatus || "task_sync_warning"
      : "task_requests_need_attention";
    const eventKey = [
      linkedWalletAddress,
      reasonCode,
      attentionRequests.length,
      Number(taskSync?.failedReducerCount || 0),
      Number(taskSync?.indexingLagCount || 0),
    ].join("|");
    if (eventKey === lastTaskSyncWarningEventRef.current) return;
    recordClientObservabilityEvent({
      eventType: "user.ui.sync_warning_shown",
      walletAddress: linkedWalletAddress,
      walletScope: linkedWalletAddress ? "active" : "unknown",
      sourceSurface: "tasks",
      sourceRoute: "src/main.jsx::TasksView",
      resultStatus: "shown",
      reasonCode,
      metadata: {
        label: taskSyncNotice?.label || "Task requests need attention",
        syncStatus,
        attentionRequestIds: attentionRequests.slice(0, 5).map((request) => request.requestId || "").filter(Boolean),
      },
      metrics: {
        attentionRequestCount: attentionRequests.length,
        failedReducerCount: Number(taskSync?.failedReducerCount || 0),
        indexingLagCount: Number(taskSync?.indexingLagCount || 0),
        projectionCount: Number(taskSync?.projectionCount || 0),
      },
    });
    lastTaskSyncWarningEventRef.current = eventKey;
  }, [
    attentionRequests,
    linkedWalletAddress,
    taskSync?.failedReducerCount,
    taskSync?.indexingLagCount,
    taskSync?.projectionCount,
    taskSync?.status,
    taskSyncNotice,
  ]);

  useEffect(() => {
    if (didAutoSelectTaskTabRef.current) return;
    if (tasksTab !== "outstanding") return;
    if (outstanding.length > 0 || verification.length > 0 || rewarded.length === 0) return;
    didAutoSelectTaskTabRef.current = true;
    setTasksTab("rewarded");
  }, [outstanding.length, rewarded.length, tasksTab, verification.length]);

  useEffect(() => {
    if (!settledTaskRequestHasVisibleOutstanding({
      outstandingCount: outstanding.length,
      taskRequestSettling,
    })) return;
    if (shouldRevealSettledOutstandingTask({
      currentTab: tasksTab,
      outstandingCount: outstanding.length,
      taskRequestSettling,
    })) {
      setTasksTab("outstanding");
    }
    setTaskRequestSettleUntilMs(0);
  }, [outstanding.length, taskRequestSettling, tasksTab]);

  useEffect(() => {
    const previous = previousActiveRequestCountRef.current;
    if (shouldStartTaskRequestSettle({
      previousActiveRequestCount: previous,
      currentActiveRequestCount: activeRequestCount,
    })) {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
    }
    previousActiveRequestCountRef.current = activeRequestCount;
  }, [activeRequestCount]);

  useEffect(() => {
    const projectionCount = Number(taskSync?.projectionCount || 0);
    if (lastTaskProjectionCountRef.current === null) {
      lastTaskProjectionCountRef.current = projectionCount;
      return;
    }
    if (projectionCount > lastTaskProjectionCountRef.current) {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
    }
    lastTaskProjectionCountRef.current = projectionCount;
  }, [taskSync?.projectionCount]);

  useEffect(() => {
    const handoffKey = [
      taskRequestHandoff.latestRequestId || "",
      taskRequestHandoff.latestRequestStatus || "",
      taskRequestHandoff.generatedTaskId || "",
      taskRequestHandoff.generatedTaskVisible ? "visible" : "pending",
      taskRequestHandoff.latestRequestUpdatedAt || "",
      taskRequestHandoff.requestHandoffState || "",
    ].join("|");
    if (!handoffKey.replace(/\|/g, "")) return;
    const shouldSettleHandoff = ["generated_visible", "generated_projection_pending"].includes(taskRequestHandoff.requestHandoffState);
    if (!lastTaskHandoffKeyRef.current) {
      lastTaskHandoffKeyRef.current = handoffKey;
      if (shouldSettleHandoff) setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
      return;
    }
    if (handoffKey === lastTaskHandoffKeyRef.current) return;
    lastTaskHandoffKeyRef.current = handoffKey;
    if (shouldSettleHandoff) {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
    }
  }, [
    taskRequestHandoff.generatedTaskId,
    taskRequestHandoff.generatedTaskVisible,
    taskRequestHandoff.latestRequestId,
    taskRequestHandoff.latestRequestStatus,
    taskRequestHandoff.latestRequestUpdatedAt,
    taskRequestHandoff.requestHandoffState,
  ]);

  const refreshCanonicalTaskState = useCallback(
    ({ taskProjectionRefresh = true } = {}) => {
      if (typeof onRequestSettled !== "function") return null;
      return onRequestSettled({ taskProjectionRefresh });
    },
    [onRequestSettled]
  );

  const handleTaskRequestRecorded = useCallback(
    async () => {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
      return refreshCanonicalTaskState({ taskProjectionRefresh: true });
    },
    [refreshCanonicalTaskState]
  );

  useEffect(() => {
    if (!shouldRefreshTaskState || typeof onRequestSettled !== "function") return undefined;
    const refresh = window.setInterval(() => {
      if (taskRequestSettling && Date.now() >= taskRequestSettleUntilMs) {
        setTaskRequestSettleUntilMs(0);
        return;
      }
      Promise.resolve(refreshCanonicalTaskState({ taskProjectionRefresh: shouldForceTaskProjection })).catch(() => null);
    }, taskRefreshMs);
    return () => window.clearInterval(refresh);
  }, [
    refreshCanonicalTaskState,
    shouldForceTaskProjection,
    shouldRefreshTaskState,
    taskRefreshMs,
    taskRequestSettleUntilMs,
    taskRequestSettling,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return undefined;
    if (typeof onRequestSettled !== "function") return undefined;

    const refreshVisibleTaskState = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastTaskFocusRefreshRef.current < 1000) return;
      lastTaskFocusRefreshRef.current = now;
      Promise.resolve(refreshCanonicalTaskState({ taskProjectionRefresh: true })).catch(() => null);
    };

    window.addEventListener("focus", refreshVisibleTaskState);
    document.addEventListener("visibilitychange", refreshVisibleTaskState);
    return () => {
      window.removeEventListener("focus", refreshVisibleTaskState);
      document.removeEventListener("visibilitychange", refreshVisibleTaskState);
    };
  }, [onRequestSettled, refreshCanonicalTaskState]);

  const emptyCopy = {
    outstanding: {
      icon: Flag,
      title: tasks?.sync?.status === "wallet_required" ? "Link a wallet to view tasks" : "No outstanding tasks",
      desc: "Tasks appear here after signed offers or updates finish syncing for your linked wallet.",
    },
    verification: {
      icon: Trophy,
      title: "Nothing awaiting verification",
      desc: "Tasks move here when someone asks for more evidence or review.",
    },
    refused: {
      icon: MoreHorizontal,
      title: "No refused tasks",
      desc: "Refused, rejected, expired, and cancelled tasks appear here.",
    },
    rewarded: {
      icon: Trophy,
      title: "No rewarded tasks",
      desc: "Paid tasks appear here after the reward is synced.",
    },
  }[tasksTab];

  return (
    <div className="route-scroll">
      <div className="tasks-view tasks-copy-surface">
        <div className="tasks-copy-header">
          <div>
            <h1>Tasks</h1>
            <p>
              <strong>{outstandingCount} outstanding</strong>
              <span aria-hidden="true">.</span>
              <span className="task-in-flight">{totalPftInFlight.toLocaleString()} PFT in flight</span>
              {tasks?.sync?.projectionCount > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span>{tasks.sync.projectionCount} task records synced</span>
                </>
              )}
              {processingRequests.length > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span>{processingRequests.length} requests processing</span>
                </>
              )}
              {attentionRequests.length > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span>{attentionRequests.length} requests need attention</span>
                </>
              )}
            </p>
            <NetworkTaskEligibilityPanel networkTasks={tasks?.networkTasks} />
          </div>
          <button className="dark-pill task-request-button" onClick={() => setTaskRequestOpen(true)} type="button">
            <Plus size={16} strokeWidth={2} />
            Request task
          </button>
        </div>

        <TaskRequestQueue requests={activeRequests} />

        {taskSyncNotice && (
          <div className="tasks-sync-notice" role="status">
            <strong>{taskSyncNotice.label}</strong>
            <p>{taskSyncNotice.body}</p>
          </div>
        )}

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

        {currentTabTasks.length > 0 ? (
          <div className="task-list task-entry-list">
            {currentTabTasks.map((task, index) => (
              <TaskRow
                isFirst={index === 0}
                key={task.taskId || task.fullId || task.id}
                onClick={() => onSelectTask(task)}
                task={task}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={emptyCopy.icon}
            title={emptyCopy.title}
            desc={emptyCopy.desc}
          />
        )}
        {taskRequestOpen && (
          <TaskRequestModal
            accountId={accountId}
            linkedWalletAddress={linkedWalletAddress}
            onClose={() => setTaskRequestOpen(false)}
            onRecorded={handleTaskRequestRecorded}
            onWalletUnlock={onWalletUnlock}
            walletSecret={walletSecret}
            walletUnlockPending={walletUnlockPending}
            walletVault={walletVault}
          />
        )}
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
    text: text.slice(0, CONTEXT_DOCUMENT_MAX_CHARS),
    rawPayload: source,
  };
}

function contextPreviewText(value, maxLength = 220) {
  return stripContextHtml(contextBodyToHtml(value)).slice(0, maxLength);
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
  return looksLikeContextHtml(text) ? sanitizeContextHtml(text) : contextTextToHtml(text);
}

function contextEditorLineRows(editor) {
  if (!editor) return [];
  const editorTop = editor.getBoundingClientRect().top;
  const rows = [];
  const blockTags = new Set(["H1", "H2", "H3", "P", "LI", "BLOCKQUOTE", "PRE", "TR"]);
  const collect = (node) => {
    for (const child of Array.from(node.children || [])) {
      if (blockTags.has(child.tagName) && child.textContent.trim()) rows.push(child);
      if (!blockTags.has(child.tagName) || ["UL", "OL", "TABLE", "TBODY", "THEAD"].includes(child.tagName)) collect(child);
    }
  };
  collect(editor);
  return (rows.length ? rows : [editor]).map((node, index) => ({
    number: index + 1,
    top: Math.max(0, Math.round(node.getBoundingClientRect().top - editorTop)),
  }));
}

function nodeBelongsToEditor(editor, node) {
  if (!editor || !node) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  return node === editor || element === editor || editor.contains(element);
}

function editorSelectionRange(editor) {
  const selection = window.getSelection?.();
  if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!nodeBelongsToEditor(editor, range.startContainer) || !nodeBelongsToEditor(editor, range.endContainer)) {
    return null;
  }
  return range;
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

async function refreshContextStateAfterSave(onContextChange) {
  if (typeof onContextChange !== "function") return null;

  let timeoutId = 0;
  try {
    return await Promise.race([
      onContextChange(),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          const error = new Error("context_app_state_refresh_timeout");
          error.code = "context_app_state_refresh_timeout";
          reject(error);
        }, 4000);
      }),
    ]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function requestContextSaveJson(path, payload) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId = 0;
  try {
    if (controller) {
      timeoutId = window.setTimeout(() => controller.abort(), 10000);
    }
    return await requestJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        body: { message: "Context save timed out. Try again." },
      };
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function ContextView({ context, linkedWalletAddress = "", onContextChange, onHydrateContext, onPublishContext, walletVault }) {
  const initialDocument = context?.document || {};
  const savePath = context?.savePath || initialDocument.savePath || "/api/context/edit/save";
  const history = context?.history || {};
  const [documentState, setDocumentState] = useState(initialDocument);
  const [title, setTitle] = useState(initialDocument.title || "Task Node Context");
  const [savedTitle, setSavedTitle] = useState(initialDocument.title || "Task Node Context");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [contextBudgetHtml, setContextBudgetHtml] = useState(() =>
    contextBodyToHtml(initialDocument.body || "")
  );
  const [contextLineCount, setContextLineCount] = useState(() =>
    countContextLines(contextBodyToHtml(initialDocument.body || ""))
  );
  const [contextLineRows, setContextLineRows] = useState([]);
  const [copied, setCopied] = useState(false);
  const [copiedCid, setCopiedCid] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    h1: false,
    h2: false,
    h3: false,
    ul: false,
    ol: false,
  });
  const [lineNumbersVisible, setLineNumbersVisible] = useState(() => {
    try {
      return window.localStorage?.getItem("tasknode.context.lineNumbers") !== "hidden";
    } catch {
      return true;
    }
  });
  const [contextBudgetOpen, setContextBudgetOpen] = useState(() => {
    try {
      return window.localStorage?.getItem("tasknode.context.taskgenBudget") === "open";
    } catch {
      return false;
    }
  });
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ rows: 0, cols: 0 });
  const [tablePickerPosition, setTablePickerPosition] = useState({ top: 0, left: 0 });
  const [hydratedContext, setHydratedContext] = useState(null);
  const [hydratedPreviewByCid, setHydratedPreviewByCid] = useState({});
  const [previewStateByCid, setPreviewStateByCid] = useState({});
  const [restoringVersionKey, setRestoringVersionKey] = useState("");
  const [previewHydration, setPreviewHydration] = useState({
    active: false,
    loaded: 0,
    total: 0,
    error: "",
  });
  const [hydrateMessage, setHydrateMessage] = useState("");
  const editorRef = useRef(null);
  const savedRangeRef = useRef(null);
  const tableWrapRef = useRef(null);
  const previewHydrationRunRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveContextRef = useRef(async () => false);
  const titleRef = useRef(initialDocument.title || "Task Node Context");
  const lastSavedHtmlRef = useRef(contextBodyToHtml(initialDocument.body || ""));
  const latestContextDocumentRef = useRef({
    id: initialDocument.id || "",
    revision: Number(initialDocument.revision || 0),
  });

  const refreshContextLineRows = useCallback((fallbackLineCount = 1) => {
    window.requestAnimationFrame(() => {
      const rows = contextEditorLineRows(editorRef.current);
      const lineCount = Math.max(1, Number(fallbackLineCount) || 1);
      setContextLineRows(rows.length ? rows : Array.from({ length: lineCount }, (_, index) => ({
        number: index + 1,
        top: index * 24,
      })));
    });
  }, []);

  useEffect(() => {
    const nextDocument = context?.document || {};
    const nextDocumentId = nextDocument.id || "";
    const nextRevision = Number(nextDocument.revision || 0);
    const latestDocument = latestContextDocumentRef.current || {};
    if (
      nextDocumentId &&
      latestDocument.id === nextDocumentId &&
      nextRevision < Number(latestDocument.revision || 0)
    ) {
      return;
    }

    const nextTitle = nextDocument.title || "Task Node Context";
    const nextHtml = contextBodyToHtml(nextDocument.body || "");
    const preserveLocalDraft = dirtyRef.current;
    latestContextDocumentRef.current = { id: nextDocumentId, revision: nextRevision };
    setDocumentState(nextDocument);
    setSavedTitle(nextTitle);
    lastSavedHtmlRef.current = nextHtml;
    if (!preserveLocalDraft) {
      setTitle(nextTitle);
      titleRef.current = nextTitle;
      if (editorRef.current) editorRef.current.innerHTML = nextHtml;
      setContextBudgetHtml(nextHtml);
      const nextLineCount = countContextLines(nextHtml);
      setContextLineCount(nextLineCount);
      refreshContextLineRows(nextLineCount);
      setDirty(false);
      setSaveMessage("");
    }
  }, [context?.document?.id, context?.document?.revision, context?.document?.updatedAt, refreshContextLineRows]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    setHydratedContext(null);
    setHydrateMessage("");
    setRestoringVersionKey("");
    setHydratedPreviewByCid({});
    setPreviewStateByCid({});
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
  const vaultDisplay = walletVaultDisplayState(walletVault, linkedWalletAddress);
  const restoringAnyVersion = Boolean(restoringVersionKey);
  const previewedHistoryCount = historyPreviewTargets.filter((version) => hydratedPreviewByCid[version.cid]?.text).length;
  const historyPreviewTotal = historyPreviewTargets.length;
  const historyPointerCount = walletHistoryActive ? Number(history?.pointerCount || 0) : 0;
  const historySync = walletHistoryActive ? history?.sync || {} : {};
  const historySyncLabel = !activeWalletAddress
    ? ""
    : historySync.status === "error"
      ? "Sync issue"
      : historySync.archiveComplete
        ? "Archive synced"
        : historySync.status === "ready"
          ? "Cache synced"
          : "Syncing history";
  const historySubtitle = !activeWalletAddress
    ? "Current account context is available without a wallet. Wallet history appears after linking."
    : historyPointerCount
      ? `${historyPointerCount} cached wallet pointer${historyPointerCount === 1 ? "" : "s"} available.`
      : "No cached PFTL context pointers for the linked wallet yet.";
  const contextBudget = contextBudgetMetrics(contextBodyText(contextBudgetHtml), {
    maxChars: TASKGEN_CONTEXT_MAX_CHARS,
  });
  const contextBudgetTone = contextBudget.clipped
    ? "danger"
    : contextBudget.usagePercent >= 90
      ? "warn"
      : "ok";
  const contextBudgetPercentLabel = `${contextBudget.usagePercent.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}%`;
  const contextBudgetIncludedLabel = contextBudget.includedChars.toLocaleString();
  const contextBudgetMaxLabel = contextBudget.maxChars.toLocaleString();
  const contextBudgetRemainingLabel = Math.max(0, contextBudget.maxChars - contextBudget.sourceChars).toLocaleString();
  const contextBudgetOmittedLabel = contextBudget.omittedChars.toLocaleString();

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
        h1: block === "h1" || block === "<h1>",
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
    try {
      window.localStorage?.setItem("tasknode.context.lineNumbers", lineNumbersVisible ? "visible" : "hidden");
    } catch {
      // Local display preference only.
    }
  }, [lineNumbersVisible]);

  useEffect(() => {
    try {
      window.localStorage?.setItem("tasknode.context.taskgenBudget", contextBudgetOpen ? "open" : "closed");
    } catch {
      // Local display preference only.
    }
  }, [contextBudgetOpen]);

  const updateTablePickerPosition = useCallback(() => {
    const anchor = tableWrapRef.current;
    if (!anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const pickerWidth = 182;
    const margin = 8;
    setTablePickerPosition({
      top: Math.round(rect.bottom + 8),
      left: Math.max(margin, Math.min(Math.round(rect.left), Math.max(margin, viewportWidth - pickerWidth - margin))),
    });
  }, []);

  useEffect(() => {
    if (!tablePickerOpen) return undefined;
    updateTablePickerPosition();

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
    window.addEventListener("resize", updateTablePickerPosition);
    window.addEventListener("scroll", updateTablePickerPosition, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateTablePickerPosition);
      window.removeEventListener("scroll", updateTablePickerPosition, true);
    };
  }, [tablePickerOpen, updateTablePickerPosition]);

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
      setContextBudgetHtml(editorRef.current.innerHTML || "");
      recomputeDirty();
    },
    [canEdit, recomputeDirty, restoreSelection]
  );

  const saveContext = useCallback(async () => {
    if (!canEdit || savingRef.current || !editorRef.current) return false;

    savingRef.current = true;
    setSaving(true);
    setSaveMessage("");
    const body = sanitizeContextHtml(editorRef.current.innerHTML);
    const requestTitle = titleRef.current;

    let result;
    try {
      result = await requestContextSaveJson(savePath, { title: requestTitle, body });
    } catch {
      setSaveMessage("Context could not be saved.");
      savingRef.current = false;
      setSaving(false);
      return false;
    }

    if (!result.ok || !result.body?.document) {
      setSaveMessage(result.body?.message || "Context could not be saved.");
      savingRef.current = false;
      setSaving(false);
      return false;
    }

    const savedDocument = result.body.document;
    let refreshedState = null;
    try {
      refreshedState = await refreshContextStateAfterSave(onContextChange);
    } catch {
      refreshedState = null;
    }
    const refreshedDocument = refreshedState?.context?.document;
    const durableDocument =
      refreshedDocument?.id === savedDocument.id &&
      Number(refreshedDocument.revision || 0) >= Number(savedDocument.revision || 0)
        ? refreshedDocument
        : savedDocument;
    const currentBody = sanitizeContextHtml(editorRef.current?.innerHTML || "");
    const currentTitle = titleRef.current;
    const continuedEditing = currentBody !== body || currentTitle !== requestTitle;
    setContextBudgetHtml(currentBody || contextBodyToHtml(durableDocument.body || ""));

    setDocumentState(durableDocument);
    latestContextDocumentRef.current = {
      id: durableDocument.id || "",
      revision: Number(durableDocument.revision || 0),
    };
    setSavedTitle(durableDocument.title || "Task Node Context");
    lastSavedHtmlRef.current = contextBodyToHtml(durableDocument.body || "");
    if (continuedEditing) {
      dirtyRef.current = true;
      setDirty(true);
    } else {
      setTitle(durableDocument.title || "Task Node Context");
      titleRef.current = durableDocument.title || "Task Node Context";
      setSaveMessage("Saved just now");
      dirtyRef.current = false;
      setDirty(false);
    }
    savingRef.current = false;
    setSaving(false);
    return true;
  }, [canEdit, onContextChange, savePath]);

  useEffect(() => {
    saveContextRef.current = saveContext;
  }, [saveContext]);

  useEffect(() => {
    if (!dirty || saving || !canEdit) return undefined;
    const timeout = window.setTimeout(() => {
      saveContext();
    }, 900);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [canEdit, dirty, saveContext, saving]);

  const handleEditorInput = () => {
    setSaveMessage("");
    const currentHtml = editorRef.current?.innerHTML || "";
    setContextBudgetHtml(currentHtml);
    const nextLineCount = countContextLines(currentHtml);
    setContextLineCount(nextLineCount);
    refreshContextLineRows(nextLineCount);
    recomputeDirty();
  };

  const flushPendingContextSave = useCallback(() => {
    if (!dirty || saving || !canEdit) return;
    saveContext();
  }, [canEdit, dirty, saveContext, saving]);

  const handleEditorKeyDown = (event) => {
    const selectedRange = editorSelectionRange(editorRef.current);
    if (canEdit && (event.key === "Backspace" || event.key === "Delete") && selectedRange) {
      event.preventDefault();
      selectedRange.deleteContents();
      const selection = window.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(selectedRange);
      if (editorRef.current && !stripContextHtml(editorRef.current.innerHTML)) {
        editorRef.current.innerHTML = "<p><br></p>";
      }
      handleEditorInput();
      updateActiveFormats();
      return;
    }

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
    handleEditorInput();
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
        preview: contextPreviewText(contextResult.text),
        wordCount: contextWordCount(contextBodyToHtml(contextResult.text)),
        decrypted: contextResult.decrypted,
        fetchedAt: contextResult.fetchedAt || new Date().toISOString(),
      },
    }));
    setPreviewStateByCid((current) => ({
      ...current,
      [normalizedCid]: {
        status: "loaded",
        message: "",
      },
    }));
  }, []);

  const setPreviewState = useCallback((cid, nextState) => {
    const normalizedCid = String(cid || "").trim();
    if (!normalizedCid) return;
    setPreviewStateByCid((current) => ({
      ...current,
      [normalizedCid]: {
        ...current[normalizedCid],
        ...nextState,
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
    setPreviewState(cid, { status: "loading", message: "" });
    try {
      const result = await onHydrateContext?.(pointer);
      if (!result?.text) {
        setHydrateMessage("Context CID was fetched, but no readable context text was found.");
        setHydratedContext(null);
        setPreviewState(cid, {
          status: "error",
          message: "No readable context text was found. Click Restore to retry.",
        });
      } else {
        const nextHydratedContext = { ...result, cid: result.cid || cid };
        setHydratedContext(nextHydratedContext);
        cacheHydratedPreview(cid, nextHydratedContext);
        setHydrateMessage(result.decrypted ? "Historical context decrypted." : "Historical context fetched.");
        setVersionsOpen(true);
      }
      return Boolean(result?.text);
    } catch (error) {
      const message = error?.message || "Context could not be hydrated.";
      setHydrateMessage(message);
      setPreviewState(cid, {
        status: "error",
        message,
      });
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
    setPreviewStateByCid((current) => {
      const next = { ...current };
      for (const target of targets) {
        next[target.cid] = next[target.cid]?.status === "loaded"
          ? next[target.cid]
          : { status: "queued", message: "" };
      }
      return next;
    });

    async function hydratePreviewRows() {
      let loaded = 0;
      let firstError = "";

      for (const version of targets) {
        if (cancelled || previewHydrationRunRef.current !== runId) return;

        try {
          setPreviewState(version.cid, { status: "loading", message: "" });
          const result = await onHydrateContext?.(version.pointer);
          if (result?.text) {
            cacheHydratedPreview(version.cid, { ...result, cid: result.cid || version.cid });
          } else {
            setPreviewState(version.cid, {
              status: "error",
              message: "No readable context text was found. Click Restore to retry.",
            });
          }
        } catch (error) {
          firstError ||= error?.message || "Some previews could not be loaded.";
          setPreviewState(version.cid, {
            status: "error",
            message: error?.message || "Preview could not be loaded. Click Restore to retry.",
          });
          if (error?.code === "wallet_vault_locked" || error?.code === "context_wallet_required") break;
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
  }, [cacheHydratedPreview, historyPreviewTargetKey, onHydrateContext, setPreviewState, versionsOpen, walletVault?.unlocked]);

  const applyHydratedContext = useCallback(() => {
    if (!hydratedContext?.text) return;
    setTitle(hydratedContext.title || "Historical PFT Context");
    const hydratedHtml = contextBodyToHtml(hydratedContext.text);
    if (editorRef.current) editorRef.current.innerHTML = hydratedHtml;
    setContextBudgetHtml(hydratedHtml);
    const nextLineCount = countContextLines(hydratedHtml);
    setContextLineCount(nextLineCount);
    refreshContextLineRows(nextLineCount);
    setHydratedContext(null);
    setHydrateMessage("Historical version loaded into the editor. It will autosave as the current context document.");
    setVersionsOpen(true);
    setSaveMessage("Historical version loaded");
    setDirty(true);
  }, [hydratedContext, refreshContextLineRows]);

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
      setContextBudgetHtml(lastSavedHtmlRef.current);
      const nextLineCount = countContextLines(lastSavedHtmlRef.current);
      setContextLineCount(nextLineCount);
      refreshContextLineRows(nextLineCount);
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
    if (!walletVault?.unlocked) {
      setSaveMessage("Unlock wallet vault to publish.");
      return;
    }
    if (!linkedWalletAddress) {
      setSaveMessage("Link a PFT wallet before publishing.");
      return;
    }
    if (typeof onPublishContext !== "function") {
      setSaveMessage("Publishing is unavailable.");
      return;
    }

    setPublishing(true);
    try {
      const body = sanitizeContextHtml(editorRef.current?.innerHTML || documentState.body || "");
      const result = await onPublishContext({
        title,
        body,
        revision: documentState.revision || 0,
        wordCount: contextWordCount(body),
        path: manifestAction?.path || "/api/context/manifest/ink",
      });
      setSaveMessage(result?.message || "Published to PFT.");
      await onContextChange?.();
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
          <div
            className="ctx-toolbar"
            role="toolbar"
            aria-label="Formatting"
            onScroll={tablePickerOpen ? updateTablePickerPosition : undefined}
          >
            <div className="ctx-toolbar-group">
              <ContextToolButton active={activeFormats.h1} disabled={!canEdit} onMouseDown={() => toggleHeading(1)} title="Heading 1">
                <Heading1 size={16} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.h2} disabled={!canEdit} onMouseDown={() => toggleHeading(2)} title="Heading 2">
                <Heading2 size={16} strokeWidth={2} />
              </ContextToolButton>
              <ContextToolButton active={activeFormats.h3} disabled={!canEdit} onMouseDown={() => toggleHeading(3)} title="Heading 3">
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
                  if (!tablePickerOpen) {
                    saveSelection();
                    updateTablePickerPosition();
                  }
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
                <div
                  className="ctx-table-picker"
                  role="dialog"
                  aria-label="Insert table"
                  style={{
                    top: `${tablePickerPosition.top}px`,
                    left: `${tablePickerPosition.left}px`,
                  }}
                >
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
            <button
              aria-label={lineNumbersVisible ? "Hide line numbers" : "Show line numbers"}
              aria-pressed={lineNumbersVisible ? "true" : "false"}
              className={`ctx-tool-btn${lineNumbersVisible ? " is-active" : ""}`}
              onClick={() => setLineNumbersVisible((visible) => !visible)}
              title={lineNumbersVisible ? "Hide line numbers" : "Show line numbers"}
              type="button"
            >
              <Hash size={15} strokeWidth={2} />
            </button>
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
              onBlur={flushPendingContextSave}
              onChange={(event) => {
                titleRef.current = event.target.value;
                setTitle(event.target.value);
                setSaveMessage("");
              }}
              placeholder="Untitled context"
              value={title}
            />
            <div className={`ctx-editor-shell${lineNumbersVisible ? "" : " is-line-numbers-hidden"}`}>
              {lineNumbersVisible && (
                <div className="ctx-line-gutter" aria-hidden="true">
                  {(contextLineRows.length ? contextLineRows : Array.from({ length: contextLineCount }, (_, index) => ({
                    number: index + 1,
                    top: index * 24,
                  }))).map((row) => (
                    <span key={row.number} style={{ transform: `translateY(${row.top}px)` }}>{row.number}</span>
                  ))}
                </div>
              )}
              <div
                aria-disabled={!canEdit}
                aria-label="Context document body"
                aria-multiline="true"
                className="ctx-editor"
                contentEditable={canEdit}
                data-placeholder="Add stable preferences, active projects, constraints, and working notes."
                onBlur={flushPendingContextSave}
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
          </div>

          {contextBudgetOpen && (
            <div className={`ctx-budget-panel is-${contextBudgetTone}`} aria-label="Task generation context budget">
              <div className="ctx-budget-panel-head">
                <strong>Task generation context</strong>
                <span>{contextBudgetIncludedLabel} / {contextBudgetMaxLabel} chars</span>
              </div>
              <div className="ctx-budget-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, contextBudget.usagePercent)}%` }} />
              </div>
              <p>
                {contextBudget.clipped
                  ? `Task generation uses the first ${contextBudgetMaxLabel} readable characters. ${contextBudgetOmittedLabel} characters are outside the generation packet.`
                  : `Task generation can use this full document. ${contextBudgetRemainingLabel} characters remain before clipping.`}
              </p>
            </div>
          )}

          <footer className="ctx-card-foot">
            <span className={`ctx-status${dirty ? " is-dirty" : ""}${saving || publishing ? " is-saving" : ""}`} role="status">
              <span className="ctx-status-dot" aria-hidden="true" />
              {statusText}
            </span>
            <div className="ctx-foot-actions">
              <button
                aria-expanded={contextBudgetOpen ? "true" : "false"}
                aria-pressed={contextBudgetOpen ? "true" : "false"}
                className={`ctx-budget-toggle is-${contextBudgetTone}${contextBudgetOpen ? " is-active" : ""}`}
                onClick={() => setContextBudgetOpen((open) => !open)}
                title="Task generation context budget"
                type="button"
              >
                <Database size={13} strokeWidth={2} />
                <span>{contextBudgetPercentLabel} task context</span>
              </button>
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
                  Encrypts the document, pins it to IPFS, and writes an immutable PFT context pointer.
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
                  <span className={`ctx-preview-state${historySync.status === "syncing" ? " is-active" : ""}`}>
                    {historySyncLabel}
                  </span>
                )}
                {!activeWalletAddress && (
                  <span className="ctx-preview-state">
                    Account context only
                  </span>
                )}
                <span className="ctx-versions-count">{versions.length} versions</span>
              </div>
            </header>
            {historySync?.lastError && (
              <div className="ctx-discover-message">{historySync.lastError}</div>
            )}
            {previewHydration.error && !previewHydration.active && (
              <div className="ctx-discover-message">{previewHydration.error}</div>
            )}
            {hydrateMessage && !hydratedContext?.text && <div className="ctx-discover-message">{hydrateMessage}</div>}
            <ol className="ctx-versions-list">
              {versions.map((version, index) => {
                const isCidCopied = copiedCid === version.cid;
                const cachedPreview = version.cid ? hydratedPreviewByCid[version.cid] : null;
                const previewState = version.cid ? previewStateByCid[version.cid] : null;
                const isPreviewing = Boolean(hydratedContext?.cid && version.cid && hydratedContext.cid === version.cid);
                const isRestoring = restoringVersionKey === version.key;
                const previewText =
                  cachedPreview?.preview ||
                  (version.type === "pointer"
                    ? walletVault?.unlocked
                      ? previewState?.status === "loading"
                        ? "Encrypted historical context preview is loading."
                        : previewState?.status === "queued"
                          ? "Encrypted historical context preview is queued."
                          : previewState?.status === "error"
                            ? previewState.message || "Preview could not be loaded. Click Restore to retry."
                            : "Click Restore to load this encrypted context preview."
                      : "Unlock the local seed vault to load this encrypted context preview."
                    : version.preview);
                const wordCount = cachedPreview?.wordCount || version.words || 0;
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
            <pre className="ctx-restore-preview">{contextPreviewText(hydratedContext.text, CONTEXT_DOCUMENT_MAX_CHARS)}</pre>
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


function SettingsModal({ chat, onAppStateChange, onClose, session, setTheme, theme }) {
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
            {page === "security" && <SecuritySettings onAppStateChange={onAppStateChange} session={session} />}
            {page === "data" && <DataSettings chat={chat} onAccountDeleted={onClose} onAppStateChange={onAppStateChange} session={session} />}
            {page === "billing" && <BillingSettings onAppStateChange={onAppStateChange} />}
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

function SecuritySettings({ onAppStateChange, session }) {
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
  const [confirmingUnlink, setConfirmingUnlink] = useState("");

  async function unlinkProvider(provider) {
    setPendingProvider(provider.id);
    setMessage("");
    try {
      const result = await requestJson("/api/account/unlink-provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, confirm: true }),
      });
      if (result.ok) {
        setMessage(result.body?.message || `${provider.label} unlinked.`);
        await onAppStateChange?.();
      } else {
        setMessage(
          result.body?.message || result.body?.error || `${provider.label} could not be unlinked.`
        );
      }
    } catch (error) {
      setMessage(error?.message || `${provider.label} could not be unlinked.`);
    } finally {
      setPendingProvider("");
      setConfirmingUnlink("");
    }
  }

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
      <IdentitySettings onAppStateChange={onAppStateChange} session={session} />
      {providers.length > 0 && (
        <section className="connected-accounts">
          <div className="connected-heading">
            <strong>Connected accounts</strong>
            <span>{linkedProviderCount} linked</span>
          </div>
          {providers.map((provider) => (
            <ConnectedAccountRow
              key={provider.id}
              confirmingUnlink={confirmingUnlink === provider.id}
              linkedProviders={linkedProviders}
              onLink={startProviderLink}
              onUnlink={unlinkProvider}
              onUnlinkConfirmChange={(open) => setConfirmingUnlink(open ? provider.id : "")}
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

function ConnectedAccountRow({
  confirmingUnlink = false,
  linkedProviders,
  onLink,
  onUnlink,
  onUnlinkConfirmChange,
  pending,
  provider,
  signedIn,
}) {
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
        <small>{confirmingUnlink ? `Unlink ${provider.label}? You can relink it later.` : status}</small>
      </div>
      {linked ? (
        confirmingUnlink ? (
          <span className="connected-unlink-confirm">
            <button disabled={pending} onClick={() => onUnlinkConfirmChange?.(false)} type="button">
              Keep
            </button>
            <button disabled={pending} onClick={() => onUnlink?.(provider)} type="button">
              {pending ? "Unlinking" : "Unlink"}
            </button>
          </span>
        ) : (
          <button disabled={!signedIn || pending} onClick={() => onUnlinkConfirmChange?.(true)} type="button">
            Disconnect
          </button>
        )
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

function TelegramProfileMenuRow({ linkedProvider, onClick, pending, provider, signedIn }) {
  const linked = Boolean(linkedProvider);
  const detail = linked
    ? linkedAccountStatus(linkedProvider)
    : provider?.enabled
      ? "Link Telegram to use Task Node from chat."
      : provider?.configured
        ? "Telegram linking is temporarily disabled."
        : "Telegram linking needs setup.";
  const status = linked
    ? "Linked"
    : pending
      ? "Checking"
      : provider?.enabled
        ? "Connect"
        : "Setup";

  return (
    <button
      className="telegram-menu-row"
      disabled={!signedIn || pending}
      onClick={onClick}
      type="button"
    >
      <span className="telegram-menu-icon">
        <ProviderIcon id="telegram" />
      </span>
      <span className="telegram-menu-copy">
        <strong>Telegram Chat</strong>
        <small>{detail}</small>
      </span>
      <span className={linked ? "telegram-menu-status linked" : "telegram-menu-status"}>
        {status}
      </span>
    </button>
  );
}

function linkedAccountStatus(provider) {
  if (provider.username) return `@${provider.username}`;
  if (provider.maskedEmail) return provider.maskedEmail;
  if (provider.email) return provider.email;
  return "Linked";
}

function accountLinkProvider(session, providerId) {
  const id = String(providerId || "").trim();
  return (
    (session?.accountLinks || []).find((provider) => provider?.id === id) || {
      id,
      label: "Telegram",
      startPath: `/api/auth/start/${id}`,
      configured: false,
      enabled: false,
    }
  );
}

function linkedProviderById(session, providerId) {
  const id = String(providerId || "").trim();
  return (session?.linkedProviders || []).find((provider) => provider?.id === id) || null;
}

function DataSettings({ chat, onAccountDeleted, onAppStateChange, session }) {
  const hiveConversation = chat?.hiveConversation || null;
  const hiveDisabled = hiveConversation?.disabled === true || hiveConversation?.enabled === false;
  const [hivePending, setHivePending] = useState(false);
  const [hiveMessage, setHiveMessage] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");

  async function enableHiveChat() {
    setHivePending(true);
    setHiveMessage("");
    try {
      const result = await requestJson("/api/hive/chat", { method: "POST" });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Hive Chat could not be enabled.");
      }
      setHiveMessage("Hive Chat enabled.");
      await onAppStateChange?.();
    } catch (error) {
      setHiveMessage(error?.message || "Hive Chat could not be enabled.");
    } finally {
      setHivePending(false);
    }
  }

  async function deleteAccount() {
    if (!isSignedInSession(session)) {
      setDeleteMessage("Sign in before deleting an account.");
      return;
    }
    const confirmed = window.confirm("Delete this Task Node account? This signs you out and releases the Hive handle.");
    if (!confirmed) return;

    setDeletePending(true);
    setDeleteMessage("");
    try {
      const result = await requestJson("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, reason: "data_controls_delete_account" }),
      });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Account deletion failed.");
      }
      await onAppStateChange?.();
      onAccountDeleted?.();
    } catch (error) {
      setDeleteMessage(error?.message || "Account deletion failed.");
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <SettingsLine desc="Allow your content to be used to improve Task Node." label="Improve the model for everyone" right={<ToggleSwitch initial />} />
      <SettingsLine
        desc={hiveDisabled ? "Restore the default Hive conversation in your chat sidebar." : "The default Hive conversation is active."}
        label="Hive Chat"
        right={
          hiveDisabled ? (
            <SmallPill disabled={hivePending} onClick={enableHiveChat}>
              {hivePending ? "Enabling" : "Re-enable"}
            </SmallPill>
          ) : (
            <SmallPill disabled>Enabled</SmallPill>
          )
        }
      />
      {hiveMessage && <div className="inline-message">{hiveMessage}</div>}
      <SettingsLine desc="Manage links you've shared from chats." label="Shared links" right={<SmallPill>Manage</SmallPill>} />
      <SettingsLine desc="Receive a copy of your conversations and PFT history." label="Export data" right={<SmallPill>Export</SmallPill>} />
      <SettingsLine desc="How Task Node handles your data." label="Privacy Policy" right={<SmallPill>View <ExternalLink size={11} /></SmallPill>} />
      <SettingsLine danger desc="Permanently remove your account and all associated data." label="Delete account" right={<SmallPill danger disabled={deletePending} onClick={deleteAccount}>{deletePending ? "Deleting" : "Delete"}</SmallPill>} />
      {deleteMessage && <div className="inline-message">{deleteMessage}</div>}
    </>
  );
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

function SmallPill({ children, danger, disabled, onClick }) {
  return (
    <button className={danger ? "small-pill danger" : "small-pill"} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function ToggleSwitch({ checked, disabled = false, initial, onChange }) {
  const controlled = checked !== undefined;
  const [on, setOn] = useState(Boolean(initial));
  const value = controlled ? Boolean(checked) : on;
  function toggle() {
    if (disabled) return;
    const nextValue = !value;
    if (!controlled) setOn(nextValue);
    onChange?.(nextValue);
  }
  return (
    <button
      aria-pressed={value}
      className={value ? "toggle-switch on" : "toggle-switch"}
      disabled={disabled}
      onClick={toggle}
      type="button"
    >
      <span />
    </button>
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

function LoginDialog({ authLoading = false, session, onClose, onSessionChange }) {
  const providers = (session?.accountLinks || []).filter((provider) =>
    ["telegram", "discord", "x", "github"].includes(provider.id) && provider.enabled
  );
  const providerDisplayState = loginProviderDisplayState({ authLoading, providers });
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
        {providerDisplayState === "loading" ? (
          <div className="login-loading-options" aria-live="polite">Checking login options</div>
        ) : (
          <>
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
          </>
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

createRoot(document.getElementById("root")).render(<App />);

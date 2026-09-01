import React from "react";
import { BookOpen, Brain, CandlestickChart, CreditCard, Database, Drama, Landmark, Lightbulb, ListTodo, Network, Settings as SettingsIcon, Shield, Sparkles, Trophy } from "lucide-react";
import { fetchAppState, requestJson } from "../api";
import { appExtensionRegistry } from "../extensions/index.js";
import { plainTextFromBlocks } from "../features/chat/chat-markdown";
import { isSignedInSession } from "../session";

export const fallbackConfig = window.__TASKNODE_CONFIG__ || {};
export function taskLifecycleDirectOffchain(config = {}) {
  return Boolean(config?.taskLifecycle?.offchainEnabled && !config?.taskLifecycle?.dualWrite);
}

export {
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_FILE_BYTES as CHAT_ATTACHMENT_MAX_BYTES,
} from "../../shared/chat-attachment-policy.js";
export const CHAT_PASTE_ATTACHMENT_THRESHOLD = 200;
export const CHAT_COMPOSER_MAX_HEIGHT = 220;
export const CHAT_SCROLL_BOTTOM_THRESHOLD = 96;
export const CHAT_PERSONA_ICONS = Object.freeze({
  odv: Sparkles,
  "odv-lindy": Sparkles,
  "trading-coach": CandlestickChart,
  jobs: Lightbulb,
  kravis: Landmark,
  brainstorming: Brain,
  motivation: Trophy,
  "five-mirrors": Drama,
  "i-ching": BookOpen,
  "sprint-planner": ListTodo,
  validator: Shield,
  "post-fiat-qa": Network,
});
export const TASK_REQUEST_CANONICAL_TEXT =
  "Request a task using my current context document, account memory, recent messages, and the additional task details I just provided.";
export const TASK_REQUEST_PLACEHOLDER = "Add any relevant details for your task request";
export const HIVE_CHAT_PLACEHOLDER = "Talk to Hive Chat";
export const HIVE_CHAT_TITLE = "Hive Chat";
export const CHAT_STARTER_PROMPTS = [
  "Help me build my context document",
  "Give me my first task",
  "How do I earn PFT?",
  "What should I do first?",
];
export const SIGNED_OUT_HELP_HISTORY_LIMIT = 10;
export const SIGNED_OUT_HELP_HISTORY_CHARS = 4000;
export const HIVE_CHAT_NOTIFICATION_REFRESH_MS = 20000;
export const ROUTE_CHUNK_RELOAD_COOLDOWN_MS = 30_000;
export const CHAT_ATTACHMENT_ACCEPT = [
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
export const serializeChatAttachments = (items = []) =>
  items.map(({ name, mimeType, size, source, dataUrl }) => ({ name, mimeType, size, source, dataUrl }));

export function textFromVisibleTurn(turn = {}) {
  if (turn.role === "user") return String(turn.text || "").trim();
  if (turn.role === "assistant") {
    return String(turn.text || plainTextFromBlocks(turn.blocks || []) || "").trim();
  }
  return "";
}

export function clientHistoryPayloadFromTurns(turns = []) {
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

export function routeLoadErrorText(error) {
  return `${error?.name || ""} ${error?.message || error || ""}`.toLowerCase();
}

export function isRouteChunkLoadError(error) {
  const text = routeLoadErrorText(error);
  return (
    text.includes("chunkloaderror") ||
    text.includes("failed to fetch dynamically imported module") ||
    text.includes("error loading dynamically imported module") ||
    text.includes("importing a module script failed") ||
    text.includes("loading chunk")
  );
}

export function shouldReloadForRouteChunkError() {
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

export class RouteErrorBoundary extends React.Component {
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

export function RouteErrorFallback({ error }) {
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

export function profileNftImageCandidates(nft = {}) {
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

export const EMPTY_TASKS = {
  outstanding: [],
  verification: [],
  refused: [],
  rewarded: [],
  sync: { status: "loading", projectionCount: 0 },
};

export function recordClientObservabilityEvent(payload = {}) {
  requestJson("/api/user-observability/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export const SETTINGS_PAGES = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "security", label: "Security", icon: Shield },
  { key: "data", label: "Data controls", icon: Database },
  { key: "billing", label: "Billing", icon: CreditCard },
];

export const APP_VIEWS = new Set([
  "chat", "tasks", "wallet", "context", "hive", "directory", "profile", "docs", "help",
  ...appExtensionRegistry.inventory().map(({ id }) => id),
]);
export const MORE_EXTENSION_VIEWS = new Set(
  appExtensionRegistry.inventory().filter(({ menu }) => menu === "more").map(({ id }) => id)
);
export const EMPTY_WALLET_VAULT_STATUS = {
  available: false,
  unlocked: false,
  accountId: null,
  address: null,
  publicKey: null,
  lastUnlockedAt: null,
  persistence: "unknown",
};
export const WALLET_BALANCE_REFRESH_MS = 1000;
export const WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS = 0;
export const WALLET_ACTIVITY_EVENT_NAME = "tasknode:wallet-activity";
export const TASK_ACTION_RECEIPTS_STORAGE_KEY = "tasknode_task_action_receipts";
export const AUTH_SESSION_HINT_STORAGE_KEY = "tasknode_auth_session_hint";
export const AUTH_SESSION_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function viewFromLocation() {
  if (typeof window === "undefined") return "chat";
  const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
  const pathParts = hashPath.split("?")[0].split("/").filter(Boolean);
  const hashView = (pathParts[0] || "").toLowerCase();
  // Before the encrypted library shipped, #docs/<wiki-slug> was the Help route.
  // New document IDs are UUIDs, so this protocol-level distinction preserves old links.
  if (hashView === "docs" && pathParts[1] && !/^[0-9a-f-]{36}$/i.test(pathParts[1])) return "help";
  return APP_VIEWS.has(hashView) ? hashView : "chat";
}

export function readAuthSessionHint(storage) {
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

export function writeAuthSessionHint(storage, session = null) {
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

export function clearAuthSessionHint(storage) {
  if (!storage) return;
  try {
    storage.removeItem(AUTH_SESSION_HINT_STORAGE_KEY);
  } catch {
    // Ignore blocked storage.
  }
}

export function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function fetchAppStateWithSessionRetry(options = {}) {
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

export function taskIdFromLocation() {
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

export function memberProfileAccountIdFromLocation(hashValue = null) {
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

export function writeViewLocation(nextView, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
  const url = new URL(window.location.href);
  if (normalizedView === "chat") {
    url.hash = "";
  } else if (normalizedView === "docs" || normalizedView === "help") {
    const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
    url.hash = hashPath.toLowerCase().startsWith(`${normalizedView}/`) ? hashPath : normalizedView;
  } else {
    url.hash = normalizedView;
  }

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (currentPath === nextPath) return;

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ tasknodeView: normalizedView }, "", nextPath);
}

export function writeTaskLocation(taskId, { replace = false } = {}) {
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

export function taskSelectionFingerprint(task = {}) {
  return [
    task?.taskId || task?.fullId || task?.id || "",
    task?.statusKey || task?.status || "",
    task?.updatedAt || "",
    task?.lastEventAt || "",
    task?.txHash || "",
    task?.metadata?.eventCount || "",
  ].join("|");
}

export function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
}

export function initialSidebarOpen() {
  return !isMobileViewport();
}


export function StatusBanner({ children, tone = "default" }) {
  return <div className={`status-banner ${tone}`}>{children}</div>;
}

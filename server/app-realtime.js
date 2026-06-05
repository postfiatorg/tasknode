import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import pg from "pg";
import { databaseEnabled, databaseUrl, query } from "./db/pool.js";

const { Client } = pg;
const REALTIME_CHANNEL = "tasknode_realtime";
const HEARTBEAT_MS = 25000;
const subscribersByAccount = new Map();
const localEvents = new EventEmitter();

let listener = null;
let listenerStarting = false;
let reconnectTimer = null;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safePayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function accountSubscribers(accountId = "") {
  const normalized = safeText(accountId, 180);
  if (!normalized) return null;
  let subscribers = subscribersByAccount.get(normalized);
  if (!subscribers) {
    subscribers = new Set();
    subscribersByAccount.set(normalized, subscribers);
  }
  return subscribers;
}

function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function deliverLocalRealtimeEvent(event = {}) {
  const accountId = safeText(event.accountId || event.account_id, 180);
  const type = safeText(event.type, 80);
  if (!accountId || !type) return { delivered: 0 };
  const subscribers = subscribersByAccount.get(accountId);
  if (!subscribers?.size) return { delivered: 0 };

  let delivered = 0;
  for (const subscriber of [...subscribers]) {
    const ok = writeSse(subscriber.res, type, {
      id: event.id || `rt_${randomUUID()}`,
      type,
      accountId,
      createdAt: event.createdAt || new Date().toISOString(),
      ...safePayload(event.payload),
    });
    if (ok) delivered += 1;
  }
  return { delivered };
}

function parseRealtimeNotification(payload = "") {
  try {
    const parsed = JSON.parse(String(payload || "{}"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function listenerConfig(env = process.env) {
  return {
    enabled: env.TASKNODE_REALTIME_EVENTS_ENABLED !== "false",
    reconnectMs: Math.min(Math.max(Number(env.TASKNODE_REALTIME_RECONNECT_MS || 5000), 1000), 60000),
  };
}

function scheduleRealtimeListenerReconnect({ logger = console, env = process.env } = {}) {
  const config = listenerConfig(env);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    listener = null;
    startRealtimeNotificationListener({ logger, env }).catch((error) => {
      logger.warn?.("realtime_notification_reconnect_failed", {
        error: error?.message || String(error),
      });
    });
  }, config.reconnectMs);
  reconnectTimer.unref?.();
}

export function subscribeRealtimeEvents({
  req,
  res,
  session,
  linkedWallet = null,
  headers = {},
} = {}) {
  const accountId = safeText(session?.accountId, 180);
  if (!accountId) return { ok: false, status: 401, error: "realtime_login_required" };

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    connection: "keep-alive",
    ...headers,
  });

  const subscriber = {
    id: `sse_${randomUUID()}`,
    accountId,
    res,
    createdAt: new Date().toISOString(),
    heartbeat: null,
  };
  const subscribers = accountSubscribers(accountId);
  subscribers.add(subscriber);

  writeSse(res, "connected", {
    ok: true,
    accountId,
    walletAddress: linkedWallet?.address || "",
    createdAt: subscriber.createdAt,
  });
  subscriber.heartbeat = setInterval(() => {
    writeSse(res, "heartbeat", { ok: true, at: new Date().toISOString() });
  }, HEARTBEAT_MS);
  subscriber.heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(subscriber.heartbeat);
    subscribers.delete(subscriber);
    if (subscribers.size === 0) subscribersByAccount.delete(accountId);
  };
  req?.on?.("close", cleanup);
  res?.on?.("close", cleanup);

  return { ok: true, subscriberId: subscriber.id };
}

export async function publishRealtimeEvent(event = {}, { notify = true, local = true } = {}) {
  const normalized = {
    id: safeText(event.id, 180) || `rt_${randomUUID()}`,
    type: safeText(event.type, 80),
    accountId: safeText(event.accountId || event.account_id, 180),
    createdAt: event.createdAt || new Date().toISOString(),
    payload: safePayload(event.payload),
  };
  if (!normalized.type || !normalized.accountId) {
    return { ok: false, error: "realtime_event_target_required" };
  }

  let delivered = 0;
  if (local) {
    delivered = deliverLocalRealtimeEvent(normalized).delivered;
    localEvents.emit("event", normalized);
  }

  if (notify && databaseEnabled()) {
    await query("SELECT pg_notify($1, $2)", [REALTIME_CHANNEL, JSON.stringify(normalized)]);
  }

  return { ok: true, delivered, event: normalized };
}

export function publishWalletActivityEvent({
  accountId = "",
  walletAddress = "",
  txHash = "",
  ledgerIndex = null,
  source = "",
} = {}, options = {}) {
  return publishRealtimeEvent({
    type: "wallet_activity",
    accountId,
    payload: {
      walletAddress: safeText(walletAddress, 120),
      txHash: safeText(txHash, 180),
      ledgerIndex,
      source: safeText(source, 80),
    },
  }, options);
}

export async function startRealtimeNotificationListener({ env = process.env, logger = console } = {}) {
  const config = listenerConfig(env);
  if (!config.enabled) return { started: false, reason: "disabled" };
  if (!databaseEnabled()) return { started: false, reason: "database_not_configured" };
  if (listener || listenerStarting) return { started: false, reason: "already_started" };

  listenerStarting = true;
  const client = new Client({
    connectionString: databaseUrl(),
    application_name: "tasknode_realtime_listener",
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${REALTIME_CHANNEL}`);
    client.on("notification", (message) => {
      const event = parseRealtimeNotification(message.payload);
      if (event) deliverLocalRealtimeEvent(event);
    });
    client.on("error", (error) => {
      logger.warn?.("realtime_notification_listener_error", {
        error: error?.message || String(error),
      });
      scheduleRealtimeListenerReconnect({ logger, env });
    });
    client.on("end", () => scheduleRealtimeListenerReconnect({ logger, env }));
    listener = client;
    return { started: true, channel: REALTIME_CHANNEL };
  } catch (error) {
    try {
      await client.end();
    } catch {
      // Ignore cleanup failures while surfacing listener startup failure.
    }
    throw error;
  } finally {
    listenerStarting = false;
  }
}

export function realtimeSubscriberCount(accountId = "") {
  if (!accountId) {
    return [...subscribersByAccount.values()].reduce((total, subscribers) => total + subscribers.size, 0);
  }
  return subscribersByAccount.get(safeText(accountId, 180))?.size || 0;
}

export function onceLocalRealtimeEvent() {
  return new Promise((resolve) => localEvents.once("event", resolve));
}

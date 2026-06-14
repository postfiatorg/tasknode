import * as keypairs from "ripple-keypairs";
import { messageToHex } from "../server/wallet-proof.js";

const baseUrl = (process.env.TASKNODE_AGENT_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const seed = String(process.env.TASKNODE_AGENT_WALLET_SEED || "").trim();
const creditToken = String(process.env.TASKNODE_AGENT_CLIENT_CREDIT_TOKEN || "").trim();

function assertLocalBaseUrl(value = "") {
  const url = new URL(value);
  const local = new Set(["localhost", "127.0.0.1", "::1"]);
  if (local.has(url.hostname)) return;
  if (process.env.TASKNODE_AGENT_ALLOW_NONLOCAL === "true") return;
  throw new Error("agent_wallet_login_client_refuses_nonlocal_base_url");
}

function deriveAgentWallet(seedValue) {
  if (!seedValue) throw new Error("TASKNODE_AGENT_WALLET_SEED is required");
  const keypair = keypairs.deriveKeypair(seedValue);
  return {
    address: keypairs.deriveAddress(keypair.publicKey),
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
  };
}

function signMessage(privateKey, message) {
  return keypairs.sign(messageToHex(message), privateKey);
}

function sessionCookie(setCookie = "") {
  const match = String(setCookie || "").match(/(?:^|,\s*)(tasknode_session=[^;,]+)/);
  if (!match) throw new Error("tasknode_session_cookie_missing");
  return match[1];
}

async function requestJson(path, { method = "GET", cookie = "", token = "", body } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `http_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: payload,
  };
}

function summarizeGates(gates = []) {
  return Array.isArray(gates)
    ? gates.map((gate) => `${gate.id || gate.label || "gate"}:${gate.status || gate.state || "unknown"}`).join(", ")
    : "";
}

assertLocalBaseUrl(baseUrl);
const wallet = deriveAgentWallet(seed);

const started = await requestJson("/api/auth/wallet/start", {
  method: "POST",
  body: { address: wallet.address, publicKey: wallet.publicKey },
});
const signature = signMessage(wallet.privateKey, started.body.challenge.message);
const verified = await requestJson("/api/auth/wallet/verify", {
  method: "POST",
  body: {
    challengeId: started.body.challenge.id,
    address: wallet.address,
    publicKey: wallet.publicKey,
    signature,
  },
});
const cookie = sessionCookie(verified.headers.get("set-cookie"));
const accountId = verified.body.accountId;

if (creditToken) {
  await requestJson("/api/usage/credit/admin", {
    method: "POST",
    token: creditToken,
    body: {
      accountId,
      amountUsd: 5,
      idempotencyKey: `agent_wallet_login_client_${accountId}_${Date.now()}`,
      note: "Local agent wallet login proof credit",
      actor: "agent_wallet_login_client",
    },
  });
}

const tasks = await requestJson("/api/tasks", { cookie });
const networkTasks = tasks.body.networkTasks || {};
console.log(`eligibility status: ${networkTasks.status || "unknown"} (${networkTasks.label || "unlabeled"})`);
console.log(`eligibility gates: ${summarizeGates(networkTasks.gates) || "none"}`);

const conversationId = `account_${accountId}_agent_wallet_login`;
const chat = await requestJson("/api/chat/send", {
  method: "POST",
  cookie,
  body: {
    message: "hello",
    mode: "Help",
    conversationId,
  },
});
console.log(`chat reply: ${String(chat.body.assistant?.body || chat.body.message || "").replace(/\s+/g, " ").slice(0, 500)}`);

const hive = await requestJson("/api/hive/context", {
  method: "POST",
  cookie,
  body: {
    body: "What can I work on?",
    conversationId: `account_${accountId}_hive`,
  },
});
console.log(`hive reply: ${String(hive.body.assistant?.body || hive.body.message || "").replace(/\s+/g, " ").slice(0, 500)}`);
console.log(`agent wallet login complete: accountId=${accountId} address=${wallet.address}`);

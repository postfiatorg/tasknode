// Finance Hub model agent. An allowlisted operator (TASKNODE_FINANCE_AGENT_ACCOUNTS: account ids or linked wallet
// addresses) chats with a DeepSeek agent about one company model. Task Node only stores the conversation; the agent
// runs on the model host, which pulls work with a service token (TASKNODE_FINANCE_AGENT_WORKER_TOKEN). The agent
// reads a sealed copy of the model and may propose a change; a proposal applies only after the operator approves it.
// Every route refuses anyone not on the allowlist, so the Finance Hub shows the panel only when the server says so.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { query, transaction } from "./db/pool.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";

const ROOT = "/api/finance-agent";
const MODEL_ID = /^(HUB|[A-Z0-9][A-Z0-9._-]{0,15})$/;
const MESSAGE_STALE_MINUTES = 40;
const PROPOSAL_STALE_MINUTES = 120;
const MESSAGES_PER_HOUR = 60;
const MAX_PROPOSALS = 5;

const failure = (message, status) => Object.assign(new Error(message), { status });
const text = (value, max) => String(value ?? "").trim().slice(0, max);
const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "")}`;

export function financeAgentAllowlist(env = process.env) {
  return new Set(String(env.TASKNODE_FINANCE_AGENT_ACCOUNTS || "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

export async function financeAgentAllowed(session, { env = process.env, linkedWallet = getLinkedWallet } = {}) {
  const accountId = session?.accountId || "";
  const allowed = financeAgentAllowlist(env);
  if (!accountId || !allowed.size) return false;
  if (allowed.has(accountId)) return true;
  const wallet = await linkedWallet({ accountId }).catch(() => null);
  return wallet?.status === "linked" && Boolean(wallet.address) && allowed.has(wallet.address);
}

export function financeAgentWorkerAuthorized(header = "", env = process.env) {
  const expected = String(env.TASKNODE_FINANCE_AGENT_WORKER_TOKEN || "");
  const value = String(header || "").trim();
  const actual = value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
  if (!expected || !actual) return false;
  const digest = (input) => createHash("sha256").update(input).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

const threadView = (row) => row && ({ id: row.id, model: row.model, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });
const messageView = (row) => ({
  id: row.id, role: row.role, content: row.content, status: row.status, progress: row.progress, replyTo: row.reply_to,
  context: row.context_json || {}, costUsd: row.cost_usd == null ? null : Number(row.cost_usd), meta: row.meta_json || {},
  createdAt: row.created_at, completedAt: row.completed_at,
});
const proposalView = (row) => ({
  id: row.id, threadId: row.thread_id, messageId: row.message_id, model: row.model, status: row.status,
  proposal: row.payload_json || {}, result: row.result_json || {}, decidedBy: row.decided_by, decidedAt: row.decided_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export function createFinanceAgentStore(db = { query, transaction }) {
  async function ownedThread(accountId, threadId) {
    const row = (await db.query(`SELECT * FROM finance_agent_threads WHERE id=$1 AND account_id=$2`, [threadId, accountId])).rows[0];
    if (!row) throw failure("finance_agent_thread_not_found", 404);
    return row;
  }
  async function threadDetail(threadId) {
    const [thread, messages, proposals] = await Promise.all([
      db.query(`SELECT * FROM finance_agent_threads WHERE id=$1`, [threadId]),
      db.query(`SELECT * FROM finance_agent_messages WHERE thread_id=$1 ORDER BY created_at, id`, [threadId]),
      db.query(`SELECT * FROM finance_agent_proposals WHERE thread_id=$1 ORDER BY created_at, id`, [threadId]),
    ]);
    return { thread: threadView(thread.rows[0]), messages: messages.rows.map(messageView), proposals: proposals.rows.map(proposalView) };
  }
  return {
    threadDetail,
    async listThreads(accountId, model) {
      const rows = (await db.query(
        `SELECT t.*, (SELECT count(*) FROM finance_agent_messages m WHERE m.thread_id=t.id)::int AS message_count,
                (SELECT count(*) FROM finance_agent_proposals p WHERE p.thread_id=t.id AND p.status='pending')::int AS pending
           FROM finance_agent_threads t WHERE t.account_id=$1 AND ($2::text IS NULL OR t.model=$2)
          ORDER BY t.updated_at DESC LIMIT 200`, [accountId, model || null])).rows;
      return rows.map((row) => ({ ...threadView(row), messageCount: row.message_count, pendingProposals: row.pending }));
    },
    async createThread(accountId, model, title = "") {
      const id = newId("fat");
      await db.query(`INSERT INTO finance_agent_threads (id, account_id, model, title) VALUES ($1,$2,$3,$4)`, [id, accountId, model, title]);
      return threadDetail(id);
    },
    async getThread(accountId, threadId) {
      await ownedThread(accountId, threadId);
      return threadDetail(threadId);
    },
    async addMessage(accountId, threadId, content, context = {}) {
      const thread = await ownedThread(accountId, threadId);
      const recent = (await db.query(
        `SELECT count(*)::int AS n FROM finance_agent_messages m JOIN finance_agent_threads t ON t.id=m.thread_id
          WHERE t.account_id=$1 AND m.role='user' AND m.created_at > now() - interval '1 hour'`, [accountId])).rows[0]?.n || 0;
      if (recent >= MESSAGES_PER_HOUR) throw failure("finance_agent_rate_limited", 429);
      const busy = (await db.query(`SELECT 1 FROM finance_agent_messages WHERE thread_id=$1 AND role='agent' AND status IN ('queued','running') LIMIT 1`, [threadId])).rows[0];
      if (busy) throw failure("finance_agent_busy", 409);
      const userId = newId("fam"), agentId = newId("fam");
      await db.transaction(async (client) => {
        await client.query(`INSERT INTO finance_agent_messages (id, thread_id, role, content, context_json, status) VALUES ($1,$2,'user',$3,$4,'done')`,
          [userId, threadId, content, JSON.stringify(context || {})]);
        await client.query(`INSERT INTO finance_agent_messages (id, thread_id, role, status, reply_to, progress, created_at)
                            VALUES ($1,$2,'agent','queued',$3,'Queued for the model agent', now() + interval '1 millisecond')`, [agentId, threadId, userId]);
        await client.query(`UPDATE finance_agent_threads SET updated_at=now(), title=CASE WHEN title='' THEN $2 ELSE title END WHERE id=$1`,
          [threadId, content.replace(/\s+/g, " ").slice(0, 90)]);
      });
      return { ...(await threadDetail(threadId)), model: thread.model };
    },
    async decide(accountId, proposalId, decision) {
      const row = (await db.query(
        `SELECT p.* FROM finance_agent_proposals p JOIN finance_agent_threads t ON t.id=p.thread_id WHERE p.id=$1 AND t.account_id=$2`,
        [proposalId, accountId])).rows[0];
      if (!row) throw failure("finance_agent_proposal_not_found", 404);
      if (row.status !== "pending") throw failure("finance_agent_proposal_already_decided", 409);
      await db.query(`UPDATE finance_agent_proposals SET status=$2, decided_by=$3, decided_at=now(), updated_at=now() WHERE id=$1 AND status='pending'`,
        [proposalId, decision === "approve" ? "approved" : "rejected", accountId]);
      await db.query(`UPDATE finance_agent_threads SET updated_at=now() WHERE id=$1`, [row.thread_id]);
      return threadDetail(row.thread_id);
    },
    // Worker side: an approved proposal first (the operator is waiting on it), then the oldest queued question.
    async claim() {
      return db.transaction(async (client) => {
        const proposal = (await client.query(
          `SELECT * FROM finance_agent_proposals
            WHERE status='approved' OR (status='applying' AND claimed_at < now() - ($1 || ' minutes')::interval)
            ORDER BY decided_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [String(PROPOSAL_STALE_MINUTES)])).rows[0];
        if (proposal) {
          await client.query(`UPDATE finance_agent_proposals SET status='applying', claimed_at=now(), updated_at=now() WHERE id=$1`, [proposal.id]);
          const thread = (await client.query(`SELECT * FROM finance_agent_threads WHERE id=$1`, [proposal.thread_id])).rows[0];
          return { kind: "proposal", proposal: proposalView({ ...proposal, status: "applying" }), thread: threadView(thread) };
        }
        const message = (await client.query(
          `SELECT * FROM finance_agent_messages
            WHERE role='agent' AND (status='queued' OR (status='running' AND claimed_at < now() - ($1 || ' minutes')::interval))
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [String(MESSAGE_STALE_MINUTES)])).rows[0];
        if (!message) return null;
        await client.query(`UPDATE finance_agent_messages SET status='running', claimed_at=now(), progress='Starting the model agent' WHERE id=$1`, [message.id]);
        const thread = (await client.query(`SELECT * FROM finance_agent_threads WHERE id=$1`, [message.thread_id])).rows[0];
        const history = (await client.query(
          `SELECT * FROM finance_agent_messages WHERE thread_id=$1 AND created_at <= $2 AND id <> $3 ORDER BY created_at, id`,
          [message.thread_id, message.created_at, message.id])).rows.map(messageView);
        const proposals = (await client.query(`SELECT * FROM finance_agent_proposals WHERE thread_id=$1 ORDER BY created_at`, [message.thread_id])).rows.map(proposalView);
        return { kind: "message", message: messageView({ ...message, status: "running" }), thread: threadView(thread), history, proposals };
      });
    },
    async progress(messageId, progress) {
      await db.query(`UPDATE finance_agent_messages SET progress=$2 WHERE id=$1 AND status='running'`, [messageId, progress]);
      return { ok: true };
    },
    async complete(messageId, { content, costUsd = null, meta = {}, proposals = [] }) {
      return db.transaction(async (client) => {
        const message = (await client.query(`SELECT * FROM finance_agent_messages WHERE id=$1 FOR UPDATE`, [messageId])).rows[0];
        if (!message || message.role !== "agent") throw failure("finance_agent_message_not_found", 404);
        if (message.status !== "running") throw failure("finance_agent_message_not_running", 409);
        await client.query(
          `UPDATE finance_agent_messages SET content=$2, status='done', progress='', cost_usd=$3, meta_json=$4, completed_at=now() WHERE id=$1`,
          [messageId, content, costUsd, JSON.stringify(meta || {})]);
        const thread = (await client.query(`SELECT * FROM finance_agent_threads WHERE id=$1`, [message.thread_id])).rows[0];
        const created = [];
        for (const payload of proposals.slice(0, MAX_PROPOSALS)) {
          const id = newId("fap");
          await client.query(`INSERT INTO finance_agent_proposals (id, thread_id, message_id, model, payload_json) VALUES ($1,$2,$3,$4,$5)`,
            [id, message.thread_id, messageId, thread.model, JSON.stringify(payload)]);
          created.push(id);
        }
        await client.query(`UPDATE finance_agent_threads SET updated_at=now() WHERE id=$1`, [message.thread_id]);
        return { ok: true, proposals: created };
      });
    },
    async fail(messageId, error) {
      await db.query(`UPDATE finance_agent_messages SET status='failed', progress='', content=$2, completed_at=now() WHERE id=$1 AND status IN ('queued','running')`,
        [messageId, error]);
      return { ok: true };
    },
    async proposalResult(proposalId, { status, result = {}, message = "" }) {
      return db.transaction(async (client) => {
        const row = (await client.query(`SELECT * FROM finance_agent_proposals WHERE id=$1 FOR UPDATE`, [proposalId])).rows[0];
        if (!row) throw failure("finance_agent_proposal_not_found", 404);
        if (row.status !== "applying") throw failure("finance_agent_proposal_not_applying", 409);
        await client.query(`UPDATE finance_agent_proposals SET status=$2, result_json=$3, updated_at=now() WHERE id=$1`,
          [proposalId, status, JSON.stringify(result || {})]);
        if (message) {
          await client.query(`INSERT INTO finance_agent_messages (id, thread_id, role, content, status, meta_json, completed_at)
                              VALUES ($1,$2,'agent',$3,'done',$4,now())`,
            [newId("fam"), row.thread_id, message, JSON.stringify({ proposalId, kind: "proposal_result" })]);
        }
        await client.query(`UPDATE finance_agent_threads SET updated_at=now() WHERE id=$1`, [row.thread_id]);
        return { ok: true };
      });
    },
  };
}

function modelParam(value) {
  const model = text(value, 16).toUpperCase();
  if (!MODEL_ID.test(model)) throw failure("finance_agent_model_invalid", 400);
  return model;
}

export function createFinanceAgentRouteHandler({ store = createFinanceAgentStore(), allowed = financeAgentAllowed,
  workerAuthorized = financeAgentWorkerAuthorized, env = process.env } = {}) {
  return async function handleFinanceAgentRoute({ json, readJson, req, res, session, url }) {
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    res.setHeader("Cache-Control", "no-store");
    const parts = url.pathname.slice(ROOT.length + 1).split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] === "worker") {
        if (!workerAuthorized(req.headers.authorization || "", env)) throw failure("finance_agent_worker_unauthorized", 401);
        if (req.method !== "POST") throw failure("finance_agent_method_not_allowed", 405);
        const body = await readJson(req, 512 * 1024);
        if (parts[1] === "claim" && parts.length === 2) { json(res, 200, { ok: true, job: await store.claim() }); return true; }
        if (parts[1] === "progress") { json(res, 200, await store.progress(text(body.id, 80), text(body.progress, 300))); return true; }
        if (parts[1] === "complete") {
          const proposals = Array.isArray(body.proposals) ? body.proposals.filter((p) => p && typeof p === "object") : [];
          json(res, 200, await store.complete(text(body.id, 80), { content: text(body.content, 60_000), costUsd: Number.isFinite(body.costUsd) ? body.costUsd : null,
            meta: body.meta && typeof body.meta === "object" ? body.meta : {}, proposals }));
          return true;
        }
        if (parts[1] === "fail") { json(res, 200, await store.fail(text(body.id, 80), text(body.error, 4000) || "The model agent failed.")); return true; }
        if (parts[1] === "proposal-result") {
          const status = body.status === "applied" ? "applied" : "failed";
          json(res, 200, await store.proposalResult(text(body.id, 80), { status, result: body.result && typeof body.result === "object" ? body.result : {}, message: text(body.message, 20_000) }));
          return true;
        }
        throw failure("finance_agent_not_found", 404);
      }
      if (!session?.accountId) throw failure("finance_agent_login_required", 401);
      if (!(await allowed(session, { env }))) throw failure("finance_agent_forbidden", 403);
      const accountId = session.accountId;
      if (parts[0] === "access" && parts.length === 1 && req.method === "GET") { json(res, 200, { ok: true, allowed: true }); return true; }
      if (parts[0] === "threads" && parts.length === 1) {
        if (req.method === "GET") {
          const model = url.searchParams.get("model");
          json(res, 200, { ok: true, threads: await store.listThreads(accountId, model ? modelParam(model) : null) });
          return true;
        }
        if (req.method === "POST") {
          const body = await readJson(req, 4096);
          json(res, 201, { ok: true, ...(await store.createThread(accountId, modelParam(body.model), text(body.title, 120))) });
          return true;
        }
      }
      if (parts[0] === "threads" && parts[1] && parts.length === 2 && req.method === "GET") {
        json(res, 200, { ok: true, ...(await store.getThread(accountId, parts[1])) });
        return true;
      }
      if (parts[0] === "messages" && parts.length === 1 && req.method === "POST") {
        const body = await readJson(req, 64 * 1024);
        const content = text(body.text, 8000);
        if (!content) throw failure("finance_agent_message_empty", 400);
        const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context : {};
        json(res, 202, { ok: true, ...(await store.addMessage(accountId, text(body.threadId, 80), content, context)) });
        return true;
      }
      if (parts[0] === "decisions" && parts.length === 1 && req.method === "POST") {
        const body = await readJson(req, 4096);
        if (!["approve", "reject"].includes(body.decision)) throw failure("finance_agent_decision_invalid", 400);
        json(res, 200, { ok: true, ...(await store.decide(accountId, text(body.proposalId, 80), body.decision)) });
        return true;
      }
      throw failure("finance_agent_not_found", 404);
    } catch (error) {
      json(res, Number(error.status || 500), { ok: false, error: error.status ? error.message : "finance_agent_unavailable" });
    }
    return true;
  };
}

export const handleFinanceAgentRoute = createFinanceAgentRouteHandler();

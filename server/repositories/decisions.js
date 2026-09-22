import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { publicMessage } from "./context-rewrite-projection.js";
import { getContextDocument } from "./context.js";
import { getChatMemoryContext } from "./chat-memory.js";
import { buildDecisionContext } from "../decision-context.js";

const terminal = new Set(["completed", "failed"]);
const error = (message, status) => Object.assign(new Error(message), { status });

export function decisionProjection(row) {
  const progress = row.progress_json || {};
  const decision = {
    jobId: row.id, status: row.status, stage: row.stage, mode: "budget",
    contextIncluded: row.context_included, markdown: row.report_markdown || "",
    contextSnapshot: row.context_snapshot_json || null,
    completedCalls: progress.completed_calls || 0, totalCalls: 10,
    researchProgress: progress.research_progress || [],
    selected: progress.selected || "", voteCounts: progress.vote_counts || {}, error: row.error || "",
  };
  const stageNames = { starting: "Connecting to Corbanu", framing: "Defining five options", planning_research: "Planning research",
    researching: "Researching the options", voting: "Collecting three votes", drafting: "Writing the report",
    mini_tih: "Reviewing the draft", rewriting: "Kimi K3 is rewriting the report", completed: "Decision report ready" };
  return {
    job: { id: row.id, conversationId: row.conversation_id, gatewayJobId: row.gateway_job_id || "",
      status: row.status, stage: row.stage, error: row.error || "", createdAt: row.created_at, updatedAt: row.updated_at },
    body: row.status === "completed" ? row.report_markdown : row.status === "failed"
      ? row.error || "The decision did not complete. Completed work is saved in the packet."
      : `${stageNames[row.stage] || "Decision running"}. You can leave and return to this chat.`,
    metadata: { kind: "decision", decision },
  };
}

async function project(client, row) {
  const view = decisionProjection(row);
  const saved = await client.query(`UPDATE chat_messages SET body=$3,metadata_json=$4 WHERE id=$1 AND account_id=$2 RETURNING *`,
    [row.assistant_message_id, row.account_id, view.body, view.metadata]);
  return { job: view.job, assistant: publicMessage(saved.rows[0]) };
}

export async function createDecisionJob({ accountId, conversationId, input, requestId, includeContext = true }, { loadContext = getContextDocument, loadMemories = getChatMemoryContext } = {}) {
  if (!databaseEnabled()) throw error("decisions_database_required", 503);
  const fingerprint = createHash("sha256").update(JSON.stringify({ conversationId, input, includeContext })).digest("hex");
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`decision-create:${accountId}:${requestId}`]);
    const existing = (await client.query("SELECT * FROM decision_jobs WHERE account_id=$1 AND request_id=$2 FOR UPDATE", [accountId, requestId])).rows[0];
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw error("decision_request_id_conflict", 409);
      const user = (await client.query("SELECT * FROM chat_messages WHERE id=$1 AND account_id=$2", [existing.question_message_id, accountId])).rows[0];
      return { ...await project(client, existing), user: publicMessage(user), record: existing };
    }
    const [document, memory] = includeContext
      ? await Promise.all([loadContext({ accountId }), loadMemories({ accountId, deepLimit: 3, turnLimit: 36 })])
      : [null, null];
    const context = buildDecisionContext({ input, document, memory });
    const id = `decision_${randomUUID()}`, userId = `msg_${randomUUID()}`, assistantId = `msg_${randomUUID()}`;
    const title = input.slice(0, 120), now = new Date();
    const conversation = await client.query(`INSERT INTO chat_conversations
      (id,account_id,title,status,mode,created_at,updated_at,last_message_at,last_message_preview,message_count)
      VALUES($1,$2,$3,'active','Decisions',$4,$4,$4,'Decision queued.',2)
      ON CONFLICT(id) DO UPDATE SET status='active',updated_at=$4,last_message_at=$4,
        last_message_preview='Decision queued.',message_count=chat_conversations.message_count+2,deleted_at=NULL
      WHERE chat_conversations.account_id=$2 RETURNING id`, [conversationId, accountId, title, now]);
    if (!conversation.rows.length) throw error("chat_conversation_not_found", 404);
    const row = (await client.query(`INSERT INTO decision_jobs
      (id,account_id,conversation_id,request_id,request_fingerprint,question_message_id,assistant_message_id,input,context_included,context_snapshot_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, accountId, conversationId, requestId, fingerprint, userId, assistantId, context.input, context.included, context.snapshot])).rows[0];
    const view = decisionProjection(row);
    const user = await client.query(`INSERT INTO chat_messages(id,conversation_id,account_id,role,body,mode,created_at,metadata_json)
      VALUES($1,$2,$3,'user',$4,'Decisions',$5,$6) RETURNING *`,
    [userId, conversationId, accountId, input, now, { kind: "decision_question", contextIncluded: context.included, contextSnapshot: context.snapshot }]);
    const assistant = await client.query(`INSERT INTO chat_messages(id,conversation_id,account_id,role,body,mode,created_at,metadata_json)
      VALUES($1,$2,$3,'assistant',$4,'Decisions',$5,$6) RETURNING *`, [assistantId, conversationId, accountId, view.body, now, view.metadata]);
    return { job: view.job, user: publicMessage(user.rows[0]), assistant: publicMessage(assistant.rows[0]), record: row };
  });
}

export async function getDecisionJob({ accountId, jobId }) {
  const row = (await query("SELECT * FROM decision_jobs WHERE id=$1 AND account_id=$2", [jobId, accountId])).rows[0];
  if (!row) return null;
  const assistant = (await query("SELECT * FROM chat_messages WHERE id=$1 AND account_id=$2", [row.assistant_message_id, accountId])).rows[0];
  return { job: decisionProjection(row).job, assistant: publicMessage(assistant), record: row };
}

export async function updateDecisionJob({ accountId, jobId, remote, markdown = "" }) {
  if (!["queued", "running", "completed", "failed"].includes(remote?.status)) throw error("decision_invalid_status", 502);
  if (remote.status === "completed" && !markdown.trim()) throw error("decision_report_missing", 502);
  return transaction(async client => {
    const current = (await client.query("SELECT * FROM decision_jobs WHERE id=$1 AND account_id=$2 FOR UPDATE", [jobId, accountId])).rows[0];
    if (!current) throw error("decision_not_found", 404);
    if (terminal.has(current.status)) return { ...await project(client, current), record: current };
    const row = (await client.query(`UPDATE decision_jobs SET gateway_job_id=COALESCE(gateway_job_id,$3),status=$4,stage=$5,
      progress_json=$6,report_markdown=$7,error=$8,updated_at=now(),completed_at=CASE WHEN $9 THEN now() ELSE NULL END
      WHERE id=$1 AND account_id=$2 RETURNING *`,
    [jobId, accountId, remote.id || null, remote.status, remote.stage || remote.status, remote,
      markdown, String(remote.error || "").slice(0, 1000), terminal.has(remote.status)])).rows[0];
    return { ...await project(client, row), record: row };
  });
}

import { randomUUID } from "node:crypto";

import { databaseEnabled, query, transaction } from "../db/pool.js";
import { publicMessage, safeText } from "./context-rewrite-projection.js";

const modeName = "Deep Research";
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function normalizedStatus(value = "") {
  const status = safeText(value, 80).toLowerCase();
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return status || "running";
}

function metadataForJob(row = {}) {
  const result = row.result_json && typeof row.result_json === "object" ? row.result_json : {};
  const usage = row.usage_json && typeof row.usage_json === "object" ? row.usage_json : {};
  const progress = row.progress_json && typeof row.progress_json === "object" ? row.progress_json : {};
  const status = normalizedStatus(row.status);
  return {
    kind: "deep_research",
    deepResearch: {
      jobId: row.id || "",
      gatewayJobId: row.gateway_job_id || "",
      status,
      stage: safeText(row.stage || status, 80),
      title: safeText(result.title || row.title || "Deep Research", 500),
      markdown: typeof result.markdown === "string" ? result.markdown : "",
      sourceManifest: typeof result.source_manifest === "string" ? result.source_manifest : "",
      filename: `deep-research-${safeText(row.id, 36) || "report"}.md`,
      progress,
      usage,
      error: safeText(row.error, 1000),
      privacy: "Provider-backed web research",
    },
  };
}

function assistantBody(row = {}) {
  const status = normalizedStatus(row.status);
  if (status === "completed") return "Deep Research report ready.";
  if (status === "failed") return safeText(row.error, 1000) || "Deep Research failed before producing a report.";
  if (status === "cancelled") return "Deep Research cancelled.";
  const stage = safeText(row.stage || status, 80).replaceAll("_", " ");
  return `Deep Research ${stage}. This can take a while; you can leave and return to this chat.`;
}

function publicJob(row = {}) {
  return {
    id: row.id || "",
    gatewayJobId: row.gateway_job_id || "",
    accountId: row.account_id || "",
    conversationId: row.conversation_id || "",
    status: normalizedStatus(row.status),
    stage: safeText(row.stage, 80),
    usage: row.usage_json || {},
    progress: row.progress_json || {},
    error: safeText(row.error, 1000),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
  };
}

export async function createDeepResearchJob({
  accountId = "",
  conversationId = "",
  question = "",
  title = "",
  requestId = "",
} = {}) {
  if (!databaseEnabled()) throw Object.assign(new Error("deep_research_database_required"), { status: 409 });
  const owner = safeText(accountId, 180);
  const conversation = safeText(conversationId, 180);
  const prompt = safeText(question, 50_000);
  const idempotency = safeText(requestId, 180);
  if (!owner) throw Object.assign(new Error("deep_research_login_required"), { status: 401 });
  if (!conversation || !prompt || !idempotency) {
    throw Object.assign(new Error("deep_research_input_required"), { status: 400 });
  }

  return transaction(async (client) => {
    const existingJob = await client.query(
      "SELECT * FROM deep_research_jobs WHERE account_id=$1 AND request_id=$2 FOR UPDATE",
      [owner, idempotency],
    );
    if (existingJob.rows[0]) {
      const row = existingJob.rows[0];
      const messages = await client.query(
        "SELECT * FROM chat_messages WHERE id=ANY($1::text[]) ORDER BY message_order",
        [[row.question_message_id, row.assistant_message_id]],
      );
      return {
        created: false,
        job: publicJob(row),
        user: publicMessage(messages.rows.find(item => item.id === row.question_message_id)),
        assistant: publicMessage(messages.rows.find(item => item.id === row.assistant_message_id)),
      };
    }

    const conversationRow = await client.query(
      "SELECT account_id FROM chat_conversations WHERE id=$1 FOR UPDATE",
      [conversation],
    );
    if (conversationRow.rows[0] && conversationRow.rows[0].account_id !== owner) {
      throw Object.assign(new Error("chat_conversation_not_found"), { status: 404 });
    }

    const jobId = `dr_${randomUUID()}`;
    const userMessageId = `msg_${randomUUID()}_deep_research_user`;
    const assistantMessageId = `msg_${randomUUID()}_deep_research_assistant`;
    const now = new Date();
    await client.query(
      `
        INSERT INTO chat_conversations (
          id,account_id,title,status,mode,created_at,updated_at,last_message_at,last_message_preview,message_count
        )
        VALUES($1,$2,$3,'active',$4,$5,$5,$5,$6,2)
        ON CONFLICT(id) DO UPDATE SET
          status='active',
          title=CASE WHEN chat_conversations.title IN ('','New chat') THEN EXCLUDED.title ELSE chat_conversations.title END,
          updated_at=EXCLUDED.updated_at,
          last_message_at=EXCLUDED.last_message_at,
          last_message_preview=EXCLUDED.last_message_preview,
          message_count=chat_conversations.message_count+2,
          deleted_at=NULL
      `,
      [conversation, owner, safeText(title || prompt, 120), modeName, now, "Deep Research queued."],
    );
    const user = await client.query(
      `
        INSERT INTO chat_messages(id,conversation_id,account_id,role,body,mode,created_at,metadata_json)
        VALUES($1,$2,$3,'user',$4,$5,$6,$7)
        RETURNING *
      `,
      [userMessageId, conversation, owner, prompt, modeName, now, {
        kind: "deep_research_question",
        deepResearch: { jobId, status: "starting" },
      }],
    );
    const initialRow = {
      id: jobId,
      account_id: owner,
      conversation_id: conversation,
      title,
      status: "starting",
      stage: "starting",
      result_json: {},
      usage_json: {},
      progress_json: {},
      error: "",
    };
    const assistant = await client.query(
      `
        INSERT INTO chat_messages(id,conversation_id,account_id,role,body,mode,created_at,metadata_json)
        VALUES($1,$2,$3,'assistant',$4,$5,$6,$7)
        RETURNING *
      `,
      [assistantMessageId, conversation, owner, assistantBody(initialRow), modeName, now, metadataForJob(initialRow)],
    );
    const inserted = await client.query(
      `
        INSERT INTO deep_research_jobs(
          id,account_id,conversation_id,request_id,question_message_id,assistant_message_id,
          question,title,status,stage,created_at,updated_at
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'starting','starting',$9,$9)
        RETURNING *
      `,
      [jobId, owner, conversation, idempotency, userMessageId, assistantMessageId, prompt, safeText(title, 500), now],
    );
    return {
      created: true,
      job: publicJob(inserted.rows[0]),
      user: publicMessage(user.rows[0]),
      assistant: publicMessage(assistant.rows[0]),
    };
  });
}

export async function attachDeepResearchGatewayJob({
  accountId = "",
  jobId = "",
  gatewayJobId = "",
  status = "queued",
  stage = "queued",
} = {}) {
  const result = await query(
    `
      UPDATE deep_research_jobs
      SET gateway_job_id=$3,status=$4,stage=$5,updated_at=now()
      WHERE id=$1 AND account_id=$2
      RETURNING *
    `,
    [jobId, safeText(accountId, 180), safeText(gatewayJobId, 180), normalizedStatus(status), safeText(stage, 80)],
  );
  if (!result.rows[0]) return null;
  return updateAssistant(result.rows[0]);
}

export async function updateDeepResearchJob({
  accountId = "",
  jobId = "",
  status = "running",
  stage = "running",
  usage = {},
  progress = {},
  result = {},
  error = "",
} = {}) {
  const normalized = normalizedStatus(status);
  const updated = await query(
    `
      UPDATE deep_research_jobs
      SET status=$3,stage=$4,usage_json=$5,progress_json=$6,result_json=$7,error=$8,
          updated_at=now(),completed_at=CASE WHEN $9 THEN COALESCE(completed_at,now()) ELSE completed_at END
      WHERE id=$1 AND account_id=$2
      RETURNING *
    `,
    [
      jobId, safeText(accountId, 180), normalized, safeText(stage, 80),
      usage && typeof usage === "object" ? usage : {},
      progress && typeof progress === "object" ? progress : {},
      result && typeof result === "object" ? result : {},
      safeText(error, 1000), terminalStatuses.has(normalized),
    ],
  );
  if (!updated.rows[0]) return null;
  return updateAssistant(updated.rows[0]);
}

async function updateAssistant(row) {
  const assistant = await query(
    `
      UPDATE chat_messages
      SET body=$3,metadata_json=$4
      WHERE id=$1 AND account_id=$2
      RETURNING *
    `,
    [row.assistant_message_id, row.account_id, assistantBody(row), metadataForJob(row)],
  );
  return { job: publicJob(row), assistant: publicMessage(assistant.rows[0]) };
}

export async function getDeepResearchJob({ accountId = "", jobId = "" } = {}) {
  const result = await query(
    "SELECT * FROM deep_research_jobs WHERE id=$1 AND account_id=$2",
    [safeText(jobId, 180), safeText(accountId, 180)],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const assistant = await query(
    "SELECT * FROM chat_messages WHERE id=$1 AND account_id=$2",
    [row.assistant_message_id, row.account_id],
  );
  return { job: publicJob(row), assistant: publicMessage(assistant.rows[0]) };
}

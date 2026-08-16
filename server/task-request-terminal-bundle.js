import { createHash } from "node:crypto";

// Tasks never die by clock: offers are retired deliberately by cancellation
// or refusal, not by an implicit client deadline.
export const NO_TASK_ACCEPT_WINDOW_HOURS = 0;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function taskRequestBundleDigest(bundle = {}) {
  return `sha256:${sha256(stableJson(bundle))}`;
}

export function buildMinimalTaskRequestBundle({ accountId = "", walletAddress = "", request = {} } = {}) {
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  return {
    schema: "pf.task.request_bundle.v1",
    bundle_id: request.bundleId,
    subject_wallet: walletAddress,
    subject_encryption_pubkey: request.subjectEncryptionPubkey || "",
    created_at: createdAtIso,
    client: {
      name: "pfterminal",
      version: "0.1.0",
      source_app: "pfterminal",
      account_id: accountId,
      conversation_id: request.conversationId || null,
      conversation_title: request.sourceConversationTitle,
    },
    request: {
      request_id: request.requestId,
      request_text: request.requestText,
      user_detail_text: request.userDetailText,
      requested_task_kind: request.requestedTaskKind,
      source: request.source,
      source_conversation_title: request.sourceConversationTitle,
      attachments: (request.attachments || []).map((attachment) => ({
        name: safeText(attachment?.name, 240),
        mime_type: safeText(attachment?.mimeType, 120),
        size: Number(attachment?.size || 0),
        source: safeText(attachment?.source, 80),
      })),
    },
    recent_chat: {
      conversations: [],
      summary: "",
    },
    memory: {
      deep_memory: [],
      recent_memory: [],
    },
    relevant_history: {
      strategy: "terminal_fast_request_minimal_bundle",
      items: [],
    },
    context: {
      primary_context_doc: {
        context_id: `ctx_${sha256(accountId).slice(0, 24)}`,
        cid: null,
        digest: "",
        summary: "",
        revision: 0,
        word_count: 0,
      },
      additional_refs: [],
    },
    task_queue: {
      counts: {},
      recent: [],
    },
    policy: {
      task_policy_version: "task-policy-minimal-v1",
      reward_policy_version: "reward-policy-minimal-v1",
      generation_policy_version: "taskgen-policy-minimal-v1",
      deadline: {
        accept_by: null,
        deadline_at: null,
        accept_window_hours: NO_TASK_ACCEPT_WINDOW_HOURS,
        source: "no_accept_window",
      },
    },
    wallet: {
      subject_wallet: walletAddress,
      subject_encryption_pubkey: request.subjectEncryptionPubkey || "",
      authority_wallet: "",
      authority_hint: "",
      allocation_wallet: "",
    },
    encryption: {
      subject_public_key: request.subjectEncryptionPubkey || "",
      tasknode_service_required: false,
    },
  };
}

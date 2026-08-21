import { requestJson } from "../../api";
import { buildActorTransitionSignature } from "./task-transition-signature.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

async function sha256Hex(value = "") {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexFromBuffer(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function eventIdFor(payload) {
  const digest = await sha256Hex(JSON.stringify(payload));
  return `evt_${digest.slice(0, 24)}`;
}

function submissionMode(detail = {}) {
  const actions = detail?.actions || {};
  if (actions.canSubmitVerificationEvidence) return "verification_response";
  return "initial_submission";
}

function schemaForMode(mode = "") {
  return mode === "verification_response"
    ? "pf.task.verification_response.v1"
    : "pf.task.submission.v1";
}

function evidenceLabel(method = "") {
  return {
    code: "code",
    commit: "github_commit",
    file: "file",
    screenshot: "screenshot",
    text: "text",
    url: "url",
  }[method] || "text";
}

function compactEvidence({ method = "text", value = "", notes = "", file = null } = {}) {
  const artifactType = evidenceLabel(method);
  const text = safeText(value, 120000);
  const base = {
    artifact_type: artifactType,
    value: text,
    notes: safeText(notes, 8000),
  };
  if (file) {
    return {
      ...base,
      file: {
        name: safeText(file.name, 240),
        mime_type: safeText(file.type, 120),
        size: Number(file.size || 0),
        sha256: safeText(file.sha256, 120),
        description: safeText(file.description, 12000),
        text: safeText(file.text, 120000),
        processing: file.processing && typeof file.processing === "object"
          ? {
              status: safeText(file.processing.status, 80),
              parser: safeText(file.processing.parser, 120),
              warnings: Array.isArray(file.processing.warnings)
                ? file.processing.warnings.slice(0, 20).map((warning) => safeText(warning, 300))
                : [],
              metadata: file.processing.metadata && typeof file.processing.metadata === "object"
                ? file.processing.metadata
                : {},
              provider: safeText(file.processing.provider, 80),
              model: safeText(file.processing.model, 120),
              prompt_path: safeText(file.processing.prompt_path, 180),
              prompt_digest: safeText(file.processing.prompt_digest, 120),
              response_id: safeText(file.processing.response_id, 180),
            }
          : undefined,
      },
    };
  }
  return base;
}

function compactEvidenceItems({ evidenceItems = [], method = "text", value = "", notes = "", file = null } = {}) {
  const sourceItems = Array.isArray(evidenceItems) && evidenceItems.length > 0
    ? evidenceItems
    : [{ method, value, notes, file }];
  return sourceItems.slice(0, 2).map((item, index) => ({
    index: index + 1,
    ...compactEvidence({
      method: item?.method || "text",
      value: item?.value || "",
      notes: item?.notes || notes,
      file: item?.file || null,
    }),
  }));
}

function combinedEvidenceText(evidenceItems = [], fallbackNotes = "") {
  const parts = evidenceItems
    .map((item, index) => {
      const label = `Evidence ${index + 1} (${item.artifact_type || "text"})`;
      const body = safeText(item.file?.description || item.file?.text || item.value || item.notes, 120000);
      return body ? `${label}: ${body}` : "";
    })
    .filter(Boolean);
  const notes = safeText(fallbackNotes, 8000);
  if (notes) parts.push(`Notes: ${notes}`);
  return safeText(parts.join("\n\n"), 120000);
}

export async function readEvidenceFile(file) {
  if (!file) return null;
  const maxBytes = 2_500_000;
  if (file.size > maxBytes) {
    throw new Error("Evidence files must be 2.5 MB or smaller for browser submission.");
  }
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const contentBase64 = btoa(binary);
  const sha256 = await sha256HexFromBuffer(arrayBuffer);
  let text = "";
  if (/^text\//i.test(file.type) || /\.(txt|md|json|csv|log|js|jsx|ts|tsx|py|sql|html|css)$/i.test(file.name)) {
    try {
      text = new TextDecoder().decode(bytes);
    } catch {
      text = "";
    }
  }
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    sha256,
    dataUrl: `data:${file.type || "application/octet-stream"};base64,${contentBase64}`,
    text,
  };
}

export async function processTaskEvidenceFile({
  file,
  method = "file",
  taskId = "",
  value = "",
  verificationCriteria = "",
} = {}) {
  if (!file) return null;

  const processed = await requestJson("/api/tasks/submission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "process_evidence",
      taskId,
      method,
      value,
      verificationCriteria,
      file,
    }),
  });
  if (!processed.ok || !processed.body?.processedEvidence?.file) {
    throw new Error(processed.body?.message || "Evidence file could not be processed.");
  }

  const evidence = processed.body.processedEvidence;
  return {
    ...file,
    name: evidence.file.name || file.name,
    type: evidence.file.mime_type || file.type,
    size: evidence.file.size || file.size,
    sha256: evidence.file.sha256 || file.sha256,
    description: evidence.description || evidence.text || "",
    text: evidence.text || evidence.description || "",
    processing: evidence.processing || null,
    dataUrl: "",
  };
}

async function buildSubmissionPayload({
  detail = {},
  linkedWalletAddress = "",
  method = "text",
  notes = "",
  task = {},
  value = "",
  file = null,
  evidenceItems = [],
}) {
  const mode = submissionMode(detail);
  const schema = schemaForMode(mode);
  const taskId = safeText(task.taskId || task.fullId || task.id || detail?.task?.taskId || detail?.task?.fullId, 180);
  const createdAt = new Date().toISOString();
  const wallets = detail?.wallets || {};
  const compactedEvidenceItems = compactEvidenceItems({ evidenceItems, method, value, notes, file });
  const evidence =
    compactedEvidenceItems.length === 1
      ? compactedEvidenceItems[0]
      : {
          artifact_type: "mixed",
          notes: safeText(notes, 8000),
          evidence_items: compactedEvidenceItems,
        };
  const responseText = combinedEvidenceText(compactedEvidenceItems, notes);
  const artifactType = compactedEvidenceItems.length > 1 ? "mixed" : evidence.artifact_type;
  const basePayload = {
    schema,
    protocol: "tasknode.pftl",
    created_at: createdAt,
    chain: "pftl-testnet",
    task_id: taskId,
    actor_wallet: linkedWalletAddress,
    subject_wallet: linkedWalletAddress,
    authority_wallet: wallets.authority || "",
    allocation_wallet: wallets.allocation || "",
    phase: mode,
    artifact_type: artifactType,
    evidence_type: artifactType,
    evidence_count: compactedEvidenceItems.length,
    evidence_items: compactedEvidenceItems,
    evidence,
  };
  if (mode === "verification_response") {
    basePayload.responded_at = createdAt;
    basePayload.response_text = responseText;
    basePayload.response = evidence;
  } else {
    basePayload.submitted_at = createdAt;
    basePayload.submission = evidence;
  }
  return {
    ...basePayload,
    event_id: await eventIdFor(basePayload),
  };
}

export async function buildTaskSubmissionPayloadForTests(args = {}) {
  return buildSubmissionPayload(args);
}

export async function publishTaskEvidenceSubmission({
  accountId = "",
  detail = {},
  onProgress = null,
  linkedWalletAddress = "",
  method = "text",
  notes = "",
  task = {},
  value = "",
  evidenceItems = [],
  walletSecret = null,
  file = null,
} = {}) {
  const taskId = safeText(task.taskId || task.fullId || task.id || detail?.task?.taskId || detail?.task?.fullId, 180);
  if (!taskId) throw new Error("Task ID is missing.");
  if (!accountId) throw new Error("Sign in before submitting evidence.");
  if (!linkedWalletAddress) throw new Error("Link a PFT wallet before submitting evidence.");

  const progress = (label) => {
    if (typeof onProgress === "function") onProgress(label);
  };

  progress("Configuring evidence");
  const config = await requestJson("/api/tasks/submission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: "config", taskId }),
  });
  const dualWrite = Boolean(config.body?.offchainLifecycle?.enabled && config.body?.offchainLifecycle?.dualWrite);
  const directOffchain = Boolean(config.body?.offchainLifecycle?.enabled && !dualWrite);
  if (!config.ok || (!directOffchain && !config.body?.tasknodeEncryptionPubkey)) {
    throw new Error(config.body?.message || "Task evidence publishing is not configured.");
  }

  const submissionPayload = await buildSubmissionPayload({
    detail: {
      ...detail,
      actions: detail?.actions || config.body?.actions || {},
      wallets: detail?.wallets || config.body?.wallets || {},
    },
    linkedWalletAddress,
    method,
    notes,
    task,
    value,
    file,
    evidenceItems,
  });

  if (directOffchain) {
    const actorSignature = await buildActorTransitionSignature({
      accountId,
      linkedWalletAddress,
      payload: submissionPayload,
      taskId,
      transition: submissionPayload.phase,
      walletSecret,
    });
    progress("Recording evidence");
    const submitted = await requestJson("/api/tasks/submission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase: "submit",
        taskId,
        offchainPayload: submissionPayload,
        actorSignature,
      }),
    });
    if (!submitted.ok || !submitted.body?.ok) {
      throw new Error(submitted.body?.message || "Task evidence could not be recorded.");
    }
    return {
      ...submitted.body,
      submissionPayload,
    };
  }

  if (!walletSecret?.mnemonic || walletSecret.accountId !== accountId) {
    throw new Error("Unlock the local seed vault before submitting evidence.");
  }
  if (walletSecret.address !== linkedWalletAddress) {
    throw new Error("Unlocked wallet does not match the linked wallet.");
  }

  progress("Encrypting evidence");
  const walletCore = await import("../../wallet-core");
  const userPubkey = await walletCore.deriveTaskNodePublicKey(walletSecret.mnemonic);
  const encryptedPayload = await walletCore.encryptTaskNodePayload({
    plaintext: JSON.stringify(submissionPayload),
    recipientPublicKeys: [userPubkey, config.body.tasknodeEncryptionPubkey],
  });

  progress("Pinning evidence");
  const prepared = await requestJson("/api/tasks/submission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "prepare",
      taskId,
      encryptedPayload,
    }),
  });
  if (!prepared.ok || !prepared.body?.txJson) {
    throw new Error(prepared.body?.message || "Task evidence transaction could not be prepared.");
  }

  progress("Signing transaction");
  const signed = walletCore.signPreparedPftlTransaction({
    mnemonic: walletSecret.mnemonic,
    txJson: prepared.body.txJson,
    expectedAddress: linkedWalletAddress,
  });
  const actorSignature = dualWrite
    ? await buildActorTransitionSignature({
        accountId,
        linkedWalletAddress,
        payload: submissionPayload,
        taskId,
        transition: submissionPayload.phase,
        walletSecret,
      })
    : undefined;
  progress("Publishing to PFTL");
  const submitted = await requestJson("/api/tasks/submission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "submit",
      taskId,
      cid: prepared.body.cid,
      signedTxBlob: signed.txBlob,
      pointer: prepared.body.pointer,
      transaction: prepared.body.transaction,
      offchainPayload: dualWrite ? submissionPayload : undefined,
      actorSignature,
    }),
  });
  if (!submitted.ok || !submitted.body?.ok) {
    throw new Error(submitted.body?.message || "Task evidence transaction could not be submitted.");
  }

  return {
    ...submitted.body,
    submissionPayload,
  };
}

import { createHash } from "node:crypto";
import { getLinkedWallet } from "./runtime-store.js";
import { pinContextIpfsJson } from "./context-ipfs.js";
import {
  encryptedPayloadHasRecipient,
  resolveTasknodeEncryptionKey,
  safeTxHash,
  validateEncryptedPayload,
} from "./context-publish.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { query } from "./db/pool.js";
import { taskLifecycleActions } from "./task-lifecycle-policy.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { processEvidenceFileForSubmission } from "./task-evidence-processing.js";
import {
  agentOriginForTaskSession,
  enforceAgentActionRateLimit,
  guardAgentSelfDealing,
  recordAgentActionJournal,
} from "./agent-quality-gates.js";
import {
  applyOffchainTaskTransition,
  offchainTaskLifecycleDualWriteEnabled,
  offchainTaskLifecycleEnabled,
  transitionForSubmissionMode,
} from "./offchain-task-lifecycle.js";

const ACTION_ID = "task_submission";
const TASK_POINTER_SCHEMA = 1;

function submissionResponse({ status, error, message, actionRequired, extra = {} }) {
  return {
    status,
    body: {
      ok: false,
      action: ACTION_ID,
      error,
      message,
      actionRequired,
      ...extra,
    },
  };
}

function okResponse(body, status = 200) {
  return {
    status,
    body: {
      ok: true,
      action: ACTION_ID,
      ...body,
    },
  };
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function submissionSchemaForMode(mode = "") {
  const normalized = safeText(mode, 80).toLowerCase();
  if (["verification", "verification_response", "verification_response_submitted"].includes(normalized)) {
    return "pf.task.verification_response.v1";
  }
  return "pf.task.submission.v1";
}

async function requireSessionTask({ payload = {}, session = null } = {}) {
  if (!session?.accountId) {
    return {
      error: submissionResponse({
        status: 401,
        error: "task_submission_login_required",
        message: "Sign in before submitting task evidence.",
        actionRequired: "Sign in, unlock the linked wallet, then retry.",
      }),
    };
  }

  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return {
      error: submissionResponse({
        status: 409,
        error: "task_submission_wallet_required",
        message: "Link a PFT wallet before submitting task evidence.",
        actionRequired: "Create or link a seed wallet, unlock the local vault, then retry.",
      }),
    };
  }

  const taskId = safeText(payload?.taskId || payload?.task_id, 180);
  if (!taskId) {
    return {
      error: submissionResponse({
        status: 400,
        error: "task_id_required",
        message: "A task ID is required.",
        actionRequired: "Open a task detail page and retry from that task.",
      }),
    };
  }

  const taskResult = await query(
    `
      SELECT task_id, account_id, subject_wallet, authority_wallet, allocation_wallet, request_id, status, title, description,
             task_kind, reward_offer_pft,
             submission_requirement_text, verification_policy_json
      FROM task_projections
      WHERE task_id = $1
        AND subject_wallet = $2
        AND account_id = $3
      LIMIT 1
    `,
    [taskId, wallet.address, session.accountId]
  );
  const task = taskResult.rows[0];
  if (!task) {
    return {
      error: submissionResponse({
        status: 404,
        error: "task_not_found",
        message: "No indexed task projection was found for the linked wallet.",
        actionRequired: "Refresh tasks and confirm the task belongs to the active wallet.",
      }),
    };
  }

  return {
    accountId: session.accountId,
    wallet,
    task,
  };
}

async function processTaskSubmissionEvidence({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;
  const allowed = validateSubmissionAllowed(resolved.task);
  if (allowed.error) return allowed.error;
  const agentGate = await guardAgentSubmission({ payload, session, resolved, mode: allowed.mode });
  if (agentGate.error) return agentGate.error;

  const file = payload?.file && typeof payload.file === "object" ? payload.file : {};
  const method = safeText(payload?.method || payload?.artifactType || payload?.artifact_type, 80);
  const processed = await processEvidenceFileForSubmission({
    file,
    method,
    task: resolved.task,
    value: payload?.value || "",
    verificationCriteria:
      payload?.verificationCriteria ||
      payload?.verification_criteria ||
      resolved.task.submission_requirement_text ||
      "",
  });

  return okResponse({
    phase: "processed_evidence",
    taskId: resolved.task.task_id,
    submissionMode: allowed.mode,
    processedEvidence: processed,
  });
}

function submissionModeForStatus(status = "") {
  const actions = taskLifecycleActions(status);
  if (actions.canSubmitVerificationEvidence) return "verification_response";
  if (actions.canSubmitInitialEvidence) return "initial_submission";
  return "";
}

function validateSubmissionAllowed(task) {
  const mode = submissionModeForStatus(task?.status);
  if (mode) return { mode };
  return {
    error: submissionResponse({
      status: 409,
      error: "task_submission_not_available",
      message: "This task state does not accept evidence right now.",
      actionRequired: "Refresh the task and follow the current primary action.",
      extra: {
        status: task?.status || "",
        actions: taskLifecycleActions(task?.status),
      },
    }),
  };
}

async function guardAgentSubmission({ payload, session, resolved, mode }) {
  const agentOrigin = agentOriginForTaskSession(session, payload, resolved.wallet.address);
  const action = mode === "verification_response" ? "task_verification_response" : "task_submission";
  const selfDealing = await guardAgentSelfDealing({
    agentOrigin,
    accountId: resolved.accountId,
    walletAddress: resolved.wallet.address,
    task: resolved.task,
    action,
  });
  if (!selfDealing.ok) {
    return {
      error: {
        status: selfDealing.status,
        body: {
          ...selfDealing.body,
          action: ACTION_ID,
        },
      },
      agentOrigin,
      action,
    };
  }
  return { agentOrigin, action };
}

async function taskSubmissionConfig({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;
  const allowed = validateSubmissionAllowed(resolved.task);
  if (allowed.error) return allowed.error;
  const agentGate = await guardAgentSubmission({ payload, session, resolved, mode: allowed.mode });
  if (agentGate.error) return agentGate.error;

  const offchainEnabled = offchainTaskLifecycleEnabled();
  const offchainDualWrite = offchainTaskLifecycleDualWriteEnabled();
  const pointerRequired = !offchainEnabled || offchainDualWrite;
  const tasknodeEncryptionKey = pointerRequired
    ? await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true })
    : null;
  if (pointerRequired && !tasknodeEncryptionKey?.publicKey) {
    return submissionResponse({
      status: 409,
      error: "tasknode_encryption_key_missing",
      message: "Task Node encryption key is not configured.",
      actionRequired: "Configure the Task Node service encryption key before publishing evidence.",
    });
  }

  const schema = submissionSchemaForMode(allowed.mode);
  return okResponse({
    phase: "config",
    taskId: resolved.task.task_id,
    status: resolved.task.status,
    title: resolved.task.title || "",
    submissionMode: allowed.mode,
    schema,
    tasknodeEncryptionPubkey: tasknodeEncryptionKey?.publicKey || "",
    tasknodeServiceAddress: tasknodeEncryptionKey?.serviceAddress || "",
    offchainLifecycle: {
      enabled: offchainEnabled,
      dualWrite: offchainDualWrite,
      writeSource: offchainEnabled
        ? offchainDualWrite
          ? "direct_write+pftl_pointer"
          : "direct_write"
        : "pftl_pointer",
    },
    wallets: {
      user: resolved.wallet.address,
      authority: resolved.task.authority_wallet || "",
      allocation: resolved.task.allocation_wallet || "",
    },
    pointer: {
      kind: "TASK_SUBMISSION",
      schema: TASK_POINTER_SCHEMA,
      flags: POINTER_FLAGS.encrypted,
    },
  });
}

async function prepareTaskSubmission({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;
  const allowed = validateSubmissionAllowed(resolved.task);
  if (allowed.error) return allowed.error;
  const agentGate = await guardAgentSubmission({ payload, session, resolved, mode: allowed.mode });
  if (agentGate.error) return agentGate.error;

  const schema = submissionSchemaForMode(allowed.mode);
  const encryptedPayload = payload?.encryptedPayload || payload?.encrypted_payload;
  if (!validateEncryptedPayload(encryptedPayload)) {
    return submissionResponse({
      status: 400,
      error: "task_submission_payload_invalid",
      message: "Task evidence must be encrypted before it is pinned.",
      actionRequired: "Unlock the local wallet vault and retry from the task detail page.",
    });
  }

  const tasknodeEncryptionKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeEncryptionKey?.publicKey) {
    return submissionResponse({
      status: 409,
      error: "tasknode_encryption_key_missing",
      message: "Task Node encryption key is not configured.",
      actionRequired: "Configure the Task Node service encryption key before publishing evidence.",
    });
  }
  if (!encryptedPayloadHasRecipient(encryptedPayload, tasknodeEncryptionKey.publicKey)) {
    return submissionResponse({
      status: 400,
      error: "tasknode_recipient_missing",
      message: "Task evidence payload is not encrypted to Task Node.",
      actionRequired:
        "Refresh the task submission configuration and retry so the encrypted IPFS payload includes the Task Node recipient shard.",
    });
  }

  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-${schema.replace(/\./g, "-")}-${sha256(`${resolved.accountId}:${resolved.task.task_id}:${Date.now()}`).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: "TASK_SUBMISSION",
      schema,
      account_hash: sha256(resolved.accountId).slice(0, 24),
      wallet_address: resolved.wallet.address,
      task_id: resolved.task.task_id,
      submission_mode: allowed.mode,
    },
  });

  const pointerMemo = buildPftPointerMemo({
    cid: pin.cid,
    kind: "TASK_SUBMISSION",
    schema: TASK_POINTER_SCHEMA,
    flags: POINTER_FLAGS.encrypted,
    taskId: resolved.task.task_id,
  });
  const prepared = await preparePftPointerTransaction({
    account: resolved.wallet.address,
    destination: resolved.task.authority_wallet || tasknodeEncryptionKey.serviceAddress || resolved.wallet.address,
    pointerMemo,
  });

  return okResponse({
    phase: "prepared",
    message: "Evidence payload pinned. Sign the PFTL pointer transaction to publish.",
    taskId: resolved.task.task_id,
    submissionMode: allowed.mode,
    schema,
    cid: pin.cid,
    payloadSha256: pin.sha256,
    sizeBytes: pin.sizeBytes,
    txJson: prepared.txJson,
    tx_json: prepared.txJson,
    pointer: pointerMemo.payload,
    memo: {
      memoType: pointerMemo.memoTypeHex,
      memoFormat: pointerMemo.memoFormatHex,
      memoData: pointerMemo.memoDataHex,
    },
    transaction: {
      fromAddress: prepared.fromAddress,
      destination: prepared.destination,
      amountDrops: prepared.amountDrops,
      feeDrops: prepared.feeDrops,
      availableDrops: prepared.availableDrops,
      networkId: prepared.networkId,
    },
  });
}

async function bestEffortRefreshTaskProjection({ accountId, walletAddress, taskId = "", txHash = "" }) {
  try {
    const synced = await syncPftlWalletTransactions({
      walletAddress,
      accountId,
      limit: 120,
      maxPages: 1,
      syncKind: "task_submission_submit",
    });
    const targeted = taskId || txHash
      ? await runPftlCacheReducerOnce({ batchLimit: 8, logger: console, taskId, txHash })
      : { claimed: 0 };
    const reduced = targeted.claimed > 0
      ? targeted
      : await runPftlCacheReducerOnce({ batchLimit: 30, logger: console });
    return { synced, reduced, targeted: Boolean(targeted.claimed > 0) };
  } catch (error) {
    return {
      ok: false,
      error: safeText(error?.code || error?.message || error, 500),
    };
  }
}

function scheduleBestEffortRefreshTaskProjection({ accountId, walletAddress, taskId, txHash = "" }) {
  setTimeout(() => {
    bestEffortRefreshTaskProjection({ accountId, walletAddress, taskId, txHash })
      .then((refresh) => {
        console.info?.("task_submission_projection_refresh_finished", {
          taskId,
          txHash,
          walletAddress,
          ok: refresh?.synced?.ok !== false && refresh?.reduced?.ok !== false,
          targeted: Boolean(refresh?.targeted),
        });
      })
      .catch((error) => {
        console.warn?.("task_submission_projection_refresh_failed", {
          taskId,
          walletAddress,
          error: safeText(error?.message || error, 500),
        });
      });
  }, 0);
  return {
    scheduled: true,
    source: "async_projection_refresh",
  };
}

async function submitTaskSubmission({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;

  const allowed = validateSubmissionAllowed(resolved.task);
  if (allowed.error) return allowed.error;
  const agentGate = await guardAgentSubmission({ payload, session, resolved, mode: allowed.mode });
  if (agentGate.error) return agentGate.error;

  const rateGate = await enforceAgentActionRateLimit({
    agentOrigin: agentGate.agentOrigin,
    action: agentGate.action,
    accountId: resolved.accountId,
    taskId: resolved.task.task_id,
    requestId: resolved.task.request_id || "",
    metadata: {
      phase: "submit",
      submissionMode: allowed.mode,
      status: resolved.task.status,
    },
  });
  if (!rateGate.ok) {
    return {
      status: rateGate.status,
      body: {
        ...rateGate.body,
        action: ACTION_ID,
      },
    };
  }

  if (offchainTaskLifecycleEnabled() && !offchainTaskLifecycleDualWriteEnabled()) {
    const transition = transitionForSubmissionMode(allowed.mode);
    if (!transition) {
      return submissionResponse({
        status: 409,
        error: "task_submission_not_available",
        message: "This task state does not accept evidence right now.",
        actionRequired: "Refresh the task and follow the current primary action.",
        extra: {
          status: resolved.task.status,
          actions: taskLifecycleActions(resolved.task.status),
        },
      });
    }
    const recorded = await applyOffchainTaskTransition({
      accountId: resolved.accountId,
      walletAddress: resolved.wallet.address,
      task: resolved.task,
      transition,
      payload,
      metadata: {
        endpoint: "POST /api/tasks/submission",
        submissionMode: allowed.mode,
        schema: submissionSchemaForMode(allowed.mode),
      },
    });
    const txHash = recorded.event.sourceTxHash;
    const orcWorkJournal = agentGate.agentOrigin
      ? await recordAgentActionJournal({
          agentOrigin: agentGate.agentOrigin,
          action: agentGate.action,
          status: "recorded",
          outcomeStatus: "submitted",
          accountId: resolved.accountId,
          taskId: resolved.task.task_id,
          requestId: resolved.task.request_id || "",
          cid: recorded.event.sourceCid,
          txHash,
          metadata: {
            phase: "submit",
            submissionMode: allowed.mode,
            previousStatus: resolved.task.status,
            writeSource: "direct_write",
          },
          idempotencyKey: `agent_task_submission:${agentGate.agentOrigin.walletAddress || resolved.accountId}:${resolved.task.task_id}:${allowed.mode}:${txHash}`,
        })
      : null;
    return okResponse({
      phase: "submitted",
      message: "Task evidence recorded directly in Task Node.",
      taskId: resolved.task.task_id,
      cid: recorded.event.sourceCid,
      txHash,
      refresh: {
        scheduled: false,
        source: "direct_write",
        reducerBypassed: true,
      },
      offchainLifecycle: {
        enabled: true,
        writeSource: "direct_write",
        eventId: recorded.event.eventId,
        transition,
      },
      orcWorkJournal,
    });
  }

  const submit = await submitSignedPftTransaction({
    signedTxBlob: payload?.signedTxBlob || payload?.signed_tx_blob,
    expectedAccount: resolved.wallet.address,
  });
  const txHash = safeTxHash(submit.txHash);
  if (!txHash) {
    return submissionResponse({
      status: 502,
      error: "task_submission_tx_hash_missing",
      message: "PFTL accepted the transaction response but did not return a hash.",
      actionRequired: "Check the linked wallet history before retrying to avoid a duplicate pointer.",
    });
  }

  const offchainDualWrite = offchainTaskLifecycleEnabled() && offchainTaskLifecycleDualWriteEnabled();
  const transition = offchainDualWrite ? transitionForSubmissionMode(allowed.mode) : "";
  const dualWriteRecorded = offchainDualWrite
    ? await applyOffchainTaskTransition({
        accountId: resolved.accountId,
        walletAddress: resolved.wallet.address,
        task: resolved.task,
        transition,
        payload,
        metadata: {
          endpoint: "POST /api/tasks/submission",
          submissionMode: allowed.mode,
          schema: submissionSchemaForMode(allowed.mode),
          pointerTxHash: txHash,
          pointerCid: safeText(payload?.cid, 240),
        },
        dualWrite: true,
      })
    : null;

  const refresh = scheduleBestEffortRefreshTaskProjection({
    accountId: resolved.accountId,
    walletAddress: resolved.wallet.address,
    taskId: resolved.task.task_id,
    txHash,
  });

  const orcWorkJournal = agentGate.agentOrigin
    ? await recordAgentActionJournal({
        agentOrigin: agentGate.agentOrigin,
        action: agentGate.action,
        status: "recorded",
        outcomeStatus: "submitted",
        accountId: resolved.accountId,
        taskId: resolved.task.task_id,
        requestId: resolved.task.request_id || "",
        cid: safeText(payload?.cid, 240),
        txHash,
        metadata: {
          phase: "submit",
          submissionMode: allowed.mode,
          previousStatus: resolved.task.status,
          writeSource: offchainDualWrite ? "direct_write+pftl_pointer" : "pftl_pointer",
        },
        idempotencyKey: `agent_task_submission:${agentGate.agentOrigin.walletAddress || resolved.accountId}:${resolved.task.task_id}:${allowed.mode}:${txHash}`,
      })
    : null;

  return okResponse({
    phase: "submitted",
    message: "Task evidence published to PFT.",
    taskId: resolved.task.task_id,
    cid: safeText(payload?.cid, 240),
    txHash,
    engineResult: submit.engineResult,
    refresh,
    offchainLifecycle: offchainDualWrite
      ? {
          enabled: true,
          dualWrite: true,
          writeSource: "direct_write+pftl_pointer",
          pointerTxHash: txHash,
          eventId: dualWriteRecorded.event.eventId,
          transition,
        }
      : undefined,
    orcWorkJournal,
  });
}

export async function taskSubmissionAction(payload = {}, method = "POST", session = null) {
  if (method !== "POST") {
    return submissionResponse({
      status: 405,
      error: "task_submission_method_not_allowed",
      message: "Task evidence submission requires POST.",
      actionRequired: "Call the task submission endpoint with POST.",
    });
  }

  const phase = safeText(payload?.phase || "", 40).toLowerCase();
  try {
    if (phase === "process_evidence") return await processTaskSubmissionEvidence({ payload, session });
    if (phase === "prepare") return await prepareTaskSubmission({ payload, session });
    if (phase === "submit" || payload?.signedTxBlob || payload?.signed_tx_blob) {
      return await submitTaskSubmission({ payload, session });
    }
    return await taskSubmissionConfig({ payload, session });
  } catch (error) {
    const evidenceError = phase === "process_evidence" && String(error?.message || "").startsWith("evidence_");
    const evidenceMessage = String(error?.message || "").startsWith("evidence_file_type_unsupported")
      ? "Task Node cannot extract readable evidence from this file type. Upload a PDF, DOCX, text/code file, ZIP, TAR, or GZIP archive."
      : String(error?.message || "").startsWith("evidence_file_no_extractable_text")
        ? "Task Node could not find readable text in this file. For scanned documents, attach a screenshot or add a text explanation."
        : String(error?.message || "").startsWith("evidence_archive")
          ? "Task Node could not safely read this archive. Check that it is a valid ZIP, TAR, or GZIP file with bounded text/code contents."
          : evidenceError
            ? "Task Node could not read this evidence file. Check the file and try again."
            : "";
    return submissionResponse({
      status: error?.status || 502,
      error: error?.code || error?.message || "task_submission_failed",
      message:
        error?.message === "context_ipfs_payload_too_large"
          ? "Task evidence is too large to publish. Process screenshots and files into compact evidence before signing."
          : evidenceMessage || error?.message || "Task evidence could not be published to PFT.",
      actionRequired: evidenceError
        ? "Choose a supported readable file or provide the evidence as text, a screenshot, or a public URL."
        : "Check wallet unlock state, PFT balance, PFTL connectivity, and IPFS configuration, then retry.",
      extra: {
        attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      },
    });
  }
}

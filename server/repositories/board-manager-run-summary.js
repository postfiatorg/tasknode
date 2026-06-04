function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function runStatus(run = {}) {
  return safeText(run.status, 80).toLowerCase();
}

function isPendingRun(run = {}) {
  return ["running", "queued", "pending", "processing"].includes(runStatus(run));
}

export function boardManagerRunState({ action, primaryResult, run = {} }) {
  const result = safeObject(primaryResult?.result);
  if (runStatus(run) === "failed") return "failed";
  if (action === "decision_queued" || action === "decision_retry_scheduled") return "no_decision";
  if (isPendingRun(run)) return "running";
  if (run.dryRun) return "dry_run";
  if (result.executed) return "executed";
  if (action === "decision_pending") return "running";
  if (!action || action === "no_decision" || action === "do_nothing") return "no_decision";
  return "recorded";
}

function actionLabel(action = "") {
  return {
    archive_project: "Archived project",
    assign_contributor: "Assigned contributor",
    create_project: "Created project",
    do_nothing: "No board change",
    daily_airdrop: "Daily airdrop",
    decision_pending: "Decision pending",
    decision_queued: "Decision queued",
    decision_retry_scheduled: "Decision retry scheduled",
    initiate_network_task: "Initiated network task",
    message_user: "Messaged user",
    refresh_hive_secretary: "Updated Hive Secretary",
    refresh_project_document: "Refreshed project document",
    restore_project: "Restored project",
  }[action] || "No decision";
}

function runSummary(run = {}, action = "", primaryResult = null) {
  const payload = safeObject(run.actionPayload);
  const decision = safeObject(run.decision);
  const result = safeObject(primaryResult?.result);
  if (runStatus(run) === "failed") return run.error || "The Board Manager run failed before completing a decision.";
  if (action === "decision_queued") return "The Board Manager job is queued and has not been claimed by the worker yet.";
  if (action === "decision_retry_scheduled") return "The Board Manager job was deferred after an error and is scheduled for retry.";
  if (isPendingRun(run)) return "The Board Manager is evaluating Hive state and has not recorded a decision yet.";
  if (!action || action === "no_decision") return "The Board Manager run did not record a selected action.";
  if (action === "do_nothing") {
    return payload.summary || decision.reason || "The agent reviewed current Hive state and chose not to change the board.";
  }
  return payload.summary || decision.reason || result.messagePreview || result.archiveReason || "The agent selected an action for the Hive board.";
}

function formatBoardManagerRunDetails(details = null) {
  const data = safeObject(details);
  if (!Object.keys(data).length) return null;
  return {
    provider: safeText(data.provider, 120),
    outputText: safeText(data.outputText, 40_000),
    decision: safeObject(data.decision),
    actionPayload: safeObject(data.actionPayload),
    microSummary: safeObject(data.microSummary),
    microSummaryText: safeText(data.microSummaryText, 5_000),
    actionResults: safeArray(data.actionResults).slice(0, 20).map((result) => ({
      id: safeText(result.id, 180),
      action: safeText(result.action, 80),
      targetType: safeText(result.targetType, 120),
      targetId: safeText(result.targetId, 240),
      result: safeObject(result.result),
      createdAt: result.createdAt || null,
    })),
    sourcePacket: safeObject(data.sourcePacket),
    job: safeObject(data.job),
  };
}

export function formatBoardManagerAgentRun(run = {}) {
  const results = safeArray(run.actionResults);
  const primaryResult = results[0] || null;
  const action = safeText(run.selectedAction, 80)
    || safeText(primaryResult?.action, 80)
    || (isPendingRun(run) ? "decision_pending" : "no_decision");
  return {
    id: safeText(run.id, 180),
    runId: safeText(run.id, 180),
    action,
    label: actionLabel(action),
    state: boardManagerRunState({ action, primaryResult, run }),
    status: safeText(run.status, 80),
    dryRun: Boolean(run.dryRun),
    summary: runSummary(run, action, primaryResult),
    reason: safeText(run.decision?.reason || run.error || "", 2000),
    decisionBasis: safeObject(run.decision?.decision_basis || run.decision?.decisionBasis),
    confidence: Number(run.decision?.confidence || 0),
    targetType: safeText(run.targetType || run.decision?.target_type || primaryResult?.targetType, 120),
    targetId: safeText(run.targetId || run.decision?.target_id || primaryResult?.targetId, 240),
    trigger: safeText(run.trigger, 160),
    model: safeText(run.model, 120),
    reasoningEffort: safeText(run.reasoningEffort, 40),
    codexSessionId: safeText(run.codexSessionId, 120),
    sessionMode: safeText(run.sessionMode, 80),
    sourcePacketDigest: safeText(run.sourcePacketDigest, 120),
    actionResults: results.slice(0, 6).map((result) => ({
      id: safeText(result.id, 180),
      action: safeText(result.action, 80),
      targetType: safeText(result.targetType, 120),
      targetId: safeText(result.targetId, 240),
      executed: Boolean(result.result?.executed),
      error: safeText(result.result?.error, 1000),
      summary: resultSummary({ action: safeText(result.action, 80), result: result.result }),
      createdAt: result.createdAt || null,
    })),
    microSummaryText: safeText(run.microSummaryText, 1800),
    details: formatBoardManagerRunDetails(run.details),
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
  };
}

export function formatBoardManagerAgentJob(job = {}) {
  const details = safeObject(job.details);
  const status = safeText(job.status, 80) || "queued";
  const selectedAction = status === "queued"
    ? "decision_queued"
    : status === "deferred"
      ? "decision_retry_scheduled"
      : "decision_pending";
  return formatBoardManagerAgentRun({
    id: safeText(job.id, 180),
    scope: safeText(job.scope, 120),
    managerId: safeText(job.claimedBy || job.claimed_by, 180),
    trigger: safeText(job.trigger, 160),
    status,
    selectedAction,
    actionPayload: {
      summary: safeText(job.reason, 1000),
    },
    decision: {},
    dryRun: false,
    actionResults: [],
    details: Object.keys(details).length ? details : null,
    startedAt: job.claimedAt || job.claimed_at || job.runAfter || job.run_after || job.createdAt || job.created_at || null,
    completedAt: null,
  });
}

function resultSummary({ action = "", result = {} } = {}) {
  const data = safeObject(result);
  if (data.error) return `failed: ${safeText(data.error, 240)}`;
  if (data.dryRun) return "dry run only; no app mutation executed";
  if (action === "do_nothing") return "reviewed state and made no board mutation";
  if (action === "daily_airdrop") {
    if (data.summary) return safeText(data.summary, 500);
    const total = Number(data.totalPft || 0);
    const users = Number(data.userCount || 0);
    return `Dispensed ${total.toLocaleString("en-US", { maximumFractionDigits: 6 })} PFT to ${users.toLocaleString("en-US")} ${users === 1 ? "user" : "users"} as part of daily airdrop.`;
  }
  if (action === "message_user") {
    return `sent Hive response to ${safeText(data.accountId, 80) || "user"} in ${safeText(data.conversationId, 80) || "chat"}`;
  }
  if (action === "refresh_hive_secretary") {
    return data.queued ? `queued Hive Secretary job ${safeText(data.jobId, 120)}` : "checked Hive Secretary freshness";
  }
  if (action === "create_project") return `created or updated project ${safeText(data.projectId, 120) || "unknown_project"}`;
  if (action === "archive_project") return `archived project ${safeText(data.projectId, 120) || "unknown_project"}`;
  if (action === "restore_project") return `restored project ${safeText(data.projectId, 120) || "unknown_project"}`;
  if (action === "refresh_project_document") {
    return `refreshed project document ${safeText(data.productDocId, 120) || "unknown_doc"}`;
  }
  if (action === "assign_contributor") {
    return `assigned ${safeText(data.walletAddress, 80) || "contributor"} to ${safeText(data.projectId, 120) || "project"}`;
  }
  if (action === "initiate_network_task") {
    const allocation = safeText(data.allocationId, 120);
    const job = safeText(data.jobId, 120);
    return `queued Network Task allocation${allocation ? ` ${allocation}` : ""}${job ? ` and generation job ${job}` : ""}`;
  }
  if (data.executed === false) return "action did not execute";
  return data.executed ? "action executed" : "action recorded";
}

function compactActionResult(result = {}) {
  const data = safeObject(result.result);
  const action = safeText(result.action, 80);
  return {
    id: safeText(result.id, 180),
    action,
    targetType: safeText(result.targetType, 120),
    targetId: safeText(result.targetId, 240),
    executed: Boolean(data.executed),
    dryRun: Boolean(data.dryRun),
    error: safeText(data.error, 500),
    summary: resultSummary({ action, result: data }),
    createdAt: result.createdAt || null,
  };
}

export function buildBoardManagerRunMicroSummary(run = {}) {
  const decision = safeObject(run.decision);
  const payload = safeObject(run.actionPayload);
  const results = safeArray(run.actionResults).slice(0, 4).map(compactActionResult);
  const action = safeText(run.selectedAction || decision.action || results[0]?.action, 80)
    || (isPendingRun(run) ? "decision_pending" : "no_decision");
  const resultText = results[0]?.summary || resultSummary({ action, result: {} });
  const summary = runStatus(run) === "failed"
    ? safeText(run.error, 1000) || "The Board Manager run failed before completing a decision."
    : isPendingRun(run)
      ? "The Board Manager is evaluating Hive state and has not recorded a decision yet."
    : safeText(payload.summary, 1000) || safeText(decision.reason, 1000) || resultText;
  const nextSteps = safeArray(payload.next_steps).slice(0, 3).map((item) => safeText(item, 240)).filter(Boolean);
  const micro = {
    schema: "pf.hive.board_manager.run_summary.v1",
    runId: safeText(run.id, 180),
    trigger: safeText(run.trigger, 160),
    scope: safeText(run.scope, 120),
    status: safeText(run.status, 80),
    action,
    targetType: safeText(decision.target_type || results[0]?.targetType, 120),
    targetId: safeText(decision.target_id || results[0]?.targetId, 240),
    state: boardManagerRunState({ action, primaryResult: run.actionResults?.[0] || null, run }),
    dryRun: Boolean(run.dryRun),
    confidence: Number(decision.confidence || 0),
    summary,
    reason: safeText(decision.reason || run.error, 1000),
    decisionBasis: safeObject(decision.decision_basis || decision.decisionBasis),
    result: resultText,
    nextSteps,
    results,
    sourcePacketDigest: safeText(run.sourcePacketDigest, 120),
    sessionMode: safeText(run.sessionMode, 80),
    model: safeText(run.model, 120),
    reasoningEffort: safeText(run.reasoningEffort, 40),
    completedAt: run.completedAt || null,
  };
  const text = [
    "Board Manager Run Summary",
    `Run: ${micro.runId || "unknown"}`,
    `Action: ${micro.action}${micro.targetId ? ` -> ${micro.targetId}` : ""}`,
    `Result: ${micro.result}`,
    `Why: ${micro.reason || micro.summary}`,
    nextSteps.length ? `Next: ${nextSteps.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  return { json: micro, text: safeText(text, 1800) };
}

export function compactBoardManagerRunForSourcePacket(run = {}) {
  const stored = safeObject(run.microSummary);
  const fallback = buildBoardManagerRunMicroSummary(run);
  const micro = Object.keys(stored).length ? stored : fallback.json;
  return {
    id: safeText(run.id, 180),
    trigger: safeText(run.trigger, 160),
    status: safeText(run.status, 80),
    action: safeText(micro.action || run.selectedAction, 80),
    targetType: safeText(micro.targetType, 120),
    targetId: safeText(micro.targetId, 240),
    state: safeText(micro.state, 80),
    dryRun: Boolean(run.dryRun),
    confidence: Number(micro.confidence || 0),
    summary: safeText(micro.summary, 700),
    result: safeText(micro.result, 500),
    reason: safeText(micro.reason, 700),
    nextSteps: safeArray(micro.nextSteps).slice(0, 3).map((item) => safeText(item, 240)).filter(Boolean),
    sourcePacketDigest: safeText(run.sourcePacketDigest, 120),
    sessionMode: safeText(run.sessionMode, 80),
    completedAt: run.completedAt || null,
  };
}

export function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

export function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

export function intValue(value, fallback = 0, { min = 0, max = 10000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const resolutionOutcomeLabels = new Map([
  ["fixed", "Fixed"],
  ["already_fixed", "Already fixed"],
  ["not_a_bug", "Not a bug"],
  ["duplicate", "Duplicate"],
]);

const closeoutOnlyPattern =
  /\b(tracker-ready|tracker ready|qa packet|qa follow-up packet|bug packet|ticket packet|documentation packet|document-only|documentation-only)\b/i;
const unresolvedCaveatPattern =
  /\b(source-backed only|did not perform fresh|no fresh reproduction|not freshly reproduced|without fresh testing|self-attested text)\b/i;
const fixedEvidencePattern =
  /\b(fixed|implemented|merged|deployed|commit|pr\b|pull request|changed|updated|added|removed|configured|migration|test(?:ed|s)?|smoke|verified|verification)\b/i;
const alreadyFixedPattern =
  /\b(already fixed|previously fixed|no longer reproduces|existing fix|fixed before closeout|already shipped)\b/i;
const notBugPattern =
  /\b(not a bug|intended behavior|works as designed|cannot reproduce|could not reproduce|invalid report|not reproducible)\b/i;
const duplicatePattern = /\bduplicate\b/i;
const duplicateTargetPattern = /\b(task_[a-z0-9]+|pr\b|pull request|issue|ticket|commit|harvest)\b/i;

export function validateTaskAccountingResolution({ outcome = "", note = "" } = {}) {
  const normalizedOutcome = safeText(outcome, 80).toLowerCase();
  const normalizedNote = safeText(note, 6000);
  if (!resolutionOutcomeLabels.has(normalizedOutcome)) {
    return {
      ok: false,
      error: "task_accounting_harvest_resolution_outcome_required",
      message: "Choose a real closeout outcome: fixed, already fixed, not a bug, or duplicate.",
    };
  }
  if (normalizedNote.length < 40) {
    return {
      ok: false,
      error: "task_accounting_harvest_resolution_note_required",
      message: "Add a short closeout note with the actual fix/proof or why this is not a real open issue.",
    };
  }
  if (closeoutOnlyPattern.test(normalizedNote)) {
    return {
      ok: false,
      error: "task_accounting_harvest_resolution_not_a_fix",
      message: "A tracker packet, QA packet, or documentation-only artifact does not resolve a harvest row.",
    };
  }
  if (normalizedOutcome === "fixed") {
    if (unresolvedCaveatPattern.test(normalizedNote)) {
      return {
        ok: false,
        error: "task_accounting_harvest_resolution_unverified_fix",
        message: "Do not close as fixed while the note says the issue was only source-backed or not freshly verified.",
      };
    }
    if (!fixedEvidencePattern.test(normalizedNote)) {
      return {
        ok: false,
        error: "task_accounting_harvest_resolution_fix_evidence_required",
        message: "Close as fixed only with fix evidence such as changed code/config, commit/PR, deployment, or regression verification.",
      };
    }
  }
  if (normalizedOutcome === "already_fixed" && !alreadyFixedPattern.test(normalizedNote)) {
    return {
      ok: false,
      error: "task_accounting_harvest_resolution_already_fixed_evidence_required",
      message: "Close as already fixed only when the note says the issue no longer reproduces or names the existing shipped fix.",
    };
  }
  if (normalizedOutcome === "not_a_bug" && !notBugPattern.test(normalizedNote)) {
    return {
      ok: false,
      error: "task_accounting_harvest_resolution_not_bug_evidence_required",
      message: "Close as not a bug only when the note explains intended behavior, invalidity, or non-reproduction.",
    };
  }
  if (normalizedOutcome === "duplicate" && (!duplicatePattern.test(normalizedNote) || !duplicateTargetPattern.test(normalizedNote))) {
    return {
      ok: false,
      error: "task_accounting_harvest_resolution_duplicate_target_required",
      message: "Close as duplicate only when the note names the existing task, issue, PR, commit, or harvest that owns the fix.",
    };
  }
  return { ok: true, outcome: normalizedOutcome, note: normalizedNote };
}

export function taskAccountingHarvestOrderSql({ resolvedFilter = "" } = {}) {
  const normalizedResolvedFilter = safeText(resolvedFilter, 20).toLowerCase();
  if (normalizedResolvedFilter === "true") {
    return `
        harvest.resolved_at DESC NULLS LAST,
        harvest.updated_at DESC,
        harvest.task_id DESC
      `;
  }
  return `
        harvest.requires_action DESC,
        harvest.completed_at DESC NULLS LAST,
        harvest.rewarded_at DESC NULLS LAST,
        harvest.updated_at DESC,
        harvest.task_id DESC
      `;
}

export function rowToHarvest(row = {}) {
  const resolved = Boolean(row.resolved_at);
  const checkedOut = Boolean(row.checked_out_at && !resolved);
  const sourcePacket = safeObject(row.source_packet_json);
  const taskPacket = safeObject(sourcePacket.task);
  const badgeIds = safeArray(row.verified_badges_json).map((badge) => safeText(badge.badgeId || badge.badge_id || badge.label, 80)).filter(Boolean);
  const requiredBadgeId = safeText(
    row.required_badge_id ||
      taskPacket.requiredBadgeId ||
      sourcePacket.requiredBadgeId ||
      inferredBadgeForWork({
        title: row.title,
        taskProposal: row.task_proposal,
        submissionRequirement: row.submission_requirement_text,
        actionCategory: row.action_category,
      }),
    80
  );
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    accountId: safeText(row.account_id, 180),
    walletAddress: safeText(row.subject_wallet, 120),
    contributor: {
      accountId: safeText(row.account_id, 180),
      walletAddress: safeText(row.subject_wallet, 120),
      displayName: safeText(row.contributor_display_name, 160),
      publicHandle: safeText(row.contributor_public_handle, 120),
      verifiedBadges: safeArray(row.verified_badges_json),
    },
    badgeContext: {
      verifiedBadgeIds: badgeIds,
      requiredBadgeId,
      operatingBadgeId: safeText(row.operating_badge_id || taskPacket.operatingBadgeId || requiredBadgeId, 80),
      taskWorkType: safeText(row.task_work_type || taskPacket.taskWorkType, 120),
      badgeWorkType: safeText(row.badge_work_type || taskPacket.badgeWorkType || row.task_work_type || taskPacket.taskWorkType, 120),
      rewardCapPft: numeric(row.badge_reward_cap_pft || taskPacket.badgeRewardCapPft),
      requiredBadgeSource: safeText(row.required_badge_id || taskPacket.requiredBadgeId, 80) ? "task_packet" : "inferred",
    },
    projectIds: safeArray(row.project_ids_json),
    title: safeText(row.title, 360),
    taskProposal: safeText(row.task_proposal, 5000),
    submissionRequirement: safeText(row.submission_requirement_text, 2000),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    rewardedAt: iso(row.rewarded_at),
    rewardEventTxHash: safeText(row.reward_event_tx_hash, 180),
    rewardEventCid: safeText(row.reward_event_cid, 240),
    status: safeText(row.status, 40),
    classification: safeText(row.classification, 80),
    requiresAction: Boolean(row.requires_action),
    actionCategory: safeText(row.action_category, 120),
    suggestedAction: safeText(row.suggested_action, 4000),
    assessmentSummary: safeText(row.assessment_summary, 4000),
    confidence: numeric(row.confidence),
    sourcePacket,
    result: safeObject(row.result_json),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 180),
    promptVersion: safeText(row.prompt_version, 120),
    promptDigest: safeText(row.prompt_digest, 120),
    responseId: safeText(row.response_id, 200),
    usage: safeObject(row.usage_json),
    workerId: safeText(row.worker_id, 180),
    workerAttemptId: safeText(row.worker_attempt_id, 180),
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    workerClaimedAt: iso(row.worker_claimed_at),
    workerHeartbeatAt: iso(row.worker_heartbeat_at),
    completedAt: iso(row.completed_at),
    checkout: {
      checkedOut,
      checkedOutAt: checkedOut ? iso(row.checked_out_at) : null,
      accountId: checkedOut ? safeText(row.checked_out_by_account_id, 180) : "",
      walletAddress: checkedOut ? safeText(row.checked_out_wallet_address, 120) : "",
    },
    checkedOut,
    checkedOutAt: checkedOut ? iso(row.checked_out_at) : null,
    checkedOutByAccountId: checkedOut ? safeText(row.checked_out_by_account_id, 180) : "",
    checkedOutWalletAddress: checkedOut ? safeText(row.checked_out_wallet_address, 120) : "",
    resolvedAt: iso(row.resolved_at),
    resolvedByAccountId: safeText(row.resolved_by_account_id, 180),
    resolutionOutcome: safeText(row.resolution_outcome, 80),
    resolutionNote: safeText(row.resolution_note, 6000),
    resolved,
    lastError: safeText(row.last_error, 1000),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function rowToCheckoutEvent(row = {}) {
  const currentWallet = safeText(row.current_checkout_wallet_address, 120);
  const currentAccountId = safeText(row.current_checkout_account_id, 180);
  const eventWallet = safeText(row.wallet_address, 120);
  const eventAccountId = safeText(row.account_id, 180);
  const resolved = Boolean(row.resolved_at);
  return {
    id: safeText(row.id, 180),
    taskId: safeText(row.task_id, 180),
    title: safeText(row.title, 360),
    eventType: safeText(row.event_type, 80) || "checked_out",
    accountId: eventAccountId,
    walletAddress: eventWallet,
    createdAt: iso(row.created_at),
    current: Boolean(
      !resolved &&
        row.current_checked_out_at &&
        currentWallet.toLowerCase() === eventWallet.toLowerCase() &&
        currentAccountId.toLowerCase() === eventAccountId.toLowerCase()
    ),
    currentCheckedOutAt: iso(row.current_checked_out_at),
    currentCheckoutWalletAddress: currentWallet,
    currentCheckoutAccountId: currentAccountId,
    resolved,
    resolvedAt: iso(row.resolved_at),
    classification: safeText(row.classification, 80),
    requiresAction: Boolean(row.requires_action),
    actionCategory: safeText(row.action_category, 120),
    suggestedAction: safeText(row.suggested_action, 1000),
    metadata: safeObject(row.metadata_json),
  };
}


function inferredBadgeForWork({ title = "", taskProposal = "", submissionRequirement = "", actionCategory = "" } = {}) {
  const text = [title, taskProposal, submissionRequirement, actionCategory].join("\n").toLowerCase();
  if (/\b(pr|pull request|code|script|cli|api|migration|regression|test suite|docker|patch|repository|github|json payload|exporter)\b/.test(text)) {
    return "core_contributor";
  }
  if (/\b(qa|ux|ui|bug|repro|screenshot|friction|workflow|login|evidence submission|task acceptance|visibility gap)\b/.test(text)) {
    return "qa_worker";
  }
  if (/\b(tweet|x post|kol|article|medium|amplification|youtube|tiktok|instagram|community announcement)\b/.test(text)) {
    return "kol";
  }
  if (/\b(expert|domain|market alpha|research|analysis|validator|risk assessment)\b/.test(text)) {
    return "expert";
  }
  if (/\b(project leader|project proposal|new project|work breakdown|roadmap|project plan)\b/.test(text)) {
    return "project_leader";
  }
  return "";
}

export function taskAccountingHarvestSourcePacket(row = {}) {
  return {
    schema: "pf.task_node.task_accounting_harvest_source.v1",
    prompt: "The following task proposal and reward were granted.",
    task: {
      taskId: safeText(row.task_id || row.taskId, 180),
      requestId: safeText(row.request_id || row.requestId, 180),
      accountId: safeText(row.account_id || row.accountId, 180),
      walletAddress: safeText(row.subject_wallet || row.walletAddress, 120),
      projectIds: safeArray(row.project_ids_json || row.projectIds),
      title: safeText(row.title, 360),
      proposal: safeText(row.task_proposal || row.taskProposal || row.description, 6000),
      submissionRequirement: safeText(row.submission_requirement_text || row.submissionRequirement, 2400),
    },
    reward: {
      offerPft: numeric(row.reward_offer_pft || row.rewardOfferPft),
      actualPft: numeric(row.reward_actual_pft || row.rewardActualPft),
      rewardedAt: iso(row.rewarded_at || row.rewardedAt),
      eventTxHash: safeText(row.reward_event_tx_hash || row.rewardEventTxHash, 180),
      eventCid: safeText(row.reward_event_cid || row.rewardEventCid, 240),
    },
    badgeContext: {
      taskWorkType: safeText(row.task_work_type || row.taskWorkType, 120),
      requiredBadgeId: safeText(row.required_badge_id || row.requiredBadgeId, 80),
      operatingBadgeId: safeText(row.operating_badge_id || row.operatingBadgeId, 80),
      badgeWorkType: safeText(row.badge_work_type || row.badgeWorkType, 120),
      badgeRewardCapPft: numeric(row.badge_reward_cap_pft || row.badgeRewardCapPft),
    },
    taskEvents: safeArray(row.event_context_json || row.taskEvents),
  };
}

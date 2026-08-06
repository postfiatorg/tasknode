function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const activeProjectTaskStatuses = new Set([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactStringList(value = [], { limit = 6, max = 240 } = {}) {
  return safeArray(value)
    .slice(0, limit)
    .map((item) => safeText(item, max))
    .filter(Boolean);
}

function presentObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === null || item === undefined || item === "") return false;
    if (Array.isArray(item) && item.length === 0) return false;
    return true;
  }));
}

function compactProjectTask(task = {}) {
  return {
    taskId: safeText(task.taskId || task.task_id, 180),
    requestId: safeText(task.requestId || task.request_id, 180),
    title: safeText(task.title || task.name, 160),
    state: safeText(task.state || task.status, 80),
    rewardPft: Number(task.rewardPft || task.reward_pft || task.rewardActualPft || task.rewardOfferPft || 0),
    updatedAt: task.updatedAt || task.updated_at || null,
  };
}

function projectTaskIsActive(task = {}) {
  return activeProjectTaskStatuses.has(safeText(task.state || task.status, 80).toLowerCase());
}

function compactProjectTasks(project = {}, limit = 2) {
  const tasks = safeArray(project.tasks);
  const activeTasks = tasks.filter(projectTaskIsActive);
  return (activeTasks.length ? activeTasks : tasks).slice(0, limit).map(compactProjectTask);
}

function compactProductDocument(document = {}) {
  if (!document?.id && !document?.summary && !document?.projectStatus) return null;
  return {
    id: safeText(document.id, 180),
    title: safeText(document.title, 180),
    summary: safeText(document.summary, 120),
    projectStatus: safeText(document.projectStatus || document.project_status, 140),
    keyPoints: safeArray(document.keyPoints || document.key_points).slice(0, 1).map((item) => safeText(item, 120)).filter(Boolean),
    blockedOrUnclear: safeArray(document.blockedOrUnclear || document.blocked_or_unclear).slice(0, 1).map((item) => safeText(item, 120)).filter(Boolean),
    nextActions: safeArray(document.nextActions || document.next_actions).slice(0, 1).map((item) => safeText(item, 120)).filter(Boolean),
  };
}

export function compactHiveProjectsForBoardManager(document = {}) {
  const projects = safeObject(document.projects);
  const projectIds = safeArray(document.projectIds).length ? document.projectIds : Object.keys(projects);
  return {
    generatedAt: document.generatedAt || null,
    projectIds: projectIds.slice(0, 8),
    stats: safeObject(document.stats),
    projects: Object.fromEntries(projectIds.slice(0, 8).map((id) => {
      const project = safeObject(projects[id]);
      return [id, {
        id: safeText(project.id || id, 180),
        name: safeText(project.name || project.title, 180),
        type: safeText(project.type || project.typeKey, 80),
        summary: safeText(project.summary, 180),
        objective: safeText(project.objective, 200),
        status: safeText(project.status, 80),
        priority: Number(project.priority || 0),
        phase: safeText(project.phase || project.phaseLabel, 120),
        taskCount: Number(project.taskCount || 0),
        tasksInFlight: Number(project.tasksInFlight || 0),
        terminalTaskCount: Number(project.terminalTaskCount || 0),
        contributorCount: Number(project.contributorCount || 0),
        pft: Number(project.pft || project.pftRouted || 0),
        contributors: safeArray(project.contributors).slice(0, 2).map((contributor) => ({
          accountId: safeText(contributor.accountId || contributor.account_id, 180),
          walletAddress: safeText(contributor.walletAddress || contributor.wallet_address, 120),
          role: safeText(contributor.role || contributor.roleLabel || contributor.role_label, 120),
          status: safeText(contributor.status, 80),
        })),
        tasks: compactProjectTasks(project, 2),
        activity: safeArray(project.activity).slice(0, 1).map((event) => ({
          label: safeText(event.label || event.title || event.action, 180),
          state: safeText(event.state || event.status, 80),
          at: event.at || event.updatedAt || event.createdAt || null,
        })),
        productDocument: compactProductDocument(project.productDocument),
      }];
    })),
  };
}

export function compactTaskStateForBoardManager(taskState = {}) {
  return {
    counts: safeArray(taskState.counts).slice(0, 20),
    recent: safeArray(taskState.recent).slice(0, 6).map((task) => ({
      taskId: safeText(task.taskId || task.task_id, 180),
      status: safeText(task.status || task.state, 80),
      title: safeText(task.title, 160),
      kind: safeText(task.kind || task.task_kind, 80),
      rewardActualPft: numberValue(task.rewardActualPft || task.reward_actual_pft, 0),
      updatedAt: task.updatedAt || task.updated_at || null,
    })),
  };
}

export function compactTaskRequestsForBoardManager(requests = []) {
  return safeArray(requests).slice(0, 4).map((request) => ({
    requestId: safeText(request.requestId, 180),
    accountId: safeText(request.accountId, 180),
    subjectWallet: safeText(request.subjectWallet, 120),
    source: safeText(request.source, 80),
    requestText: safeText(request.requestText, 180),
    userDetailText: safeText(request.userDetailText, 220),
    requestedTaskKind: safeText(request.requestedTaskKind, 80),
    status: safeText(request.status, 80),
    generatedTaskId: safeText(request.generatedTaskId, 180),
    lastError: safeText(request.lastError, 300),
    updatedAt: request.updatedAt || null,
  }));
}

function compactNetworkTaskContentItem(task = {}) {
  const state = safeText(task.state || task.status, 80);
  const completed = state === "rewarded";
  const stopped = ["refused", "cancelled", "rejected", "expired", "failed", "rerouted"].includes(state);
  const common = {
    projectId: safeText(task.projectId || task.project_id, 180),
    taskId: safeText(task.taskId || task.task_id, 180),
    requestId: safeText(task.requestId || task.request_id, 180),
    generationJobId: safeText(task.generationJobId || task.generation_job_id, 180),
    state,
    title: safeText(task.title, 140),
    description: safeText(task.description, completed ? 140 : 160),
    rewardOfferPft: numberValue(task.rewardOfferPft || task.reward_offer_pft, 0) || undefined,
    rewardActualPft: numberValue(task.rewardActualPft || task.reward_actual_pft, 0) || undefined,
    projectNeedSummary: safeText(task.projectNeedSummary || task.project_need_summary, 120),
    updatedAt: task.updatedAt || task.updated_at || null,
  };
  if (completed) {
    return presentObject({
      ...common,
      rewardSummary: safeText(task.rewardSummary || task.reward_summary, 140),
    });
  }
  if (stopped) {
    return presentObject({
      ...common,
      stopSummary: safeText(task.stopSummary || task.stop_summary, 120),
    });
  }
  return presentObject({
    ...common,
    steps: compactStringList(task.steps, { limit: 1, max: 120 }),
    submissionRequirement: safeText(task.submissionRequirement || task.submission_requirement, 100),
    verificationAsk: safeText(task.verificationAsk || task.verification_ask, 100),
    routingReason: safeText(task.routingReason || task.routing_reason, 110),
    candidateAccountId: safeText(task.candidateAccountId || task.candidate_account_id, 180),
    candidateWalletAddress: safeText(task.candidateWalletAddress || task.candidate_wallet_address, 120),
  });
}

export function compactNetworkTaskContentForBoardManager(content = {}) {
  // An explicit null (e.g. from a snapshot .catch fallback) bypasses the
  // `= {}` parameter default; normalize before field access.
  content = content && typeof content === "object" ? content : {};
  return {
    schema: safeText(content.schema, 120),
    generatedAt: content.generatedAt || null,
    counts: safeObject(content.counts),
    completed: safeArray(content.completed).slice(0, 4).map(compactNetworkTaskContentItem),
    outstanding: safeArray(content.outstanding).slice(0, 5).map(compactNetworkTaskContentItem),
    stopped: safeArray(content.stopped).slice(0, 2).map(compactNetworkTaskContentItem),
    pendingGeneration: safeArray(content.pendingGeneration).slice(0, 3).map(compactNetworkTaskContentItem),
    text: safeText(content.text, 500),
  };
}

export function compactProjectRegistryForBoardManager(projects = []) {
  return safeArray(projects).slice(0, 8).map((project) => ({
    id: safeText(project.id, 180),
    type: safeText(project.type, 80),
    title: safeText(project.title || project.name, 180),
    summary: safeText(project.summary, 260),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    phaseLabel: safeText(project.phaseLabel || project.phase, 120),
    taskCount: Number(project.taskCount || 0),
    contributorCount: Number(project.contributorCount || 0),
    updatedAt: project.updatedAt || null,
  }));
}

function compactAuthorityBadges(badges = []) {
  return safeArray(badges).slice(0, 8).map((badge) => {
    const item = safeObject(badge);
    return {
      badgeId: safeText(item.badgeId || item.badge_id || item.id, 80),
      label: safeText(item.label || item.name, 120),
      status: safeText(item.status, 80),
      source: safeText(item.source, 120),
    };
  }).filter((badge) => badge.badgeId || badge.label || badge.status);
}

function compactSecretaryAttachment(attachment = {}) {
  return {
    name: safeText(attachment.name || attachment.filename, 180),
    kind: safeText(attachment.kind || attachment.type, 80),
    mimeType: safeText(attachment.mimeType || attachment.mime_type, 120),
    sizeBytes: numberValue(attachment.sizeBytes || attachment.size_bytes, 0),
    textExcerpt: safeText(attachment.textExcerpt || attachment.text_excerpt || attachment.textContent || attachment.text_content, 180),
  };
}

function compactSecretaryEntry(entry = {}) {
  return {
    id: safeText(entry.id, 180),
    accountId: safeText(entry.accountId || entry.account_id, 180),
    displayName: safeText(entry.displayName || entry.display_name, 120),
    body: safeText(entry.body || entry.text || entry.content, 220),
    sourceConversationId: safeText(entry.sourceConversationId || entry.source_conversation_id, 180),
    walletValidated: Boolean(entry.walletValidated ?? entry.wallet_validated),
    walletAddress: safeText(entry.walletAddress || entry.wallet_address, 120),
    authorityBadges: compactAuthorityBadges(entry.authorityBadges || entry.authority_badges),
    attachments: safeArray(entry.attachments).slice(0, 1).map(compactSecretaryAttachment),
    createdAt: entry.createdAt || entry.created_at || null,
  };
}

export function compactSecretarySourceForBoardManager(packet = {}) {
  const sourceJson = safeObject(packet.sourceJson || packet.source_json);
  return {
    digest: safeText(packet.sourcePacketDigest || packet.source_packet_digest || packet.digest, 120),
    counts: safeObject(packet.counts),
    sourceJson: {
      schema: safeText(sourceJson.schema, 120),
      generatedAt: sourceJson.generatedAt || sourceJson.generated_at || null,
      validatedEntryCount: numberValue(sourceJson.validatedEntryCount || sourceJson.validated_entry_count, 0),
      userCount: numberValue(sourceJson.userCount || sourceJson.user_count, 0),
      factsToPreserve: compactStringList(sourceJson.factsToPreserve || sourceJson.facts_to_preserve, { limit: 4, max: 280 }),
      groups: safeArray(sourceJson.groups).slice(0, 2).map((group) => ({
        accountId: safeText(group.accountId || group.account_id, 180),
        displayName: safeText(group.displayName || group.display_name, 120),
        walletAddress: safeText(group.walletAddress || group.wallet_address, 120),
        latestAt: group.latestAt || group.latest_at || null,
        entryCount: numberValue(group.entryCount || group.entry_count, 0),
        authorityBadges: compactAuthorityBadges(group.authorityBadges || group.authority_badges),
        entries: safeArray(group.entries).slice(0, 2).map(compactSecretaryEntry),
      })),
    },
    sourceText: safeText(packet.sourceText || packet.source_text, 600),
  };
}

function compactCandidateCapability(item = {}) {
  return {
    capabilityType: safeText(item.capability_type || item.capabilityType || item.type, 100),
    scopeLabel: safeText(item.scope_label || item.scopeLabel || item.scope, 160),
    status: safeText(item.status || item.effective_status, 80),
    projectId: safeText(item.project_id || item.projectId, 180),
    evidenceTaskId: safeText(item.evidence_task_id || item.evidenceTaskId, 180),
    source: safeText(item.source, 120),
  };
}

export function compactNetworkTaskCandidatesForBoardManager(candidates = []) {
  return safeArray(candidates).slice(0, 8).map((candidate) => {
    const profileOutput = safeObject(candidate.profileOutput || candidate.profile_output || candidate.output_json);
    const capabilityBlock = safeObject(profileOutput.capabilities || profileOutput.capability_profile || profileOutput.capabilityProfile);
    const verifiedCapabilities = [
      ...safeArray(profileOutput.verified_capabilities || profileOutput.verifiedCapabilities),
      ...safeArray(capabilityBlock.verified || capabilityBlock.verified_capabilities || capabilityBlock.verifiedCapabilities),
    ].map(compactCandidateCapability).filter((item) => item.capabilityType || item.scopeLabel || item.status).slice(0, 8);
    const declaredCapabilities = [
      ...safeArray(profileOutput.declared_capabilities || profileOutput.declaredCapabilities),
      ...safeArray(capabilityBlock.declared || capabilityBlock.declared_capabilities || capabilityBlock.declaredCapabilities),
      ...safeArray(capabilityBlock.items),
    ].map(compactCandidateCapability).filter((item) => item.capabilityType || item.scopeLabel || item.status).slice(0, 8);
    return {
      accountId: safeText(candidate.accountId || candidate.account_id, 180),
      walletAddress: safeText(candidate.walletAddress || candidate.wallet_address, 120),
      profileId: safeText(candidate.profileId || candidate.profile_id, 180),
      profileDigest: safeText(candidate.profileDigest || candidate.profile_digest || candidate.source_packet_digest, 120),
      profileText: safeText(candidate.profileText || candidate.profile_text || candidate.output_text, 200),
      profileSummary: safeText(profileOutput.summary || profileOutput.profile_summary || profileOutput.profileSummary, 180),
      verifiedCapabilities,
      declaredCapabilities,
      completedAt: candidate.completedAt || candidate.completed_at || null,
    };
  });
}

function compactCorpusOutput(output = {}) {
  return {
    taskId: safeText(output.taskId || output.task_id, 180),
    requestId: safeText(output.requestId || output.request_id, 180),
    projectId: safeText(output.projectId || output.project_id, 180),
    state: safeText(output.state || output.status, 80),
    title: safeText(output.title, 180),
    summary: safeText(output.eventSummary || output.event_summary || output.summary || output.projectNeedSummary || output.project_need_summary, 240),
    assigneeWallet: safeText(output.assigneeWallet || output.assignee_wallet, 120),
    candidateAccountId: safeText(output.candidateAccountId || output.candidate_account_id, 180),
    rewardPft: numberValue(output.rewardPft || output.reward_pft, 0),
    eventType: safeText(output.eventType || output.event_type, 120),
    sourceCids: compactStringList(output.sourceCids || output.source_cids, { limit: 2, max: 240 }),
    sourceTxHashes: compactStringList(output.sourceTxHashes || output.source_tx_hashes, { limit: 2, max: 180 }),
    actionOutput: safeText(output.actionOutput || output.action_output, 180),
    deliverySurface: safeText(output.deliverySurface || output.delivery_surface, 120),
    escalationStage: safeText(output.escalationStage || output.escalation_stage, 120),
    updatedAt: output.updatedAt || output.updated_at || null,
  };
}

export function compactNetworkTaskOutputCorpusPacketForBoardManager(corpus = {}) {
  const summary = safeObject(corpus.summary);
  const recentOutputs = safeArray(summary.recent_outputs || summary.recentOutputs)
    .slice(0, 8)
    .map((output) => ({
      task_id: safeText(output.task_id || output.taskId, 180),
      project_id: safeText(output.project_id || output.projectId, 180),
      title: safeText(output.title, 160),
      summary: safeText(output.summary, 160),
      state: safeText(output.state || output.status, 80),
    }));
  return {
    schema: safeText(corpus.schema || "pf.hive.network_task_output_corpus.v1", 120),
    generatedAt: corpus.generatedAt || corpus.generated_at || null,
    summary: {
      projects_covered: compactStringList(summary.projects_covered || summary.projectsCovered, { limit: 8, max: 140 }),
      recent_outputs: recentOutputs.slice(0, 2),
      repeated_themes: compactStringList(summary.repeated_themes || summary.repeatedThemes, { limit: 3, max: 160 }),
      open_actionable_items: compactStringList(summary.open_actionable_items || summary.openActionableItems, { limit: 3, max: 160 }),
    },
    outputs: safeArray(corpus.outputs).slice(0, 2).map(compactCorpusOutput),
    deduplicationWatchlist: safeArray(corpus.deduplicationWatchlist || corpus.deduplication_watchlist)
      .slice(0, 2)
      .map((item) => ({
        theme: safeText(item.theme, 140),
        project_id: safeText(item.project_id || item.projectId, 180),
        prior_task_ids: compactStringList(item.prior_task_ids || item.priorTaskIds, { limit: 3, max: 180 }),
        prior_cids: compactStringList(item.prior_cids || item.priorCids, { limit: 1, max: 180 }),
        why_not_repeat: safeText(item.why_not_repeat || item.whyNotRepeat, 160),
        next_action_suggestion: safeText(item.next_action_suggestion || item.nextActionSuggestion, 160),
      })),
  };
}

export function compactEvidenceEvaluationPacketsForBoardManager(packets = []) {
  return safeArray(packets).slice(0, 6).map((packet) => ({
    id: safeText(packet.id, 180),
    taskId: safeText(packet.taskId || packet.task_id, 180),
    projectId: safeText(packet.projectId || packet.project_id, 180),
    status: safeText(packet.status || packet.packetStatus || packet.packet_status, 80),
    summary: safeText(packet.summary || packet.evaluationSummary || packet.evaluation_summary, 240),
    recommendation: safeText(packet.recommendation || packet.recommendedAction || packet.recommended_action, 240),
    riskLevel: safeText(packet.riskLevel || packet.risk_level, 80),
    evidenceCids: compactStringList(packet.evidenceCids || packet.evidence_cids || packet.sourceCids || packet.source_cids, { limit: 4, max: 240 }),
    sourceTxHashes: compactStringList(packet.sourceTxHashes || packet.source_tx_hashes, { limit: 4, max: 180 }),
    updatedAt: packet.updatedAt || packet.updated_at || null,
  }));
}

export function compactEvidenceEvaluationRefreshForBoardManager(refresh = {}) {
  return {
    attempted: numberValue(refresh.attempted, 0),
    createdOrUpdated: numberValue(refresh.createdOrUpdated || refresh.created_or_updated, 0),
    error: safeText(refresh.error, 240),
    results: safeArray(refresh.results).slice(0, 8).map((result) => {
      const packet = safeObject(result.packet);
      return {
        ok: result.ok !== false,
        taskId: safeText(result.taskId || result.task_id || packet.taskId || packet.task_id, 180),
        packetId: safeText(packet.id, 180),
        packetStatus: safeText(packet.packetStatus || packet.packet_status || packet.status, 80),
        summary: safeText(packet.summary, 180),
        error: safeText(result.error, 180),
      };
    }),
  };
}

function compactOrcReviewItem(review = {}) {
  return {
    taskId: safeText(review.taskId || review.task_id, 180),
    disposition: safeText(review.disposition, 120),
    actionRequired: Boolean(review.actionRequired ?? review.action_required),
    actionOwner: safeText(review.actionOwner || review.action_owner, 120),
    confidence: safeText(review.confidence, 40),
    categories: compactStringList(review.categories, { limit: 3, max: 70 }),
    integritySignals: compactStringList(review.integritySignals || review.integrity_signals, { limit: 3, max: 70 }),
    summary: safeText(review.summary, 120),
    recommendedAction: safeText(review.recommendedAction || review.recommended_action, 120),
    reviewerHandle: safeText(review.reviewerHandle || review.reviewer_handle, 120),
    reviewerWallet: safeText(review.reviewerWallet || review.reviewer_wallet, 120),
    reviewedAt: review.reviewedAt || review.reviewed_at || null,
  };
}

function compactOrcRollupItem(rollup = {}) {
  const lastReviewedAction = safeObject(rollup.lastReviewedAction || rollup.last_reviewed_action);
  return {
    accountId: safeText(rollup.accountId || rollup.account_id, 180),
    walletAddress: safeText(rollup.walletAddress || rollup.wallet_address, 120),
    category: safeText(rollup.category, 120),
    reviewedCount: numberValue(rollup.reviewedCount || rollup.reviewed_count, 0),
    actionRequiredCount: numberValue(rollup.actionRequiredCount || rollup.action_required_count, 0),
    integrityFollowUpCount: numberValue(rollup.integrityFollowUpCount || rollup.integrity_follow_up_count, 0),
    hasIntegritySignals: Boolean(rollup.hasIntegritySignals ?? rollup.has_integrity_signals),
    highValueCategory: Boolean(rollup.highValueCategory ?? rollup.high_value_category),
    integritySignalCounts: safeObject(rollup.integritySignalCounts || rollup.integrity_signal_counts),
    repeatedIntegritySignals: compactStringList(rollup.repeatedIntegritySignals || rollup.repeated_integrity_signals, { limit: 3, max: 90 }),
    lastReviewedAction: {
      taskId: safeText(lastReviewedAction.taskId || lastReviewedAction.task_id, 180),
      disposition: safeText(lastReviewedAction.disposition, 120),
      actionRequired: Boolean(lastReviewedAction.actionRequired ?? lastReviewedAction.action_required),
      confidence: safeText(lastReviewedAction.confidence, 40),
      reviewerHandle: safeText(lastReviewedAction.reviewerHandle || lastReviewedAction.reviewer_handle, 120),
      reviewedAt: lastReviewedAction.reviewedAt || lastReviewedAction.reviewed_at || null,
    },
  };
}

function compactOrcRunItem(run = {}) {
  return {
    orcHandle: safeText(run.orcHandle || run.orc_handle, 120),
    agentId: safeText(run.agentId || run.agent_id, 180),
    command: safeText(run.command, 120),
    phase: safeText(run.phase, 80),
    status: safeText(run.status, 80),
    taskId: safeText(run.taskId || run.task_id, 180),
    createdAt: run.createdAt || run.created_at || null,
  };
}

function compactOrcInteractionItem(interaction = {}) {
  return {
    id: safeText(interaction.id, 180),
    orcHandle: safeText(interaction.orcHandle || interaction.orc_handle, 120),
    interactionType: safeText(interaction.interactionType || interaction.interaction_type, 80),
    directive: safeText(interaction.directive, 260),
    issue: safeText(interaction.issue, 260),
    status: safeText(interaction.status, 80),
    createdAt: interaction.createdAt || interaction.created_at || null,
  };
}

export function compactOrcOperationsForBoardManager(orcOperations = {}) {
  const summary = safeObject(orcOperations.summary);
  return {
    schema: safeText(orcOperations.schema || "pf.hive.board_manager.orc_operations.v1", 120),
    generatedAt: orcOperations.generatedAt || orcOperations.generated_at || null,
    status: safeText(orcOperations.status, 120),
    enforcement: safeText(orcOperations.enforcement || "none_context_only", 120),
    accountingPolicy: safeText(orcOperations.accountingPolicy || orcOperations.accounting_policy, 120),
    tables: safeObject(orcOperations.tables),
    summary: {
      activeAgentCount: numberValue(summary.activeAgentCount || summary.active_agent_count, 0),
      availableForRoutingCount: numberValue(summary.availableForRoutingCount || summary.available_for_routing_count, 0),
      outstandingNetworkTaskCount: numberValue(summary.outstandingNetworkTaskCount || summary.outstanding_network_task_count, 0),
      pendingGenerationCount: numberValue(summary.pendingGenerationCount || summary.pending_generation_count, 0),
      actionRequiredReviewCount: numberValue(summary.actionRequiredReviewCount || summary.action_required_review_count, 0),
      reviewRollupCount: numberValue(summary.reviewRollupCount || summary.review_rollup_count, 0),
    },
    agents: safeArray(orcOperations.agents).slice(0, 6).map((agent) => ({
      id: safeText(agent.id, 180),
      handle: safeText(agent.handle, 120),
      agentId: safeText(agent.agentId || agent.agent_id, 180),
      accountId: safeText(agent.accountId || agent.account_id, 180),
      walletAddress: safeText(agent.walletAddress || agent.wallet_address, 120),
      role: safeText(agent.role, 80),
      status: safeText(agent.status, 80),
      active: Boolean(agent.active),
      capacityLimit: numberValue(agent.capacityLimit || agent.capacity_limit, 0),
      routingEligible: Boolean(agent.routingEligible ?? agent.routing_eligible),
      currentTasks: {
        outstandingNetworkTaskCount: numberValue(agent.currentTasks?.outstandingNetworkTaskCount || agent.current_tasks?.outstanding_network_task_count, 0),
        pendingGenerationCount: numberValue(agent.currentTasks?.pendingGenerationCount || agent.current_tasks?.pending_generation_count, 0),
      },
      reviews: {
        reviewedCount: numberValue(agent.reviews?.reviewedCount || agent.reviews?.reviewed_count, 0),
        actionRequiredCount: numberValue(agent.reviews?.actionRequiredCount || agent.reviews?.action_required_count, 0),
      },
      interactions: {
        count: numberValue(agent.interactions?.count, 0),
        unresolvedCount: numberValue(agent.interactions?.unresolvedCount || agent.interactions?.unresolved_count, 0),
      },
      updatedAt: agent.updatedAt || agent.updated_at || null,
    })),
    routingCandidates: safeArray(orcOperations.routingCandidates || orcOperations.routing_candidates).slice(0, 4),
    reviewQueue: {
      actionRequiredCount: numberValue(orcOperations.reviewQueue?.actionRequiredCount || orcOperations.review_queue?.action_required_count, 0),
      recent: safeArray(orcOperations.reviewQueue?.recent || orcOperations.review_queue?.recent).slice(0, 3).map(compactOrcReviewItem),
    },
    reviewRollups: {
      policy: safeText(orcOperations.reviewRollups?.policy || orcOperations.review_rollups?.policy, 120),
      recent: safeArray(orcOperations.reviewRollups?.recent || orcOperations.review_rollups?.recent).slice(0, 12).map(compactOrcRollupItem),
      repeatedIntegritySignals: safeArray(orcOperations.reviewRollups?.repeatedIntegritySignals || orcOperations.review_rollups?.repeated_integrity_signals).slice(0, 6).map(compactOrcRollupItem),
    },
    runJournal: {
      recent: safeArray(orcOperations.runJournal?.recent || orcOperations.run_journal?.recent).slice(0, 2).map(compactOrcRunItem),
    },
    operatorInteractions: {
      recent: safeArray(orcOperations.operatorInteractions?.recent || orcOperations.operator_interactions?.recent).slice(0, 3).map(compactOrcInteractionItem),
    },
  };
}

function compactCapabilityRequirement(requirement = {}) {
  return {
    project_id: safeText(requirement.project_id || requirement.projectId, 180),
    capability_type: safeText(requirement.capability_type || requirement.capabilityType, 100),
    scope_label: safeText(requirement.scope_label || requirement.scopeLabel, 140),
    visibility: safeText(requirement.visibility, 80),
    required_for_work_type: safeText(requirement.required_for_work_type || requirement.requiredForWorkType, 100),
  };
}

function compactCapabilityCandidate(candidate = {}) {
  return {
    account_id: safeText(candidate.account_id || candidate.accountId, 180),
    wallet_address: safeText(candidate.wallet_address || candidate.walletAddress, 120),
    verified_capabilities: safeArray(candidate.verified_capabilities || candidate.verifiedCapabilities)
      .slice(0, 4)
      .map(compactCandidateCapability),
    declared_capabilities: safeArray(candidate.declared_capabilities || candidate.declaredCapabilities)
      .slice(0, 3)
      .map(compactCandidateCapability),
    capability_source: safeText(candidate.capability_source || candidate.capabilitySource, 100),
  };
}

function compactCapabilityGap(gap = {}) {
  return {
    project_id: safeText(gap.project_id || gap.projectId, 180),
    candidate_account_id: safeText(gap.candidate_account_id || gap.candidateAccountId, 180),
    candidate_wallet_address: safeText(gap.candidate_wallet_address || gap.candidateWalletAddress, 120),
    capability_type: safeText(gap.capability_type || gap.capabilityType, 100),
    scope_label: safeText(gap.scope_label || gap.scopeLabel, 140),
    candidate_status: safeText(gap.candidate_status || gap.candidateStatus, 100),
    recommended_task_work_type: safeText(gap.recommended_task_work_type || gap.recommendedTaskWorkType, 120),
  };
}

export function compactCapabilityInstrumentationForBoardManager(instrumentation = {}) {
  return {
    schema: safeText(instrumentation.schema || "pf.hive.board_manager.capability_instrumentation.v1", 120),
    status: safeText(instrumentation.status, 120),
    task_work_type_vocabulary: safeArray(instrumentation.task_work_type_vocabulary || instrumentation.taskWorkTypeVocabulary)
      .slice(0, 4)
      .map((item) => ({
        id: safeText(item.id, 100),
        label: safeText(item.label, 120),
        definition: safeText(item.definition, 160),
      })),
    capability_profile_status: safeText(instrumentation.capability_profile_status || instrumentation.capabilityProfileStatus, 140),
    project_capability_requirements: safeArray(instrumentation.project_capability_requirements || instrumentation.projectCapabilityRequirements)
      .slice(0, 8)
      .map(compactCapabilityRequirement),
    candidate_capabilities: safeArray(instrumentation.candidate_capabilities || instrumentation.candidateCapabilities)
      .slice(0, 8)
      .map(compactCapabilityCandidate),
    capability_gaps: safeArray(instrumentation.capability_gaps || instrumentation.capabilityGaps)
      .slice(0, 12)
      .map(compactCapabilityGap),
    summary: safeObject(instrumentation.summary),
    enforcement: safeText(instrumentation.enforcement || "none_context_only", 100),
  };
}

export function compactProjectPlanningForBoardManager(planning = {}) {
  const generation = safeObject(planning.generation);
  const output = safeObject(generation.output);
  return {
    job: planning.job ? {
      id: safeText(planning.job.id, 180),
      status: safeText(planning.job.status, 80),
      reason: safeText(planning.job.reason, 240),
      sourceReportId: safeText(planning.job.sourceReportId || planning.job.source_report_id, 180),
      updatedAt: planning.job.updatedAt || planning.job.updated_at || null,
    } : null,
    generation: generation.id ? {
      id: safeText(generation.id, 180),
      sourceReportId: safeText(generation.sourceReportId || generation.source_report_id, 180),
      provider: safeText(generation.provider, 80),
      model: safeText(generation.model, 160),
      promptVersion: safeText(generation.promptVersion || generation.prompt_version, 120),
      completedAt: generation.completedAt || generation.completed_at || null,
      output: {
        title: safeText(output.title, 180),
        summary: safeText(output.summary, 300),
        projects: safeArray(output.projects).slice(0, 8).map((project) => ({
          id: safeText(project.id, 180),
          type: safeText(project.type, 80),
          title: safeText(project.title || project.name, 180),
          summary: safeText(project.summary, 220),
          status: safeText(project.status, 80),
          priority: numberValue(project.priority, 0),
          phaseLabel: safeText(project.phase_label || project.phaseLabel || project.phase, 120),
        })),
      },
    } : null,
  };
}

export function compactHiveSecretaryStateForBoardManager(state = {}) {
  const report = safeObject(state.report);
  const job = safeObject(state.job);
  const output = safeObject(report.output || report.output_json);
  return {
    status: safeText(state.status, 80),
    report: report.id ? {
      id: safeText(report.id, 180),
      sourcePacketDigest: safeText(report.sourcePacketDigest || report.source_packet_digest, 120),
      outputTitle: safeText(output.title, 180),
      outputSummary: safeText(output.summary, 240),
      completedAt: report.completedAt || report.completed_at || null,
      updatedAt: report.updatedAt || report.updated_at || null,
    } : null,
    job: job.id ? {
      id: safeText(job.id, 180),
      status: safeText(job.status, 80),
      reason: safeText(job.reason, 180),
      createdAt: job.createdAt || job.created_at || null,
      updatedAt: job.updatedAt || job.updated_at || null,
    } : null,
  };
}

export function compactOperatorStandingPolicyForBoardManager(policy = []) {
  return safeArray(policy).slice(0, 8).map((item) => ({
    source_id: safeText(item.source_id || item.sourceId || item.id, 180),
    source_account_id: safeText(item.source_account_id || item.sourceAccountId || item.account_id || item.accountId, 180),
    created_at: safeText(item.created_at || item.createdAt, 80),
    directive: safeText(item.directive || item.body || item.text, 420),
    active_scope: safeText(item.active_scope || item.activeScope || "global", 80) || "global",
    generation_implication: safeText(item.generation_implication || item.generationImplication, 300),
  })).filter((item) => item.directive || item.source_id);
}

export function compactBoardActionPressureForBoardManager(pressure = {}) {
  const candidateCapacity = safeObject(pressure.candidateCapacity || pressure.candidate_capacity);
  const compactCapacityBlocker = (blocker = {}) => {
    const rewardOfferPft = numberValue(blocker.rewardOfferPft ?? blocker.reward_offer_pft, 0);
    return presentObject({
      kind: safeText(blocker.kind, 40),
      taskId: safeText(blocker.taskId || blocker.task_id, 180),
      generationJobId: safeText(blocker.generationJobId || blocker.generation_job_id, 180),
      allocationId: safeText(blocker.allocationId || blocker.allocation_id, 180),
      projectId: safeText(blocker.projectId || blocker.project_id, 180),
      title: safeText(blocker.title, 180),
      state: safeText(blocker.state || blocker.status, 80),
      rewardOfferPft: rewardOfferPft || undefined,
      acceptBy: safeText(blocker.acceptBy || blocker.accept_by, 80),
      deadlineAt: safeText(blocker.deadlineAt || blocker.deadline_at, 80),
    });
  };
  return {
    schema: safeText(pressure.schema || "pf.hive.board_action_pressure.v1", 120),
    summary: safeObject(pressure.summary),
    candidateCapacity: {
      eligibleCandidates: safeArray(candidateCapacity.eligibleCandidates || candidateCapacity.eligible_candidates).slice(0, 4),
      candidates: safeArray(candidateCapacity.candidates).slice(0, 5).map((candidate) => ({
        accountId: safeText(candidate.accountId || candidate.account_id, 180),
        walletAddress: safeText(candidate.walletAddress || candidate.wallet_address, 120),
        availableForNetworkTask: candidate.availableForNetworkTask !== false && candidate.available_for_network_task !== false,
        capacityBlockers: safeArray(candidate.capacityBlockers || candidate.capacity_blockers).slice(0, 2).map(compactCapacityBlocker),
      })),
      activeNetworkTaskCapacityBlockers: safeArray(candidateCapacity.activeNetworkTaskCapacityBlockers || candidateCapacity.active_network_task_capacity_blockers)
        .slice(0, 5)
        .map(compactCapacityBlocker),
    },
    signals: safeArray(pressure.signals).slice(0, 5).map((signal) => ({
      projectId: safeText(signal.projectId || signal.project_id, 180),
      title: safeText(signal.title, 180),
      status: safeText(signal.status, 80),
      severity: safeText(signal.severity, 80),
      requiresAction: Boolean(signal.requiresAction ?? signal.requires_action),
      pressure: safeText(signal.pressure, 120),
      reasons: compactStringList(signal.reasons, { limit: 2, max: 160 }),
      allowedNextActions: compactStringList(signal.allowedNextActions || signal.allowed_next_actions, { limit: 4, max: 80 }),
      preferredNextAction: safeText(signal.preferredNextAction || signal.preferred_next_action, 80),
      plannedTaskCount: numberValue(signal.plannedTaskCount || signal.planned_task_count, 0),
      liveTaskCount: numberValue(signal.liveTaskCount || signal.live_task_count, 0),
      plannedContributorCount: numberValue(signal.plannedContributorCount || signal.planned_contributor_count, 0),
      liveContributorCount: numberValue(signal.liveContributorCount || signal.live_contributor_count, 0),
      hasOutstandingNetworkTask: Boolean(signal.hasOutstandingNetworkTask ?? signal.has_outstanding_network_task),
      hasPendingNetworkTaskGeneration: Boolean(signal.hasPendingNetworkTaskGeneration ?? signal.has_pending_network_task_generation),
      latestClosureAt: signal.latestClosureAt || signal.latest_closure_at || null,
      recentlyHandled: Boolean(signal.recentlyHandled ?? signal.recently_handled),
    })),
    policy: {
      emptyActiveProjectRequiresAction: true,
      candidateCapacityIsConsumedOnlyByOutstandingOrPendingNetworkTasks: true,
      doNothingRequiresHealthyMotionOrRecentHandling: true,
      stoppedOrRefusedNetworkTaskRequiresFollowup: true,
    },
  };
}

export function compactRoutingConstraintsForBoardManager(snapshot = {}) {
  return {
    ok: snapshot.ok !== false,
    status: safeText(snapshot.status, 80),
    generatedAt: snapshot.generatedAt || snapshot.generated_at || null,
    activeAllocationStatuses: compactStringList(snapshot.activeAllocationStatuses || snapshot.active_allocation_statuses, { limit: 12, max: 80 }),
    accounts: safeArray(snapshot.accounts).slice(0, 8).map((account) => ({
      accountId: safeText(account.accountId || account.account_id, 180),
      reservationRate: safeObject(account.reservationRate || account.reservation_rate),
      recentRefusals: safeObject(account.recentRefusals || account.recent_refusals),
    })),
    digest: safeText(snapshot.digest, 120),
  };
}

export function compactOpenFollowupsForBoardManager(followups = []) {
  return safeArray(followups).slice(0, 5).map((followup) => ({
    id: safeText(followup.id, 180),
    runId: safeText(followup.runId || followup.run_id, 180),
    accountId: safeText(followup.accountId || followup.account_id, 180),
    projectId: safeText(followup.projectId || followup.project_id, 180),
    blockerType: safeText(followup.blockerType || followup.blocker_type, 120),
    blockerSummary: safeText(followup.blockerSummary || followup.blocker_summary, 220),
    expectedResponse: safeText(followup.expectedResponse || followup.expected_response, 180),
    lastSentAt: followup.lastSentAt || followup.last_sent_at || null,
    expiresAt: followup.expiresAt || followup.expires_at || null,
  }));
}

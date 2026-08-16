function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactPressureSummary(sourcePacket = {}) {
  const summary = safeObject(sourcePacket?.boardActionPressure?.summary);
  return Object.entries(summary)
    .slice(0, 12)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(", ");
}

function sourceProjectSummaries(sourcePacket = {}) {
  const projects = safeObject(sourcePacket?.hiveProjects?.projects || sourcePacket?.projects);
  return Object.values(projects)
    .slice(0, 12)
    .map((project) => {
      const item = safeObject(project);
      return {
        project_id: safeText(item.id || item.project_id || item.projectId, 180),
        title: safeText(item.title || item.name, 240),
        state: safeText(item.state || item.status || "unknown", 80),
        live_task_count: Math.max(0, Math.round(Number(item.liveTaskCount ?? item.live_task_count ?? item.taskCount ?? 0) || 0)),
        contributor_count: Math.max(0, Math.round(Number(item.contributorCount ?? item.contributor_count ?? 0) || 0)),
        status: safeText(item.status || item.summary || item.objective, 900),
        next_needed: safeText(item.nextNeeded || item.next_needed || item.next_actions || "", 900),
      };
    })
    .filter((item) => item.project_id || item.title || item.status);
}

function fallbackFactsToPreserve({
  sourcePacket = {},
  operatorStandingPolicy = [],
  priorOutputCorpusSummary = {},
  deduplicationWatchlist = [],
  projectLeaderInputs = [],
  capabilityGapSummary = {},
  orcOperationsSummary = {},
} = {}) {
  const corpus = safeObject(priorOutputCorpusSummary);
  const recentOutputIds = safeArray(corpus.recent_outputs)
    .map((item) => typeof item === "string" ? item : safeObject(item).task_id || safeObject(item).taskId)
    .filter(Boolean);
  const dedupTaskIds = safeArray(deduplicationWatchlist)
    .flatMap((item) => safeArray(item.prior_task_ids || item.priorTaskIds))
    .filter(Boolean);
  const projectLeaderFacts = safeArray(projectLeaderInputs)
    .map((input) => {
      const item = safeObject(input);
      const entryId = safeText(item.source_entry_id || item.sourceEntryId, 180);
      const handle = safeText(item.hive_handle || item.hiveHandle || item.handle, 120);
      if (!entryId && !handle) return "";
      return `project_leader_input:${entryId || "entry"}:${handle || "handle"}`;
    })
    .filter(Boolean);
  const capabilityGapFacts = safeArray(capabilityGapSummary.gaps)
    .map((gap) => {
      const item = safeObject(gap);
      const projectId = safeText(item.project_id || item.projectId, 180);
      const capabilityType = safeText(item.capability_type || item.capabilityType, 120);
      const candidateAccountId = safeText(item.candidate_account_id || item.candidateAccountId, 180);
      if (!projectId && !capabilityType && !candidateAccountId) return "";
      return `capability_gap:${projectId || "project"}:${capabilityType || "capability"}:${candidateAccountId || "candidate"}`;
    })
    .filter(Boolean);
  const orcFacts = safeArray(orcOperationsSummary.agents)
    .map((agent) => {
      const item = safeObject(agent);
      const handle = safeText(item.handle || item.agent_id || item.account_id, 120);
      if (!handle) return "";
      return `orc_agent:${handle}:status=${safeText(item.status, 80) || "unknown"}:network_tasks=${Math.max(0, Math.round(Number(item.outstanding_network_task_count || 0) || 0))}`;
    })
    .filter(Boolean);
  const orcReviewFacts = Math.max(0, Math.round(Number(orcOperationsSummary.action_required_review_count || 0) || 0)) > 0
    ? [`orc_reviews:action_required=${Math.max(0, Math.round(Number(orcOperationsSummary.action_required_review_count || 0) || 0))}`]
    : [];
  const orcRollupFacts = safeArray(orcOperationsSummary.review_rollups)
    .slice(0, 8)
    .map((rollup) => {
      const item = safeObject(rollup);
      const wallet = safeText(item.wallet_address || item.walletAddress, 120);
      const account = safeText(item.account_id || item.accountId, 180);
      const category = safeText(item.category || "uncategorized", 120);
      const integrityCount = Math.max(
        0,
        Math.round(Number(item.integrity_follow_up_count ?? item.integrityFollowUpCount ?? 0) || 0)
      );
      if (!wallet && !account) return "";
      return `orc_review_rollup:${account || wallet}:${category}:integrity_follow_up=${integrityCount}`;
    })
    .filter(Boolean);
  return [
    safeText(sourcePacket.sourcePacketDigest, 120) ? `source_packet_digest:${safeText(sourcePacket.sourcePacketDigest, 120)}` : "",
    ...safeArray(operatorStandingPolicy).map((item) => `operator_policy:${item.source_id || item.sourceId || "source"}`),
    ...projectLeaderFacts,
    ...recentOutputIds.map((taskId) => `prior_output:${safeText(taskId, 180)}`),
    ...dedupTaskIds.map((taskId) => `dedup_against:${safeText(taskId, 180)}`),
    ...capabilityGapFacts,
    ...orcFacts,
    ...orcReviewFacts,
    ...orcRollupFacts,
  ].filter(Boolean).slice(0, 32);
}

export function boardManagerSecretaryFallbackPacket({ sourcePacket = {}, parseError = "" } = {}) {
  const pressure = safeObject(sourcePacket?.boardActionPressure?.summary);
  const requiresAction = clampBoolean(pressure.requiresAction ?? pressure.requires_action, false);
  const operatorStandingPolicy = normalizeOperatorStandingPolicy(
    sourcePacket.operatorStandingPolicy || sourcePacket.operator_standing_policy
  );
  const generationQualityPolicy = normalizeGenerationQualityPolicy(
    sourcePacket.generationQualityPolicy || sourcePacket.generation_quality_policy
  );
  const priorOutputCorpusSummary = normalizePriorOutputCorpusSummary(
    sourcePacket.priorOutputCorpusSummary ||
      sourcePacket.prior_output_corpus_summary ||
      sourcePacket.networkTaskOutputCorpus?.summary ||
      sourcePacket.network_task_output_corpus?.summary
  );
  const deduplicationWatchlist = normalizeDeduplicationWatchlist(
    sourcePacket.deduplicationWatchlist ||
      sourcePacket.deduplication_watchlist ||
      sourcePacket.networkTaskOutputCorpus?.deduplicationWatchlist ||
      sourcePacket.network_task_output_corpus?.deduplicationWatchlist
  );
  const projectLeaderInputs = normalizeProjectLeaderInputs(sourcePacket.projectLeaderInputs || sourcePacket.project_leader_inputs);
  const capabilityGapSummary = normalizeCapabilityGapSummary(
    sourcePacket.capabilityGapSummary ||
      sourcePacket.capability_gap_summary ||
      sourcePacket.capabilityInstrumentation ||
      sourcePacket.capability_instrumentation
  );
  const badgeEligibility = normalizeBadgeEligibility(sourcePacket.badgeEligibility || sourcePacket.badge_eligibility);
  const orcOperationsSummary = normalizeOrcOperationsSummary(
    sourcePacket.orcOperations || sourcePacket.orc_operations || sourcePacket.orcOperationsSummary || sourcePacket.orc_operations_summary
  );
  const candidateCount = Math.max(
    safeArray(sourcePacket.networkTaskCandidates).length,
    Number(pressure.eligibleCandidateCount || pressure.eligible_candidate_count || 0) || 0
  );
  const corpusOutputCount = safeArray(sourcePacket.networkTaskOutputCorpus?.outputs || sourcePacket.network_task_output_corpus?.outputs).length ||
    safeArray(priorOutputCorpusSummary.recent_outputs).length;
  const normalized = normalizeBoardManagerSecretaryPacket({
    motion_state: requiresAction ? "needs_attention" : "moving",
    requires_attention: requiresAction,
    do_nothing_allowed: !requiresAction,
    board_summary: "Source-derived Secretary fallback packet created because the Secretary model returned malformed JSON after one repair attempt.",
    reason_summary: [
      "The fallback preserves deterministic source facts and non-compressible generation policy instead of failing the Board Manager worker.",
      `Parse error: ${safeText(parseError, 300) || "unknown"}`,
    ].join(" "),
    staleness_summary: "No model-authored staleness summary was available; downstream decision model must rely on preserved source packet pressure and freshness fields.",
    action_pressure_summary: compactPressureSummary(sourcePacket) || "No deterministic action pressure summary was present.",
    recommended_context_request: { packet_type: "board_triage", target_type: "none", target_id: "", reason: "" },
    attention_targets: [],
    project_summaries: sourceProjectSummaries(sourcePacket),
    network_task_summary: `${corpusOutputCount} prior network-task corpus outputs preserved for reference and deduplication.`,
    candidate_summary: `${candidateCount} network-task candidate(s) preserved from the source packet.`,
    recent_run_summary: `${safeArray(sourcePacket.recentBoardManagerRuns).length} recent Board Manager run(s) were present in the source packet.`,
    operator_standing_policy: operatorStandingPolicy,
    generation_quality_policy: generationQualityPolicy,
    prior_output_corpus_summary: priorOutputCorpusSummary,
    deduplication_watchlist: deduplicationWatchlist,
    project_leader_inputs: projectLeaderInputs,
    capability_gap_summary: capabilityGapSummary,
    badge_eligibility: badgeEligibility,
    orc_operations_summary: orcOperationsSummary,
    facts_to_preserve: fallbackFactsToPreserve({
      sourcePacket,
      operatorStandingPolicy,
      priorOutputCorpusSummary,
      deduplicationWatchlist,
      projectLeaderInputs,
      capabilityGapSummary,
      orcOperationsSummary,
    }),
    redaction_count: 0,
  });
  return normalized;
}

function clampBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeContextRequest(value = {}) {
  const input = safeObject(value);
  const packetType = safeText(input.packet_type || input.packetType, 80);
  const targetType = safeText(input.target_type || input.targetType, 80);
  return {
    packet_type: ["board_triage", "project_focus", "contributor_focus", "network_task_evidence", "none"].includes(packetType)
      ? packetType
      : "none",
    target_type: ["network_project", "account", "task", "hive_context_entry", "none"].includes(targetType)
      ? targetType
      : "none",
    target_id: safeText(input.target_id || input.targetId, 240),
    reason: safeText(input.reason, 1000),
  };
}

export function normalizeOperatorStandingPolicy(value = []) {
  return safeArray(value)
    .slice(0, 16)
    .map((item) => {
      const input = safeObject(item);
      return {
        source_id: safeText(input.source_id || input.sourceId || input.id, 180),
        source_account_id: safeText(input.source_account_id || input.sourceAccountId || input.account_id || input.accountId, 180),
        created_at: safeText(input.created_at || input.createdAt, 80),
        directive: safeText(input.directive || input.body || input.text, 1200),
        active_scope: safeText(input.active_scope || input.activeScope || "global", 80) || "global",
        generation_implication: safeText(
          input.generation_implication ||
            input.generationImplication ||
            "Preserve as operator policy context for Network Task shape, routing, and output decisions.",
          900
        ),
      };
    })
    .filter((item) => item.directive || item.source_id);
}

export function normalizeGenerationQualityPolicy(value = {}) {
  const input = safeObject(value);
  return {
    documentation_only_default: safeText(
      input.documentation_only_default || input.documentationOnlyDefault || "low_value_unless_action_coupled",
      120
    ) || "low_value_unless_action_coupled",
    requires_concrete_action_output: clampBoolean(
      input.requires_concrete_action_output ?? input.requiresConcreteActionOutput,
      true
    ),
    escalation_ladder: safeText(input.escalation_ladder || input.escalationLadder || "document_to_action_v1", 120) ||
      "document_to_action_v1",
    operator_constraints_summary: safeText(input.operator_constraints_summary || input.operatorConstraintsSummary, 1200),
  };
}

export function normalizePriorOutputCorpusSummary(value = {}) {
  const input = safeObject(value);
  return {
    projects_covered: safeArray(input.projects_covered || input.projectsCovered)
      .slice(0, 12)
      .map((item) => safeText(item, 180))
      .filter(Boolean),
    recent_outputs: safeArray(input.recent_outputs || input.recentOutputs)
      .slice(0, 18)
      .map((item) => {
        if (typeof item === "string") return safeText(item, 700);
        const output = safeObject(item);
        return {
          task_id: safeText(output.task_id || output.taskId, 180),
          project_id: safeText(output.project_id || output.projectId, 180),
          title: safeText(output.title, 240),
          summary: safeText(output.summary || output.description, 700),
          state: safeText(output.state || output.status, 80),
        };
      })
      .filter((item) => typeof item === "string" ? item : item.task_id || item.title || item.summary),
    repeated_themes: safeArray(input.repeated_themes || input.repeatedThemes)
      .slice(0, 12)
      .map((item) => safeText(item, 700))
      .filter(Boolean),
    open_actionable_items: safeArray(input.open_actionable_items || input.openActionableItems)
      .slice(0, 12)
      .map((item) => safeText(item, 700))
      .filter(Boolean),
  };
}

export function normalizeDeduplicationWatchlist(value = []) {
  return safeArray(value)
    .slice(0, 16)
    .map((item) => {
      const input = safeObject(item);
      return {
        theme: safeText(input.theme, 240),
        project_id: safeText(input.project_id || input.projectId, 180),
        prior_task_ids: safeArray(input.prior_task_ids || input.priorTaskIds)
          .slice(0, 10)
          .map((taskId) => safeText(taskId, 180))
          .filter(Boolean),
        prior_cids: safeArray(input.prior_cids || input.priorCids)
          .slice(0, 10)
          .map((cid) => safeText(cid, 240))
          .filter(Boolean),
        why_not_repeat: safeText(input.why_not_repeat || input.whyNotRepeat, 900),
        next_action_suggestion: safeText(input.next_action_suggestion || input.nextActionSuggestion, 900),
      };
    })
    .filter((item) => item.theme || item.prior_task_ids.length || item.prior_cids.length || item.next_action_suggestion);
}

export function normalizeCapabilityGapSummary(value = {}) {
  const input = safeObject(value);
  const summary = safeObject(input.summary);
  const rawGaps = safeArray(input.gaps || input.capability_gaps || input.capabilityGaps);
  return {
    schema: "pf.hive.board_manager.capability_gap_summary.v1",
    status: safeText(input.status || "phase_b_capability_profiles_context_only", 120) ||
      "phase_b_capability_profiles_context_only",
    enforcement: safeText(input.enforcement || "none_context_only", 120) || "none_context_only",
    requirement_count: Math.max(
      0,
      Math.round(Number(input.requirement_count ?? input.requirementCount ?? summary.requirement_count ?? summary.requirementCount ?? 0) || 0)
    ),
    candidate_count: Math.max(
      0,
      Math.round(Number(input.candidate_count ?? input.candidateCount ?? summary.candidate_count ?? summary.candidateCount ?? 0) || 0)
    ),
    gap_count: Math.max(
      0,
      Math.round(Number(input.gap_count ?? input.gapCount ?? summary.gap_count ?? summary.gapCount ?? rawGaps.length) || 0)
    ),
    verified_capability_count: Math.max(
      0,
      Math.round(
        Number(input.verified_capability_count ?? input.verifiedCapabilityCount ?? summary.verified_capability_count ?? summary.verifiedCapabilityCount ?? 0) || 0
      )
    ),
    task_work_types: safeArray(input.task_work_types || input.taskWorkTypes || input.task_work_type_vocabulary || input.taskWorkTypeVocabulary)
      .slice(0, 8)
      .map((item) => {
        const type = safeObject(item);
        return {
          id: safeText(type.id, 80),
          label: safeText(type.label, 120),
          definition: safeText(type.definition, 500),
        };
      })
      .filter((item) => item.id || item.label),
    gaps: rawGaps
      .slice(0, 16)
      .map((item) => {
        const gap = safeObject(item);
        return {
          project_id: safeText(gap.project_id || gap.projectId, 180),
          candidate_account_id: safeText(gap.candidate_account_id || gap.candidateAccountId, 180),
          capability_type: safeText(gap.capability_type || gap.capabilityType, 120),
          scope_label: safeText(gap.scope_label || gap.scopeLabel, 180),
          candidate_status: safeText(gap.candidate_status || gap.candidateStatus, 120),
          recommended_task_work_type: safeText(gap.recommended_task_work_type || gap.recommendedTaskWorkType, 120),
          privacy_note: safeText(gap.privacy_note || gap.privacyNote, 500),
        };
      })
      .filter((item) => item.project_id || item.candidate_account_id || item.capability_type),
    open_questions_reserved_for_alex: safeArray(
      input.open_questions_reserved_for_alex || input.openQuestionsReservedForAlex || input.open_questions || input.openQuestions
    )
      .slice(0, 8)
      .map((item) => safeText(item, 300))
      .filter(Boolean),
  };
}

export function normalizeBadgeEligibility(value = {}) {
  const input = safeObject(value);
  const candidates = safeArray(input.candidates)
    .slice(0, 24)
    .map((item) => {
      const candidate = safeObject(item);
      return {
        account_id: safeText(candidate.account_id || candidate.accountId, 180),
        wallet_address: safeText(candidate.wallet_address || candidate.walletAddress, 120),
        verified_badges: safeArray(candidate.verified_badges || candidate.verifiedBadges)
          .slice(0, 12)
          .map((badge) => safeText(badge, 80))
          .filter(Boolean),
        default_badge: safeText(candidate.default_badge || candidate.defaultBadge, 80),
        allowed_work_types: safeArray(candidate.allowed_work_types || candidate.allowedWorkTypes)
          .slice(0, 24)
          .map((workType) => safeText(workType, 120))
          .filter(Boolean),
        reward_caps: safeObject(candidate.reward_caps || candidate.rewardCaps),
      };
    })
    .filter((item) => item.account_id || item.wallet_address);
  return {
    schema: safeText(input.schema || "pf.task_node.badge_eligibility.v1", 120),
    catalog_version: safeText(input.catalog_version || input.catalogVersion || "network_badges_v1", 120),
    enforcement: safeText(input.enforcement || "executor_required", 120) || "executor_required",
    candidate_count: Math.max(0, Math.round(Number(input.candidate_count ?? input.candidateCount ?? candidates.length) || 0)),
    badge_eligible_candidate_count: Math.max(
      0,
      Math.round(Number(input.badge_eligible_candidate_count ?? input.badgeEligibleCandidateCount ?? candidates.filter((candidate) => candidate.verified_badges.length > 0).length) || 0)
    ),
    candidates,
  };
}

export function normalizeOrcOperationsSummary(value = {}) {
  const input = safeObject(value);
  const summary = safeObject(input.summary || input);
  const agents = safeArray(input.agents)
    .slice(0, 12)
    .map((item) => {
      const agent = safeObject(item);
      const currentTasks = safeObject(agent.currentTasks || agent.current_tasks);
      const reviews = safeObject(agent.reviews);
      return {
        handle: safeText(agent.handle, 120),
        agent_id: safeText(agent.agent_id || agent.agentId, 180),
        account_id: safeText(agent.account_id || agent.accountId, 180),
        wallet_address: safeText(agent.wallet_address || agent.walletAddress, 120),
        status: safeText(agent.status || "active", 80),
        active: clampBoolean(agent.active, true),
        routing_eligible: clampBoolean(agent.routingEligible ?? agent.routing_eligible, false),
        outstanding_network_task_count: Math.max(
          0,
          Math.round(Number(currentTasks.outstandingNetworkTaskCount ?? currentTasks.outstanding_network_task_count ?? 0) || 0)
        ),
        pending_generation_count: Math.max(
          0,
          Math.round(Number(currentTasks.pendingGenerationCount ?? currentTasks.pending_generation_count ?? 0) || 0)
        ),
        action_required_review_count: Math.max(
          0,
          Math.round(Number(reviews.actionRequiredCount ?? reviews.action_required_count ?? 0) || 0)
        ),
      };
    })
    .filter((item) => item.handle || item.account_id || item.wallet_address);
  const recentReviews = safeArray(input.reviewQueue?.recent || input.review_queue?.recent)
    .slice(0, 8)
    .map((item) => {
      const review = safeObject(item);
      return {
        task_id: safeText(review.task_id || review.taskId, 180),
        disposition: safeText(review.disposition || "not_reviewed", 120),
        action_required: clampBoolean(review.action_required ?? review.actionRequired, false),
        reviewer_handle: safeText(review.reviewer_handle || review.reviewerHandle, 120),
        summary: safeText(review.summary, 700),
        recommended_action: safeText(review.recommended_action || review.recommendedAction, 700),
      };
    })
    .filter((item) => item.task_id || item.summary || item.recommended_action);
  const recentInteractions = safeArray(input.operatorInteractions?.recent || input.operator_interactions?.recent)
    .slice(0, 8)
    .map((item) => {
      const interaction = safeObject(item);
      return {
        orc_handle: safeText(interaction.orc_handle || interaction.orcHandle, 120),
        interaction_type: safeText(interaction.interaction_type || interaction.interactionType, 80),
        status: safeText(interaction.status, 80),
        directive: safeText(interaction.directive, 700),
        issue: safeText(interaction.issue, 700),
        created_at: safeText(interaction.created_at || interaction.createdAt, 80),
      };
    })
    .filter((item) => item.orc_handle || item.directive || item.issue);
  const reviewRollupsSource = safeArray(
    input.reviewRollups?.recent ||
      input.review_rollups?.recent ||
      input.reviewRollups ||
      input.review_rollups
  );
  const reviewRollups = reviewRollupsSource
    .slice(0, 10)
    .map((item) => {
      const rollup = safeObject(item);
      const lastAction = safeObject(rollup.lastReviewedAction || rollup.last_reviewed_action);
      return {
        account_id: safeText(rollup.account_id || rollup.accountId, 180),
        wallet_address: safeText(rollup.wallet_address || rollup.walletAddress, 120),
        category: safeText(rollup.category || "uncategorized", 120) || "uncategorized",
        reviewed_count: Math.max(0, Math.round(Number(rollup.reviewed_count ?? rollup.reviewedCount ?? 0) || 0)),
        action_required_count: Math.max(
          0,
          Math.round(Number(rollup.action_required_count ?? rollup.actionRequiredCount ?? 0) || 0)
        ),
        integrity_follow_up_count: Math.max(
          0,
          Math.round(Number(rollup.integrity_follow_up_count ?? rollup.integrityFollowUpCount ?? 0) || 0)
        ),
        resolved_review_count: Math.max(
          0,
          Math.round(Number(rollup.resolved_review_count ?? rollup.resolvedReviewCount ?? 0) || 0)
        ),
        high_value_category: clampBoolean(rollup.high_value_category ?? rollup.highValueCategory, false),
        repeated_integrity_signals: safeArray(rollup.repeated_integrity_signals || rollup.repeatedIntegritySignals)
          .slice(0, 6)
          .map((signal) => safeText(signal, 120))
          .filter(Boolean),
        integrity_signal_counts: safeObject(rollup.integrity_signal_counts || rollup.integritySignalCounts),
        last_reviewed_action: {
          task_id: safeText(lastAction.task_id || lastAction.taskId, 180),
          disposition: safeText(lastAction.disposition, 120),
          action_required: clampBoolean(lastAction.action_required ?? lastAction.actionRequired, false),
          reviewer_handle: safeText(lastAction.reviewer_handle || lastAction.reviewerHandle, 120),
          updated_at: safeText(lastAction.updated_at || lastAction.updatedAt, 80),
        },
        last_review_at: safeText(rollup.last_review_at || rollup.lastReviewAt, 80),
      };
    })
    .filter((item) => item.account_id || item.wallet_address);
  return {
    schema: "pf.hive.board_manager.orc_operations_summary.v1",
    enforcement: safeText(input.enforcement || "none_context_only", 120) || "none_context_only",
    agent_count: Math.max(0, Math.round(Number(summary.agentCount ?? summary.agent_count ?? agents.length) || 0)),
    active_agent_count: Math.max(0, Math.round(Number(summary.activeAgentCount ?? summary.active_agent_count ?? 0) || 0)),
    available_for_routing_count: Math.max(
      0,
      Math.round(Number(summary.availableForRoutingCount ?? summary.available_for_routing_count ?? 0) || 0)
    ),
    outstanding_orc_network_task_count: Math.max(
      0,
      Math.round(Number(summary.outstandingOrcNetworkTaskCount ?? summary.outstanding_orc_network_task_count ?? 0) || 0)
    ),
    pending_orc_generation_count: Math.max(
      0,
      Math.round(Number(summary.pendingOrcGenerationCount ?? summary.pending_orc_generation_count ?? 0) || 0)
    ),
    action_required_review_count: Math.max(
      0,
      Math.round(Number(summary.actionRequiredReviewCount ?? summary.action_required_review_count ?? 0) || 0)
    ),
    review_history_count: Math.max(
      0,
      Math.round(Number(summary.reviewHistoryCount ?? summary.review_history_count ?? 0) || 0)
    ),
    review_rollup_count: Math.max(0, Math.round(Number(summary.reviewRollupCount ?? summary.review_rollup_count ?? reviewRollups.length) || 0)),
    integrity_follow_up_rollup_count: Math.max(
      0,
      Math.round(Number(summary.integrityFollowUpRollupCount ?? summary.integrity_follow_up_rollup_count ?? 0) || 0)
    ),
    repeated_integrity_signal_rollup_count: Math.max(
      0,
      Math.round(Number(summary.repeatedIntegritySignalRollupCount ?? summary.repeated_integrity_signal_rollup_count ?? 0) || 0)
    ),
    recent_interaction_count: Math.max(
      0,
      Math.round(Number(summary.recentInteractionCount ?? summary.recent_interaction_count ?? 0) || 0)
    ),
    agents,
    review_rollups: reviewRollups,
    recent_reviews: recentReviews,
    recent_operator_interactions: recentInteractions,
  };
}

export function normalizeProjectLeaderInputs(value = []) {
  return safeArray(value).slice(0, 16).map((input) => {
    const item = safeObject(input);
    return {
      source_entry_id: safeText(item.source_entry_id || item.sourceEntryId, 180),
      account_id: safeText(item.account_id || item.accountId, 180),
      display_name: safeText(item.display_name || item.displayName, 120),
      hive_handle: safeText(item.hive_handle || item.hiveHandle || item.handle, 120),
      wallet_address: safeText(item.wallet_address || item.walletAddress, 120),
      source_conversation_id: safeText(item.source_conversation_id || item.sourceConversationId, 180),
      created_at: safeText(item.created_at || item.createdAt, 80),
      authority: safeArray(item.authority).slice(0, 8).map((authority) => safeText(authority, 120)).filter(Boolean),
      body_excerpt: safeText(item.body_excerpt || item.bodyExcerpt, 800),
    };
  }).filter((item) => item.source_entry_id || item.account_id || item.hive_handle);
}

export function normalizeBoardManagerSecretaryPacket(output = {}) {
  const input = safeObject(output);
  const motionState = safeText(input.motion_state || input.motionState, 80).toLowerCase();
  const normalizedMotionState = ["moving", "stalled", "blocked", "needs_attention", "unknown"].includes(motionState)
    ? motionState
    : "unknown";
  return {
    schema: "pf.hive.board_manager.secretary_packet.v1",
    motion_state: normalizedMotionState,
    requires_attention: clampBoolean(input.requires_attention ?? input.requiresAttention, false),
    do_nothing_allowed: clampBoolean(input.do_nothing_allowed ?? input.doNothingAllowed, normalizedMotionState === "moving"),
    board_summary: safeText(input.board_summary || input.boardSummary, 1800),
    reason_summary: safeText(input.reason_summary || input.reasonSummary, 1800),
    staleness_summary: safeText(input.staleness_summary || input.stalenessSummary, 1400),
    action_pressure_summary: safeText(input.action_pressure_summary || input.actionPressureSummary, 1400),
    recommended_context_request: normalizeContextRequest(input.recommended_context_request || input.recommendedContextRequest),
    attention_targets: safeArray(input.attention_targets || input.attentionTargets)
      .slice(0, 8)
      .map((item) => {
        const target = safeObject(item);
        return {
          target_type: safeText(target.target_type || target.targetType, 80),
          target_id: safeText(target.target_id || target.targetId, 240),
          title: safeText(target.title, 240),
          priority: Math.min(10, Math.max(0, Math.round(Number(target.priority || 0) || 0))),
          reason: safeText(target.reason, 900),
          recommended_context_request: safeText(target.recommended_context_request || target.recommendedContextRequest, 900),
        };
      })
      .filter((item) => item.target_id || item.reason),
    project_summaries: safeArray(input.project_summaries || input.projectSummaries)
      .slice(0, 12)
      .map((item) => {
        const project = safeObject(item);
        return {
          project_id: safeText(project.project_id || project.projectId, 180),
          title: safeText(project.title, 240),
          state: safeText(project.state, 80),
          live_task_count: Math.max(0, Math.round(Number(project.live_task_count ?? project.liveTaskCount ?? 0) || 0)),
          contributor_count: Math.max(0, Math.round(Number(project.contributor_count ?? project.contributorCount ?? 0) || 0)),
          status: safeText(project.status, 900),
          next_needed: safeText(project.next_needed || project.nextNeeded, 900),
        };
      })
      .filter((item) => item.project_id || item.title || item.status),
    network_task_summary: safeText(input.network_task_summary || input.networkTaskSummary, 1600),
    candidate_summary: safeText(input.candidate_summary || input.candidateSummary, 1200),
    recent_run_summary: safeText(input.recent_run_summary || input.recentRunSummary, 1200),
    operator_standing_policy: normalizeOperatorStandingPolicy(input.operator_standing_policy || input.operatorStandingPolicy),
    generation_quality_policy: normalizeGenerationQualityPolicy(input.generation_quality_policy || input.generationQualityPolicy),
    prior_output_corpus_summary: normalizePriorOutputCorpusSummary(
      input.prior_output_corpus_summary || input.priorOutputCorpusSummary
    ),
    deduplication_watchlist: normalizeDeduplicationWatchlist(input.deduplication_watchlist || input.deduplicationWatchlist),
    project_leader_inputs: normalizeProjectLeaderInputs(input.project_leader_inputs || input.projectLeaderInputs),
    capability_gap_summary: normalizeCapabilityGapSummary(input.capability_gap_summary || input.capabilityGapSummary),
    badge_eligibility: normalizeBadgeEligibility(input.badge_eligibility || input.badgeEligibility),
    orc_operations_summary: normalizeOrcOperationsSummary(input.orc_operations_summary || input.orcOperationsSummary),
    facts_to_preserve: safeArray(input.facts_to_preserve || input.factsToPreserve)
      .slice(0, 24)
      .map((item) => safeText(item, 500))
      .filter(Boolean),
    redaction_count: Math.max(0, Math.round(Number(input.redaction_count ?? input.redactionCount ?? 0) || 0)),
  };
}

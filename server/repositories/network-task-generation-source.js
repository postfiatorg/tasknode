import {
  compactProductDoc,
  compactProject,
  numeric,
  safeArray,
  safeObject,
  safeText,
} from "./network-tasks-utils.js";

export function sourcePacketText(source = {}) {
  const project = source.project || {};
  const candidate = source.candidate || {};
  const networkTask = source.networkTask || {};
  const lineage = source.taskLineage || {};
  const hiveReportLines = safeArray(source.hiveReports?.reports)
    .slice(0, 6)
    .map((report) => {
      const item = safeObject(report);
      return `- ${safeText(item.type, 80)} ${safeText(item.id, 180)}: ${safeText(item.bodyMarkdownExcerpt, 900)}`;
    })
    .filter(Boolean);
  const priorOutputLines = safeArray(source.priorOutputCorpus?.outputs)
    .slice(0, 12)
    .map((output) => {
      const ids = [
        output.taskId || output.task_id,
        safeArray(output.sourceCids || output.source_cids).join(", "),
        safeArray(output.sourceTxHashes || output.source_tx_hashes).join(", "),
      ].map((item) => safeText(item, 240)).filter(Boolean).join(" | ");
      return `- ${ids || output.title || "prior output"}: ${safeText(output.eventSummary || output.summary || output.projectNeedSummary, 420)}`;
    })
    .filter(Boolean);
  const referencedLines = safeArray(lineage.referencedOutputs || lineage.referenced_outputs)
    .map((item) => {
      const output = safeObject(item);
      return `- ${safeText(output.task_id || output.taskId, 180)} ${safeText(output.cid, 240)} ${safeText(output.tx_hash || output.txHash, 180)}: ${safeText(output.summary || output.how_used || output.howUsed, 420)}`.trim();
    })
    .filter(Boolean);
  const dedupLines = safeArray(lineage.dedupedAgainst || lineage.deduped_against)
    .map((item) => {
      const output = safeObject(item);
      return `- ${safeText(output.task_id || output.taskId, 180)} ${safeText(output.theme, 240)}: ${safeText(output.reason_not_repeated || output.reasonNotRepeated || output.reason, 420)}`.trim();
    })
    .filter(Boolean);
  const policyLines = safeArray(source.operatorStandingPolicy || source.operator_standing_policy)
    .map((item) => {
      const policy = safeObject(item);
      return `- [${safeText(policy.source_id || policy.sourceId, 180)}] ${safeText(policy.directive, 700)} -> ${safeText(policy.generation_implication || policy.generationImplication, 420)}`.trim();
    })
    .filter(Boolean);
  return [
    "NETWORK TASK GENERATION SOURCE",
    "",
    `Project: ${project.title || project.id}`,
    `Project ID: ${project.id}`,
    `Project type: ${project.type}`,
    `Task work type: ${networkTask.taskWorkType || "unspecified"}`,
    `Task class: ${networkTask.taskClass}`,
    `Reward band: ${networkTask.rewardMinPft} to ${networkTask.rewardMaxPft} PFT`,
    "",
    "Project need",
    networkTask.projectNeedSummary || source.decision?.reason || "",
    "",
    "Routing rationale",
    networkTask.allocationReasonSummary || source.decision?.reason || "",
    "",
    "Operator standing policy",
    policyLines.join("\n") || "None",
    "",
    "Generation quality policy",
    `documentationOnlyDefault: ${source.generationQualityPolicy?.documentationOnlyDefault || "low_value_unless_action_coupled"}`,
    `requiresConcreteActionOutput: ${source.generationQualityPolicy?.requiresConcreteActionOutput ? "true" : "false"}`,
    `escalationLadder: ${source.generationQualityPolicy?.escalationLadder || "document_to_action_v1"}`,
    "",
    "Hive v2 reports",
    hiveReportLines.join("\n") || "No Hive reports attached.",
    "",
    "Decision Agent guardrails",
    `structuralDedupRequired: ${source.decisionAgentGuardrails?.structuralDedupRequired ? "true" : "false"}`,
    `routeOnlyToIdleEligibleContributors: ${source.decisionAgentGuardrails?.routeOnlyToIdleEligibleContributors ? "true" : "false"}`,
    `dedupIndexCount: ${Number(source.decisionAgentGuardrails?.dedupIndexCount || 0)}`,
    "",
    "Concrete action/output",
    networkTask.actionOutput || "Not specified by Board Manager.",
    `Delivery surface: ${networkTask.deliverySurface || "unspecified"}`,
    `Recipient/reviewer: ${networkTask.recipientOrReviewer || "unspecified"}`,
    `Escalation stage: ${networkTask.escalationStage || "unspecified"}`,
    "",
    "Lineage and referenced prior outputs",
    referencedLines.join("\n") || "None",
    "",
    "Deduped against",
    dedupLines.join("\n") || "None",
    lineage.whyNotDuplicate || "",
    "",
    "Prior output corpus",
    priorOutputLines.join("\n") || "None",
    "",
    "Candidate",
    `Account: ${candidate.accountId}`,
    `Wallet: ${candidate.walletAddress}`,
    candidate.profileText || "No Network Diagnostic Report text available.",
  ].join("\n");
}

export function formatNetworkTaskGenerationSourceText(source = {}) {
  return sourcePacketText(source);
}

export function normalizeTaskIds(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => safeText(item, 180))
    .filter(Boolean);
}

export function normalizeReferencedOutputs(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        task_id: safeText(input.task_id || input.taskId, 180),
        cid: safeText(input.cid || input.source_cid || input.sourceCid, 240),
        tx_hash: safeText(input.tx_hash || input.txHash || input.source_tx_hash || input.sourceTxHash, 180),
        summary: safeText(input.summary || input.title || input.description, 700),
        how_used: safeText(input.how_used || input.howUsed, 700),
      };
    })
    .filter((item) => item.task_id || item.cid || item.tx_hash || item.summary);
}

export function normalizeDedupedAgainst(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        task_id: safeText(input.task_id || input.taskId, 180),
        theme: safeText(input.theme || input.title, 240),
        reason_not_repeated: safeText(input.reason_not_repeated || input.reasonNotRepeated || input.reason, 700),
      };
    })
    .filter((item) => item.task_id || item.theme || item.reason_not_repeated);
}

export function compactOperatorStandingPolicy(value = []) {
  return safeArray(value)
    .slice(0, 12)
    .map((item) => {
      const input = safeObject(item);
      return {
        source_id: safeText(input.source_id || input.sourceId || input.id, 180),
        source_account_id: safeText(input.source_account_id || input.sourceAccountId || input.account_id || input.accountId, 180),
        created_at: safeText(input.created_at || input.createdAt, 80),
        directive: safeText(input.directive || input.body || input.text, 900),
        active_scope: safeText(input.active_scope || input.activeScope || "global", 80) || "global",
        generation_implication: safeText(input.generation_implication || input.generationImplication, 700),
      };
    })
    .filter((item) => item.directive || item.source_id);
}

export function compactGenerationQualityPolicy(value = {}) {
  const input = safeObject(value);
  return {
    schema: safeText(input.schema || "pf.hive.generation_quality_policy.v1", 120),
    documentationOnlyDefault: safeText(
      input.documentationOnlyDefault || input.documentation_only_default || "low_value_unless_action_coupled",
      120
    ) || "low_value_unless_action_coupled",
    requiresConcreteActionOutput: input.requiresConcreteActionOutput ?? input.requires_concrete_action_output ?? true,
    escalationLadder: safeText(input.escalationLadder || input.escalation_ladder || "document_to_action_v1", 120) ||
      "document_to_action_v1",
    operatorConstraintsSummary: safeText(input.operatorConstraintsSummary || input.operator_constraints_summary, 900),
  };
}

export function compactPriorOutputCorpus(value = {}, { projectId = "", candidate = {} } = {}) {
  const corpus = safeObject(value);
  const outputs = safeArray(corpus.outputs)
    .filter((output) => {
      const item = safeObject(output);
      const outputProjectId = safeText(item.projectId || item.project_id, 180);
      const accountId = safeText(item.candidateAccountId || item.candidate_account_id, 180);
      const wallet = safeText(item.candidateWalletAddress || item.candidate_wallet_address || item.assigneeWallet || item.assignee_wallet, 120);
      return (
        outputProjectId === projectId ||
        accountId === candidate.accountId ||
        wallet === candidate.walletAddress ||
        (!projectId && !candidate.accountId && !candidate.walletAddress)
      );
    })
    .slice(0, 24)
    .map((output) => {
      const item = safeObject(output);
      return {
        taskId: safeText(item.taskId || item.task_id, 180),
        requestId: safeText(item.requestId || item.request_id, 180),
        projectId: safeText(item.projectId || item.project_id, 180),
        state: safeText(item.state || item.status, 80),
        title: safeText(item.title, 240),
        summary: safeText(item.eventSummary || item.event_summary || item.summary || item.projectNeedSummary || item.project_need_summary, 700),
        assigneeWallet: safeText(item.assigneeWallet || item.assignee_wallet, 120),
        candidateAccountId: safeText(item.candidateAccountId || item.candidate_account_id, 180),
        rewardPft: Number(item.rewardPft || item.reward_pft || 0),
        sourceCids: safeArray(item.sourceCids || item.source_cids).slice(0, 4).map((cid) => safeText(cid, 240)).filter(Boolean),
        sourceTxHashes: safeArray(item.sourceTxHashes || item.source_tx_hashes).slice(0, 4).map((tx) => safeText(tx, 180)).filter(Boolean),
        actionOutput: safeText(item.actionOutput || item.action_output, 700),
        deliverySurface: safeText(item.deliverySurface || item.delivery_surface, 120),
        escalationStage: safeText(item.escalationStage || item.escalation_stage, 120),
      };
    });
  return {
    schema: safeText(corpus.schema || "pf.hive.network_task_output_corpus.v1", 120),
    summary: safeObject(corpus.summary),
    outputs: outputs.length ? outputs : safeArray(corpus.outputs).slice(0, 12),
    deduplicationWatchlist: safeArray(corpus.deduplicationWatchlist || corpus.deduplication_watchlist).slice(0, 12),
  };
}

export function compactHiveReportsForTaskGeneration(value = {}) {
  const reports = safeObject(value);
  const entries = Object.entries(reports)
    .map(([type, report]) => {
      const item = safeObject(report);
      const body = safeText(item.bodyMarkdown || item.body_markdown || item.body || "", 6000);
      return {
        type: safeText(type || item.type, 80),
        id: safeText(item.id, 180),
        label: safeText(item.label, 120),
        generatedAt: safeText(item.generatedAt || item.generated_at, 80),
        model: safeText(item.model, 180),
        bodyMarkdownExcerpt: body,
        metadata: safeObject(item.metadata || item.metadata_json),
      };
    })
    .filter((report) => report.id || report.bodyMarkdownExcerpt);
  return {
    schema: "pf.hive.task_generation_reports.v1",
    source: "hive_decision_agent_source_packet",
    reports: entries,
    reportIds: entries.map((report) => report.id).filter(Boolean),
  };
}

export function compactTaskManagerForGeneration({ sourcePacket = {}, project = {}, candidate = {} } = {}) {
  const taskManager = safeObject(sourcePacket.taskManager || sourcePacket.task_manager);
  const boardPackets = safeObject(sourcePacket.boardPacketsByProjectId || sourcePacket.board_packets_by_project_id);
  const operatorPackets = safeObject(sourcePacket.operatorPacketsByAccount || sourcePacket.operator_packets_by_account);
  const projectId = safeText(project.id || project.projectId, 180);
  const accountId = safeText(candidate.accountId || candidate.account_id, 180);
  const boardPacket = safeObject(boardPackets[projectId]);
  const operatorPacket = safeObject(operatorPackets[accountId]);
  return {
    schema: "pf.hive.task_manager_generation_context.v1",
    selection: safeObject(taskManager.selection),
    promptVersion: safeText(taskManager.promptVersion || taskManager.prompt_version, 120),
    boardPacket: {
      projectId: safeText(boardPacket.projectId, 180),
      title: safeText(boardPacket.title, 220),
      type: safeText(boardPacket.type, 120),
      summary: safeText(boardPacket.summary, 1200),
      tasksInFlight: Number(boardPacket.tasksInFlight || 0),
      contributorCount: Number(boardPacket.contributorCount || 0),
      pendingGenerationCount: Number(boardPacket.pendingGenerationCount || 0),
      tasks: safeArray(boardPacket.tasks).slice(0, 8),
    },
    operatorPacket: {
      accountId: safeText(operatorPacket.accountId, 180),
      walletAddress: safeText(operatorPacket.walletAddress, 120),
      identity: safeObject(operatorPacket.identity),
      verifiedBadges: safeArray(operatorPacket.verifiedBadges).slice(0, 8),
      allowedWorkTypes: safeArray(operatorPacket.allowedWorkTypes).slice(0, 20),
      publicProfile: safeObject(operatorPacket.publicProfile),
      memory: {
        contextTitle: safeText(operatorPacket.memory?.contextTitle, 160),
        contextExcerpt: safeText(operatorPacket.memory?.contextExcerpt, 2000),
        deepMemory: safeArray(operatorPacket.memory?.deepMemory).slice(0, 3),
      },
      taskState: {
        counts: safeObject(operatorPacket.taskState?.counts),
        currentTasks: safeObject(operatorPacket.taskState?.currentTasks),
        refused: safeArray(operatorPacket.taskState?.refused).slice(0, 6),
        rewarded: safeArray(operatorPacket.taskState?.rewarded).slice(0, 6),
      },
    },
  };
}

export function buildNetworkTaskGenerationSource({
  runId = "",
  decision = {},
  sourcePacket = {},
  project = {},
  projectDocument = null,
  candidate = {},
  normalizedTaskClass = "network",
  band = { min: 10000, max: 50000 },
  projectNeedSummary = "",
  allocationReasonSummary = "",
  cadenceReason = "",
  acceptWindowHours = 0,
  badgeEligibilityDecision = null,
} = {}) {
  const payload = safeObject(decision.payload);
  const networkTask = safeObject(payload.network_task || payload.networkTask);
  const taskLineage = {
    lineageTaskIds: normalizeTaskIds(networkTask.lineage_task_ids || networkTask.lineageTaskIds),
    referencedOutputs: normalizeReferencedOutputs(networkTask.referenced_outputs || networkTask.referencedOutputs),
    dedupedAgainst: normalizeDedupedAgainst(networkTask.deduped_against || networkTask.dedupedAgainst),
    whyNotDuplicate: safeText(networkTask.why_not_duplicate || networkTask.whyNotDuplicate, 1200),
  };
  return {
    schema: "pf.hive.network_task_generation_source.v1",
    generated_at: new Date().toISOString(),
    board_manager_run_id: safeText(runId, 180),
    board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
    decision: {
      action: decision.action,
      target_type: decision.target_type,
      target_id: decision.target_id,
      reason: decision.reason,
      confidence: decision.confidence,
      summary: payload.summary,
      next_steps: payload.next_steps,
      decision_basis: safeObject(decision.decision_basis || decision.decisionBasis),
    },
    project: compactProject(project),
    project_document: compactProductDoc(projectDocument),
    candidate,
    hiveReports: compactHiveReportsForTaskGeneration(sourcePacket.reports),
    decisionAgentGuardrails: {
      structuralDedupRequired: sourcePacket.guardrails?.structuralDedupRequired === true,
      routeOnlyToIdleEligibleContributors: sourcePacket.guardrails?.routeOnlyToIdleEligibleContributors === true,
      dedupIndexCount: safeArray(sourcePacket.guardrails?.dedupIndex).length,
      candidateCount: safeArray(sourcePacket.candidates?.all).length,
      idleEligibleContributorCount: safeArray(sourcePacket.candidates?.idleEligibleContributors).length,
    },
    operatorStandingPolicy: compactOperatorStandingPolicy(sourcePacket.operatorStandingPolicy || sourcePacket.operator_standing_policy),
    generationQualityPolicy: compactGenerationQualityPolicy(sourcePacket.generationQualityPolicy || sourcePacket.generation_quality_policy),
    priorOutputCorpus: compactPriorOutputCorpus(sourcePacket.networkTaskOutputCorpus || sourcePacket.priorOutputCorpus, {
      projectId: safeText(project.id, 180),
      candidate,
    }),
    taskLineage,
    networkTask: {
      taskWorkType: safeText(networkTask.task_work_type || networkTask.taskWorkType, 80),
      requiredBadgeId: safeText(networkTask.required_badge_id || networkTask.requiredBadgeId, 80),
      operatingBadgeId: safeText(networkTask.operating_badge_id || networkTask.operatingBadgeId, 80),
      badgeWorkType: safeText(networkTask.badge_work_type || networkTask.badgeWorkType || networkTask.task_work_type || networkTask.taskWorkType, 120),
      badgeReason: safeText(networkTask.badge_reason || networkTask.badgeReason, 1000),
      badgeRewardCapPft: numeric(
        networkTask.badge_reward_cap_pft ||
          networkTask.badgeRewardCapPft ||
          badgeEligibilityDecision?.badge_reward_cap_pft,
        0
      ),
      badgeEvidenceRequirements: safeArray(networkTask.badge_evidence_requirements || networkTask.badgeEvidenceRequirements)
        .slice(0, 8)
        .map((item) => safeText(item, 500))
        .filter(Boolean),
      discordEvidenceRequired: networkTask.discord_evidence_required ?? networkTask.discordEvidenceRequired ?? true,
      taskClass: normalizedTaskClass,
      projectNeedSummary,
      allocationReasonSummary,
      cadenceReason,
      actionOutput: safeText(networkTask.action_output || networkTask.actionOutput, 1200),
      deliverySurface: safeText(networkTask.delivery_surface || networkTask.deliverySurface, 120),
      recipientOrReviewer: safeText(networkTask.recipient_or_reviewer || networkTask.recipientOrReviewer, 240),
      escalationStage: safeText(networkTask.escalation_stage || networkTask.escalationStage, 120),
      lineageTaskIds: taskLineage.lineageTaskIds,
      referencedOutputs: taskLineage.referencedOutputs,
      dedupedAgainst: taskLineage.dedupedAgainst,
      whyNotDuplicate: taskLineage.whyNotDuplicate,
      rewardMinPft: band.min,
      rewardMaxPft: band.max,
      acceptWindowHours,
    },
    policy: {
      taskLifecycle: "normal_pftl_task_engine",
      supportedEvidence: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
      rewardBandPft: [band.min, band.max],
      badgeEligibilityDecision: badgeEligibilityDecision || null,
      badgeRewardCapPft: numeric(badgeEligibilityDecision?.badge_reward_cap_pft || networkTask.badge_reward_cap_pft || networkTask.badgeRewardCapPft, 0),
      discordEvidenceRequired: networkTask.discord_evidence_required ?? networkTask.discordEvidenceRequired ?? true,
      boardManagerDoesNotAuthorTaskText: true,
      generationPolicy: compactGenerationQualityPolicy(sourcePacket.generationQualityPolicy || sourcePacket.generation_quality_policy),
    },
    ...(() => {
      const taskManagerContext = compactTaskManagerForGeneration({ sourcePacket, project, candidate });
      return {
        taskManager: {
          schema: taskManagerContext.schema,
          selection: taskManagerContext.selection,
          promptVersion: taskManagerContext.promptVersion,
        },
        boardPacket: taskManagerContext.boardPacket,
        operatorPacket: taskManagerContext.operatorPacket,
      };
    })(),
  };
}

export function networkTaskIntelligenceMetadata(sourceJson = {}) {
  return {
    operatorStandingPolicy: safeArray(sourceJson.operatorStandingPolicy),
    generationQualityPolicy: safeObject(sourceJson.generationQualityPolicy),
    hiveReportIds: safeArray(sourceJson.hiveReports?.reportIds).slice(0, 12),
    decisionAgentGuardrails: safeObject(sourceJson.decisionAgentGuardrails),
    priorOutputCorpusSummary: safeObject(sourceJson.priorOutputCorpus?.summary),
    taskLineage: safeObject(sourceJson.taskLineage),
    taskWorkType: safeText(sourceJson.networkTask?.taskWorkType, 80),
    requiredBadgeId: safeText(sourceJson.networkTask?.requiredBadgeId, 80),
    operatingBadgeId: safeText(sourceJson.networkTask?.operatingBadgeId, 80),
    badgeWorkType: safeText(sourceJson.networkTask?.badgeWorkType, 120),
    badgeRewardCapPft: numeric(sourceJson.networkTask?.badgeRewardCapPft || sourceJson.policy?.badgeRewardCapPft, 0),
    discordEvidenceRequired: sourceJson.networkTask?.discordEvidenceRequired ?? sourceJson.policy?.discordEvidenceRequired ?? true,
    badgeEligibilityDecision: safeObject(sourceJson.policy?.badgeEligibilityDecision),
    taskManagerSelection: safeObject(sourceJson.taskManager?.selection),
    actionOutput: safeText(sourceJson.networkTask?.actionOutput, 1200),
    deliverySurface: safeText(sourceJson.networkTask?.deliverySurface, 120),
    recipientOrReviewer: safeText(sourceJson.networkTask?.recipientOrReviewer, 240),
    escalationStage: safeText(sourceJson.networkTask?.escalationStage, 120),
  };
}

export function normalizedIntentText(value = "") {
  return safeText(value, 2400)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|and|for|with|that|this|from|into|onto|about|please|task|work)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function intentStatusForAllocationStatus(status = "", canonicalStatus = "") {
  const normalized = safeText(status, 80).toLowerCase();
  const canonical = safeText(canonicalStatus, 80).toLowerCase();
  if (canonical === "rewarded" || normalized === "rewarded") return "rewarded";
  if (["completed", "reward_decided"].includes(normalized) || canonical === "completed") return "completed";
  if (["refused", "cancelled", "expired", "rerouted"].includes(normalized)) return "stopped";
  if (normalized === "rejected" || canonical === "rejected") return "rejected";
  if (normalized === "failed") return "failed";
  if (["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted"].includes(normalized)) {
    return "active";
  }
  return normalized || "active";
}

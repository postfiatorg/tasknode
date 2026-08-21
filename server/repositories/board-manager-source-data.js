import { databaseEnabled, query } from "../db/pool.js";
import {
  capabilityScopeDigest,
  normalizeCapabilityType,
} from "./capability-profiles.js";
import { createEvidenceEvaluationPacketForTask } from "./evidence-evaluation-packets.js";
import {
  compactAuthorityBadges,
  compactContextDocument,
  compactTask,
  iso,
  safeArray,
  safeObject,
  safeText,
} from "./board-manager-contract.js";

function useDatabase() {
  return databaseEnabled();
}

export async function currentProjectRegistry({ limit = 50 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT id, type, title, summary, objective, about, status, priority, origin,
             phase_label, phase_current, phase_total, pft_routed, task_count,
             contributor_count, source_hive_secretary_report_id,
             source_hive_secretary_report_digest, metadata_json, updated_at, created_at
      FROM network_projects
      ORDER BY
        CASE status
          WHEN 'active' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'archived' THEN 3
          WHEN 'completed' THEN 4
          ELSE 5
        END,
        priority ASC,
        updated_at DESC,
        id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    objective: row.objective,
    about: row.about,
    status: row.status,
    priority: Number(row.priority || 0),
    origin: row.origin,
    phaseLabel: row.phase_label,
    phaseCurrent: Number(row.phase_current || 0),
    phaseTotal: Number(row.phase_total || 0),
    pftRouted: Number(row.pft_routed || 0),
    taskCount: Number(row.task_count || 0),
    contributorCount: Number(row.contributor_count || 0),
    sourceHiveSecretaryReportId: row.source_hive_secretary_report_id,
    sourceHiveSecretaryReportDigest: row.source_hive_secretary_report_digest,
    metadata: safeObject(row.metadata_json),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
  }));
}

export async function currentTaskState({ limit = 30 } = {}) {
  if (!useDatabase()) return { counts: [], recent: [] };
  const [counts, recent] = await Promise.all([
    query(
      `
        SELECT status, count(*)::int AS count
        FROM task_projections
        GROUP BY status
        ORDER BY status ASC
      `
    ),
    query(
      `
        SELECT task_id, request_id, status, title, task_kind, reward_offer_pft,
               reward_actual_pft, subject_wallet, updated_at, last_event_at
        FROM task_projections
        ORDER BY updated_at DESC, task_id ASC
        LIMIT $1
      `,
      [Math.min(Math.max(Number(limit) || 30, 1), 80)]
    ),
  ]);
  return {
    counts: counts.rows.map((row) => ({ status: row.status, count: Number(row.count || 0) })),
    recent: recent.rows.map(compactTask),
  };
}

export async function currentTaskRequests({ limit = 20 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT request_id, account_id, subject_wallet, source, source_conversation_id,
             source_conversation_title, request_text, user_detail_text,
             requested_task_kind, status, generated_task_id, worker_attempt_count,
             last_error, created_at, updated_at
      FROM task_requests
      ORDER BY updated_at DESC, request_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 20, 1), 60)]
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    accountId: row.account_id,
    subjectWallet: row.subject_wallet,
    source: row.source,
    sourceConversationId: row.source_conversation_id,
    sourceConversationTitle: row.source_conversation_title,
    requestText: safeText(row.request_text, 800),
    userDetailText: safeText(row.user_detail_text, 1600),
    requestedTaskKind: row.requested_task_kind,
    status: row.status,
    generatedTaskId: row.generated_task_id,
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

export function buildHiveGenerationQualityPolicy({ operatorConstraintsSummary = "" } = {}) {
  return {
    schema: "pf.hive.generation_quality_policy.v1",
    documentationOnlyDefault: "low_value_unless_action_coupled",
    requiresConcreteActionOutput: true,
    escalationLadder: "document_to_action_v1",
    operatorConstraintsSummary: safeText(operatorConstraintsSummary, 1200),
  };
}

export const boardManagerTaskWorkTypeVocabulary = Object.freeze([
  {
    id: "code_task",
    label: "Code task",
    definition: "Requires changing, reviewing, or proving access to code, pull requests, commits, deployment artifacts, or repository state.",
    evidence_standard: "Needs a resolvable PR/commit/build artifact or an approved capability proof before private-repo work is sensible.",
  },
  {
    id: "documentation_task",
    label: "Documentation task",
    definition: "Produces a report, memo, friction list, map, audit note, or recommendation without requiring the contributor to take an external action.",
    evidence_standard: "Low-value unless explicitly coupled to a concrete action/output and prior-output lineage.",
  },
  {
    id: "capability_gating_task",
    label: "Capability-gating task",
    definition: "Asks the contributor to prove they can access or deliver on a surface before routing the substantive work.",
    evidence_standard: "Needs a capability proof artifact such as an accessible PR URL, integration-backed access check, or operator-reviewed attestation.",
  },
  {
    id: "evidence_evaluation_packet",
    label: "Evidence-evaluation packet",
    definition: "A concise review packet that classifies submitted evidence as verified, unverifiable, or self-attested and recommends the next board action.",
    evidence_standard: "Advisory context only; never a reward verdict or hidden task lifecycle mutation.",
  },
]);

export function normalizeCapabilityRequirement(value = {}, { projectId = "" } = {}) {
  const input = typeof value === "string" ? { capability_type: value } : safeObject(value);
  const capabilityType = normalizeCapabilityType(
    input.capability_type || input.capabilityType || input.type || input.id || input.capability || "unspecified_capability"
  );
  const rawScope = safeText(
    input.scope || input.scope_ref || input.scopeRef || input.repository || input.repo || input.channel || "",
    500
  );
  const scopeLabel = safeText(
    input.scope_label || input.scopeLabel || input.surface_label || input.surfaceLabel || input.label || capabilityType,
    180
  );
  const visibility = safeText(input.visibility || input.exposure || "internal", 80).toLowerCase();
  return {
    requirement_id: safeText(input.requirement_id || input.requirementId || `${projectId || "project"}:${capabilityType}`, 240),
    project_id: safeText(projectId, 180),
    capability_type: capabilityType,
    scope_label: scopeLabel || capabilityType,
    scope_digest: capabilityScopeDigest(rawScope || scopeLabel || capabilityType),
    visibility: ["public", "internal", "private"].includes(visibility) ? visibility : "internal",
    status: "required",
    proof_task_type: "capability_gating_task",
    public_exposure: "do_not_expose_private_membership",
  };
}

export function capabilityRequirementsFromProject(project = {}) {
  const metadata = safeObject(project.metadata || project.metadata_json);
  const routing = safeObject(metadata.routing_constraints || metadata.routingConstraints);
  const rawRequirements = [
    ...safeArray(metadata.required_capabilities),
    ...safeArray(metadata.requiredCapabilities),
    ...safeArray(metadata.capability_requirements),
    ...safeArray(metadata.capabilityRequirements),
    ...safeArray(routing.required_capabilities),
    ...safeArray(routing.requiredCapabilities),
  ];
  const seen = new Set();
  return rawRequirements
    .map((item) => normalizeCapabilityRequirement(item, { projectId: project.id }))
    .filter((item) => {
      const key = `${item.project_id}:${item.capability_type}:${item.scope_digest}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return item.capability_type;
    })
    .slice(0, 8);
}

export function normalizeCandidateCapabilityEvidence(value = {}, { source = "candidate_profile" } = {}) {
  const input = typeof value === "string" ? { capability_type: value } : safeObject(value);
  const rawType = input.capability_type || input.capabilityType || input.type || input.id || input.capability || "";
  if (!safeText(rawType, 120)) return null;
  const capabilityType = normalizeCapabilityType(rawType);
  const rawScope = safeText(
    input.scope || input.scope_ref || input.scopeRef || input.repository || input.repo || input.channel || "",
    500
  );
  return {
    capability_type: capabilityType,
    scope_label: safeText(input.scope_label || input.scopeLabel || input.surface_label || input.surfaceLabel || input.label || capabilityType, 180),
    scope_digest: capabilityScopeDigest(rawScope || input.scope_label || input.scopeLabel || capabilityType),
    project_id: safeText(input.project_id || input.projectId, 180),
    status: safeText(input.status || source, 80).toLowerCase(),
    evidence_task_id: safeText(input.evidence_task_id || input.evidenceTaskId || input.task_id || input.taskId, 180),
    source,
  };
}

export function candidateCapabilityEvidence(candidate = {}) {
  const profileOutput = safeObject(candidate.profileOutput || candidate.profile_output || candidate.output_json);
  const capabilityBlock = safeObject(profileOutput.capabilities || profileOutput.capability_profile || profileOutput.capabilityProfile);
  const profileClaimRaw = [
    ...safeArray(profileOutput.verified_capabilities),
    ...safeArray(profileOutput.verifiedCapabilities),
    ...safeArray(capabilityBlock.verified),
    ...safeArray(capabilityBlock.verified_capabilities),
    ...safeArray(capabilityBlock.verifiedCapabilities),
  ];
  const declaredRaw = [
    ...safeArray(profileOutput.declared_capabilities),
    ...safeArray(profileOutput.declaredCapabilities),
    ...safeArray(capabilityBlock.declared),
    ...safeArray(capabilityBlock.declared_capabilities),
    ...safeArray(capabilityBlock.declaredCapabilities),
    ...safeArray(capabilityBlock.items),
  ];
  const declared = [...profileClaimRaw, ...declaredRaw]
    .map((item) => normalizeCandidateCapabilityEvidence(item, { source: "declared_profile_capability" }))
    .filter(Boolean)
    .slice(0, 12);
  return { declared };
}

export function normalizeDurableCapability(profile = {}) {
  return {
    capability_type: normalizeCapabilityType(profile.capability_type || profile.capabilityType),
    scope_label: safeText(profile.scope_label || profile.scopeLabel, 180),
    scope_digest: safeText(profile.scope_digest || profile.scopeDigest, 80),
    project_id: safeText(profile.project_id || profile.projectId, 180),
    status: safeText(profile.effective_status || profile.status, 80).toLowerCase(),
    evidence_task_id: safeText(profile.evidence_task_id || profile.evidenceTaskId, 180),
    evidence_url_or_ref: safeText(profile.evidence_url_or_ref || profile.evidenceUrlOrRef, 500),
    verified_by: safeText(profile.verified_by || profile.verifiedBy, 180),
    verified_at: profile.verified_at || profile.verifiedAt || null,
    expires_at: profile.expires_at || profile.expiresAt || null,
    source: "board_manager_capability_profile",
  };
}

export function candidateSatisfiesRequirement(candidate = {}, requirement = {}) {
  return safeArray(candidate.verified_capabilities).some((capability) => {
    if (capability.capability_type !== requirement.capability_type) return false;
    if (capability.project_id && requirement.project_id && capability.project_id !== requirement.project_id) return false;
    if (!requirement.scope_digest) return true;
    return capability.scope_digest === requirement.scope_digest;
  });
}

export function buildBoardManagerCapabilityInstrumentation({
  projectRegistry = [],
  networkTaskCandidates = [],
  capabilityProfiles = [],
} = {}) {
  const projects = safeArray(projectRegistry).slice(0, 24);
  const durableProfilesByAccount = new Map();
  for (const profile of safeArray(capabilityProfiles)) {
    const normalized = normalizeDurableCapability(profile);
    const accountId = safeText(profile.account_id || profile.accountId, 180);
    if (!accountId) continue;
    const list = durableProfilesByAccount.get(accountId) || [];
    list.push(normalized);
    durableProfilesByAccount.set(accountId, list);
  }
  const candidates = safeArray(networkTaskCandidates).slice(0, 20).map((candidate) => {
    const evidence = candidateCapabilityEvidence(candidate);
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    const durableCapabilities = safeArray(durableProfilesByAccount.get(accountId));
    const verifiedCapabilities = durableCapabilities
      .filter((item) => item.status === "verified")
      .slice(0, 20);
    const otherProfiles = durableCapabilities
      .filter((item) => item.status !== "verified")
      .slice(0, 12);
    return {
      account_id: accountId,
      wallet_address: safeText(candidate.walletAddress || candidate.wallet_address, 120),
      profile_id: safeText(candidate.profileId || candidate.profile_id, 180),
      verified_capabilities: verifiedCapabilities,
      declared_capabilities: evidence.declared,
      non_verified_capability_profiles: otherProfiles,
      capability_source: verifiedCapabilities.length
        ? "board_manager_capability_profiles"
        : evidence.declared.length
          ? "network_task_profile_output_declared_only"
          : "none_recorded",
    };
  });
  const projectCapabilityRequirements = projects
    .flatMap((project) => capabilityRequirementsFromProject(project))
    .slice(0, 40);
  const capabilityGaps = [];
  for (const requirement of projectCapabilityRequirements) {
    for (const candidate of candidates) {
      if (!candidate.account_id && !candidate.wallet_address) continue;
      if (candidateSatisfiesRequirement(candidate, requirement)) continue;
      capabilityGaps.push({
        project_id: requirement.project_id,
        candidate_account_id: candidate.account_id,
        candidate_wallet_address: candidate.wallet_address,
        capability_type: requirement.capability_type,
        scope_label: requirement.scope_label,
        scope_digest: requirement.scope_digest,
        candidate_status: "missing_verified_capability",
        recommended_task_work_type: "capability_gating_task",
        privacy_note: "Do not expose private repo/channel membership; route proof-gathering work or ask the operator for verification.",
      });
      if (capabilityGaps.length >= 48) break;
    }
    if (capabilityGaps.length >= 48) break;
  }
  return {
    schema: "pf.hive.board_manager.capability_instrumentation.v1",
    status: "phase_b_capability_profiles_context_only",
    task_work_type_vocabulary: boardManagerTaskWorkTypeVocabulary,
    capability_profile_status: "persistent_capability_profiles_enabled_context_only",
    project_capability_requirements: projectCapabilityRequirements,
    candidate_capabilities: candidates,
    capability_gaps: capabilityGaps,
    summary: {
      requirement_count: projectCapabilityRequirements.length,
      candidate_count: candidates.length,
      verified_capability_count: candidates.reduce((count, candidate) => count + candidate.verified_capabilities.length, 0),
      gap_count: capabilityGaps.length,
      has_private_scope_requirements: projectCapabilityRequirements.some((item) => item.visibility === "private"),
    },
    open_questions_reserved_for_alex: [
      "which repos count as private code surfaces",
      "who can mark a capability verified",
      "whether capability-gating tasks are paid",
      "which Discord channels can be system-verified",
    ],
    enforcement: "none_context_only",
  };
}

export function contextEntries(document = {}) {
  return safeArray(document.groups).flatMap((group) =>
    safeArray(group.entries).map((entry) => ({
      id: safeText(entry.id, 180),
      accountId: safeText(entry.accountId || group.accountId, 180),
      displayName: safeText(entry.displayName || group.displayName, 120),
      body: safeText(entry.body, 1600),
      sourceConversationId: safeText(entry.sourceConversationId, 180),
      walletValidated: Boolean(entry.walletValidated),
      walletAddress: safeText(entry.walletAddress, 120),
      authorityBadges: compactAuthorityBadges(
        safeArray(entry.authorityBadges).length ? entry.authorityBadges : group.authorityBadges
      ),
      createdAt: entry.createdAt || group.latestAt || null,
    }))
  ).filter((entry) => entry.id || entry.body);
}

export function extractProjectLeaderInputs(hiveContext = {}) {
  return contextEntries(compactContextDocument(hiveContext))
    .filter((entry) => safeArray(entry.authorityBadges).some((badge) => badge.badgeId === "project_leader"))
    .slice(0, 16)
    .map((entry) => {
      const badge = safeArray(entry.authorityBadges).find((item) => item.badgeId === "project_leader") || {};
      return {
        sourceEntryId: entry.id,
        accountId: entry.accountId,
        displayName: entry.displayName,
        hiveHandle: badge.handle || badge.matchedHandle || "",
        walletAddress: entry.walletAddress,
        sourceConversationId: entry.sourceConversationId,
        createdAt: entry.createdAt || null,
        authority: safeArray(badge.authority).slice(0, 8),
        bodyExcerpt: safeText(entry.body, 800),
      };
    });
}

export function extractOperatorStandingPolicy({
  hiveContext = {},
  hiveSecretarySource = {},
  recentBoardManagerRuns: runs = [],
} = {}) {
  const entries = contextEntries(compactContextDocument(hiveContext))
    .sort((left, right) => (Date.parse(right.createdAt || "") || 0) - (Date.parse(left.createdAt || "") || 0))
    .slice(0, 16)
    .map((entry) => ({
      source_id: entry.id,
      source_account_id: entry.accountId,
      created_at: entry.createdAt || "",
      directive: entry.body,
      active_scope: "global",
      generation_implication: "Preserve as non-compressible operator context for Network Task shape, routing, and output decisions.",
    }));
  const secretaryFacts = safeArray(hiveSecretarySource?.sourceJson?.facts_to_preserve || hiveSecretarySource?.facts_to_preserve)
    .slice(0, 8)
    .map((fact, index) => ({
      source_id: `secretary_fact_${index + 1}`,
      source_account_id: "",
      created_at: hiveSecretarySource?.sourceJson?.generated_at || "",
      directive: safeText(fact, 1200),
      active_scope: "global",
      generation_implication: "Preserve from the pre-compression Secretary source as operator policy context.",
    }))
    .filter((item) => item.directive);
  const runPolicyFacts = safeArray(runs)
    .flatMap((run) => safeArray(run?.decision?.decision_basis?.source_facts || run?.decisionBasis?.sourceFacts))
    .slice(0, 8)
    .map((fact, index) => ({
      source_id: `recent_run_fact_${index + 1}`,
      source_account_id: "",
      created_at: "",
      directive: safeText(fact, 1200),
      active_scope: "global",
      generation_implication: "Preserve recent Board Manager basis as continuity context for the next generation decision.",
    }))
    .filter((item) => item.directive);
  const seen = new Set();
  return [...entries, ...secretaryFacts, ...runPolicyFacts]
    .filter((item) => {
      const key = `${item.source_id}:${item.directive}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

export function compactEventSummary(payload = {}) {
  const input = safeObject(payload);
  const rewardScore = safeObject(input.reward_score || input.score);
  return safeText(
    input.submission_summary ||
      input.evidence_summary ||
      input.verification_summary ||
      input.review_summary ||
      input.summary ||
      rewardScore.user_feedback ||
      rewardScore.reason ||
      input.reward_summary ||
      input.reason ||
      "",
    900
  );
}

export function compactCorpusRow(row = {}) {
  const sourcePayload = safeObject(row.source_payload_json);
  const sourceNetworkTask = safeObject(sourcePayload.networkTask || sourcePayload.network_task);
  const eventPayload = safeObject(row.latest_event_payload);
  const sourceCids = [
    row.latest_source_cid,
    safeArray(sourceNetworkTask.referencedOutputs).find((item) => item?.cid)?.cid,
  ].map((cid) => safeText(cid, 240)).filter(Boolean);
  const sourceTxHashes = [
    row.latest_source_tx_hash,
    safeArray(sourceNetworkTask.referencedOutputs).find((item) => item?.txHash || item?.tx_hash)?.txHash,
  ].map((txHash) => safeText(txHash, 180)).filter(Boolean);
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    projectId: safeText(row.project_id || sourcePayload.project?.id, 180),
    state: safeText(row.status || row.ref_state, 80),
    title: safeText(row.title || row.ref_title, 240),
    summary: safeText(row.description || row.project_need_summary || sourceNetworkTask.projectNeedSummary, 900),
    assigneeWallet: safeText(row.assignee_wallet || row.subject_wallet || row.candidate_wallet_address, 120),
    candidateAccountId: safeText(row.candidate_account_id, 180),
    rewardPft: Number(row.reward_actual_pft || row.reward_offer_pft || row.ref_reward_pft || 0),
    projectNeedSummary: safeText(row.project_need_summary || sourceNetworkTask.projectNeedSummary, 700),
    routingReason: safeText(row.allocation_reason_summary || sourceNetworkTask.allocationReasonSummary, 700),
    eventSummary: compactEventSummary(eventPayload),
    eventType: safeText(row.latest_event_type, 120),
    sourceCids: [...new Set(sourceCids)].slice(0, 4),
    sourceTxHashes: [...new Set(sourceTxHashes)].slice(0, 4),
    actionOutput: safeText(sourceNetworkTask.actionOutput || sourceNetworkTask.action_output, 700),
    deliverySurface: safeText(sourceNetworkTask.deliverySurface || sourceNetworkTask.delivery_surface, 120),
    escalationStage: safeText(sourceNetworkTask.escalationStage || sourceNetworkTask.escalation_stage, 120),
    updatedAt: iso(row.updated_at || row.ref_updated_at),
    createdAt: iso(row.created_at || row.ref_created_at),
  };
}

export function corpusTheme(task = {}) {
  return safeText(task.title || task.projectNeedSummary || task.summary, 240)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(document|write|map|review|inspect|trace|draft|create|submit|task|report|friction|fixes|fix|and|the|for|with|to|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

export function compactNetworkTaskOutputCorpusForBoardManager(rows = [], { limit = 36 } = {}) {
  const outputs = safeArray(rows).map(compactCorpusRow).filter((item) => item.taskId || item.requestId).slice(0, limit);
  const projectsCovered = [...new Set(outputs.map((item) => item.projectId).filter(Boolean))].slice(0, 16);
  const themeGroups = new Map();
  for (const output of outputs) {
    const theme = corpusTheme(output);
    if (!theme) continue;
    const group = themeGroups.get(theme) || [];
    group.push(output);
    themeGroups.set(theme, group);
  }
  const repeatedThemes = [...themeGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .slice(0, 12)
    .map(([theme, items]) => `${theme}: ${items.slice(0, 5).map((item) => item.taskId || item.requestId).join(", ")}`);
  const deduplicationWatchlist = [...themeGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .slice(0, 12)
    .map(([theme, items]) => ({
      theme,
      project_id: safeText(items[0]?.projectId, 180),
      prior_task_ids: items.map((item) => item.taskId).filter(Boolean).slice(0, 8),
      prior_cids: [...new Set(items.flatMap((item) => item.sourceCids || []))].slice(0, 8),
      why_not_repeat: "Prior outputs already cover this theme; use them as lineage and choose the next concrete action.",
      next_action_suggestion: "Escalate documented findings into a PR, mock, named handoff, project patch, or verification task.",
    }));
  return {
    schema: "pf.hive.network_task_output_corpus.v1",
    generatedAt: new Date().toISOString(),
    summary: {
      projects_covered: projectsCovered,
      recent_outputs: outputs.slice(0, 12).map((item) => ({
        task_id: item.taskId,
        project_id: item.projectId,
        title: item.title,
        summary: item.eventSummary || item.summary || item.projectNeedSummary,
        state: item.state,
      })),
      repeated_themes: repeatedThemes,
      open_actionable_items: outputs
        .filter((item) => ["proposed", "accepted", "submitted", "verification_requested"].includes(item.state))
        .slice(0, 10)
        .map((item) => `${item.taskId || item.requestId}: ${item.title || item.projectNeedSummary}`),
    },
    outputs,
    deduplicationWatchlist,
  };
}

export async function getNetworkTaskOutputCorpus({ limit = 36 } = {}) {
  if (!useDatabase()) return compactNetworkTaskOutputCorpusForBoardManager([]);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 36, 1), 80);
  const result = await query(
    `
      SELECT
        refs.project_id,
        refs.task_id,
        refs.request_id,
        refs.title AS ref_title,
        refs.state AS ref_state,
        refs.assignee_wallet,
        refs.reward_pft AS ref_reward_pft,
        refs.created_at AS ref_created_at,
        refs.updated_at AS ref_updated_at,
        p.status,
        p.title,
        p.description,
        p.reward_offer_pft,
        p.reward_actual_pft,
        p.subject_wallet,
        p.created_at,
        p.updated_at,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        alloc.project_need_summary,
        alloc.allocation_reason_summary,
        job.source_payload_json,
        latest_event.event_type AS latest_event_type,
        latest_event.source_tx_hash AS latest_source_tx_hash,
        latest_event.source_cid AS latest_source_cid,
        latest_event.payload_json AS latest_event_payload
      FROM network_project_task_refs refs
      LEFT JOIN task_projections p
        ON p.task_id = refs.task_id
      LEFT JOIN network_task_generation_jobs job
        ON (
          (refs.task_id <> '' AND job.task_id = refs.task_id)
          OR (refs.request_id <> '' AND job.request_id = refs.request_id)
        )
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      LEFT JOIN LATERAL (
        SELECT e.event_type, e.source_tx_hash, e.source_cid, e.payload_json
        FROM task_events e
        WHERE e.task_id = refs.task_id
          AND e.event_type IN (
            'pf.task.submission.v1',
            'pf.task.verification_request.v1',
            'pf.task.verification_response.v1',
            'pf.reward.v1'
          )
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
      ) latest_event ON true
      WHERE refs.source = 'network_task_generation'
      ORDER BY COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at, refs.created_at) DESC,
               refs.id DESC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return compactNetworkTaskOutputCorpusForBoardManager(result.rows, { limit: normalizedLimit });
}

export async function ensureRecentEvidenceEvaluationPackets({
  corpus = null,
  limit = 8,
  fetchUrlExcerptImpl = undefined,
  queryImpl = undefined,
} = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const candidates = safeArray(corpus?.outputs)
    .filter((item) => item?.taskId && [
      "submitted",
      "verification_requested",
      "verification_response_submitted",
      "reward_decided",
      "rewarded",
      "paid",
    ].includes(safeText(item.state, 80).toLowerCase()))
    .slice(0, normalizedLimit);
  const results = [];
  for (const item of candidates) {
    const result = await createEvidenceEvaluationPacketForTask({
      taskId: item.taskId,
      evaluatorId: "evidence_evaluation_orc",
      ...(fetchUrlExcerptImpl ? { fetchUrlExcerptImpl } : {}),
      ...(queryImpl ? { queryImpl } : {}),
      persist: true,
    }).catch((error) => ({
      ok: false,
      taskId: item.taskId,
      error: safeText(error?.message || error, 500),
    }));
    results.push(result);
  }
  return {
    attempted: candidates.length,
    createdOrUpdated: results.filter((result) => result?.ok).length,
    results,
  };
}

export function internalRunFilterSql(includeInternal = false) {
  return includeInternal
    ? ""
    : "AND lower(trigger) NOT LIKE '%smoke%' AND lower(manager_id) NOT LIKE '%smoke%'";
}

export function boardManagerSourceLogSnapshot(packet = {}) {
  const source = safeObject(packet);
  if (!Object.keys(source).length) return {};
  return {
    schema: safeText(source.schema, 120),
    scope: safeText(source.scope, 120),
    trigger: safeText(source.trigger, 160),
    generatedAt: source.generatedAt || null,
    sourcePacketDigest: safeText(source.sourcePacketDigest, 120),
    freshness: safeObject(source.freshness),
    boardActionPressure: safeObject(source.boardActionPressure),
    networkTaskCandidates: safeArray(source.networkTaskCandidates).slice(0, 20),
    operatorStandingPolicy: safeArray(source.operatorStandingPolicy).slice(0, 24),
    generationQualityPolicy: safeObject(source.generationQualityPolicy),
    networkTaskOutputCorpus: safeObject(source.networkTaskOutputCorpus),
    evidenceEvaluationPackets: safeArray(source.evidenceEvaluationPackets).slice(0, 24),
    priorOutputCorpusSummary: safeObject(source.priorOutputCorpusSummary),
    deduplicationWatchlist: safeArray(source.deduplicationWatchlist).slice(0, 16),
    capabilityInstrumentation: safeObject(source.capabilityInstrumentation),
    badgeEligibility: safeObject(source.badgeEligibility),
    orcOperations: safeObject(source.orcOperations),
    routingConstraints: safeObject(source.routingConstraints),
    openFollowups: safeArray(source.openFollowups).slice(0, 20),
    hiveProjects: safeObject(source.hiveProjects),
    projectRegistry: safeArray(source.projectRegistry).slice(0, 40),
    networkTaskContent: safeObject(source.networkTaskContent),
    taskState: safeObject(source.taskState),
    taskRequests: safeArray(source.taskRequests).slice(0, 20),
    recentBoardManagerRuns: safeArray(source.recentBoardManagerRuns).slice(0, 20),
    executionPolicy: safeObject(source.executionPolicy),
  };
}

export async function recentBoardManagerRuns({ limit = 12, includeInternal = false, includeDetails = false } = {}) {
  if (!useDatabase()) return [];
  const exists = await query("SELECT to_regclass('public.board_manager_runs') AS name");
  if (!exists.rows[0]?.name) return [];
  const result = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             selected_action, action_payload_json, decision_json, dry_run,
             model, reasoning_effort, error, codex_session_id, codex_session_path,
             session_mode, micro_summary_json, micro_summary_text, usage_json,
             ${includeDetails ? "provider, output_text, source_packet_json," : ""}
             started_at, completed_at
      FROM board_manager_runs
      WHERE 1 = 1
        ${internalRunFilterSql(includeInternal)}
      ORDER BY started_at DESC, id DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 12, 1), 30)]
  );
  const actionResults = result.rows.length
    ? await query(
        `
          SELECT run_id, id, action, target_type, target_id, result_json, created_at
          FROM board_manager_action_results
          WHERE run_id = ANY($1::text[])
          ORDER BY created_at DESC, id DESC
        `,
        [result.rows.map((row) => row.id)]
      )
    : { rows: [] };
  const actionResultsByRun = new Map();
  for (const row of actionResults.rows) {
    const list = actionResultsByRun.get(row.run_id) || [];
    list.push({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      result: safeObject(row.result_json),
      createdAt: iso(row.created_at),
    });
    actionResultsByRun.set(row.run_id, list);
  }
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    managerId: row.manager_id,
    trigger: row.trigger,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    selectedAction: row.selected_action,
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    microSummary: safeObject(row.micro_summary_json),
    microSummaryText: safeText(row.micro_summary_text, 3000),
    dryRun: Boolean(row.dry_run),
    provider: safeText(row.provider, 120),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    usage: safeObject(row.usage_json),
    codexSessionId: row.codex_session_id,
    codexSessionPath: row.codex_session_path,
    sessionMode: row.session_mode,
    error: row.error,
    actionResults: actionResultsByRun.get(row.id) || [],
    details: includeDetails
      ? {
          provider: safeText(row.provider, 120),
          outputText: safeText(row.output_text, 40_000),
          decision: safeObject(row.decision_json),
          actionPayload: safeObject(row.action_payload_json),
          microSummary: safeObject(row.micro_summary_json),
          microSummaryText: safeText(row.micro_summary_text, 5000),
          actionResults: actionResultsByRun.get(row.id) || [],
          sourcePacket: boardManagerSourceLogSnapshot(row.source_packet_json),
        }
      : null,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  }));
}

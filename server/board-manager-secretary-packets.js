import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "./db/pool.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { boardManagerActions } from "./repositories/board-manager.js";
import { AMBIENT_MODELS, ambientConfigured, ambientFetchCompatibility } from "./ambient-inference.js";

const promptVersion = "board_manager_secretary_v1";
const secretaryPrompt = loadPrompt("hive/board_manager_secretary_v1.md");

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

const volatileDigestKeys = new Set([
  "generatedAt",
  "generated_at",
  "sourcePacketDigest",
  "trigger",
]);

const volatileFreshnessKeys = new Set([
  "hiveSecretaryAgeMs",
  "latestProjectGenerationAgeMs",
]);

function stripVolatileSourceText(value = "") {
  return String(value || "")
    .split("\n")
    .filter((line) => !/^Generated At:\s*/i.test(line.trim()))
    .join("\n");
}

function actionAffectsBoardState(run = {}) {
  const action = safeText(run.action || run.selectedAction, 80);
  if (!action || action === "do_nothing" || action === "no_decision" || action === "decision_pending") return false;
  if (run.dryRun) return false;
  return true;
}

function stableSecretarySourceValue(value, key = "") {
  if (key === "sourceText") return stripVolatileSourceText(value);
  if (key === "recentBoardManagerRuns" && Array.isArray(value)) {
    return value.filter(actionAffectsBoardState).map((item) => stableSecretarySourceValue(item));
  }
  if (Array.isArray(value)) return value.map((item) => stableSecretarySourceValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([itemKey]) => !volatileDigestKeys.has(itemKey))
      .filter(([itemKey]) => !volatileFreshnessKeys.has(itemKey))
      .filter(([itemKey]) => itemKey !== "digest")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([itemKey, item]) => [itemKey, stableSecretarySourceValue(item, itemKey)])
  );
}

export function boardManagerSecretarySourceDigest(sourcePacket = {}) {
  return digestJson(stableSecretarySourceValue(safeObject(sourcePacket)));
}

export function boardManagerSecretaryModel() {
  return safeText(process.env.TASKNODE_BOARD_MANAGER_SECRETARY_MODEL || AMBIENT_MODELS.structured, 120);
}

function secretaryReasoningEffort() {
  const configured = safeText(process.env.TASKNODE_BOARD_MANAGER_SECRETARY_REASONING_EFFORT || "high", 40).toLowerCase();
  return configured === "max" || configured === "xhigh" ? "max" : "high";
}

function secretaryTimeoutMs() {
  return Math.max(30000, Number(process.env.TASKNODE_BOARD_MANAGER_SECRETARY_TIMEOUT_MS || 240000));
}

export function boardManagerSecretaryEnabled() {
  return (
    process.env.TASKNODE_BOARD_MANAGER_SECRETARY_ENABLED !== "false" &&
    useDatabase() &&
    ambientConfigured()
  );
}

function redactSensitiveText(value = "") {
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[redacted_secret_or_hash]")
    .replace(
      /\b(seed phrase|recovery phrase|mnemonic|private key|password|oauth token|api key)\s*[:=]\s*[^\n\r]+/gi,
      "$1: [redacted]"
    );
}

function sourcePacketText(sourcePacket = {}) {
  return redactSensitiveText(JSON.stringify(sourcePacket, null, 2));
}

function secretaryMessages(sourcePacket = {}) {
  return [
    { role: "system", content: secretaryPrompt },
    {
      role: "user",
      content: [
        "Return JSON only. Compress this Board Manager source packet for a downstream action-deciding model.",
        "",
        "BOARD MANAGER SOURCE PACKET JSON",
        sourcePacketText(sourcePacket),
      ].join("\n"),
    },
  ];
}

function parseJsonOutput(text = "") {
  const raw = safeText(text, 2_000_000);
  if (!raw) throw new Error("board_manager_secretary_empty_output");
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  let lastError = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  const message = safeText(lastError?.message || "invalid JSON", 500);
  throw new Error(`board_manager_secretary_invalid_json:${message}`);
}

function isJsonOutputParseError(error) {
  if (error instanceof SyntaxError) return true;
  const message = safeText(error?.message, 500);
  return message === "board_manager_secretary_empty_output" ||
    message.startsWith("board_manager_secretary_invalid_json") ||
    /JSON|Unexpected|Expected|unterminated|parse/i.test(message);
}

function boardManagerSecretaryRepairMessages({ sourcePacket = {}, invalidText = "", parseError = "" } = {}) {
  return [
    ...secretaryMessages(sourcePacket),
    {
      role: "assistant",
      content: safeText(invalidText, 20000),
    },
    {
      role: "user",
      content: [
        "The previous assistant message was not valid JSON and could not be parsed.",
        `Parser error: ${safeText(parseError, 500)}`,
        "Repair the same Board Manager Secretary packet now.",
        "Return exactly one JSON object matching the packet contract. Do not add prose, markdown, comments, or trailing text.",
        "Preserve operator_standing_policy, generation_quality_policy, project_leader_inputs, prior_output_corpus_summary, deduplication_watchlist, capability_gap_summary, badge_eligibility, orc_operations_summary, and facts_to_preserve.",
      ].join("\n"),
    },
  ];
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

function boardManagerSecretaryFallbackPacket({ sourcePacket = {}, parseError = "" } = {}) {
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

function normalizeOperatorStandingPolicy(value = []) {
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

function normalizeGenerationQualityPolicy(value = {}) {
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

function normalizePriorOutputCorpusSummary(value = {}) {
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

function normalizeDeduplicationWatchlist(value = []) {
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

function normalizeCapabilityGapSummary(value = {}) {
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

function normalizeBadgeEligibility(value = {}) {
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

function normalizeOrcOperationsSummary(value = {}) {
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

function normalizeProjectLeaderInputs(value = []) {
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

function packetText(packet = {}) {
  const targets = safeArray(packet.attention_targets)
    .map((target) => `- ${target.target_type || "target"} ${target.target_id || ""}: ${target.reason || target.title || ""}`.trim())
    .filter(Boolean)
    .join("\n") || "None";
  const projects = safeArray(packet.project_summaries)
    .map((project) => `- ${project.project_id || project.title}: ${project.status || project.next_needed || ""}`.trim())
    .filter(Boolean)
    .join("\n") || "None";
  const standingPolicy = safeArray(packet.operator_standing_policy)
    .map((policy) =>
      `- [${policy.source_id || "source"} ${policy.created_at || ""} ${policy.active_scope || "global"}] ${policy.directive || ""} -> ${policy.generation_implication || ""}`.trim()
    )
    .filter(Boolean)
    .join("\n") || "None";
  const generationPolicy = safeObject(packet.generation_quality_policy);
  const corpusSummary = safeObject(packet.prior_output_corpus_summary);
  const recentOutputs = safeArray(corpusSummary.recent_outputs)
    .map((output) => {
      if (typeof output === "string") return `- ${output}`;
      return `- ${output.task_id || output.title || "output"} ${output.project_id || ""}: ${output.summary || output.title || ""}`.trim();
    })
    .filter(Boolean)
    .join("\n") || "None";
  const dedupWatchlist = safeArray(packet.deduplication_watchlist)
    .map((item) =>
      `- ${item.theme || item.project_id || "theme"}: prior tasks ${(item.prior_task_ids || []).join(", ") || "none"}; prior CIDs ${(item.prior_cids || []).join(", ") || "none"}; next ${item.next_action_suggestion || "unspecified"}`.trim()
    )
    .filter(Boolean)
    .join("\n") || "None";
  const capabilityGapSummary = safeObject(packet.capability_gap_summary);
  const capabilityGaps = safeArray(capabilityGapSummary.gaps)
    .map((gap) =>
      `- ${gap.project_id || "project"} / ${gap.candidate_account_id || "candidate"}: ${gap.capability_type || "capability"} -> ${gap.candidate_status || "unknown"}; next ${gap.recommended_task_work_type || "unspecified"}`.trim()
    )
    .filter(Boolean)
    .join("\n") || "None";
  const orcOperationsSummary = safeObject(packet.orc_operations_summary);
  const orcAgents = safeArray(orcOperationsSummary.agents)
    .map((agent) =>
      `- ${agent.handle || agent.agent_id || agent.account_id || "orc"}: ${agent.status || "unknown"}; routing=${agent.routing_eligible ? "yes" : "no"}; network_tasks=${agent.outstanding_network_task_count || 0}; pending_generation=${agent.pending_generation_count || 0}; reviews_action_required=${agent.action_required_review_count || 0}`.trim()
    )
    .filter(Boolean)
    .join("\n") || "None";
  const orcReviews = safeArray(orcOperationsSummary.recent_reviews)
    .map((review) =>
      `- ${review.task_id || "task"}: ${review.disposition || "unknown"}${review.action_required ? " action_required" : ""}; ${review.summary || review.recommended_action || ""}`.trim()
    )
    .filter(Boolean)
    .join("\n") || "None";
  const orcRollups = safeArray(orcOperationsSummary.review_rollups)
    .map((rollup) =>
      `- ${rollup.account_id || rollup.wallet_address || "contributor"} / ${rollup.category || "uncategorized"}: reviewed=${rollup.reviewed_count || 0}; action_required=${rollup.action_required_count || 0}; integrity_follow_up=${rollup.integrity_follow_up_count || 0}; repeated=${safeArray(rollup.repeated_integrity_signals).join(", ") || "none"}; latest=${safeObject(rollup.last_reviewed_action).task_id || "none"}`.trim()
    )
    .filter(Boolean)
    .join("\n") || "None";
  return [
    "BOARD MANAGER SECRETARY PACKET",
    "",
    `Motion state: ${packet.motion_state}`,
    `Requires attention: ${packet.requires_attention ? "yes" : "no"}`,
    `Do nothing allowed: ${packet.do_nothing_allowed ? "yes" : "no"}`,
    "",
    "Board summary",
    packet.board_summary || "No board summary.",
    "",
    "Reason summary",
    packet.reason_summary || "No reason summary.",
    "",
    "Staleness summary",
    packet.staleness_summary || "No staleness summary.",
    "",
    "Action pressure",
    packet.action_pressure_summary || "No action pressure summary.",
    "",
    "Recommended context request",
    `${packet.recommended_context_request.packet_type} ${packet.recommended_context_request.target_type} ${packet.recommended_context_request.target_id}`.trim(),
    packet.recommended_context_request.reason || "",
    "",
    "Attention targets",
    targets,
    "",
    "Project summaries",
    projects,
    "",
    "Network tasks",
    packet.network_task_summary || "No network task summary.",
    "",
    "Candidates",
    packet.candidate_summary || "No candidate summary.",
    "",
    "Recent Board Manager runs",
    packet.recent_run_summary || "No recent run summary.",
    "",
    "Operator standing policy",
    standingPolicy,
    "",
    "Generation quality policy",
    `documentation_only_default: ${generationPolicy.documentation_only_default || "low_value_unless_action_coupled"}`,
    `requires_concrete_action_output: ${generationPolicy.requires_concrete_action_output ? "true" : "false"}`,
    `escalation_ladder: ${generationPolicy.escalation_ladder || "document_to_action_v1"}`,
    generationPolicy.operator_constraints_summary || "",
    "",
    "Prior output corpus summary",
    `Projects covered: ${safeArray(corpusSummary.projects_covered).join(", ") || "none"}`,
    `Repeated themes: ${safeArray(corpusSummary.repeated_themes).join("; ") || "none"}`,
    `Open actionable items: ${safeArray(corpusSummary.open_actionable_items).join("; ") || "none"}`,
    recentOutputs,
    "",
    "Deduplication watchlist",
    dedupWatchlist,
    "",
    "Capability gap summary",
    `status: ${capabilityGapSummary.status || "phase_a_instrumentation_only_no_enforcement"}`,
    `enforcement: ${capabilityGapSummary.enforcement || "none_context_only"}`,
    `requirements: ${capabilityGapSummary.requirement_count || 0}; candidates: ${capabilityGapSummary.candidate_count || 0}; verified capabilities: ${capabilityGapSummary.verified_capability_count || 0}; gaps: ${capabilityGapSummary.gap_count || 0}`,
    capabilityGaps,
    "",
    "Orc operations summary",
    `enforcement: ${orcOperationsSummary.enforcement || "none_context_only"}`,
    `agents: ${orcOperationsSummary.agent_count || 0}; active: ${orcOperationsSummary.active_agent_count || 0}; routeable: ${orcOperationsSummary.available_for_routing_count || 0}; review history: ${orcOperationsSummary.review_history_count || 0}; action-required reviews: ${orcOperationsSummary.action_required_review_count || 0}; rollups: ${orcOperationsSummary.review_rollup_count || 0}; integrity-follow-up rollups: ${orcOperationsSummary.integrity_follow_up_rollup_count || 0}`,
    orcAgents,
    "Orc review rollups (manager-internal triage signals; not public fraud findings)",
    orcRollups,
    "Recent Orc reviews",
    orcReviews,
    "",
    "Facts to preserve",
    safeArray(packet.facts_to_preserve).map((fact) => `- ${fact}`).join("\n") || "None",
  ].join("\n").trim();
}

function buildActionTargetRegistry(sourcePacket = {}) {
  const accounts = new Map();
  const hiveContextEntries = [];
  const contributorCandidates = new Map();

  const addAccount = ({ accountId = "", displayName = "", latestHiveContextEntryId = "", latestSourceConversationId = "" } = {}) => {
    const normalizedAccount = safeText(accountId, 180);
    if (!normalizedAccount) return;
    const existing = accounts.get(normalizedAccount) || {};
    accounts.set(normalizedAccount, {
      accountId: normalizedAccount,
      displayName: safeText(displayName || existing.displayName, 120),
      latestHiveContextEntryId: safeText(latestHiveContextEntryId || existing.latestHiveContextEntryId, 180),
      latestSourceConversationId: safeText(latestSourceConversationId || existing.latestSourceConversationId, 180),
    });
  };

  const addContributor = ({ accountId = "", displayName = "", walletAddress = "" } = {}) => {
    const normalizedWallet = safeText(walletAddress, 120);
    if (!normalizedWallet) return;
    const normalizedAccount = safeText(accountId, 180);
    const key = `${normalizedAccount}:${normalizedWallet}`;
    if (contributorCandidates.has(key)) return;
    contributorCandidates.set(key, {
      accountId: normalizedAccount,
      displayName: safeText(displayName, 120),
      walletAddress: normalizedWallet,
    });
  };

  for (const group of safeArray(sourcePacket?.hiveContext?.groups)) {
    const groupAccountId = safeText(group.accountId, 180);
    const groupDisplayName = safeText(group.displayName, 120);
    addAccount({ accountId: groupAccountId, displayName: groupDisplayName });
    for (const entry of safeArray(group.entries)) {
      const accountId = safeText(entry.accountId || groupAccountId, 180);
      const displayName = safeText(entry.displayName || groupDisplayName, 120);
      const item = {
        id: safeText(entry.id, 180),
        accountId,
        displayName,
        sourceConversationId: safeText(entry.sourceConversationId, 180),
        walletValidated: Boolean(entry.walletValidated),
        walletAddress: safeText(entry.walletAddress, 120),
        bodyPreview: safeText(entry.body, 500),
        generationPolicyHint: Boolean(safeText(entry.body, 2000)),
        createdAt: entry.createdAt || null,
      };
      if (item.id) hiveContextEntries.push(item);
      addAccount({
        accountId,
        displayName,
        latestHiveContextEntryId: item.id,
        latestSourceConversationId: item.sourceConversationId,
      });
      if (item.walletValidated) addContributor(item);
    }
  }

  for (const candidate of safeArray(sourcePacket?.networkTaskCandidates)) {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    const displayName = safeText(candidate.displayName || candidate.display_name, 120);
    const walletAddress = safeText(candidate.walletAddress || candidate.wallet_address, 120);
    addAccount({ accountId, displayName });
    addContributor({ accountId, displayName, walletAddress });
  }

  for (const candidate of safeArray(sourcePacket?.orcOperations?.routingCandidates || sourcePacket?.orc_operations?.routingCandidates)) {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    const displayName = safeText(candidate.handle || candidate.displayName || candidate.display_name, 120);
    const walletAddress = safeText(candidate.walletAddress || candidate.wallet_address, 120);
    addAccount({ accountId, displayName });
    addContributor({ accountId, displayName, walletAddress });
  }

  return {
    accounts: [...accounts.values()].slice(0, 48),
    hiveContextEntries: hiveContextEntries.slice(0, 96),
    contributorCandidates: [...contributorCandidates.values()].slice(0, 48),
  };
}

function deepSeekUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0),
  };
}

export async function fetchBoardManagerSecretaryPacket({
  sourcePacket = {},
  model = boardManagerSecretaryModel(),
  fetchImpl = fetch,
} = {}) {
  if (!ambientConfigured()) {
    const error = new Error("board_manager_secretary_ambient_not_configured");
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), secretaryTimeoutMs());
  const startedAt = Date.now();
  try {
    const requestPacket = async (messages) => {
      const response = await ambientFetchCompatibility(fetchImpl, "", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          thinking: { type: "enabled" },
          reasoning_effort: secretaryReasoningEffort(),
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: Math.max(2500, Number(process.env.TASKNODE_BOARD_MANAGER_SECRETARY_MAX_TOKENS || 6000)),
          stream: false,
        }),
      }, { capability: "strict_json", timeoutMs: secretaryTimeoutMs() });
      const bodyText = await response.text();
      const body = bodyText ? JSON.parse(bodyText) : {};
      if (!response.ok) {
        const error = new Error(body?.error?.message || body?.message || `DeepSeek Board Manager Secretary HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return {
        body,
        outputText: body?.choices?.[0]?.message?.content || "",
      };
    };

    let response = await requestPacket(secretaryMessages(sourcePacket));
    let parsed;
    let repairAttempted = false;
    let repairFailed = false;
    const firstUsage = deepSeekUsage(response.body);
    try {
      parsed = parseJsonOutput(response.outputText);
    } catch (error) {
      if (!isJsonOutputParseError(error)) throw error;
      repairAttempted = true;
      response = await requestPacket(boardManagerSecretaryRepairMessages({
        sourcePacket,
        invalidText: response.outputText,
        parseError: error?.message || String(error),
      }));
      try {
        parsed = parseJsonOutput(response.outputText);
      } catch (repairError) {
        if (!isJsonOutputParseError(repairError)) throw repairError;
        repairFailed = true;
        parsed = boardManagerSecretaryFallbackPacket({
          sourcePacket,
          parseError: repairError?.message || String(repairError),
        });
        response = {
          ...response,
          outputText: JSON.stringify(parsed),
        };
      }
    }
    const packet = normalizeBoardManagerSecretaryPacket(parsed);
    if (!packet.board_summary && !packet.reason_summary) {
      throw new Error("board_manager_secretary_missing_summary");
    }
    const usage = deepSeekUsage(response.body);
    if (repairAttempted) {
      usage.inputTokens += firstUsage.inputTokens;
      usage.outputTokens += firstUsage.outputTokens;
      usage.totalTokens += firstUsage.totalTokens;
      usage.reasoningTokens += firstUsage.reasoningTokens;
      usage.repairAttempted = true;
      usage.repairFailed = repairFailed;
    }
    return {
      packet,
      outputText: response.outputText,
      packetText: packetText(packet),
      provider: "ambient",
      model: response.body?.model || model,
      responseId: safeText(response.body?.id, 200),
      promptVersion,
      promptDigest: promptDigest(secretaryPrompt),
      usage: {
        ...usage,
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("board_manager_secretary_deepseek_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function rowToPacket(row = {}) {
  return {
    id: row.id,
    scope: row.scope,
    packetType: row.packet_type,
    targetType: row.target_type,
    targetId: row.target_id,
    sourceDigest: row.source_digest,
    packetDigest: row.packet_digest,
    packetJson: safeObject(row.packet_json),
    packetText: safeText(row.packet_text, 20000),
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    promptDigest: row.prompt_digest,
    responseId: row.response_id,
    usage: safeObject(row.usage_json),
    status: row.status,
    error: row.error,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    supersededAt: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
  };
}

export async function getCurrentBoardManagerSecretaryPacket({
  scope = "global_hive",
  packetType = "board_triage",
  targetType = "",
  targetId = "",
  sourceDigest = "",
} = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM board_manager_secretary_packets
      WHERE scope = $1
        AND packet_type = $2
        AND target_type = $3
        AND target_id = $4
        AND source_digest = $5
        AND status = 'current'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [
      safeText(scope, 120) || "global_hive",
      safeText(packetType, 80) || "board_triage",
      safeText(targetType, 80),
      safeText(targetId, 240),
      safeText(sourceDigest, 120),
    ]
  );
  return result.rows[0] ? rowToPacket(result.rows[0]) : null;
}

export async function getLatestBoardManagerSecretaryPacket({
  scope = "global_hive",
  packetType = "board_triage",
  targetType = "",
  targetId = "",
} = {}) {
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT *
      FROM board_manager_secretary_packets
      WHERE scope = $1
        AND packet_type = $2
        AND target_type = $3
        AND target_id = $4
        AND status = 'current'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [
      safeText(scope, 120) || "global_hive",
      safeText(packetType, 80) || "board_triage",
      safeText(targetType, 80),
      safeText(targetId, 240),
    ]
  );
  return result.rows[0] ? rowToPacket(result.rows[0]) : null;
}

async function insertBoardManagerSecretaryPacket({
  scope = "global_hive",
  packetType = "board_triage",
  targetType = "",
  targetId = "",
  sourceDigest = "",
  result = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const packet = normalizeBoardManagerSecretaryPacket(result.packet);
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const normalizedPacketType = safeText(packetType, 80) || "board_triage";
  const normalizedTargetType = safeText(targetType, 80);
  const normalizedTargetId = safeText(targetId, 240);
  const normalizedSourceDigest = safeText(sourceDigest, 120);
  const normalizedPacketDigest = digestJson(packet);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE board_manager_secretary_packets
        SET status = 'superseded',
            superseded_at = now()
        WHERE scope = $1
          AND packet_type = $2
          AND target_type = $3
          AND target_id = $4
          AND status = 'current'
      `,
      [normalizedScope, normalizedPacketType, normalizedTargetType, normalizedTargetId]
    );
    const inserted = await client.query(
      `
        INSERT INTO board_manager_secretary_packets (
          id, scope, packet_type, target_type, target_id, source_digest,
          packet_digest, packet_json, packet_text, provider, model,
          prompt_version, prompt_digest, response_id, usage_json, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb, 'current')
        RETURNING *
      `,
      [
        `bmsec_${randomUUID()}`,
        normalizedScope,
        normalizedPacketType,
        normalizedTargetType,
        normalizedTargetId,
        normalizedSourceDigest,
        normalizedPacketDigest,
        jsonValue(packet),
        safeText(result.packetText || packetText(packet), 20000),
        safeText(result.provider || "ambient", 80),
        safeText(result.model || boardManagerSecretaryModel(), 120),
        safeText(result.promptVersion || promptVersion, 120),
        safeText(result.promptDigest || promptDigest(secretaryPrompt), 120),
        safeText(result.responseId, 200),
        jsonValue(result.usage || {}),
      ]
    );
    return { ok: true, packet: rowToPacket(inserted.rows[0]), reused: false };
  });
}

export async function ensureBoardManagerSecretaryPacket({
  sourcePacket = {},
  scope = "global_hive",
  packetType = "board_triage",
  targetType = "",
  targetId = "",
  fetchImpl = fetch,
} = {}) {
  if (!boardManagerSecretaryEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: !useDatabase() ? "database_not_configured" : "deepseek_not_configured_or_disabled",
    };
  }
  const sourceDigest = boardManagerSecretarySourceDigest(sourcePacket);
  const existing = await getCurrentBoardManagerSecretaryPacket({
    scope,
    packetType,
    targetType,
    targetId,
    sourceDigest,
  });
  if (existing) return { ok: true, packet: existing, reused: true };
  const result = await fetchBoardManagerSecretaryPacket({ sourcePacket, fetchImpl });
  return insertBoardManagerSecretaryPacket({
    scope,
    packetType,
    targetType,
    targetId,
    sourceDigest,
    result,
  });
}

export function buildBoardManagerSecretaryDecisionPacket({
  sourcePacket = {},
  secretaryPacket = {},
  reused = false,
} = {}) {
  const normalizedSecretaryJson = normalizeBoardManagerSecretaryPacket(secretaryPacket.packetJson);
  const packetCore = {
    schema: "pf.hive.board_manager.decision_source.v1",
    sourceMode: "ambient_secretary_packet",
    scope: safeText(sourcePacket.scope, 120) || "global_hive",
    trigger: safeText(sourcePacket.trigger, 160),
    generatedAt: new Date().toISOString(),
    database: safeObject(sourcePacket.database),
    actionRegistry: boardManagerActions,
    rawSourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
    secretarySourceDigest: safeText(secretaryPacket.sourceDigest, 120),
    boardActionPressure: safeObject(sourcePacket.boardActionPressure),
    openFollowups: safeArray(sourcePacket.openFollowups).slice(0, 20),
    actionTargetRegistry: buildActionTargetRegistry(sourcePacket),
    operatorStandingPolicy: normalizeOperatorStandingPolicy(
      sourcePacket.operatorStandingPolicy ||
        sourcePacket.operator_standing_policy ||
        normalizedSecretaryJson.operator_standing_policy
    ),
    generationQualityPolicy: normalizeGenerationQualityPolicy(
      sourcePacket.generationQualityPolicy ||
        sourcePacket.generation_quality_policy ||
        normalizedSecretaryJson.generation_quality_policy
    ),
    networkTaskOutputCorpus: safeObject(sourcePacket.networkTaskOutputCorpus || sourcePacket.network_task_output_corpus),
    priorOutputCorpusSummary: normalizePriorOutputCorpusSummary(
      sourcePacket.priorOutputCorpusSummary ||
        sourcePacket.prior_output_corpus_summary ||
        sourcePacket.networkTaskOutputCorpus?.summary ||
        normalizedSecretaryJson.prior_output_corpus_summary
    ),
    deduplicationWatchlist: normalizeDeduplicationWatchlist(
      sourcePacket.deduplicationWatchlist ||
        sourcePacket.deduplication_watchlist ||
        sourcePacket.networkTaskOutputCorpus?.deduplicationWatchlist ||
        normalizedSecretaryJson.deduplication_watchlist
    ),
    projectLeaderInputs: normalizeProjectLeaderInputs(
      sourcePacket.projectLeaderInputs ||
        sourcePacket.project_leader_inputs ||
        normalizedSecretaryJson.project_leader_inputs
    ),
    capabilityInstrumentation: safeObject(sourcePacket.capabilityInstrumentation || sourcePacket.capability_instrumentation),
    capabilityGapSummary: normalizeCapabilityGapSummary(
      sourcePacket.capabilityGapSummary ||
        sourcePacket.capability_gap_summary ||
        sourcePacket.capabilityInstrumentation ||
        normalizedSecretaryJson.capability_gap_summary
    ),
    badgeEligibility: normalizeBadgeEligibility(
      sourcePacket.badgeEligibility ||
        sourcePacket.badge_eligibility ||
        normalizedSecretaryJson.badge_eligibility
    ),
    orcOperations: safeObject(sourcePacket.orcOperations || sourcePacket.orc_operations),
    orcOperationsSummary: normalizeOrcOperationsSummary(
      sourcePacket.orcOperations ||
        sourcePacket.orc_operations ||
        sourcePacket.orcOperationsSummary ||
        normalizedSecretaryJson.orc_operations_summary
    ),
    secretaryPacket: {
      id: safeText(secretaryPacket.id, 180),
      packetType: safeText(secretaryPacket.packetType || "board_triage", 80),
      sourceDigest: safeText(secretaryPacket.sourceDigest, 120),
      packetDigest: safeText(secretaryPacket.packetDigest, 120),
      reused: Boolean(reused),
      provider: safeText(secretaryPacket.provider || "ambient", 80),
      model: safeText(secretaryPacket.model || boardManagerSecretaryModel(), 120),
      promptVersion: safeText(secretaryPacket.promptVersion || promptVersion, 120),
      createdAt: secretaryPacket.createdAt || null,
      packetJson: normalizedSecretaryJson,
      packetText: safeText(secretaryPacket.packetText, 20000),
      usage: safeObject(secretaryPacket.usage),
    },
    executionPolicy: safeObject(sourcePacket.executionPolicy),
  };
  return {
    ...packetCore,
    sourcePacketDigest: digestJson({ ...packetCore, generatedAt: "" }),
  };
}

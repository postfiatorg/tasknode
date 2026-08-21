import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "./db/pool.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { boardManagerActions } from "./repositories/board-manager.js";
import { AMBIENT_MODELS, ambientConfigured, ambientFetchCompatibility } from "./ambient-inference.js";
import {
  boardManagerSecretaryFallbackPacket,
  normalizeBadgeEligibility,
  normalizeBoardManagerSecretaryPacket,
  normalizeCapabilityGapSummary,
  normalizeDeduplicationWatchlist,
  normalizeGenerationQualityPolicy,
  normalizeOperatorStandingPolicy,
  normalizeOrcOperationsSummary,
  normalizePriorOutputCorpusSummary,
  normalizeProjectLeaderInputs,
} from "./board-manager-secretary-contract.js";

export { normalizeBoardManagerSecretaryPacket } from "./board-manager-secretary-contract.js";

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

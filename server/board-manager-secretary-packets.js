import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "./db/pool.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { boardManagerActions } from "./repositories/board-manager.js";

const defaultDeepSeekBaseUrl = "https://api.deepseek.com";
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
  if (!action || action === "do_nothing" || action === "no_decision") return false;
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

function deepSeekKey() {
  return safeText(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK, 10000);
}

export function boardManagerSecretaryModel() {
  return safeText(process.env.TASKNODE_BOARD_MANAGER_SECRETARY_MODEL || "deepseek-v4-pro", 120);
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
    Boolean(deepSeekKey())
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

function parseJsonOutput(text = "") {
  const raw = safeText(text, 2_000_000);
  if (!raw) throw new Error("board_manager_secretary_empty_output");
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("board_manager_secretary_invalid_json");
  }
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
  const apiKey = deepSeekKey();
  if (!apiKey) {
    const error = new Error("board_manager_secretary_deepseek_not_configured");
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), secretaryTimeoutMs());
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${(process.env.DEEPSEEK_BASE_URL || defaultDeepSeekBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
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
        ],
        thinking: { type: "enabled" },
        reasoning_effort: secretaryReasoningEffort(),
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: Math.max(2500, Number(process.env.TASKNODE_BOARD_MANAGER_SECRETARY_MAX_TOKENS || 6000)),
        stream: false,
      }),
    });
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `DeepSeek Board Manager Secretary HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const outputText = body?.choices?.[0]?.message?.content || "";
    const packet = normalizeBoardManagerSecretaryPacket(parseJsonOutput(outputText));
    if (!packet.board_summary && !packet.reason_summary) {
      throw new Error("board_manager_secretary_missing_summary");
    }
    return {
      packet,
      outputText,
      packetText: packetText(packet),
      provider: "deepseek",
      model: body?.model || model,
      responseId: safeText(body?.id, 200),
      promptVersion,
      promptDigest: promptDigest(secretaryPrompt),
      usage: {
        ...deepSeekUsage(body),
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
        safeText(result.provider || "deepseek", 80),
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
  const packetCore = {
    schema: "pf.hive.board_manager.decision_source.v1",
    sourceMode: "deepseek_secretary_packet",
    scope: safeText(sourcePacket.scope, 120) || "global_hive",
    trigger: safeText(sourcePacket.trigger, 160),
    generatedAt: new Date().toISOString(),
    database: safeObject(sourcePacket.database),
    actionRegistry: boardManagerActions,
    rawSourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
    secretarySourceDigest: safeText(secretaryPacket.sourceDigest, 120),
    boardActionPressure: safeObject(sourcePacket.boardActionPressure),
    actionTargetRegistry: buildActionTargetRegistry(sourcePacket),
    secretaryPacket: {
      id: safeText(secretaryPacket.id, 180),
      packetType: safeText(secretaryPacket.packetType || "board_triage", 80),
      sourceDigest: safeText(secretaryPacket.sourceDigest, 120),
      packetDigest: safeText(secretaryPacket.packetDigest, 120),
      reused: Boolean(reused),
      provider: safeText(secretaryPacket.provider || "deepseek", 80),
      model: safeText(secretaryPacket.model || boardManagerSecretaryModel(), 120),
      promptVersion: safeText(secretaryPacket.promptVersion || promptVersion, 120),
      createdAt: secretaryPacket.createdAt || null,
      packetJson: normalizeBoardManagerSecretaryPacket(secretaryPacket.packetJson),
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

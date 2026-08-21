import { AMBIENT_MODELS, ambientConfigured, ambientFetchCompatibility } from "../ambient-inference.js";

export const maxRecommendedConnections = 4;
export const minRecommendedConnections = 3;
const weeklyRefreshMs = 7 * 24 * 60 * 60 * 1000;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function publicRecommendedConnectionCandidate(row = {}) {
  const packet = safeObject(row.packet_json);
  const snapshot = safeObject(packet.public_profile_snapshot);
  const diagnostic = safeObject(packet.network_diagnostic);
  const distance = Number(row.distance ?? 0);
  return {
    accountId: row.account_id || "",
    displayName: row.display_name || packet.display_name || "",
    hiveHandle: row.hive_handle || packet.hive_handle || "",
    walletAddress: row.wallet_address || "",
    packetDigest: row.packet_digest || "",
    roleTitle: snapshot.role_title || diagnostic.title || "",
    roleSummary: snapshot.role_summary || "",
    skills: safeArray(snapshot.skills).slice(0, 6),
    networkDiagnosticText: diagnostic.text || row.packet_text || "",
    currentFocus: safeArray(diagnostic.current_focus).slice(0, 6),
    primaryContribution: safeArray(diagnostic.primary_contribution_ability).slice(0, 6),
    currentTasks: safeArray(packet.current_tasks).slice(0, 4),
    similarity: Number((1 - distance).toFixed(6)),
    distance,
  };
}

export function recommendedConnectionRunIsFresh(run = null) {
  const completedAt = Date.parse(run?.completed_at || run?.completedAt || "");
  return Number.isFinite(completedAt) && Date.now() - completedAt < weeklyRefreshMs;
}

export function publicRecommendedConnection(row = {}) {
  const snapshot = safeObject(row.candidate_snapshot);
  const candidateAccountId = row.candidate_account_id || snapshot.accountId || "";
  const heroNft = safeObject(row.candidate_hero_nft || snapshot.heroNft);
  return {
    id: row.id || "",
    runId: row.run_id || "",
    accountId: candidateAccountId,
    displayName: snapshot.displayName || "",
    hiveHandle: snapshot.hiveHandle || "",
    heroNft: heroNft.id || heroNft.imageCid || heroNft.imageGatewayUrl ? heroNft : null,
    walletAddress: row.candidate_wallet_address || snapshot.walletAddress || "",
    profilePath: candidateAccountId
      ? `/api/profile/member?accountId=${encodeURIComponent(candidateAccountId)}`
      : "",
    roleTitle: snapshot.roleTitle || "",
    roleSummary: snapshot.roleSummary || "",
    rank: Number(row.rank || 0),
    reason: row.reason || "",
    suggestedFirstAction: row.suggested_first_action || "",
    sharedContext: row.shared_context || "",
    complementaryValue: row.complementary_value || "",
    riskOrUncertainty: row.risk_or_uncertainty || "",
    supportingSignals: safeArray(row.supporting_signals),
    score: Number(row.score || 0),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
  };
}

export function parseRecommendedConnectionsJson(text = "", candidates = []) {
  const raw = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("recommended_connections_invalid_json");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const candidateIds = new Set(candidates.map((candidate) => candidate.accountId));
  return safeArray(parsed.recommendations)
    .map((entry, index) => {
      const candidateAccountId = safeText(entry.candidate_account_id || entry.account_id || entry.accountId, 180);
      return {
        candidateAccountId,
        rank: Math.max(1, Number(entry.rank || index + 1)),
        reason: safeText(entry.reason, 900),
        suggestedFirstAction: safeText(entry.suggested_first_action || entry.suggestedFirstAction, 500),
        sharedContext: safeText(entry.shared_context || entry.sharedContext, 500),
        complementaryValue: safeText(entry.complementary_value || entry.complementaryValue, 500),
        riskOrUncertainty: safeText(entry.risk_or_uncertainty || entry.riskOrUncertainty, 500),
        supportingSignals: safeArray(entry.supporting_signals || entry.supportingSignals)
          .map((item) => safeText(item, 180))
          .filter(Boolean)
          .slice(0, 5),
        score: Math.max(0, Math.min(1, Number(entry.score || 0))),
      };
    })
    .filter((entry) => (
      entry.candidateAccountId &&
      candidateIds.has(entry.candidateAccountId) &&
      entry.reason &&
      entry.suggestedFirstAction
    ))
    .slice(0, maxRecommendedConnections);
}

export function deterministicRecommendedConnections({ candidates = [] } = {}) {
  return safeArray(candidates)
    .slice(0, maxRecommendedConnections)
    .map((candidate, index) => ({
      candidateAccountId: candidate.accountId,
      rank: index + 1,
      reason: `${candidate.displayName || "This member"} has overlapping Task Node work and a completed Network Diagnostic Report that matches the current profile packet.`,
      suggestedFirstAction: "Review their current focus and ask for one concrete contribution on the shared product surface.",
      sharedContext: safeArray(candidate.currentFocus)[0] || candidate.roleTitle || "Shared Task Node context.",
      complementaryValue: safeArray(candidate.primaryContribution)[0] || "Can add useful review or implementation judgment.",
      riskOrUncertainty: "This is a deterministic fallback until DeepSeek reranking is available.",
      supportingSignals: [
        candidate.roleTitle || "Completed Network Diagnostic Report",
        candidate.skills?.[0] || "Discoverable public profile",
        candidate.currentTasks?.[0]?.title || "Recent task context",
      ].filter(Boolean).slice(0, 3),
      score: Math.max(0, Number(candidate.similarity || 0)),
    }));
}

function recommendationPromptPayload({ target = {}, candidates = [] } = {}) {
  return {
    schema: "pf.profile.recommended_connections_rerank_input.v1",
    objective: "Choose the 3-4 Task Node members most useful for the target member to know or work with next.",
    target,
    candidate_count: candidates.length,
    candidates: candidates.map((candidate, index) => ({
      rank_from_vector_search: index + 1,
      account_id: candidate.accountId,
      display_name: candidate.displayName,
      hive_handle: candidate.hiveHandle,
      role_title: candidate.roleTitle,
      role_summary: candidate.roleSummary,
      skills: candidate.skills,
      vector_similarity: candidate.similarity,
      network_diagnostic_report: candidate.networkDiagnosticText,
      current_focus: candidate.currentFocus,
      primary_contribution_ability: candidate.primaryContribution,
      current_tasks: candidate.currentTasks,
    })),
  };
}

export async function callRecommendedConnectionsProvider({
  prompt,
  target,
  candidates,
  fetchImpl = fetch,
} = {}) {
  if (!ambientConfigured()) {
    const recommendations = deterministicRecommendedConnections({ candidates });
    return {
      provider: "deterministic_fallback",
      model: "deterministic-recommended-connections-v1",
      recommendations,
      output: { recommendations },
      usage: {},
    };
  }
  const model = process.env.TASKNODE_RECOMMENDED_CONNECTIONS_MODEL || AMBIENT_MODELS.fastText;
  const timeoutMs = Math.max(10_000, Number(process.env.TASKNODE_RECOMMENDED_CONNECTIONS_TIMEOUT_MS || 90_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await ambientFetchCompatibility(fetchImpl, "", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify(recommendationPromptPayload({ target, candidates })) },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    }, { capability: "fast_text", timeoutMs });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("recommended_connections_deepseek_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `DeepSeek recommended connections HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const content = body?.choices?.[0]?.message?.content || "";
  return {
    provider: "ambient",
    model: body?.model || model,
    recommendations: parseRecommendedConnectionsJson(content, candidates),
    output: body,
    usage: body?.usage || {},
  };
}

export function recommendedConnectionCandidateSnapshot(candidate = {}) {
  return {
    accountId: candidate.accountId,
    displayName: candidate.displayName,
    hiveHandle: candidate.hiveHandle,
    walletAddress: candidate.walletAddress,
    roleTitle: candidate.roleTitle,
    roleSummary: candidate.roleSummary,
    skills: candidate.skills,
    similarity: candidate.similarity,
  };
}

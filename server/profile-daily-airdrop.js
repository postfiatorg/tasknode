import { createHash } from "node:crypto";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { query } from "./db/pool.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import {
  completeDailyAirdropRun,
  createDailyAirdropRun,
  failDailyAirdropRun,
  recentDailyAirdropRunWindow,
  resolveDailyAirdropRecipientWallet,
  resolveDailyAirdropWalletCloud,
} from "./repositories/profile-daily-airdrop.js";
import { canonicalRewardedTaskProjectionSql } from "./repositories/task-projection-integrity.js";

const PROMPT_PATH = "profile/daily_airdrop_v1.md";
const PROMPT_VERSION = "daily_airdrop_v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_MAX_DAILY_PFT = 10000;
const DEFAULT_LOOKBACK_DAYS = 7;

export function dailyAirdropMaxRewardFraction(env = process.env) {
  const raw = env.TASKNODE_DAILY_AIRDROP_MAX_REWARD_FRACTION;
  if (raw === undefined || String(raw).trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function isoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function clampInteger(value, min = 0, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampNumber(value, min = 0, max = DEFAULT_MAX_DAILY_PFT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function normalizedRewardFraction(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseJsonObject(text = "") {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("daily_airdrop_empty_model_output");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("daily_airdrop_model_output_not_json");
  }
}

function objectFromValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  const raw = value.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    return {};
  }
  return {};
}

function openRouterKey(env = process.env) {
  return safeText(env.OPENROUTER_API_KEY || env.OPENROUTER, 4000);
}

function providerOrder(env = process.env) {
  return safeText(env.TASKNODE_DAILY_AIRDROP_PROVIDER_ORDER || env.TASKNODE_PRIVATE_PROVIDER_ORDER || "", 1000)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function dailyAirdropResponseFormat(maxDailyPft = DEFAULT_MAX_DAILY_PFT) {
  return {
    type: "json_schema",
    json_schema: {
      name: "daily_airdrop_score",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          daily_airdrop_pft: { type: "integer", minimum: 0, maximum: maxDailyPft },
          retention_value_score: { type: "integer", minimum: 0, maximum: 100 },
          what_raised_today: { type: "string" },
          what_kept_it_lower: { type: "string" },
          to_improve_tomorrow: { type: "string" },
          eligibility_status: { type: "string", enum: ["eligible", "ineligible"] },
          eligibility_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
          reasoning_text: { type: "string" },
        },
        required: [
          "daily_airdrop_pft",
          "retention_value_score",
          "what_raised_today",
          "what_kept_it_lower",
          "to_improve_tomorrow",
          "eligibility_status",
          "eligibility_reason",
          "reasoning_text",
        ],
      },
    },
  };
}

export async function buildDailyAirdropTaskRewardPacket({
  accountId,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  maxDailyPft = DEFAULT_MAX_DAILY_PFT,
  maxRewardFraction = dailyAirdropMaxRewardFraction(),
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("daily_airdrop_account_required");
  const to = now instanceof Date ? now : new Date(now);
  const from = new Date(to.getTime() - Math.max(1, Number(lookbackDays || DEFAULT_LOOKBACK_DAYS)) * 24 * 60 * 60 * 1000);
  const walletCloud = await resolveDailyAirdropWalletCloud({ accountId: normalizedAccount });
  const airdropRecipient = await resolveDailyAirdropRecipientWallet({
    accountId: normalizedAccount,
    candidateWallets: walletCloud.wallets,
    activeWalletAddress: walletCloud.activeWalletAddress,
  });
  const walletCloudAddresses = walletCloud.wallets.map((wallet) => String(wallet.address || "").trim()).filter(Boolean);
  const result = await query(
    `WITH reward_events AS (
       SELECT DISTINCT ON (task_id)
              task_id,
              source_tx_hash,
              source_cid,
              occurred_at,
              payload_json
         FROM task_events
        WHERE account_id = $1
          AND event_type = 'pf.reward.v1'
        ORDER BY task_id, occurred_at DESC
     )
     SELECT p.task_id,
            p.subject_wallet,
            p.title,
            p.task_kind,
            p.status,
            p.reward_offer_pft::text AS reward_offer_pft,
            p.reward_actual_pft::text AS reward_paid_pft,
            p.last_event_tx_hash,
            p.last_event_cid,
            p.last_event_at,
            p.updated_at,
            p.metadata_json,
            r.source_tx_hash AS reward_tx_hash,
            r.source_cid AS reward_cid,
            r.occurred_at AS rewarded_at,
            r.payload_json AS reward_payload
       FROM task_projections p
       LEFT JOIN reward_events r ON r.task_id = p.task_id
      WHERE p.account_id = $1
        AND p.subject_wallet = ANY($4::text[])
        AND ${canonicalRewardedTaskProjectionSql("p")}
        AND COALESCE(r.occurred_at, p.last_event_at, p.updated_at) >= $2::timestamptz
        AND COALESCE(r.occurred_at, p.last_event_at, p.updated_at) <= $3::timestamptz
      ORDER BY COALESCE(r.occurred_at, p.last_event_at, p.updated_at) DESC, p.task_id ASC
      LIMIT 80`,
    [normalizedAccount, from.toISOString(), to.toISOString(), walletCloudAddresses]
  );
  const tasks = result.rows.map((row) => {
    const rewardPayload = objectFromValue(row.reward_payload);
    const score = objectFromValue(rewardPayload.reward_score || rewardPayload.score);
    return {
      task_id: row.task_id,
      subject_wallet: safeText(row.subject_wallet, 120),
      title: safeText(row.title, 240),
      kind: safeText(row.task_kind, 80),
      status: safeText(row.status, 80),
      reward_offer_pft: Number(row.reward_offer_pft || 0),
      reward_paid_pft: Number(row.reward_paid_pft || 0),
      reward_decision: safeText(score.decision || rewardPayload.reward_decision || "", 80),
      reward_tier: safeText(rewardPayload.reward_tier || "", 80),
      reward_reason: safeText(score.reason || score.user_feedback || rewardPayload.reward_summary || "", 800),
      evidence_quality: Number(score.evidence_quality || rewardPayload.evidence_quality || 0),
      completion_score: Number(score.completion || rewardPayload.completion || 0),
      rewarded_at: isoDate(row.rewarded_at || row.last_event_at || row.updated_at),
      event_cids: [row.reward_cid || row.last_event_cid].filter(Boolean),
      tx_hashes: [row.reward_tx_hash || row.last_event_tx_hash].filter(Boolean),
    };
  });
  const totalReward = tasks.reduce((sum, task) => sum + Number(task.reward_paid_pft || 0), 0);
  return {
    account_id: normalizedAccount,
    computed_at: to.toISOString(),
    lookback: {
      from: from.toISOString(),
      to: to.toISOString(),
      days: lookbackDays,
    },
    reward_totals: {
      rewarded_task_count: tasks.length,
      total_reward_paid_pft: Number(totalReward.toFixed(6)),
    },
    identity_cloud: {
      account_id: normalizedAccount,
      active_wallet_address: walletCloud.activeWalletAddress || "",
      eligible_wallet_count: walletCloud.wallets.length,
      source: walletCloud.source || "pftl_sync_wallets",
      eligible_wallets: walletCloud.wallets.map((wallet) => ({
        address: wallet.address,
        status: wallet.status,
        sources: wallet.sources || [],
        linked_at: wallet.linkedAt || null,
        updated_at: wallet.updatedAt || null,
      })),
    },
    airdrop_recipient: {
      ...airdropRecipient,
      selection_basis: "identity_cloud_all_time_task_count",
    },
    rewarded_tasks: tasks,
    daily_airdrop_policy: {
      max_daily_pft: maxDailyPft,
      max_reward_fraction: normalizedRewardFraction(maxRewardFraction),
      deterministic_cap_rule: normalizedRewardFraction(maxRewardFraction) === null
        ? "max_daily_pft"
        : "min(max_daily_pft, floor(max_reward_fraction * total_reward_paid_pft))",
      network_value_heuristic:
        "How much would a crypto network rationally pay today to retain this actor as a community member and contributor?",
      no_work_rule: "zero_if_no_positive_rewarded_task_in_lookback",
      scoring_version: PROMPT_VERSION,
    },
  };
}

export function normalizeDailyAirdropOutput(
  output = {},
  packet = {},
  { maxDailyPft = DEFAULT_MAX_DAILY_PFT, maxRewardFraction = dailyAirdropMaxRewardFraction() } = {}
) {
  const totalRewardPaidPft = positiveNumber(packet?.reward_totals?.total_reward_paid_pft);
  const hasPositiveRewards = Number(packet?.reward_totals?.rewarded_task_count || 0) > 0 && totalRewardPaidPft > 0;
  const eligibilityStatus = hasPositiveRewards && output.eligibility_status === "eligible" ? "eligible" : "ineligible";
  const modelAmount = eligibilityStatus === "eligible" ? clampInteger(output.daily_airdrop_pft, 0, maxDailyPft) : 0;
  // Defense in depth: the paid amount can never exceed the deterministic
  // max-daily cap. Operators may additionally opt into a proportional cap with
  // TASKNODE_DAILY_AIRDROP_MAX_REWARD_FRACTION; it is disabled by default so
  // deploying this path does not slash normal airdrops.
  const fraction = normalizedRewardFraction(maxRewardFraction);
  const rewardFractionCapPft = fraction === null
    ? maxDailyPft
    : Math.min(maxDailyPft, Math.floor(totalRewardPaidPft * fraction));
  const amount = Math.min(modelAmount, rewardFractionCapPft);
  return {
    daily_airdrop_pft: amount,
    deterministic_cap: {
      rule: fraction === null
        ? "max_daily_pft"
        : "min(max_daily_pft, floor(max_reward_fraction * total_reward_paid_pft))",
      max_daily_pft: maxDailyPft,
      max_reward_fraction: fraction,
      total_reward_paid_pft: totalRewardPaidPft,
      reward_fraction_cap_pft: rewardFractionCapPft,
      model_daily_airdrop_pft: modelAmount,
      cap_bound: modelAmount > rewardFractionCapPft,
    },
    retention_value_score: eligibilityStatus === "eligible" ? clampInteger(output.retention_value_score, 0, 100) : 0,
    what_raised_today: safeText(output.what_raised_today, 1000),
    what_kept_it_lower: safeText(output.what_kept_it_lower, 1000),
    to_improve_tomorrow: safeText(output.to_improve_tomorrow, 1000),
    eligibility_status: eligibilityStatus,
    eligibility_reason: eligibilityStatus === "eligible" ? null : safeText(output.eligibility_reason || "no_positive_rewarded_task_in_lookback", 300),
    reasoning_text: safeText(output.reasoning_text, 2500),
  };
}

export async function scoreDailyAirdropWithOpenRouter({ packet, promptText, model, maxDailyPft, env = process.env } = {}) {
  const apiKey = openRouterKey(env);
  if (!apiKey) throw new Error("openrouter_api_key_required");
  const order = providerOrder(env);
  const baseUrl = safeText(env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", 400).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": env.OPENROUTER_REFERER || env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
      "x-title": env.OPENROUTER_TITLE || "Task Node Official",
      "x-openrouter-title": env.OPENROUTER_TITLE || "Task Node Official",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: promptText },
        {
          role: "user",
          content: JSON.stringify(
            {
              daily_airdrop_policy: packet.daily_airdrop_policy,
              task_reward_packet: packet,
            },
            null,
            2
          ),
        },
      ],
      provider: {
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
        ...(order.length > 0 ? { order, only: order } : {}),
      },
      temperature: 0,
      max_tokens: 1200,
      response_format: dailyAirdropResponseFormat(maxDailyPft),
      usage: { include: true },
    }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `OpenRouter daily airdrop HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const content = body?.choices?.[0]?.message?.content || "";
  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    output: parseJsonObject(content),
    rawText: content,
    usage: body?.usage || {},
  };
}

export async function runDailyAirdropScore({
  accountId,
  runMode = "dry_run",
  scenarioId = "",
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  maxDailyPft = Number(process.env.TASKNODE_DAILY_AIRDROP_MAX_PFT || DEFAULT_MAX_DAILY_PFT),
  maxRewardFraction = dailyAirdropMaxRewardFraction(),
  model = process.env.TASKNODE_DAILY_AIRDROP_MODEL || DEFAULT_MODEL,
  scoreAttempts = Number(process.env.TASKNODE_DAILY_AIRDROP_SCORE_ATTEMPTS || 2),
  expectedCandidate = null,
  env = process.env,
} = {}) {
  const promptText = loadPrompt(PROMPT_PATH);
  const digest = promptDigest(promptText);
  const packet = await buildDailyAirdropTaskRewardPacket({ accountId, now, lookbackDays, maxDailyPft, maxRewardFraction });
  const expectedRewardedTasks = positiveNumber(expectedCandidate?.rewardedTaskCount);
  const expectedRewardPft = positiveNumber(expectedCandidate?.rewardActualPft);
  const packetRewardedTasks = positiveNumber(packet?.reward_totals?.rewarded_task_count);
  const packetRewardPft = positiveNumber(packet?.reward_totals?.total_reward_paid_pft);
  const packetWalletCount = positiveNumber(packet?.identity_cloud?.eligible_wallet_count);
  if ((expectedRewardedTasks > 0 || expectedRewardPft > 0) && (packetWalletCount === 0 || packetRewardedTasks === 0 || packetRewardPft === 0)) {
    const error = new Error("daily_airdrop_packet_candidate_mismatch");
    error.details = {
      accountId,
      expectedRewardedTasks,
      expectedRewardPft,
      packetWalletCount,
      packetRewardedTasks,
      packetRewardPft,
      walletCloudSource: packet?.identity_cloud?.source || "",
    };
    throw error;
  }
  const inputHash = `sha256:${sha256(packet)}`;
  const run = await createDailyAirdropRun({
    accountId,
    runDate: dateOnly(now),
    runMode,
    scenarioId,
    isCanonical: runMode === "production",
    status: "running",
    inputHash,
    inputSnapshot: packet,
    provider: "openrouter",
    model,
    promptVersion: PROMPT_VERSION,
    promptDigest: digest,
  });
  try {
    const attempts = Math.min(Math.max(Number(scoreAttempts) || 1, 1), 5);
    let response = null;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await scoreDailyAirdropWithOpenRouter({
          packet,
          promptText,
          model,
          maxDailyPft,
          env,
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) throw error;
      }
    }
    if (!response) throw lastError || new Error("daily_airdrop_score_failed");
    const normalized = normalizeDailyAirdropOutput(response.output, packet, { maxDailyPft, maxRewardFraction });
    const airdropWindow = await recentDailyAirdropRunWindow({
      accountId,
      from: packet.lookback.from,
      to: packet.lookback.to,
      includeDryRunId: runMode === "dry_run" ? run.id : "",
      includeDryRunAmount: normalized.daily_airdrop_pft,
      includeDryRunMaxPft: maxDailyPft,
    });
    const actualAirdropPft7d = airdropWindow.actualAirdropPft;
    const maxPossibleAirdropPft7d = Math.max(0, Number(airdropWindow.maxPossibleAirdropPft || 0));
    const alignmentScore7d = maxPossibleAirdropPft7d > 0 ? clampNumber(actualAirdropPft7d / maxPossibleAirdropPft7d, 0, 1) : 0;
    const row = await completeDailyAirdropRun({
      id: run.id,
      output: {
        ...response.output,
        normalized,
        response_id: response.responseId,
        usage: response.usage,
      },
      dailyAirdropPft: normalized.daily_airdrop_pft,
      retentionValueScore: normalized.retention_value_score,
      whatRaisedToday: normalized.what_raised_today,
      whatKeptItLower: normalized.what_kept_it_lower,
      toImproveTomorrow: normalized.to_improve_tomorrow,
      eligibilityStatus: normalized.eligibility_status,
      eligibilityReason: normalized.eligibility_reason,
      reasoningText: normalized.reasoning_text,
      actualAirdropPft7d,
      maxPossibleAirdropPft7d,
      alignmentScore7d,
    });
    await recordUserObservabilityEvent({
      eventType: "user.profile.daily_airdrop_scored",
      accountId: safeText(accountId, 180),
      walletAddress: safeText(packet?.airdrop_recipient?.wallet_address, 120),
      walletScope: packet?.airdrop_recipient?.wallet_address ? "recipient_wallet" : "",
      sourceSurface: "profile",
      sourceRoute: "server/profile-daily-airdrop.js::runDailyAirdropScore",
      resultStatus: normalized.eligibility_status,
      reasonCode: normalized.eligibility_reason || "scored",
      metadata: {
        runId: row?.id || run.id,
        runMode,
        scenarioId: safeText(scenarioId, 120),
        provider: response.provider,
        model: response.model,
        responseId: response.responseId || "",
        promptVersion: PROMPT_VERSION,
        promptDigest: digest,
        inputHash,
      },
      metrics: {
        dailyAirdropPft: normalized.daily_airdrop_pft,
        retentionValueScore: normalized.retention_value_score,
        rewardedTaskCount: Number(packet?.reward_totals?.rewarded_task_count || 0),
        totalRewardPaidPft: Number(packet?.reward_totals?.total_reward_paid_pft || 0),
        actualAirdropPft7d,
        maxPossibleAirdropPft7d,
        alignmentScore7d,
      },
    }).catch(() => {});
    return {
      ok: true,
      run: row,
      packet,
      output: normalized,
      provider: response.provider,
      model: response.model,
      responseId: response.responseId,
      inputHash,
      promptDigest: digest,
    };
  } catch (error) {
    await failDailyAirdropRun({ id: run.id, errorMessage: error?.message || String(error) }).catch(() => null);
    throw error;
  }
}

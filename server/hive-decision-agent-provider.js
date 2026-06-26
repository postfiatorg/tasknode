import { createHash } from "node:crypto";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { hiveDecisionActions, normalizeHiveDecisionOutput } from "./repositories/hive-decision-agent.js";

const defaultOpenRouterBaseUrl = "https://api.openrouter.ai/api/v1";
const fallbackOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const decisionPrompt = loadPrompt("hive/hive_decision_agent_v1.md");

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function openRouterKey() {
  return safeText(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER, 10000);
}

export function hiveDecisionAgentProvider() {
  return "openrouter";
}

export function hiveDecisionAgentModel() {
  return safeText(process.env.TASKNODE_HIVE_DECISION_AGENT_MODEL || process.env.TASKNODE_BOARD_MANAGER_MODEL || "z-ai/glm-5.2", 160);
}

export function hiveDecisionAgentReasoningEffort() {
  return safeText(process.env.TASKNODE_HIVE_DECISION_AGENT_REASONING_EFFORT || "high", 40);
}

function providerTimeoutMs() {
  return Math.min(Math.max(Number(process.env.TASKNODE_HIVE_DECISION_AGENT_TIMEOUT_MS || 240000), 1000), 600000);
}

export function hiveDecisionAgentProviderConfigured() {
  return process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK === "true" || Boolean(openRouterKey());
}

function compactJson(value, maxLength = 140_000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n\n[...middle truncated...]\n\n${text.slice(-Math.floor(maxLength * 0.28))}`;
}

function modelReport(report = null) {
  if (!report) return null;
  return {
    id: safeText(report.id, 180),
    type: safeText(report.type, 80),
    label: safeText(report.label, 120),
    generatedAt: safeText(report.generatedAt, 80),
    model: safeText(report.model, 180),
    bodyMarkdown: safeText(report.bodyMarkdown, 6000),
    bodyMarkdownTruncated: report.bodyMarkdownTruncated === true || String(report.bodyMarkdown || "").length > 6000,
    bodyMarkdownOriginalLength: Number(report.bodyMarkdownOriginalLength || String(report.bodyMarkdown || "").length || 0),
  };
}

function modelTask(task = {}) {
  return {
    taskId: safeText(task.taskId, 180),
    requestId: safeText(task.requestId, 180),
    accountId: safeText(task.accountId, 180),
    walletAddress: safeText(task.walletAddress, 120),
    status: safeText(task.status, 80),
    title: safeText(task.title, 240),
    description: safeText(task.description, 650),
    submissionRequirement: safeText(task.submissionRequirement, 450),
    rewardOfferPft: Number(task.rewardOfferPft || 0),
    rewardActualPft: Number(task.rewardActualPft || 0),
    updatedAt: safeText(task.updatedAt, 80),
    lastEventAt: safeText(task.lastEventAt, 80),
  };
}

function modelDedup(item = {}) {
  return {
    source: safeText(item.source, 80),
    taskId: safeText(item.taskId, 180),
    jobId: safeText(item.jobId, 180),
    requestId: safeText(item.requestId, 180),
    accountId: safeText(item.accountId, 180),
    walletAddress: safeText(item.walletAddress, 120),
    status: safeText(item.status, 80),
    title: safeText(item.title, 240),
    summaryKey: safeText(item.summaryKey, 320),
    active: item.active === true,
    terminal: item.terminal === true,
    updatedAt: safeText(item.updatedAt, 80),
  };
}

function modelSourcePacket(sourcePacket = {}) {
  const reports = safeObject(sourcePacket.reports);
  const liveTaskState = safeObject(sourcePacket.liveTaskState);
  const candidates = safeObject(sourcePacket.candidates);
  const guardrails = safeObject(sourcePacket.guardrails);
  return {
    schema: "pf.hive.decision_agent.model_input.v1",
    sourceSchema: safeText(sourcePacket.schema, 120),
    sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
    version: safeText(sourcePacket.version, 80),
    scope: safeText(sourcePacket.scope, 120),
    trigger: safeText(sourcePacket.trigger, 160),
    generatedAt: safeText(sourcePacket.generatedAt, 80),
    phase: safeText(sourcePacket.phase, 40),
    actionRegistry: safeArray(sourcePacket.actionRegistry),
    routingCritical: {
      copyExactCandidateLaneValues: true,
      routeOnlyToIdleEligibleContributors: guardrails.routeOnlyToIdleEligibleContributors === true,
      structuralDedupRequired: guardrails.structuralDedupRequired === true,
      allCandidateCount: safeArray(candidates.all).length,
      idleEligibleContributorCount: safeArray(candidates.idleEligibleContributors).length,
    },
    candidates: {
      idleEligibleContributors: safeArray(candidates.idleEligibleContributors),
    },
    projects: sourcePacket.projects,
    reports: Object.fromEntries(Object.entries(reports).map(([type, report]) => [type, modelReport(report)])),
    liveTaskState: {
      outstandingNetworkTasks: safeArray(liveTaskState.outstandingNetworkTasks).slice(0, 80).map(modelTask),
      pendingGenerationJobs: safeArray(liveTaskState.pendingGenerationJobs).slice(0, 80),
      recentTerminalNetworkTasks: safeArray(liveTaskState.recentTerminalNetworkTasks).slice(0, 100).map(modelTask),
    },
    boardDiscussions: safeArray(sourcePacket.boardDiscussions).slice(0, 40),
    guardrails: {
      routeOnlyToIdleEligibleContributors: guardrails.routeOnlyToIdleEligibleContributors === true,
      structuralDedupRequired: guardrails.structuralDedupRequired === true,
      shadowOnlyNoMutations: guardrails.shadowOnlyNoMutations === true,
      activeExecutionFeatureFlag: safeText(guardrails.activeExecutionFeatureFlag, 120),
      candidateCapacitySource: safeText(guardrails.candidateCapacitySource, 120),
      dedupIndex: safeArray(guardrails.dedupIndex).slice(0, 260).map(modelDedup),
    },
  };
}

function decisionSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "hive_decision_agent_output",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["explanation", "options_considered", "informed_by", "action", "payload", "confidence"],
        properties: {
          explanation: { type: "string" },
          options_considered: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["action", "summary", "rejected_because"],
              properties: {
                action: { type: "string", enum: hiveDecisionActions },
                summary: { type: "string" },
                rejected_because: { type: "string" },
              },
            },
          },
          informed_by: {
            type: "object",
            additionalProperties: false,
            required: ["report_ids", "task_state_refs", "discussion_ids"],
            properties: {
              report_ids: { type: "array", items: { type: "string" } },
              task_state_refs: { type: "array", items: { type: "string" } },
              discussion_ids: { type: "array", items: { type: "string" } },
            },
          },
          action: { type: "string", enum: hiveDecisionActions },
          payload: {
            type: "object",
            additionalProperties: false,
            required: [
              "project_id",
              "project_title",
              "candidate_account_id",
              "candidate_wallet_address",
              "required_badge_id",
              "operating_badge_id",
              "task_work_type",
              "badge_work_type",
              "title",
              "project_need_summary",
              "project_status",
              "project_summary",
              "key_points",
              "blocked_or_unclear",
              "next_actions",
              "routing_reason",
              "dedup_basis",
              "message_text",
              "cancel_task_id",
              "archive_reason",
              "action_output",
              "delivery_surface",
              "recipient_or_reviewer",
              "escalation_stage",
              "reward_min_pft",
              "reward_max_pft",
              "badge_reward_cap_pft",
            ],
            properties: {
              project_id: { type: "string" },
              project_title: { type: "string" },
              candidate_account_id: { type: "string" },
              candidate_wallet_address: { type: "string" },
              required_badge_id: { type: "string" },
              operating_badge_id: { type: "string" },
              task_work_type: { type: "string" },
              badge_work_type: { type: "string" },
              title: { type: "string" },
              project_need_summary: { type: "string" },
              project_status: { type: "string" },
              project_summary: { type: "string" },
              key_points: { type: "array", items: { type: "string" } },
              blocked_or_unclear: { type: "array", items: { type: "string" } },
              next_actions: { type: "array", items: { type: "string" } },
              routing_reason: { type: "string" },
              dedup_basis: { type: "string" },
              message_text: { type: "string" },
              cancel_task_id: { type: "string" },
              archive_reason: { type: "string" },
              action_output: { type: "string" },
              delivery_surface: { type: "string" },
              recipient_or_reviewer: { type: "string" },
              escalation_stage: { type: "string" },
              reward_min_pft: { type: "number" },
              reward_max_pft: { type: "number" },
              badge_reward_cap_pft: { type: "number" },
            },
          },
          confidence: { type: "number" },
        },
      },
    },
  };
}

function messagesForSource(sourcePacket = {}) {
  const modelPacket = modelSourcePacket(sourcePacket);
  return [
    {
      role: "system",
      content: decisionPrompt,
    },
    {
      role: "user",
      content: [
        "HIVE DECISION SOURCE PACKET",
        "```json",
        compactJson(modelPacket),
        "```",
      ].join("\n"),
    },
  ];
}

function parseJsonOutput(text = "") {
  const trimmed = safeText(text, 500_000);
  if (!trimmed) throw new Error("hive_decision_agent_empty_output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("hive_decision_agent_invalid_json");
  }
}

function openRouterUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

function emptyDecisionPayload() {
  return {
    project_id: "",
    project_title: "",
    candidate_account_id: "",
    candidate_wallet_address: "",
    required_badge_id: "",
    operating_badge_id: "",
    task_work_type: "",
    badge_work_type: "",
    title: "",
    project_need_summary: "",
    project_status: "",
    project_summary: "",
    key_points: [],
    blocked_or_unclear: [],
    next_actions: [],
    routing_reason: "",
    dedup_basis: "",
    message_text: "",
    cancel_task_id: "",
    archive_reason: "",
    action_output: "",
    delivery_surface: "",
    recipient_or_reviewer: "",
    escalation_stage: "",
    reward_min_pft: 0,
    reward_max_pft: 0,
    badge_reward_cap_pft: 0,
  };
}

function parseFallbackDecision({ error } = {}) {
  return normalizeHiveDecisionOutput({
    explanation: "The model response was not valid Decision Agent JSON, so no board mutation can be trusted for this run. The safe action is to do nothing and preserve the raw output for operator audit.",
    options_considered: [
      {
        action: "do_nothing",
        summary: "Reject malformed model output and make no board change.",
        rejected_because: "Selected because execution requires a valid structured action payload.",
      },
    ],
    informed_by: {
      report_ids: [],
      task_state_refs: [],
      discussion_ids: [],
    },
    action: "do_nothing",
    payload: emptyDecisionPayload(),
    confidence: 0,
    parse_error: safeText(error?.message || error, 1200),
  });
}

function mockDecision(sourcePacket = {}) {
  const idle = safeArray(sourcePacket.candidates?.idleEligibleContributors);
  const reports = safeObject(sourcePacket.reports);
  const reportIds = Object.values(reports).map((report) => safeText(report?.id, 180)).filter(Boolean);
  const firstCandidate = idle[0] || null;
  const firstProject = safeArray(sourcePacket.projects?.projects).find((project) => safeText(project.status, 80) === "active") ||
    safeArray(sourcePacket.projects?.projects)[0] ||
    {};
  if (firstCandidate) {
    const requiredBadgeId = firstCandidate.defaultBadge || firstCandidate.verifiedBadges?.[0] || "";
    const taskWorkType = firstCandidate.allowedWorkTypes?.[0] || "capability_gating_task";
    const rewardMaxPft = Number(firstCandidate.rewardCaps?.[taskWorkType] || firstCandidate.badgeDetails?.[0]?.maxPayoutPft || 100);
    return normalizeHiveDecisionOutput({
      explanation: "The reports and live task state show at least one idle badge-eligible contributor. The Decision Agent can route a scoped task only after structural dedup confirms the contributor does not already have matching outstanding or rewarded work.",
      options_considered: [
        {
          action: "create_task",
          summary: "Route one scoped task to an idle eligible contributor.",
          rejected_because: "Selected for shadow evaluation only; server guardrails still validate dedup and capacity.",
        },
        {
          action: "do_nothing",
          summary: "Wait for the old Board Manager cadence.",
          rejected_because: "Rejected because idle eligible capacity exists and Phase 2 specifically tests non-stall routing intelligence.",
        },
      ],
      informed_by: {
        report_ids: reportIds,
        task_state_refs: [firstCandidate.accountId, firstProject.id].filter(Boolean),
        discussion_ids: safeArray(sourcePacket.boardDiscussions).slice(0, 3).map((item) => item.id),
      },
      action: "create_task",
      payload: {
        project_id: firstProject.id || "",
        project_title: firstProject.name || "",
        candidate_account_id: firstCandidate.accountId || "",
        candidate_wallet_address: firstCandidate.walletAddress || "",
        required_badge_id: requiredBadgeId,
        operating_badge_id: requiredBadgeId,
        task_work_type: taskWorkType,
        badge_work_type: taskWorkType,
        title: "Shadow Decision Agent Routing Candidate",
        project_need_summary: firstProject.summary || "Shadow routing candidate generated from report-fed decision inputs.",
        project_status: "",
        project_summary: "",
        key_points: [],
        blocked_or_unclear: [],
        next_actions: [],
        routing_reason: "Idle eligible contributor present; testing non-stall routing guardrail.",
        dedup_basis: "Checked source guardrails dedup index before recording shadow decision.",
        message_text: "",
        cancel_task_id: "",
        archive_reason: "",
        action_output: "Complete the scoped project action and submit direct evidence.",
        delivery_surface: "task_node",
        recipient_or_reviewer: "@goodalexander or the project leader named in the task",
        escalation_stage: "normal",
        reward_min_pft: Math.min(100, rewardMaxPft),
        reward_max_pft: rewardMaxPft,
        badge_reward_cap_pft: rewardMaxPft,
      },
      confidence: 0.66,
    });
  }
  return normalizeHiveDecisionOutput({
    explanation: "The reports were available, but no idle badge-eligible contributor was present in the live candidate snapshot. The correct shadow decision is to avoid routing and preserve the board state.",
    options_considered: [
      {
        action: "create_task",
        summary: "Route work to a contributor.",
        rejected_because: "No idle badge-eligible candidate was present in the source packet.",
      },
      {
        action: "do_nothing",
        summary: "Record no mutation.",
        rejected_because: "Selected because guardrails prevent routing without eligible idle capacity.",
      },
    ],
    informed_by: {
      report_ids: reportIds,
      task_state_refs: [],
      discussion_ids: safeArray(sourcePacket.boardDiscussions).slice(0, 3).map((item) => item.id),
    },
    action: "do_nothing",
    payload: {
      project_id: "",
      project_title: "",
      candidate_account_id: "",
      candidate_wallet_address: "",
      required_badge_id: "",
      operating_badge_id: "",
      task_work_type: "",
      badge_work_type: "",
      title: "",
      project_need_summary: "",
      project_status: "",
      project_summary: "",
      key_points: [],
      blocked_or_unclear: [],
      next_actions: [],
      routing_reason: "",
      dedup_basis: "",
      message_text: "",
      cancel_task_id: "",
      archive_reason: "",
      action_output: "",
      delivery_surface: "",
      recipient_or_reviewer: "",
      escalation_stage: "",
      reward_min_pft: 0,
      reward_max_pft: 0,
      badge_reward_cap_pft: 0,
    },
    confidence: 0.7,
  });
}

export async function fetchHiveDecisionAgentDecision({
  sourcePacket = {},
  model = hiveDecisionAgentModel(),
  reasoningEffort = hiveDecisionAgentReasoningEffort(),
  fetchImpl = fetch,
} = {}) {
  if (process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK === "true") {
    const decision = mockDecision(sourcePacket);
    return {
      decision,
      outputText: JSON.stringify(decision, null, 2),
      provider: "mock",
      model: "mock-hive-decision-agent",
      responseId: `mock_hivedec_${createHash("sha256").update(JSON.stringify(sourcePacket)).digest("hex").slice(0, 16)}`,
      promptDigest: promptDigest(decisionPrompt),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      },
    };
  }
  const apiKey = openRouterKey();
  if (!apiKey) {
    const error = new Error("hive_decision_agent_openrouter_not_configured");
    error.status = 409;
    throw error;
  }
  const baseUrl = (process.env.OPENROUTER_BASE_URL || fallbackOpenRouterBaseUrl || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutMs = providerTimeoutMs();
  let timeout = null;
  const startedAt = Date.now();
  const messages = messagesForSource(sourcePacket);
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("hive_decision_agent_openrouter_timeout"));
      }, timeoutMs);
      timeout.unref?.();
    });
    const response = await Promise.race([fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model,
        messages,
        reasoning: { effort: reasoningEffort },
        response_format: decisionSchema(),
        provider: {
          data_collection: "deny",
          require_parameters: true,
        },
        temperature: 0,
        max_tokens: Math.max(2500, Number(process.env.TASKNODE_HIVE_DECISION_AGENT_MAX_TOKENS || 8000)),
        usage: { include: true },
        metadata: {
          app: "tasknodeofficial",
          worker: "hive_decision_agent",
          prompt_version: "hive_decision_agent_v1",
          source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        },
      }),
    }), timeoutPromise]);
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `OpenRouter Hive Decision Agent HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const outputText = body?.choices?.[0]?.message?.content || "";
    const usage = openRouterUsage(body);
    let decision;
    let parseError = null;
    try {
      decision = normalizeHiveDecisionOutput(parseJsonOutput(outputText));
    } catch (error) {
      parseError = error;
      decision = parseFallbackDecision({ error });
    }
    return {
      decision,
      outputText,
      provider: "openrouter",
      model: safeText(body?.model || model, 180),
      responseId: safeText(body?.id, 200),
      promptDigest: promptDigest(decisionPrompt),
      usage: {
        ...usage,
        parseError: parseError ? safeText(parseError.message || parseError, 1200) : "",
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError" || error?.message === "hive_decision_agent_openrouter_timeout") {
      throw new Error("hive_decision_agent_openrouter_timeout");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

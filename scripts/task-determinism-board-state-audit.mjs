import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPrompt, promptDigest } from "../server/prompt-registry.js";
import { validateTaskgenOutput } from "../server/task-generation-worker.js";
import { AMBIENT_MODELS, ambientChatCompletion, ambientConfigured } from "../server/ambient-inference.js";

const taskId = "task_724460b146babbd93e71cdce425bd0e6";
const evidencePath = path.join(
  "docs",
  "verification",
  "evidence",
  `${taskId}_determinism_board_state_audit.json`
);
const taskgenPromptPath = "task_engine/taskgen_personal_v1.md";
const taskgenPromptVersion = "taskgen_personal_v1";
const taskgenModel = process.env.TASKNODE_TASKGEN_MODEL || AMBIENT_MODELS.structured;

const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "taskgen_output",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        schema: { type: "string", enum: ["pf.taskgen.output.v1"] },
        title: { type: "string" },
        description: { type: "string" },
        task_kind: { type: "string", enum: ["personal", "network", "alpha"] },
        steps: { type: "array", items: { type: "string" } },
        submission_requirement: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"] },
            criteria: { type: "string" },
          },
          required: ["type", "criteria"],
        },
        verification_policy: {
          type: "object",
          additionalProperties: false,
          properties: {
            followup_required: { type: "boolean" },
            mode: { type: "string" },
            verification_type: { type: "string", enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"] },
          },
          required: ["followup_required", "mode", "verification_type"],
        },
        reward_offer: {
          type: "object",
          additionalProperties: false,
          properties: { amount_estimate_pft: { type: "string" } },
          required: ["amount_estimate_pft"],
        },
        deadline: {
          type: "object",
          additionalProperties: false,
          properties: {
            accept_by: { type: "string" },
            deadline_at: { type: ["string", "null"] },
          },
          required: ["accept_by", "deadline_at"],
        },
      },
      required: [
        "schema",
        "title",
        "description",
        "task_kind",
        "steps",
        "submission_requirement",
        "verification_policy",
        "reward_offer",
        "deadline",
      ],
    },
  },
};

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

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function parseJsonObject(text = "") {
  const raw = String(text || "").trim();
  if (!raw.startsWith("```")) return JSON.parse(raw);
  const stripped = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(stripped);
}

function fixture({
  id,
  requestText,
  detail,
  taskKind = "personal",
  context,
  memory = [],
  queue = {},
  networkTask = null,
  rewardMin = taskKind === "personal" ? 0.5 : 10000,
  rewardMax = taskKind === "personal" ? 5 : 50000,
}) {
  const baseQueue = {
    schema: "pf.task.queue_cache.v1",
    groups: {
      outstanding: [],
      pending_verification: [],
      refused: [],
      rewarded: [],
      ...(queue.groups || {}),
    },
    summary: {
      outstanding: 0,
      pending_verification: 0,
      refused: 0,
      rewarded: 0,
      ...(queue.summary || {}),
    },
  };
  return {
    id,
    input: {
      schema: "pf.taskgen.input.v1",
      request_bundle: {
        bundle_id: `audit_bundle_${id}`,
        cid: `ipfs://audit/${id}`,
        digest: `sha256:${sha256(`bundle:${id}`)}`,
      },
      request: {
        request_id: `audit_req_${id}`,
        request_text: requestText,
        user_detail_text: detail,
        requested_task_kind: taskKind,
        source: networkTask ? "network_task" : "audit_fixture",
      },
      context: {
        context_cid: null,
        context_digest: `sha256:${sha256(context)}`,
        summary: context,
      },
      chat: {
        recent_chat_summary: detail,
        relevant_history_summary: safeText(memory.join("; "), 1200),
        recent_messages: [
          {
            role: "user",
            content: requestText,
            created_at: "2026-05-31T00:00:00.000Z",
          },
          {
            role: "assistant",
            content: "I will generate one concrete, verifiable task.",
            created_at: "2026-05-31T00:00:01.000Z",
          },
        ],
        summary: detail,
      },
      memory: {
        deep_memory: memory.map((summary, index) => ({ id: `mem_${id}_${index}`, summary })),
        recent_memory: [],
      },
      task_queue: baseQueue,
      network_task: networkTask,
      wallet: {
        subject_wallet: "rAuditSubjectWallet11111111111111111111",
        allocation_wallet: "rAuditAllocationWallet111111111111111111",
      },
      policy: {
        task_policy_version: networkTask ? "task-policy-network-v1" : "task-policy-minimal-v1",
        reward_policy_version: networkTask ? "network-reward-policy-v1" : "reward-policy-minimal-v1",
        generation_policy_version: networkTask ? "taskgen-policy-network-v1" : "taskgen-policy-minimal-v1",
        task_class: taskKind,
        reward_offer_min_pft: rewardMin,
        reward_offer_max_pft: rewardMax,
        supported_evidence_types: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
      },
    },
  };
}

const fixtures = [
  fixture({
    id: "personal_context_refine",
    requestText: "Give me one task to make my context page useful.",
    detail: "User wants the context page to help them decide what to do next, not become a power tool.",
    context: "North star: ship Task Node beta. Strategy: make context, task generation, Telegram, and Hive board obvious to a new user.",
    memory: ["Context persistence previously failed after UI said Saved."],
  }),
  fixture({
    id: "personal_wallet_gate",
    requestText: "What should I work on if my wallet is locked?",
    detail: "Generate one task that can be completed before wallet-bound submission.",
    context: "User needs deterministic wallet state messaging before asking users to create or submit work.",
    memory: ["Wallet unlock status must distinguish locked, unlock-pending, and unlocked."],
  }),
  fixture({
    id: "personal_telegram",
    requestText: "Make Telegram feel like a real part of the product.",
    detail: "Focus on one verifiable improvement to Telegram response usefulness.",
    context: "Telegram is a key Task Node surface. It should respond with context-aware clarity and avoid insulting users.",
    memory: ["Telegram Discount Thinking failed with provider 402 and needed fallback."],
  }),
  fixture({
    id: "personal_docs_runbook",
    requestText: "Clean up system status runbooks.",
    detail: "Generate one docs task with architecture link verification.",
    context: "Every System Status row should link to a useful architecture page with green/amber/red derivation and repair steps.",
    memory: ["Broken or missing architecture links were previously red for Docs/System Status."],
  }),
  fixture({
    id: "personal_memory_delete",
    requestText: "Make memory deletion auditable.",
    detail: "The output should be a testable task, not broad design.",
    context: "Users can clear memory. They need confidence that private memory actually disappears after refresh.",
    memory: ["Memory tab should not expose packet ids as primary labels."],
  }),
  fixture({
    id: "duplicate_outstanding_guard",
    requestText: "Generate a task for acceptance gate failures.",
    detail: "There is already an outstanding similar task; avoid duplication.",
    context: "Beta acceptance gates cover Telegram, Task Generation, Context Editing, and Hive Board.",
    queue: {
      groups: {
        outstanding: [
          {
            task_id: "task_existing_acceptance_gate",
            title: "Fix Acceptance Gate Failures In Hive Outputs",
            status: "accepted",
          },
        ],
      },
      summary: { outstanding: 1 },
    },
    memory: ["Task generation should avoid duplicate outstanding tasks."],
  }),
  fixture({
    id: "network_reliability_audit",
    requestText: "Network Task",
    detail: "Generate a QA/reliability audit task for board state reporting and determinism.",
    taskKind: "network",
    context: "Network project task_node_reliability_outputs needs evidence-backed fixes for stale board state and task determinism.",
    memory: ["Candidate has a 25,000 PFT reservation rate and accepted a 30,000 PFT task."],
    networkTask: {
      schema: "pf.hive.network_task_request.v1",
      allocation_id: "netalloc_e04b3a9b134f83640934f873c1cab23a",
      generation_job_id: "nettaskjob_e04b3a9b134f83640934f873c1cab23a",
      project_id: "task_node_reliability_outputs",
      project_type: "production_readiness",
      task_class: "network",
      reward_band_pft: { min: 25000, max: 50000 },
      project_need_summary: "Audit determinism and board state integrity with reproducible evidence.",
      routing_reason: "The candidate is eligible, unblocked, and asked for reliability-oriented work at 25k+ PFT.",
    },
    rewardMin: 25000,
    rewardMax: 50000,
  }),
  fixture({
    id: "network_reward_visibility",
    requestText: "Network Task",
    detail: "Generate one task around contributor reward visibility gaps.",
    taskKind: "network",
    context: "The Hive board must make contributor eligibility, capacity, and reward minimums understandable.",
    memory: ["The candidate refused a prior 15,000 PFT task after stating a 25,000 PFT minimum."],
    networkTask: {
      schema: "pf.hive.network_task_request.v1",
      allocation_id: "audit_reward_visibility_alloc",
      generation_job_id: "audit_reward_visibility_job",
      project_id: "contributor_rewards_status_visibility",
      project_type: "reliability",
      task_class: "network",
      reward_band_pft: { min: 25000, max: 50000 },
      project_need_summary: "Clarify why contributors can or cannot receive Network Tasks and what reward band applies.",
      routing_reason: "User confusion about capacity and reservation-rate handling is blocking trust.",
    },
    rewardMin: 25000,
    rewardMax: 50000,
  }),
  fixture({
    id: "alpha_boundary",
    requestText: "Network Task",
    detail: "Generate one alpha task without expanding beta scope.",
    taskKind: "alpha",
    context: "The product must ship the first Task Node loop before expanding into new mocks or side quests.",
    memory: ["Alpha lane was previously empty; avoid broad roadmap tasks."],
    networkTask: {
      schema: "pf.hive.network_task_request.v1",
      allocation_id: "audit_alpha_alloc",
      generation_job_id: "audit_alpha_job",
      project_id: "task_node_alpha_boundary",
      project_type: "alpha_generation",
      task_class: "alpha",
      reward_band_pft: { min: 10000, max: 30000 },
      project_need_summary: "Define a bounded alpha task that supports the beta task loop.",
      routing_reason: "The board needs alpha work only if it tightens the current beta loop.",
    },
    rewardMin: 10000,
    rewardMax: 30000,
  }),
  fixture({
    id: "verification_followup",
    requestText: "Create a task that requires evidence after a reviewer asks for more proof.",
    detail: "The task should make follow-up verification easy and not require unsupported evidence.",
    context: "Task review should move through submitted, verification requested, response submitted, and rewarded without ambiguous state.",
    memory: ["Reviewers requested screenshots or file excerpts for prior docs tasks."],
  }),
];

function outputExcerpt(output = {}) {
  return {
    title: output.title,
    task_kind: output.task_kind,
    reward: output.reward_offer?.amount_estimate_pft,
    submission_type: output.submission_requirement?.type,
    verification_type: output.verification_policy?.verification_type,
    step_count: Array.isArray(output.steps) ? output.steps.length : 0,
    first_step: output.steps?.[0] || "",
  };
}

function diffOutputs(a = {}, b = {}) {
  const fields = [
    ["title", a.title, b.title],
    ["task_kind", a.task_kind, b.task_kind],
    ["description", a.description, b.description],
    ["steps", stableJson(a.steps || []), stableJson(b.steps || [])],
    ["submission_requirement.type", a.submission_requirement?.type, b.submission_requirement?.type],
    ["submission_requirement.criteria", a.submission_requirement?.criteria, b.submission_requirement?.criteria],
    ["verification_policy", stableJson(a.verification_policy || {}), stableJson(b.verification_policy || {})],
    ["reward_offer.amount_estimate_pft", a.reward_offer?.amount_estimate_pft, b.reward_offer?.amount_estimate_pft],
    ["deadline", stableJson(a.deadline || {}), stableJson(b.deadline || {})],
  ];
  return fields
    .filter(([, left, right]) => left !== right)
    .map(([field, left, right]) => ({
      field,
      runA: safeText(left, 800),
      runB: safeText(right, 800),
    }));
}

async function callTaskgen(taskInput, systemPrompt) {
  const startedAt = Date.now();
  const result = await ambientChatCompletion({ capability: "strict_json", body: {
      model: taskgenModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.\n\n${stableJson(taskInput)}`,
        },
      ],
      response_format: responseFormat,
    } });
  const rawContent = result.text;
  const output = validateTaskgenOutput(parseJsonObject(rawContent), taskInput.policy || {});
  return {
    responseId: result.id || "",
    latencyMs: Date.now() - startedAt,
    output,
    outputDigest: sha256(output),
    excerpt: outputExcerpt(output),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, error: safeText(text, 1000) };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, error: "json_parse_failed", text: safeText(text, 1000) };
  }
}

async function captureLiveBoardState() {
  const [systemStatus, hiveContext] = await Promise.all([
    fetchJson("https://tasknodeofficial-dev.fly.dev/api/system/status"),
    fetchJson("https://tasknodeofficial-dev.fly.dev/api/hive/context?limit=20"),
  ]);
  const categories = Array.isArray(systemStatus.categories) ? systemStatus.categories : [];
  const systemRows = categories.flatMap((category) => {
    const items = Array.isArray(category.items) ? category.items : [];
    return items.map((item) => ({
      category: category.id,
      id: item.id,
      status: item.status,
      label: item.label,
      lastRunAt: item.lastRunAt || item.last_run_at || "",
      summary: item.summary || item.description || "",
    }));
  });
  const feed = Array.isArray(hiveContext?.boardManager?.feed) ? hiveContext.boardManager.feed : [];
  return {
    systemStatus: {
      ok: systemStatus.ok,
      generatedAt: systemStatus.generatedAt,
      summary: systemStatus.summary,
      rows: systemRows,
    },
    boardManagerFeed: {
      logMode: hiveContext?.boardManager?.logMode || "",
      logsAvailable: Boolean(hiveContext?.boardManager?.logsAvailable),
      entries: feed.slice(0, 12).map((run) => ({
        runId: run.runId || run.id,
        action: run.action,
        state: run.state,
        status: run.status,
        trigger: run.trigger,
        completedAt: run.completedAt,
        summary: run.summary,
        reason: run.reason,
        hasDetails: Boolean(run.details),
      })),
    },
  };
}

async function main() {
  if (!ambientConfigured()) {
    throw new Error("AMBIENT_API_KEY required before running live audit");
  }
  const systemPrompt = loadPrompt(taskgenPromptPath);
  const runs = [];
  for (const item of fixtures) {
    const inputDigest = sha256(item.input);
    const first = await callTaskgen(item.input, systemPrompt);
    const second = await callTaskgen(item.input, systemPrompt);
    runs.push({
      id: item.id,
      inputDigest,
      sameInput: inputDigest === sha256(item.input),
      runA: first,
      runB: second,
      deterministicOutput: first.outputDigest === second.outputDigest,
      differences: diffOutputs(first.output, second.output),
    });
    console.log(`${item.id}: ${first.outputDigest === second.outputDigest ? "same" : "different"}`);
  }
  const liveBoardState = await captureLiveBoardState();
  const evidence = {
    schema: "tasknode.determinism_board_state_audit.v1",
    taskId,
    generatedAt: new Date().toISOString(),
    environment: {
      repoPath: process.cwd(),
      appUrl: "https://tasknodeofficial-dev.fly.dev/",
      provider: "ambient_chat_completions",
      model: taskgenModel,
      promptVersion: taskgenPromptVersion,
      promptDigest: promptDigest(systemPrompt),
      responseFormat: "strict_json_schema",
      temperatureSet: false,
      seedSet: false,
      liveTaskPublishing: false,
    },
    pairedRuns: runs,
    summary: {
      fixtureCount: runs.length,
      pairCount: runs.length,
      deterministicPairs: runs.filter((run) => run.deterministicOutput).length,
      nonDeterministicPairs: runs.filter((run) => !run.deterministicOutput).length,
      parseFailures: 0,
    },
    liveBoardState,
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    evidencePath,
    summary: evidence.summary,
    boardStatus: liveBoardState.systemStatus.summary,
    latestBoardSummary: liveBoardState.boardManagerFeed.entries[0]?.summary || "",
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

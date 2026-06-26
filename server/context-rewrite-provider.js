const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const defaultTimeoutMs = 20 * 60 * 1000;
const defaultScoreTimeoutMs = 12 * 60 * 1000;
const defaultSearchTimeoutMs = 5 * 60 * 1000;
const defaultFinalTimeoutMs = 45 * 60 * 1000;

function envInt(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function timeoutDisableAllowed() {
  if (process.env.CONTEXT_REWRITE_ALLOW_UNSAFE_NO_TIMEOUT === "true") return true;
  const environment = String(process.env.NODE_ENV || process.env.TASKNODE_ENV || "").trim().toLowerCase();
  return environment !== "production";
}

function envTimeoutMs(name, fallback = defaultTimeoutMs) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (["0", "none", "false", "off", "no"].includes(raw)) {
    return timeoutDisableAllowed() ? 0 : fallback;
  }
  return envInt(name, fallback, 5000, 86_400_000);
}

function stageTimeoutMs(stageEnvName, fallback = defaultTimeoutMs) {
  return envTimeoutMs(stageEnvName, envTimeoutMs("CONTEXT_REWRITE_PROVIDER_TIMEOUT_MS", fallback));
}

export function contextRewriteStageTimeoutMs(stage = "") {
  const normalized = String(stage || "").trim();
  if (normalized.startsWith("score")) return stageTimeoutMs("CONTEXT_REWRITE_SCORE_TIMEOUT_MS", defaultScoreTimeoutMs);
  if (normalized.startsWith("research")) return stageTimeoutMs("CONTEXT_REWRITE_SEARCH_TIMEOUT_MS", defaultSearchTimeoutMs);
  if (normalized === "polish_rewrite") {
    return stageTimeoutMs("CONTEXT_REWRITE_POLISH_TIMEOUT_MS", stageTimeoutMs("CONTEXT_REWRITE_FINAL_TIMEOUT_MS", defaultFinalTimeoutMs));
  }
  if (normalized === "final_rewrite") return stageTimeoutMs("CONTEXT_REWRITE_FINAL_TIMEOUT_MS", defaultFinalTimeoutMs);
  return stageTimeoutMs("CONTEXT_REWRITE_PROVIDER_TIMEOUT_MS", defaultTimeoutMs);
}

function openRouterKey() {
  return String(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER || "")
    .trim()
    .replace(/^['"‘’]+|['"‘’]+$/g, "");
}

function baseUrl() {
  return (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
}

function referer() {
  return (
    process.env.OPENROUTER_REFERER ||
    process.env.TASKNODE_PUBLIC_URL ||
    process.env.VITE_SITE_ORIGIN ||
    "https://tasknodeofficial-dev.fly.dev"
  );
}

function title() {
  return process.env.OPENROUTER_TITLE || "Task Node Official";
}

function headerValue(value = "", fallback = "") {
  const normalized = String(value || fallback || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  return normalized || fallback;
}

function providerOrderFromEnv(name = "") {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function providerPreferences({ modelFamily = "", requireParameters = true } = {}) {
  const family = String(modelFamily || "").toLowerCase();
  const order =
    family === "glm"
      ? providerOrderFromEnv("CONTEXT_REWRITE_GLM_OPENROUTER_PROVIDERS")
      : family === "deepseek"
        ? providerOrderFromEnv("CONTEXT_REWRITE_DEEPSEEK_OPENROUTER_PROVIDERS")
        : providerOrderFromEnv("CONTEXT_REWRITE_OPENROUTER_PROVIDERS");
  const provider = {
    zdr: true,
    data_collection: "deny",
  };
  if (requireParameters) provider.require_parameters = true;
  if (order.length > 0) {
    provider.order = order;
    provider.only = order;
  }
  return provider;
}

function outputTextFromOpenRouter(body = {}) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || "").filter(Boolean).join("\n").trim();
  }
  return "";
}

function annotationsFromOpenRouter(body = {}) {
  const message = body?.choices?.[0]?.message || {};
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  return annotations
    .map((annotation) => {
      const citation = annotation?.url_citation || annotation?.citation || annotation;
      return {
        type: annotation?.type || "url_citation",
        title: String(citation?.title || "").trim().slice(0, 220),
        url: String(citation?.url || "").trim().slice(0, 1000),
        content: String(citation?.content || citation?.snippet || "").trim().slice(0, 1200),
      };
    })
    .filter((item) => item.url || item.title || item.content)
    .slice(0, 8);
}

export function contextRewriteModels() {
  return {
    glm: process.env.CONTEXT_REWRITE_GLM_MODEL || "z-ai/glm-5.2",
    deepseek: process.env.CONTEXT_REWRITE_DEEPSEEK_MODEL || "deepseek/deepseek-v4-pro",
    final: process.env.CONTEXT_REWRITE_FINAL_MODEL || process.env.CONTEXT_REWRITE_GLM_MODEL || "z-ai/glm-5.2",
    polish:
      process.env.CONTEXT_REWRITE_POLISH_MODEL ||
      process.env.CONTEXT_REWRITE_FINAL_MODEL ||
      process.env.CONTEXT_REWRITE_GLM_MODEL ||
      "z-ai/glm-5.2",
    research: process.env.CONTEXT_REWRITE_RESEARCH_MODEL || "openai/gpt-5.4-mini",
  };
}

export function contextRewriteProviderConfigured() {
  if (process.env.CONTEXT_REWRITE_PROVIDER_MOCK === "true") return true;
  return Boolean(openRouterKey());
}

export function contextRewriteEstimateUsd() {
  const configured = Number(process.env.CONTEXT_REWRITE_ESTIMATE_USD);
  const value = Number.isFinite(configured) && configured > 0 ? configured : 0.5;
  return Number(value.toFixed(6));
}

function usageFromOpenRouter(body = {}, { webSearchCalls = 0 } = {}) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens || 0);
  const costUsd = Number(usage.cost || usage.total_cost || 0);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    webSearchCalls,
    toolCostUsd: 0,
    costUsd: Number.isFinite(costUsd) ? Number(costUsd.toFixed(6)) : 0,
    raw: usage,
  };
}

function parseJsonText(text = "", errorCode = "context_rewrite_invalid_json") {
  const raw = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    const error = new Error(errorCode);
    error.rawText = raw.slice(0, 1200);
    throw error;
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function fetchOpenRouter(body, { timeoutMs = defaultTimeoutMs } = {}) {
  const useTimeout = Number(timeoutMs || 0) > 0;
  const controller = useTimeout ? new AbortController() : null;
  const timeout = useTimeout ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      signal: controller?.signal,
      headers: {
        authorization: `Bearer ${openRouterKey()}`,
        "content-type": "application/json",
        "http-referer": headerValue(referer(), "https://tasknodeofficial-dev.fly.dev"),
        "x-title": headerValue(title(), "Task Node Official"),
        "x-openrouter-title": headerValue(title(), "Task Node Official"),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("context_rewrite_provider_timeout");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const error = new Error("context_rewrite_provider_failed");
    error.status = response.status;
    error.providerMessage =
      parsed?.error?.message || parsed?.message || text || `OpenRouter returned HTTP ${response.status}`;
    throw error;
  }
  return parsed;
}

function commonRequest({
  model,
  modelFamily = "",
  system,
  user,
  maxTokens,
  temperature = 0,
  json = true,
  tools = [],
  reasoningEffort = "none",
  includeProvider = true,
} = {}) {
  const body = {
    model,
    messages: [
      { role: "system", content: String(system || "") },
      { role: "user", content: String(user || "") },
    ],
    reasoning: {
      effort: reasoningEffort || "none",
      exclude: true,
    },
    temperature,
    max_tokens: maxTokens,
    usage: { include: true },
  };
  if (includeProvider) {
    body.provider = providerPreferences({ modelFamily, requireParameters: true });
  }
  if (json) body.response_format = { type: "json_object" };
  if (tools.length > 0) body.tools = tools;
  return body;
}

function mockScore({ modelFamily = "glm", runIndex = 1 } = {}) {
  const base = modelFamily === "deepseek" ? 8.2 : 9.1;
  const drift = Math.min(1.2, Math.max(0, Number(runIndex || 1) * 0.25));
  const scores = {
    human_readability: base + 0.6,
    not_prompt_guide: base + 0.1,
    urgency: base - 1.5 + drift,
    values_clarity: base + 0.2,
    strategy_clarity: base - 1.1,
    milestone_map: base - 1.4,
    task_history_interpretation: base - 1.8,
    markdown_renderability: base + 1.4,
    best_practice_grounding: base - 2.0,
    jobs_business_wisdom: base - 1.7,
    concision: base - 1.2,
    no_disclaimer_drift: base + 1.1,
    source_grounding: base - 0.6,
    specificity: base - 0.9,
    downstream_task_utility: base - 1.0,
  };
  const scoreTotal = Object.values(scores).reduce((sum, value) => sum + value, 0) / Object.keys(scores).length;
  return {
    schema: "context_rewrite.score.v1",
    score_total: Number(scoreTotal.toFixed(1)),
    band: scoreTotal >= 10 ? "10-15" : scoreTotal >= 5 ? "5-10" : "0-5",
    scores,
    strengths: ["The document contains real operating context and enough specifics to preserve."],
    weaknesses: [
      "Strategy and milestone maps are not sharp enough for downstream task decisions.",
      "Task history is not consistently interpreted into values, constraints, and follow-through patterns.",
      "Best-practice grounding and Jobs-style focus are underused.",
    ],
    rewrite_priorities: [
      "Turn scattered current work into a short strategy with explicit tradeoffs.",
      "Convert task history into evidence about what the user rewards and completes.",
      "Add a milestone map that makes urgent next actions legible.",
    ],
    research_requests: [
      {
        question: "goal hierarchy implementation intentions milestone planning research",
        why_it_matters: "Improves strategy-to-tactic flow without becoming a task ledger.",
      },
      {
        question: "startup product focus tradeoffs customer clarity best practices",
        why_it_matters: "Sharpens Jobs-style focus and customer clarity.",
      },
    ],
    task_history_interpretation:
      "Use rewarded and completed work as evidence of operating values, capability, and follow-through; do not repeat task rows.",
    jobs_business_wisdom:
      "Make the document say no to distracting work so the essential product loop becomes obvious.",
    risk_flags: ["repetition", "weak_best_practice_grounding"],
  };
}

function mockFinal({ sourcePacket = {}, aggregateScore = {}, jobsRetrieval = {} } = {}) {
  const currentTitle = sourcePacket?.current_context?.title || "Task Node Context";
  const jobLine = Array.isArray(jobsRetrieval?.chunks) && jobsRetrieval.chunks.length
    ? "Use focus, taste, and craft as operating constraints: the important work should become obvious, and the merely interesting work should wait."
    : "Use focus, taste, and craft as operating constraints: the important work should become obvious, and the merely interesting work should wait.";
  const markdown = [
    `# ${currentTitle}`,
    "",
    "## Operating Urgency",
    "The next cycle needs fewer live priorities, clearer proof of progress, and tighter conversion from strategy into shipped work. Do not let a broad context document make Task Node generate broad tasks.",
    "",
    "## Values",
    "- Focus over breadth: keep the work small enough that the next useful loop can ship.",
    "- Craft over volume: hidden implementation quality matters because rough internals eventually surface as user pain.",
    "- Evidence over theater: completed and rewarded tasks matter as signals, but they should not be recopied into the document.",
    "",
    "## Strategy",
    "Build the smallest complete Task Node operating loop that makes the user's current context, task history, and chat history improve future task decisions. Strategy should reject stale work, collapse duplicated priorities, and make the next milestone testable.",
    "",
    "The document should behave like an operating brief for a serious builder. It should make the active bet clear, make the rejected work explicit enough that Task Node does not keep reviving it, and connect values to tactics without turning into a prompt manual. The practical test is whether a future task request can be judged quickly: does it advance the current operating cycle, does it create proof, and does it preserve the quality bar that the user repeatedly rewards?",
    "",
    "A strong rewrite should also absorb the best external know-how instead of reinventing basic workflow practice. Goal hierarchy, implementation intentions, and milestone planning should show up as simple operating structure: one active outcome, a small number of near-term commitments, concrete evidence for completion, and a review loop that changes the document when reality changes. Product focus should show up as restraint. Steve Jobs' lesson is not decorative minimalism; it is the discipline to make the essential thing obvious by cutting work that competes for attention.",
    "",
    "## Current State",
    "The current context carries enough real source material to be useful, but it needs a stronger hierarchy. The user is not asking Task Node to admire a pile of facts. They need the facts converted into operating judgment: what matters now, what is no longer worth carrying, what constraints should govern new work, and what kind of artifact proves progress. Memory, chat history, profile, and task outcomes should be treated as evidence about repeated preferences and successful patterns rather than as text to be copied forward.",
    "",
    "The immediate risk is sprawl. A context document can become long while still being weak if every task, idea, or old ambition gets equal weight. The rewrite should preserve concrete facts and urgency, but it should compress repeated ideas into sharper decision rules. When two passages say the same thing, keep the one that helps the next task decision. When a passage is vivid but no longer strategically active, move its lesson into a constraint or drop it.",
    "",
    "## Milestone Map",
    "1. Clarify the current operating cycle and name the one outcome that matters most.",
    "2. Convert rewarded task patterns into decision rules for what Task Node should generate next.",
    "3. Ship one complete loop, then use real completion evidence to revise the context.",
    "4. Review the resulting artifacts against the values in this document before adding more work.",
    "5. Update the context only when new evidence changes strategy, constraints, or the milestone map.",
    "",
    "The milestone map should be tactical without becoming a task ledger. It should say what kind of proof is needed, why that proof matters, and how the next milestone flows from the strategy. It should not list every historical task. Completed and rewarded work should appear as interpreted evidence: the user rewards concrete artifacts, directness, working software, visible verification, and execution that closes the loop.",
    "",
    "## Decision Rules",
    "- If a task does not support the active strategy, defer it.",
    "- If a priority cannot be verified by a concrete artifact, tighten it before generating work.",
    "- If the context starts sounding like instructions to an AI, rewrite it as human operating judgment.",
    "- If a proposed rewrite makes the document shorter by deleting substance, reject it; remove repetition, not facts.",
    "- If a best practice is relevant, translate it into a workflow rule rather than citing it as decoration.",
    "",
    "## Product And Workflow Context",
    "Task Node should use this document to generate better work, not more work. The strongest outputs will usually be narrow, inspectable, and tied to a real operating surface: a doc update, a testable implementation step, a verification run, a product decision, or a milestone review. The context should help the system notice when a request is too vague and push it toward a concrete artifact.",
    "",
    "The workflow should prefer source-grounded decisions. Chat history gives recent intent, memory gives recurring patterns, task history gives proof of what was actually completed or rewarded, and network profile data gives context about how the user operates in broader task networks. Those sources should not be flattened into one undifferentiated summary. Each source has a job: intent, pattern, proof, or operating style.",
    "",
    "## Best Practice Grounding",
    "Use goal hierarchy to keep the document from treating every ambition as active. Use implementation intentions to connect milestones to observable next actions. Use product strategy practice to state tradeoffs and customer clarity. Use Jobs-style focus to remove the merely interesting. The end product should feel like a document a capable human would want to reread before deciding what to do next.",
    "",
    "Good context is not maximal context. It is selected context. The rewrite should make it easier for Task Node to say no, ask for specificity, or produce a concrete next task. It should create enough shared judgment that future chats can move faster without relying on hidden assumptions.",
    "",
    "## Jobs Standard",
    jobLine,
    "",
    "Jobs-style focus means the rewrite should have taste. Taste here means clear hierarchy, fewer live priorities, strong defaults, and respect for craft. The back of the fence matters: if the context is sloppy, repetitive, or evasive, that sloppiness will surface in generated tasks. The document should make quality operational by naming what proof looks like and by refusing unfocused work.",
    "",
    "## What Task Node Should Preserve",
    "- Urgency from the user's current chat instructions.",
    "- Strategic constraints from the context document.",
    "- Evidence from completed and rewarded tasks, interpreted into patterns rather than repeated.",
    "- Relevant best practices from research, used only as operating wisdom.",
    "",
    "## Open Questions For The Next Rewrite",
    "- Which current milestone is the highest-leverage proof point for the next operating cycle?",
    "- Which old priorities should be explicitly retired so they do not keep reappearing as suggested tasks?",
    "- Which repeated task outcomes reveal the user's real quality bar, and how should that bar constrain future work?",
    "",
    "## What Task Node Should Generate Next",
    "Generate work that closes a loop. Prefer tasks that produce a reviewable artifact, expose a real product or workflow decision, or sharpen the context with new evidence. Avoid generic brainstorming, motivational filler, and rewrites that merely rearrange text. The next task should make the user's strategy easier to execute or easier to falsify.",
    "",
    "## Operating Cadence",
    "The cadence should be simple enough to survive contact with real work. Start each cycle by naming the active strategic outcome and the proof that would make it true. During the cycle, accept only work that creates that proof or removes a direct blocker to it. At the end of the cycle, revise the context based on what shipped, what failed, and what the task history now proves about the user's operating pattern.",
    "",
    "This cadence matters because context documents decay when they become museums. A good document should preserve durable values, current constraints, and the next strategic map, but it should not preserve every abandoned branch. The user needs the document to make future Task Node behavior sharper. That means the rewrite must include enough detail to keep judgment grounded while still making the hierarchy obvious.",
    "",
    "The review loop should ask four questions. First, did the last milestone produce an artifact that can be inspected? Second, did the artifact change the strategy, or did it merely confirm the current direction? Third, did any completed or rewarded task reveal a stronger decision rule? Fourth, what should Task Node stop suggesting because it no longer fits the active strategy? These questions keep the context alive without turning it into a diary.",
    "",
    "## Quality Bar",
    "The quality bar is directness, specificity, and proof. The rewrite should use plain language that a human can scan under pressure. It should name real work, real constraints, and real tradeoffs. It should not hide behind abstract productivity language. If a sentence cannot change a future task decision, it should be cut, merged, or rewritten until it carries weight.",
    "",
    "The strongest version of the document will make downstream work faster because the hard choices have already been made. Task Node should be able to look at the context and understand what kind of request is worth generating, what kind of request should be narrowed, and what kind of request should be refused or deferred. That is the point of the full rewrite: not prettier prose, but better operating judgment.",
    "",
    "## Anti-Sprawl Rules",
    "Do not let the context become a place where every idea receives permanent residency. Ideas earn space by changing strategy, changing a milestone, changing a decision rule, or preserving a source fact that future work will need. Everything else should be summarized into a lesson or removed. This is how the document remains substantial without becoming noisy.",
    "",
    "When the user asks for a new task, Task Node should compare it against the active strategy before treating it as executable. If the request is aligned, generate a concrete task with a reviewable artifact. If it is adjacent but underspecified, ask for the missing constraint. If it is outside the active cycle, name the tradeoff and defer it. The context should make those choices feel obvious.",
    "",
    "The same rule applies to rewrites. A rewrite is not better because it is shorter, smoother, or more enthusiastic. It is better when it preserves the facts that matter, removes duplicated weight, clarifies what is urgent, and gives Task Node a stronger basis for future decisions. Substance stays; repetition goes.",
  ].join("\n");
  return {
    schema: "context_rewrite.final.v1",
    title: currentTitle,
    markdown,
    metadata: {
      summary: "Mock Context Rewrite artifact generated from the sample orchestration path.",
      jobs_principles: ["focus", "taste", "craft"],
      research_used: (aggregateScore?.research_requests || []).slice(0, 2).map((item) => item.question || item),
      source_caveats: [],
    },
  };
}

function mockPolish({ draftMarkdown = "", draftMetadata = {} } = {}) {
  const markdown = String(draftMarkdown || "").trim();
  return {
    schema: "context_rewrite.polish.v1",
    title: draftMetadata.title || "Context Rewrite",
    markdown,
    metadata: {
      summary: draftMetadata.summary || "Mock Context Rewrite polish pass preserved the rewritten artifact.",
      polish_focus: ["readability", "persuasion", "flow"],
      removed_repetition: [],
      source_caveats: draftMetadata.source_caveats || [],
    },
  };
}

export async function runContextRewriteScoreCall({
  modelFamily = "glm",
  model,
  systemPrompt = "",
  sourcePacket = {},
  runIndex = 1,
  decorrelation = "",
} = {}) {
  if (process.env.CONTEXT_REWRITE_PROVIDER_MOCK === "true") {
    const parsed = mockScore({ modelFamily, runIndex });
    return {
      provider: "mock",
      model: model || modelFamily,
      responseId: `mock_score_${modelFamily}_${runIndex}`,
      text: JSON.stringify(parsed),
      parsed,
      annotations: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, webSearchCalls: 0, toolCostUsd: 0, costUsd: 0 },
    };
  }

  const maxTokens = envInt("CONTEXT_REWRITE_SCORE_MAX_TOKENS", 8192, 1024, 60000);
  const body = await fetchOpenRouter(
    commonRequest({
      model,
      modelFamily,
      system: systemPrompt,
      user: JSON.stringify({
        schema: "context_rewrite.score_input.v1",
        run_index: runIndex,
        decorrelation,
        source_packet: sourcePacket,
      }),
      maxTokens,
      temperature: 0.15,
      json: true,
      reasoningEffort: process.env.CONTEXT_REWRITE_SCORE_REASONING_EFFORT || "none",
    }),
    { timeoutMs: stageTimeoutMs("CONTEXT_REWRITE_SCORE_TIMEOUT_MS", defaultScoreTimeoutMs) }
  );
  const text = outputTextFromOpenRouter(body);
  if (!text) throw new Error("context_rewrite_score_empty_response");
  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    parsed: parseJsonText(text, "context_rewrite_score_invalid_json"),
    annotations: annotationsFromOpenRouter(body),
    usage: usageFromOpenRouter(body),
  };
}

export async function runContextRewriteSearchCall({ model, query = "", index = 0 } = {}) {
  if (process.env.CONTEXT_REWRITE_PROVIDER_MOCK === "true") {
    const parsed = {
      schema: "context_rewrite.search_result.v1",
      query,
      summary: `Mock research summary for ${query}.`,
      sources: [
        {
          title: "Goal hierarchy and implementation intentions",
          url: "https://example.test/goal-hierarchy",
          snippet: "Goal hierarchy works best when milestones connect to a small number of strategic outcomes.",
        },
        {
          title: "Product focus and customer clarity",
          url: "https://example.test/product-focus",
          snippet: "Product strategy improves when teams say no to attractive work that does not advance the customer loop.",
        },
      ],
    };
    return {
      provider: "mock",
      model: model || "mock-search",
      responseId: `mock_search_${index}`,
      text: JSON.stringify(parsed),
      parsed,
      annotations: parsed.sources,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, webSearchCalls: 1, toolCostUsd: 0, costUsd: 0 },
    };
  }

  const maxTokens = envInt("CONTEXT_REWRITE_SEARCH_MAX_TOKENS", 3000, 512, 12000);
  const engine = String(process.env.CONTEXT_REWRITE_SEARCH_ENGINE || "exa").trim() || "exa";
  const maxResults = envInt("CONTEXT_REWRITE_SEARCH_MAX_RESULTS", 3, 1, 10);
  const body = await fetchOpenRouter(
    commonRequest({
      model,
      modelFamily: "research",
      system:
        "Run web search for the specific question provided. Do not request, infer, or use private source context. Summarize only general best practices relevant to improving a context operating document. Return JSON only.",
      user: JSON.stringify({
        schema: "context_rewrite.search_request.v1",
        query,
      }),
      maxTokens,
      temperature: 0,
      json: true,
      tools: [
        {
          type: "openrouter:web_search",
          parameters: {
            engine,
            max_results: maxResults,
            max_total_results: maxResults,
            search_context_size: process.env.CONTEXT_REWRITE_SEARCH_CONTEXT_SIZE || "low",
          },
        },
      ],
      reasoningEffort: "none",
      includeProvider: false,
    }),
    { timeoutMs: stageTimeoutMs("CONTEXT_REWRITE_SEARCH_TIMEOUT_MS", defaultSearchTimeoutMs) }
  );
  const text = outputTextFromOpenRouter(body);
  const annotations = annotationsFromOpenRouter(body);
  if (!text && annotations.length === 0) throw new Error("context_rewrite_search_empty_response");
  if (!text) {
    const parsed = {
      schema: "context_rewrite.search_result.v1",
      query,
      summary: annotations
        .map((item) => item.content || item.title)
        .filter(Boolean)
        .slice(0, 3)
        .join(" "),
      sources: annotations.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
      })),
    };
    return {
      provider: "openrouter",
      model: body?.model || model,
      responseId: body?.id || null,
      text: JSON.stringify(parsed),
      parsed,
      annotations,
      usage: usageFromOpenRouter(body, { webSearchCalls: 1 }),
    };
  }
  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    parsed: parseJsonText(text, "context_rewrite_search_invalid_json"),
    annotations,
    usage: usageFromOpenRouter(body, { webSearchCalls: 1 }),
  };
}

export async function runContextRewriteFinalCall({
  model,
  systemPrompt = "",
  sourcePacket = {},
  aggregateScore = {},
  researchResults = [],
  jobsRetrieval = {},
} = {}) {
  if (process.env.CONTEXT_REWRITE_PROVIDER_MOCK === "true") {
    const parsed = mockFinal({ sourcePacket, aggregateScore, jobsRetrieval });
    return {
      provider: "mock",
      model: model || "mock-final",
      responseId: "mock_final_context_rewrite",
      text: JSON.stringify(parsed),
      parsed,
      annotations: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, webSearchCalls: 0, toolCostUsd: 0, costUsd: 0 },
    };
  }

  const maxTokens = envInt("CONTEXT_REWRITE_FINAL_MAX_TOKENS", 24000, 4096, 60000);
  const body = await fetchOpenRouter(
    commonRequest({
      model,
      modelFamily: "glm",
      system: systemPrompt,
      user: JSON.stringify({
        schema: "context_rewrite.final_input.v1",
        source_packet: sourcePacket,
        aggregate_score: aggregateScore,
        research_results: researchResults,
        jobs_retrieval: jobsRetrieval,
      }),
      maxTokens,
      temperature: 0.2,
      json: true,
      reasoningEffort: process.env.CONTEXT_REWRITE_FINAL_REASONING_EFFORT || "high",
    }),
    { timeoutMs: stageTimeoutMs("CONTEXT_REWRITE_FINAL_TIMEOUT_MS", defaultFinalTimeoutMs) }
  );
  const text = outputTextFromOpenRouter(body);
  if (!text) throw new Error("context_rewrite_final_empty_response");
  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    parsed: parseJsonText(text, "context_rewrite_final_invalid_json"),
    annotations: annotationsFromOpenRouter(body),
    usage: usageFromOpenRouter(body),
  };
}

export async function runContextRewritePolishCall({
  model,
  systemPrompt = "",
  sourcePacket = {},
  aggregateScore = {},
  researchResults = [],
  jobsRetrieval = {},
  draftMarkdown = "",
  draftMetadata = {},
} = {}) {
  if (process.env.CONTEXT_REWRITE_PROVIDER_MOCK === "true") {
    const parsed = mockPolish({ draftMarkdown, draftMetadata });
    return {
      provider: "mock",
      model: model || "mock-polish",
      responseId: "mock_polish_context_rewrite",
      text: JSON.stringify(parsed),
      parsed,
      annotations: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, webSearchCalls: 0, toolCostUsd: 0, costUsd: 0 },
    };
  }

  const finalMaxTokens = envInt("CONTEXT_REWRITE_FINAL_MAX_TOKENS", 24000, 4096, 60000);
  const maxTokens = envInt("CONTEXT_REWRITE_POLISH_MAX_TOKENS", finalMaxTokens, 4096, 60000);
  const body = await fetchOpenRouter(
    commonRequest({
      model,
      modelFamily: "glm",
      system: systemPrompt,
      user: JSON.stringify({
        schema: "context_rewrite.polish_input.v1",
        draft_markdown: String(draftMarkdown || ""),
        draft_metadata: draftMetadata,
        source_packet: sourcePacket,
        aggregate_score: aggregateScore,
        research_results: researchResults,
        jobs_retrieval: jobsRetrieval,
      }),
      maxTokens,
      temperature: 0.1,
      json: true,
      reasoningEffort: process.env.CONTEXT_REWRITE_POLISH_REASONING_EFFORT || "xhigh",
    }),
    { timeoutMs: stageTimeoutMs("CONTEXT_REWRITE_POLISH_TIMEOUT_MS", stageTimeoutMs("CONTEXT_REWRITE_FINAL_TIMEOUT_MS", defaultFinalTimeoutMs)) }
  );
  const text = outputTextFromOpenRouter(body);
  if (!text) throw new Error("context_rewrite_polish_empty_response");
  return {
    provider: "openrouter",
    model: body?.model || model,
    responseId: body?.id || null,
    text,
    parsed: parseJsonText(text, "context_rewrite_polish_invalid_json"),
    annotations: annotationsFromOpenRouter(body),
    usage: usageFromOpenRouter(body),
  };
}

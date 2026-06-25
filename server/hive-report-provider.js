import { createHash } from "node:crypto";
import { hiveReportTypes } from "./repositories/hive-reports.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const defaultReportModel = "z-ai/glm-5.2";

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

export function hiveReportModel() {
  return safeText(process.env.TASKNODE_HIVE_REPORT_MODEL || process.env.TASKNODE_BOARD_MANAGER_MODEL || defaultReportModel, 160);
}

function hiveReportReasoningEffort() {
  return safeText(process.env.TASKNODE_HIVE_REPORT_REASONING_EFFORT || "high", 40);
}

function providerTimeoutMs() {
  return Math.max(30000, Number(process.env.TASKNODE_HIVE_REPORT_PROVIDER_TIMEOUT_MS || 240000));
}

export function hiveReportsProviderConfigured() {
  return process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true" || Boolean(openRouterKey());
}

function promptDigest(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function markdownBody(value = "") {
  const body = safeText(value, 250_000);
  if (!body) throw new Error("hive_report_provider_empty_markdown");
  const first = body.trimStart().slice(0, 1);
  if (first === "{" || first === "[") throw new Error("hive_report_provider_json_blob_rejected");
  return body;
}

function compactJson(value, maxLength = 70_000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n\n[...middle truncated for report prompt...]\n\n${text.slice(-Math.floor(maxLength * 0.28))}`;
}

function reportInstructions(type = "", phase = "initial") {
  const definition = hiveReportTypes[type] || {};
  const common = [
    `Report type: ${definition.label || type}`,
    `Purpose: ${definition.summary || "Hive operating report."}`,
    "Write a human-readable Markdown document. Do not output JSON.",
    "Start with one H1. Use short sections, bullets, and concise evidence references.",
    "Include relevant counts and KPIs when present in the source packet.",
    "Call out uncertainty and missing evidence instead of inventing facts.",
    "Projects are dynamic; do not assume a fixed project list.",
    "Do not change or recommend reward policy, clawbacks, bans, or enforcement execution.",
  ];
  const byType = {
    rewarded_task: [
      "Group by role. For each role, summarize the last rewarded Network Tasks available in the packet.",
      "For each task include task id, title, operator, proposal/evidence gist, actual reward, and why it matters.",
    ],
    operative: [
      "Group operators by KOL, Core Contributor, QA Worker, Expert, and Project Leader where present.",
      "For each person include profile context, whether they currently have a task, and 1-2 sentences on what they appear to be doing.",
    ],
    kol: [
      "Summarize marketing/amplification state, KOL operators, public artifacts, key rewarded tasks, and trajectory.",
      "List every public link you rely on so the link-verifier can check it.",
    ],
    development: [
      "Summarize core development work, active code tasks, rewarded code tasks, repository evidence, and delivery risks.",
      "List repository, PR, issue, or commit links you rely on so the repo-verifier can check them.",
    ],
    qa: [
      "Write this as a product QA document: observed issues, suggested improvements, evidence from rewarded QA tasks, and Hive chat feedback.",
      "Separate confirmed findings from ideas or thin reports.",
    ],
    executive: [
      "Assemble Project Leader Hive chat from the last 24h into an executive brief.",
      "Preserve who said what, project implications, unresolved decisions, and concrete next actions.",
    ],
  };
  const phaseInstructions = phase === "final"
    ? [
        "This is the final phase. Incorporate the verifier summary directly into the report.",
        "Add a Verification section with confirmed, refuted, and unverified items.",
      ]
    : [
        "This is the initial phase. Produce the best report possible from the source packet.",
      ];
  return [...common, ...(byType[type] || []), ...phaseInstructions].join("\n");
}

function reportMessages({ type = "", sourcePacket = {}, phase = "initial", initialMarkdown = "", verifierSummary = "" } = {}) {
  const system = [
    "You are the Task Node Hive Reports writer.",
    "Your output is a prose operating report for a human operator.",
    "Never output raw JSON as the report body.",
    "Do not claim actions were executed; report only observed evidence.",
  ].join("\n");
  const user = [
    reportInstructions(type, phase),
    "",
    initialMarkdown ? ["INITIAL REPORT MARKDOWN", initialMarkdown].join("\n") : "",
    verifierSummary ? ["VERIFIER SUMMARY", verifierSummary].join("\n") : "",
    "SOURCE PACKET",
    "```json",
    compactJson(sourcePacket),
    "```",
  ].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
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

function mockMarkdownReport({ type = "", sourcePacket = {}, phase = "initial", verifierSummary = "" } = {}) {
  const label = hiveReportTypes[type]?.label || type;
  const counts = safeObject(sourcePacket.sourceCounts);
  const generatedAt = safeText(sourcePacket.generatedAt, 80) || new Date().toISOString();
  const roleLines = Object.entries(safeObject(sourcePacket.roles?.byRole))
    .map(([role, rows]) => `- ${role}: ${safeArray(rows).length} verified operators`)
    .join("\n");
  return markdownBody([
    `# ${label} Report`,
    "",
    `Generated: ${generatedAt}`,
    `Phase: ${phase}`,
    "",
    "## Snapshot",
    `- Verified role accounts: ${counts.roleAccountCount || 0}`,
    `- Dynamic projects in scope: ${counts.projectCount || 0}`,
    `- Rewarded Network Tasks in packet: ${counts.rewardedTaskCount || 0}`,
    `- Active Network Tasks in packet: ${counts.activeTaskCount || 0}`,
    `- Hive chat entries in packet: ${counts.hiveChatCount || 0}`,
    "",
    "## Roles",
    roleLines || "- No verified role rows were present in the source packet.",
    "",
    "## Observations",
    `This mock report validates the ${label} report pipeline without calling OpenRouter. Production generation uses the configured Hive report model.`,
    verifierSummary ? ["", "## Verification", verifierSummary].join("\n") : "",
  ].filter(Boolean).join("\n"));
}

export async function generateHiveReportMarkdown({
  type = "",
  sourcePacket = {},
  phase = "initial",
  initialMarkdown = "",
  verifierSummary = "",
  fetchImpl = fetch,
} = {}) {
  if (process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true") {
    return {
      bodyMarkdown: mockMarkdownReport({ type, sourcePacket, phase, verifierSummary }),
      provider: "mock",
      model: "mock-glm-high-thinking",
      responseId: `mock_hive_report_${type}_${phase}`,
      promptDigest: promptDigest(reportInstructions(type, phase)),
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
    const error = new Error("hive_report_openrouter_not_configured");
    error.status = 409;
    throw error;
  }
  const model = hiveReportModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs());
  const startedAt = Date.now();
  const messages = reportMessages({ type, sourcePacket, phase, initialMarkdown, verifierSummary });
  try {
    const response = await fetchImpl(`${(process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
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
        reasoning: { effort: hiveReportReasoningEffort() },
        provider: {
          data_collection: "deny",
        },
        temperature: 0.2,
        max_tokens: Math.max(3000, Number(process.env.TASKNODE_HIVE_REPORT_MAX_TOKENS || 9000)),
        usage: { include: true },
        metadata: {
          app: "tasknodeofficial",
          worker: "hive_reports",
          report_type: type,
          report_phase: phase,
        },
      }),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `OpenRouter Hive Report HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      bodyMarkdown: markdownBody(body?.choices?.[0]?.message?.content || ""),
      provider: "openrouter",
      model: safeText(body?.model || model, 160),
      responseId: safeText(body?.id, 200),
      promptDigest: promptDigest(JSON.stringify(messages)),
      usage: {
        ...openRouterUsage(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("hive_report_openrouter_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractLinksFromText(text = "") {
  const matches = String(text || "").match(/https?:\/\/[^\s)>\]]+/g) || [];
  return [...new Set(matches.map((link) => link.replace(/[.,;:]+$/g, "")))].slice(0, 30);
}

function collectText(value, depth = 0) {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).join("\n");
  if (value && typeof value === "object") return Object.values(value).map((item) => collectText(item, depth + 1)).join("\n");
  return "";
}

async function fetchWithTimeout(url, { fetchImpl = fetch, method = "HEAD", timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: {
        "user-agent": "TaskNodeHiveReportVerifier/1.0",
        ...headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkUrl(url, fetchImpl = fetch) {
  try {
    let response = await fetchWithTimeout(url, { fetchImpl, method: "HEAD" });
    if (response.status === 405 || response.status === 403 || response.status === 400) {
      response = await fetchWithTimeout(url, { fetchImpl, method: "GET" });
    }
    return {
      url,
      ok: response.ok,
      status: response.status,
      contentType: response.headers?.get?.("content-type") || "",
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      error: safeText(error?.message || "fetch_failed", 180),
    };
  }
}

function verificationMarkdown({ title = "", checks = [], note = "" } = {}) {
  const okCount = checks.filter((item) => item.ok).length;
  return markdownBody([
    `# ${title}`,
    "",
    `- Checked: ${checks.length}`,
    `- Reachable: ${okCount}`,
    `- Unreachable or unknown: ${Math.max(0, checks.length - okCount)}`,
    note ? `- Note: ${note}` : "",
    "",
    "## Checks",
    checks.length
      ? checks.map((item) => `- ${item.ok ? "Confirmed" : "Unverified"}: ${item.url} (${item.status || item.error || "no status"})`).join("\n")
      : "- No public links were available for this verifier.",
  ].filter(Boolean).join("\n"));
}

export async function verifyKolReportLinks({ markdown = "", sourcePacket = {}, fetchImpl = fetch } = {}) {
  const links = [...new Set([
    ...extractLinksFromText(markdown),
    ...extractLinksFromText(collectText(sourcePacket.rewardedTasksByRole?.kol)),
    ...extractLinksFromText(collectText(sourcePacket.roles?.byRole?.kol)),
  ])].slice(0, 20);
  if (process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true") {
    return verificationMarkdown({
      title: "KOL Link Verification",
      checks: links.slice(0, 5).map((url) => ({ url, ok: true, status: 200 })),
      note: links.length ? "Mock verifier treated sampled links as reachable." : "Mock verifier found no links.",
    });
  }
  const checks = [];
  for (const link of links) {
    checks.push(await checkUrl(link, fetchImpl));
  }
  return verificationMarkdown({
    title: "KOL Link Verification",
    checks,
    note: "The verifier only confirms public link reachability; it does not validate off-platform audience quality.",
  });
}

async function githubJson(url, fetchImpl = fetch) {
  const headers = {
    "user-agent": "TaskNodeHiveReportVerifier/1.0",
    accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchWithTimeout(url, { fetchImpl, method: "GET", timeoutMs: 12000, headers });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  const body = await response.json().catch(() => null);
  return { ok: true, status: response.status, body };
}

export async function verifyDevelopmentReportRepos({ markdown = "", sourcePacket = {}, fetchImpl = fetch } = {}) {
  const sourceText = [markdown, collectText(sourcePacket.rewardedTasksByRole?.core_contributor), collectText(sourcePacket.activeTasksByRole?.core_contributor)].join("\n");
  const repoLinks = extractLinksFromText(sourceText)
    .filter((link) => /github\.com\/postfiatorg\//i.test(link))
    .slice(0, 20);
  if (process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK === "true") {
    return verificationMarkdown({
      title: "Development Repository Verification",
      checks: repoLinks.slice(0, 5).map((url) => ({ url, ok: true, status: 200 })),
      note: repoLinks.length ? "Mock verifier treated sampled repository links as reachable." : "Mock verifier found no repository links.",
    });
  }
  const linkChecks = [];
  for (const link of repoLinks) {
    linkChecks.push(await checkUrl(link, fetchImpl));
  }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(`org:postfiatorg updated:>=${since}`)}&per_page=10`;
  const githubSearch = await githubJson(searchUrl, fetchImpl).catch((error) => ({
    ok: false,
    status: 0,
    body: null,
    error: error?.message || "github_search_failed",
  }));
  const checks = [
    ...linkChecks,
    {
      url: searchUrl,
      ok: githubSearch.ok,
      status: githubSearch.status,
      error: githubSearch.error || "",
    },
  ];
  const totalCount = Number(githubSearch.body?.total_count || 0);
  return verificationMarkdown({
    title: "Development Repository Verification",
    checks,
    note: `GitHub issue/PR search for postfiatorg updated since ${since} returned ${totalCount} visible items.`,
  });
}

import { promptDigest as digestPrompt, loadPrompt } from "./prompt-registry.js";
import {
  buildHiveProjectProductDocSourcePacket,
  completeHiveProjectProductDoc,
  hiveProjectProductDocPromptVersion,
  normalizeHiveProjectProductDocOutput,
} from "./repositories/hive-project-product-docs.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const defaultProviderOrder = ["parasail", "siliconflow", "atlas-cloud", "deepinfra", "akashml", "novita"];
const projectDocPrompt = loadPrompt("hive/hive_project_product_doc_v1.md");

function openRouterKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER || "";
}

function projectDocModel() {
  return process.env.TASKNODE_HIVE_PROJECT_DOC_MODEL || "deepseek/deepseek-v4-pro";
}

function providerOrder() {
  const configured = process.env.TASKNODE_HIVE_PROJECT_DOC_OPENROUTER_PROVIDERS || process.env.TASKNODE_MEMORY_OPENROUTER_PROVIDERS || "";
  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function providerTimeoutMs() {
  return Math.max(5000, Number(process.env.TASKNODE_HIVE_PROJECT_DOC_TIMEOUT_MS || 240000));
}

function maxTokens() {
  return Math.max(900, Number(process.env.TASKNODE_HIVE_PROJECT_DOC_MAX_TOKENS || 1800));
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function stripMarkdownFence(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function compactSourcePacket(packet = {}, maxLength = 60000) {
  const text = JSON.stringify(packet, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n\n[...middle truncated...]\n\n${text.slice(-Math.floor(maxLength * 0.28))}`;
}

function parseProjectDocJson(text = "") {
  const raw = stripMarkdownFence(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("hive_project_product_doc_invalid_json");
  }
  const output = normalizeHiveProjectProductDocOutput(JSON.parse(raw.slice(start, end + 1)));
  if (!output.project_status) {
    throw new Error("hive_project_product_doc_missing_status");
  }
  return output;
}

function openRouterUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

export async function fetchHiveProjectProductDoc(sourcePacket = {}, { fetchImpl = fetch } = {}) {
  if (!openRouterKey()) throw new Error("hive_project_product_doc_openrouter_key_missing");
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const order = providerOrder();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs());
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openRouterKey()}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model: projectDocModel(),
        messages: [
          { role: "system", content: projectDocPrompt },
          { role: "user", content: compactSourcePacket(sourcePacket, 60000) },
        ],
        provider: {
          zdr: true,
          data_collection: "deny",
          order: order.length > 0 ? order : defaultProviderOrder,
          only: order.length > 0 ? order : defaultProviderOrder,
        },
        temperature: 0,
        max_tokens: maxTokens(),
        usage: { include: true },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("hive_project_product_doc_provider_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `OpenRouter Hive Project Product Doc HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const content = body?.choices?.[0]?.message?.content || "";
  return {
    output: parseProjectDocJson(content),
    provider: "openrouter",
    model: safeText(body?.model || projectDocModel(), 160),
    promptDigest: digestPrompt(projectDocPrompt),
    promptVersion: hiveProjectProductDocPromptVersion,
    usage: openRouterUsage(body),
  };
}

export async function refreshHiveProjectProductDocument({
  projectId = "",
  boardManagerRunId = "",
  boardSourcePacket = {},
  fetchImpl = fetch,
} = {}) {
  const sourcePacket = await buildHiveProjectProductDocSourcePacket({ projectId, boardSourcePacket });
  const result = await fetchHiveProjectProductDoc(sourcePacket, { fetchImpl });
  const completed = await completeHiveProjectProductDoc({
    projectId,
    output: result.output,
    sourcePacket,
    boardManagerRunId,
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    promptDigest: result.promptDigest,
    usage: result.usage,
  });
  return {
    executed: true,
    projectId,
    productDocId: completed.doc?.id || "",
    sourcePacketDigest: sourcePacket.sourcePacketDigest,
    title: completed.doc?.title || "",
    model: result.model,
    promptVersion: result.promptVersion,
  };
}

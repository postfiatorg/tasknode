import { createHash } from "node:crypto";
import { loadPrompt, promptDigest, renderPromptTemplate } from "./prompt-registry.js";

const SCREENSHOT_PROMPT_PATH = "task_engine/evidence_screenshot_read_v1.md";
const MAX_EVIDENCE_IMAGE_BYTES = 2_500_000;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseDataUrl(dataUrl = "") {
  const value = String(dataUrl || "");
  if (!value.startsWith("data:")) return null;
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) return null;
  const header = value.slice(5, commaIndex);
  const data = value.slice(commaIndex + 1);
  const parts = header.split(";").map((part) => part.trim()).filter(Boolean);
  const mimeType = parts[0] || "application/octet-stream";
  const base64 = parts.includes("base64");
  if (!base64) return null;
  return { mimeType, data };
}

function compactFileMetadata(file = {}, parsed = null, buffer = null) {
  return {
    name: safeText(file.name, 240),
    mime_type: safeText(parsed?.mimeType || file.type || file.mime_type, 120),
    size: Number(file.size || buffer?.byteLength || 0),
    sha256: buffer ? sha256Buffer(buffer) : safeText(file.sha256, 120),
  };
}

function openAiVisionModel(env = process.env) {
  return safeText(
    env.TASKNODE_EVIDENCE_VISION_MODEL ||
      env.CHAT_MODEL_FRONTIER_INSTANT ||
      env.OPENAI_MODEL ||
      "chat-latest",
    120
  );
}

function openAiResponseText(body = {}) {
  if (typeof body.output_text === "string") return body.output_text;
  const output = Array.isArray(body.output) ? body.output : [];
  return output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function describeScreenshotWithOpenAi({
  dataUrl,
  file,
  task,
  verificationCriteria = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const apiKey = safeText(env.OPENAI_API_KEY);
  if (!apiKey) {
    const error = new Error("openai_api_key_missing");
    error.status = 409;
    throw error;
  }

  const prompt = renderPromptTemplate(loadPrompt(SCREENSHOT_PROMPT_PATH), {
    TASK_TITLE: safeText(task?.title, 500),
    TASK_DESCRIPTION: safeText(task?.description, 3000),
    VERIFICATION_CRITERIA: safeText(verificationCriteria || task?.submission_requirement_text, 3000),
  });
  const model = openAiVisionModel(env);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(5000, Number(env.TASKNODE_EVIDENCE_VISION_TIMEOUT_MS || 45000))
  );

  try {
    const response = await fetchImpl(`${(env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${prompt}\n\nEvidence file: ${safeText(file?.name, 240)}`,
              },
              {
                type: "input_image",
                image_url: dataUrl,
                detail: "high",
              },
            ],
          },
        ],
        max_output_tokens: Number(env.TASKNODE_EVIDENCE_VISION_MAX_TOKENS || 700),
        store: false,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      const error = new Error(`evidence_vision_openai_http_${response.status}:${bodyText.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    const body = JSON.parse(bodyText);
    return {
      description: safeText(openAiResponseText(body), 8000),
      metadata: {
        provider: "openai",
        model,
        prompt_path: SCREENSHOT_PROMPT_PATH,
        prompt_digest: promptDigest(prompt),
        latency_ms: Date.now() - startedAt,
        response_id: safeText(body?.id, 200),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function processEvidenceFileForSubmission({
  file = {},
  method = "",
  task = {},
  value = "",
  verificationCriteria = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const artifactType = safeText(method, 80).toLowerCase();
  const parsed = parseDataUrl(file.dataUrl || file.data_url || "");
  if (!parsed) {
    return {
      ok: true,
      artifact_type: artifactType || "file",
      file: compactFileMetadata(file),
      text: safeText(file.text || value, 120000),
      processing: {
        status: "metadata_only",
        reason: "no_data_url",
      },
    };
  }

  const buffer = Buffer.from(parsed.data, "base64");
  if (buffer.byteLength > MAX_EVIDENCE_IMAGE_BYTES) {
    const error = new Error("evidence_file_too_large");
    error.status = 413;
    throw error;
  }

  const metadata = compactFileMetadata(file, parsed, buffer);
  if (file.sha256 && safeText(file.sha256, 120) !== metadata.sha256) {
    const error = new Error("evidence_file_digest_mismatch");
    error.status = 400;
    throw error;
  }

  if (artifactType !== "screenshot") {
    return {
      ok: true,
      artifact_type: artifactType || "file",
      file: metadata,
      text: safeText(file.text || value, 120000),
      processing: {
        status: "metadata_only",
        reason: "non_image_file",
      },
    };
  }

  if (!metadata.mime_type.startsWith("image/")) {
    const error = new Error("screenshot_evidence_requires_image");
    error.status = 400;
    throw error;
  }

  const described = await describeScreenshotWithOpenAi({
    dataUrl: `data:${metadata.mime_type};base64,${parsed.data}`,
    file: metadata,
    task,
    verificationCriteria,
    env,
    fetchImpl,
  });

  return {
    ok: true,
    artifact_type: "screenshot",
    file: metadata,
    description: described.description,
    text: described.description,
    processing: {
      status: "described",
      ...described.metadata,
    },
  };
}

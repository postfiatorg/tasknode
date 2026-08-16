import { createHash } from "node:crypto";
import { loadPrompt, promptDigest, renderPromptTemplate } from "./prompt-registry.js";
import {
  decodeEvidenceDataUrl,
  extractEvidenceFileContent,
  MAX_EVIDENCE_FILE_BYTES,
} from "./evidence-file-extraction.js";
import { AMBIENT_MODELS, ambientChatCompletion } from "./ambient-inference.js";

const SCREENSHOT_PROMPT_PATH = "task_engine/evidence_screenshot_read_v1.md";

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
      env.AMBIENT_MODEL_VISION ||
      AMBIENT_MODELS.vision,
    120
  );
}

async function describeScreenshotWithOpenAi({
  dataUrl,
  file,
  task,
  verificationCriteria = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const prompt = renderPromptTemplate(loadPrompt(SCREENSHOT_PROMPT_PATH), {
    TASK_TITLE: safeText(task?.title, 500),
    TASK_DESCRIPTION: safeText(task?.description, 3000),
    VERIFICATION_CRITERIA: safeText(verificationCriteria || task?.submission_requirement_text, 3000),
  });
  const model = openAiVisionModel(env);
  const startedAt = Date.now();
  const result = await ambientChatCompletion({
      env,
      fetchImpl,
      capability: "verification_vision",
      timeoutMs: Math.max(5000, Number(env.TASKNODE_EVIDENCE_VISION_TIMEOUT_MS || 45000)),
      body: {
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${prompt}\n\nEvidence file: ${safeText(file?.name, 240)}`,
              },
              {
                type: "image_url",
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
        max_tokens: Number(env.TASKNODE_EVIDENCE_VISION_MAX_TOKENS || 700),
      },
    });
    const body = result.body;
    return {
      description: safeText(result.text, 8000),
      metadata: {
        provider: "ambient",
        model,
        prompt_path: SCREENSHOT_PROMPT_PATH,
        prompt_digest: promptDigest(prompt),
        latency_ms: Date.now() - startedAt,
        response_id: safeText(body?.id, 200),
      },
    };
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

  const { buffer, mimeType } = decodeEvidenceDataUrl(file.dataUrl || file.data_url || "");
  if (buffer.byteLength > MAX_EVIDENCE_FILE_BYTES) {
    const error = new Error("evidence_file_too_large");
    error.status = 413;
    throw error;
  }

  const metadata = compactFileMetadata(file, { ...parsed, mimeType }, buffer);
  if (file.sha256 && safeText(file.sha256, 120) !== metadata.sha256) {
    const error = new Error("evidence_file_digest_mismatch");
    error.status = 400;
    throw error;
  }

  if (artifactType !== "screenshot") {
    let extracted;
    try {
      extracted = await extractEvidenceFileContent({
        buffer,
        fileName: metadata.name,
        mimeType: metadata.mime_type,
      });
    } catch (error) {
      if (error?.status) throw error;
      const unreadable = new Error(`evidence_file_unreadable:${safeText(error?.message || error, 240)}`);
      unreadable.status = 422;
      throw unreadable;
    }
    const visualDescriptions = [];
    for (const [index, image] of (extracted.images || []).entries()) {
      const described = await describeScreenshotWithOpenAi({
        dataUrl: `data:${image.mimeType};base64,${Buffer.from(image.buffer).toString("base64")}`,
        file: { ...metadata, name: `${metadata.name}:${image.name || `visual-${index + 1}`}` },
        task,
        verificationCriteria,
        env,
        fetchImpl,
      });
      visualDescriptions.push(`[Visual ${index + 1}] ${described.description}`);
    }
    const combinedText = [safeText(extracted.text || file.text || value, 120000), ...visualDescriptions].filter(Boolean).join("\n\n");
    return {
      ok: true,
      artifact_type: artifactType || "file",
      file: metadata,
      text: safeText(combinedText, 120000),
      processing: {
        status: "extracted",
        parser: extracted.parser,
        warnings: extracted.warnings || [],
        metadata: { ...(extracted.metadata || {}), visual_observation_count: visualDescriptions.length },
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const promptsDir = process.env.TASKNODE_PROMPTS_DIR
  ? path.resolve(process.env.TASKNODE_PROMPTS_DIR)
  : path.join(rootDir, "prompts");

export function promptPath(relativePath = "") {
  const raw = String(relativePath || "");
  if (!raw.trim()) throw new Error("prompt_path_required");
  if (path.isAbsolute(raw)) return raw;
  if (raw.startsWith(`prompts${path.sep}`) || raw.startsWith("prompts/")) {
    return path.join(rootDir, raw);
  }
  return path.join(promptsDir, raw);
}

export function loadPrompt(relativePath) {
  return readFileSync(promptPath(relativePath), "utf8").trim();
}

export function promptDigest(promptText = "") {
  return createHash("sha256").update(String(promptText || ""), "utf8").digest("hex");
}

export function renderPromptTemplate(promptText = "", variables = {}) {
  return Object.entries(variables).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value || "")),
    String(promptText || "")
  ).trim();
}

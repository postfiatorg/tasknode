#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync(new URL("../quality/file-size-limits.json", import.meta.url), "utf8"));

const ignoredPathPrefixes = [
  "dist/",
  "node_modules/",
  // Historical/private evidence and generated run artifacts are governed by
  // publication/retention checks, not source modularity budgets.
  "docs/archive/",
  "docs/verification/",
  "mocks/",
  "ops/",
  "reference_clients/python/orc_tooling/",
  "reference_clients/python/runs/",
  "work_in_progress/",
];
const ignoredFiles = new Set([
  "package-lock.json",
  "PUBLICATION.json",
  "login.jsx",
  "reference_clients/python/tests/test_orc_tooling.py",
]);

// A line budget is meaningful only for text. Prefix rules intentionally do not
// imply that every file below that prefix is text: docs and frontend folders
// also contain PNG, JPEG, video, font, and archive assets.
const textExtensions = new Set([
  ".cjs", ".css", ".csv", ".env", ".graphql", ".html", ".js", ".json",
  ".jsx", ".md", ".mjs", ".py", ".scss", ".sh", ".sql", ".svg", ".toml",
  ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const textBasenames = new Set([
  ".dockerignore", ".editorconfig", ".gitignore", ".npmrc", "CODEOWNERS",
  "Dockerfile", "LICENSE", "NOTICE",
]);

function isTextFile(file) {
  const basename = path.basename(file);
  return textBasenames.has(basename)
    || basename.startsWith("Dockerfile.")
    || textExtensions.has(path.extname(file).toLowerCase());
}

function trackedFiles() {
  let candidates = [];
  try {
    candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).split(/\r?\n/);
  } catch {
    const walk = (directory = ".", prefix = "") => readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const file = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if ([".git", "dist", "node_modules"].includes(entry.name)) return [];
          return walk(path.join(directory, entry.name), file);
        }
        return entry.isFile() ? [file] : [];
      });
    candidates = walk();
  }
  return candidates
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => existsSync(file))
    .filter(isTextFile)
    .filter((file) => !ignoredFiles.has(file) && !ignoredFiles.has(path.basename(file)))
    .filter((file) => !ignoredPathPrefixes.some((prefix) => file.startsWith(prefix)));
}

function lineCount(file) {
  const text = readFileSync(file, "utf8");
  if (!text) return 0;
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function baseRuleForFile(file) {
  const prefixRule = (config.prefixes || []).find((rule) => file.startsWith(rule.prefix));
  if (prefixRule) return prefixRule;

  const extensionRule = config.extensions?.[path.extname(file)];
  if (extensionRule) return extensionRule;

  return config.defaults || { maxLines: 1200 };
}

function exceptionForFile(file) {
  return config.exceptions?.[file] || null;
}

function validateException(file, exception) {
  const missingFields = ["owner", "removeBy", "reason"].filter((field) => !String(exception[field] || "").trim());
  if (missingFields.length > 0) {
    return {
      file,
      message: `file-size exception is missing ${missingFields.join(", ")}`,
    };
  }
  const removeBy = String(exception.removeBy);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(removeBy) || Number.isNaN(Date.parse(`${removeBy}T00:00:00Z`))) {
    return { file, message: `file-size exception has invalid removeBy date ${JSON.stringify(removeBy)}` };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (removeBy < today) {
    return { file, message: `file-size exception expired on ${removeBy}` };
  }
  if (!Number.isFinite(Number(exception.maxLines)) || Number(exception.maxLines) <= 0) {
    return { file, message: "file-size exception must declare a positive maxLines budget" };
  }
  return null;
}

const violations = [];
const activeExceptions = [];

for (const file of trackedFiles()) {
  const baseRule = baseRuleForFile(file);
  const exception = exceptionForFile(file);
  const exceptionProblem = exception ? validateException(file, exception) : null;

  if (exceptionProblem) {
    violations.push(exceptionProblem);
    continue;
  }

  const rule = exception || baseRule;
  const lines = lineCount(file);

  if (exception) {
    activeExceptions.push({ file, lines, maxLines: rule.maxLines, baseMaxLines: baseRule.maxLines });
  }

  if (lines > Number(rule.maxLines || 0)) {
    violations.push({
      file,
      message: `${lines} lines exceeds ${rule.maxLines}`,
    });
  }
}

if (violations.length > 0) {
  console.error("file size check failed:");
  for (const entry of violations) {
    console.error(`  ${entry.file}: ${entry.message}`);
  }
  process.exit(1);
}

console.log(
  `file size check ok: ${activeExceptions.length} active exceptions, no file over its configured limit`,
);

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync(new URL("../quality/file-size-limits.json", import.meta.url), "utf8"));

const ignoredPathPrefixes = [
  "dist/",
  "node_modules/",
];
const ignoredFiles = new Set([
  "package-lock.json",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !ignoredFiles.has(file))
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
  if (missingFields.length === 0) return null;
  return {
    file,
    message: `file-size exception is missing ${missingFields.join(", ")}`,
  };
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

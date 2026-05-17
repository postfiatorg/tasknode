#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const checkedExtensions = new Set([
  ".css",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".py",
  ".sql",
]);

const ignoredPathPrefixes = [
  "dist/",
  "mocks/",
  "node_modules/",
  "work_in_progress/",
];

const ignoredFiles = new Set(["package-lock.json", "jsx_mock.jsx", "login.jsx"]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !ignoredFiles.has(file))
    .filter((file) => !ignoredPathPrefixes.some((prefix) => file.startsWith(prefix)))
    .filter((file) => checkedExtensions.has(path.extname(file)));
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function inspectFile(file) {
  const buffer = readFileSync(file);
  if (isBinary(buffer)) return [];

  const text = buffer.toString("utf8");
  const issues = [];

  if (text.includes("\r\n")) {
    issues.push("uses CRLF line endings");
  }

  if (text.length > 0 && !text.endsWith("\n")) {
    issues.push("is missing a final newline");
  }

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    if (/[ \t]+$/.test(line)) {
      issues.push(`has trailing whitespace on line ${index + 1}`);
      break;
    }
  }

  return issues;
}

const violations = [];

for (const file of trackedFiles()) {
  for (const issue of inspectFile(file)) {
    violations.push({ file, issue });
  }
}

if (violations.length > 0) {
  console.error("format check failed:");
  for (const violation of violations) {
    console.error(`  ${violation.file}: ${violation.issue}`);
  }
  process.exit(1);
}

console.log("format check ok");

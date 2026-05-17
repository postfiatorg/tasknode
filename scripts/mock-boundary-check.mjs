#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const checkedPrefixes = ["src/", "server/", "shared/"];
const checkedExtensions = new Set([".js", ".jsx", ".mjs"]);
const importPattern = /\b(?:import|from)\s*(?:[^'"]*)["']([^"']+)["']/g;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => checkedPrefixes.some((prefix) => file.startsWith(prefix)))
    .filter((file) => checkedExtensions.has(path.extname(file)));
}

const violations = [];

for (const file of trackedFiles()) {
  const text = readFileSync(file, "utf8");
  let match;
  while ((match = importPattern.exec(text)) !== null) {
    const source = match[1];
    if (source.includes("/mocks/") || source.startsWith("../mocks") || source.startsWith("../../mocks")) {
      violations.push({ file, source });
    }
  }
}

if (violations.length > 0) {
  console.error("mock boundary check failed:");
  for (const violation of violations) {
    console.error(`  ${violation.file} imports ${violation.source}`);
  }
  process.exit(1);
}

console.log("mock boundary check ok");

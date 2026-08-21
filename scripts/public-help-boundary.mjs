#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "docs/public-help-manifest.json");
const contentModulePath = path.join(repoRoot, "src/features/docs/docs-content.js");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const contentModule = readFileSync(contentModulePath, "utf8");

function normalizedRepoPath(value = "") {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function markdownImports(source = "") {
  const imports = [];
  const patterns = [
    /^import\s+[^;]+\s+from\s+["']([^"']+\.md)\?raw["'];?$/gm,
    /\bimport\(\s*["']([^"']+\.md)\?raw["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const absolute = path.resolve(path.dirname(contentModulePath), match[1]);
      imports.push(normalizedRepoPath(path.relative(repoRoot, absolute)));
    }
  }
  return imports;
}

const allowlist = [...new Set((manifest.sources || []).map(normalizedRepoPath))].sort();
const imported = [...new Set(markdownImports(contentModule))].sort();
const violations = [];

if (allowlist.length !== (manifest.sources || []).length) {
  violations.push("docs/public-help-manifest.json contains duplicate sources");
}

for (const source of allowlist) {
  if (!source.startsWith("docs/wiki/")) violations.push(`${source}: public Help sources must live under docs/wiki/`);
  if (!existsSync(path.join(repoRoot, source))) violations.push(`${source}: allowlisted source does not exist`);
  if (!imported.includes(source)) violations.push(`${source}: allowlisted but not imported by docs-content.js`);
}

for (const source of imported) {
  if (!allowlist.includes(source)) violations.push(`${source}: browser Markdown import is not allowlisted`);
}

const forbiddenSourcePrefixes = [
  "docs/archive/",
  "docs/verification/",
  "docs/wiki/plans/",
  "prompts/",
  "private_prompts/",
];
for (const source of imported) {
  if (forbiddenSourcePrefixes.some((prefix) => source.startsWith(prefix))) {
    violations.push(`${source}: private/historical source may not enter the browser Help bundle`);
  }
}

const forbiddenContent = [
  { label: "machine-specific repository path", pattern: /\/home\/pfrpc\//i },
  { label: "temporary incident/evidence path", pattern: /\/tmp\/tasknode/i },
  { label: "named credential owner", pattern: /Alexander Good|owned by Sauron|token ending\s+[A-Za-z0-9]+/i },
  { label: "raw private infrastructure address", pattern: /(?:^|\D)178\.156\.143\.199(?:\D|$)/ },
];

for (const source of imported) {
  const text = readFileSync(path.join(repoRoot, source), "utf8");
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(text)) violations.push(`${source}: contains ${rule.label}`);
  }
}

if (/(?:from\s+|import\s*\(\s*)["'][^"']*prompts\//.test(contentModule)) {
  violations.push("docs-content.js imports a prompt into the production browser bundle");
}

if (violations.length) {
  console.error("public Help boundary failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`public Help boundary ok: ${imported.length} explicitly allowlisted Markdown sources`);

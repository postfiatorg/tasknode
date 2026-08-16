#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "release/publication-manifest.json"), "utf8"));
const helpManifest = JSON.parse(readFileSync(path.join(repoRoot, "docs/public-help-manifest.json"), "utf8"));
const publicHelpSources = new Set(helpManifest.sources || []);
const publicScriptFiles = new Set([
  "scripts/app-state-cache-gate-smoke.mjs",
  "scripts/account-data-lifecycle-smoke.mjs",
  "scripts/account-wallet-repository-smoke.mjs",
  "scripts/account-repository-smoke.mjs",
  "scripts/ethereum-deposit-repository-smoke.mjs",
  "scripts/terminal-auth-repository-smoke.mjs",
  "scripts/auth-session-repository-smoke.mjs",
  "scripts/auth-challenge-repository-smoke.mjs",
  "scripts/auth-state-migration-smoke.mjs",
  "scripts/asset-provenance-check.mjs",
  "scripts/bundle-budget-check.mjs",
  "scripts/build-runtime-tree.mjs",
  "scripts/chat-attachment-smoke.mjs",
  "scripts/check-file-size.mjs",
  "scripts/check-jsx-react-import.mjs",
  "scripts/container-entrypoint-smoke.mjs",
  "scripts/dependency-license-check.mjs",
  "scripts/durable-identity-boundary-smoke.mjs",
  "scripts/data-retention-smoke.mjs",
  "scripts/extension-registry-smoke.mjs",
  "scripts/generate-api-reference.mjs",
  "scripts/data-recovery.mjs",
  "scripts/data-recovery-safety-smoke.mjs",
  "scripts/export-public-candidate.mjs",
  "scripts/format-check.mjs",
  "scripts/frame-smoke.mjs",
  "scripts/hive-board-secretary-worker.mjs",
  "scripts/migrate-db.mjs",
  "scripts/mock-boundary-check.mjs",
  "scripts/nostr-messages-smoke.mjs",
  "scripts/pftl-cache-smoke.mjs",
  "scripts/pftl-cache-watcher-smoke.mjs",
  "scripts/profile-nft-render-worker.mjs",
  "scripts/prompt-boundary-check.mjs",
  "scripts/public-suite.mjs",
  "scripts/public-help-boundary.mjs",
  "scripts/request-validation-smoke.mjs",
  "scripts/route-auth-policy-smoke.mjs",
  "scripts/trusted-proxy-rate-limit-smoke.mjs",
  "scripts/route-smoke.mjs",
  "scripts/runtime-store-smoke.mjs",
  "scripts/runtime-role-boundary-smoke.mjs",
  "scripts/security-smoke.mjs",
  "scripts/secret-scan-review.mjs",
  "scripts/wallet-state-regression.mjs",
]);
const publicPackageScripts = new Set([
  "dev", "dev:api", "docker:dev", "docker:dev:down", "docker:dev:logs",
  "docker:integration", "docker:integration:down", "build", "format-check", "lint",
  "test:unit", "test:integration", "test:e2e", "test:e2e:full", "security",
  "check:fast", "check", "data-recovery-drill", "db:migrate",
  "sbom:cyclonedx", "sbom:spdx", "start", "start:web", "start:worker", "start:board-secretary",
]);

function includeScriptDependencies(file) {
  const source = readFileSync(path.join(repoRoot, file), "utf8");
  const importPattern = /(?:from\s+|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const dependency = normalized(path.relative(
      repoRoot,
      path.resolve(repoRoot, path.dirname(file), match[1])
    ));
    if (!dependency.startsWith("scripts/") || publicScriptFiles.has(dependency) || !existsSync(path.join(repoRoot, dependency))) continue;
    publicScriptFiles.add(dependency);
    includeScriptDependencies(dependency);
  }
}
[...publicScriptFiles].forEach(includeScriptDependencies);
const requestedOut = process.argv.indexOf("--out") >= 0 ? process.argv[process.argv.indexOf("--out") + 1] : "";
const allowUnlicensed = process.argv.includes("--allow-unlicensed");
const allowDirty = process.argv.includes("--allow-dirty");

function normalized(value) {
  return String(value || "").replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const includes = manifest.include.map(globRegex);
const excludes = manifest.exclude.map(globRegex);
function selected(file) {
  if (file.startsWith("docs/wiki/") && !publicHelpSources.has(file)) return false;
  if (file.startsWith("scripts/") && !publicScriptFiles.has(file)) return false;
  return includes.some((pattern) => pattern.test(file))
    && !excludes.some((pattern) => pattern.test(file));
}

function sourceFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split(/\r?\n/).map(normalized).filter(Boolean);
}

function safeOutputDirectory() {
  if (!requestedOut) return mkdtempSync(path.join(tmpdir(), "tasknode-public-candidate-"));
  const output = path.resolve(requestedOut);
  if ([repoRoot, path.parse(output).root, path.resolve(tmpdir())].includes(output)) {
    throw new Error(`unsafe_public_candidate_output:${output}`);
  }
  if (existsSync(output) && readdirSync(output).length > 0) throw new Error(`public_candidate_output_not_empty:${output}`);
  mkdirSync(output, { recursive: true });
  return output;
}

const allFiles = sourceFiles();
const files = allFiles.filter(selected).sort();
const errors = [];
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const sourceDirty = Boolean(execFileSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" }).trim());
if (sourceDirty && !allowDirty) errors.push("public candidate must be exported from a clean protected commit (use --allow-dirty only for local verification)");
for (const required of manifest.required) {
  if (!files.includes(required)) errors.push(`required file is absent: ${required}`);
}
for (const file of files) {
  if (manifest.forbiddenFiles.includes(file)) errors.push(`forbidden file selected: ${file}`);
  if (manifest.forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) errors.push(`forbidden prefix selected: ${file}`);
  const stat = lstatSync(path.join(repoRoot, file));
  if (!stat.isFile()) errors.push(`candidate entry is not a regular file: ${file}`);
}
if (!allowUnlicensed && !files.includes("LICENSE")) errors.push("copyright owner must approve and add LICENSE");
if (errors.length) throw new Error(`public_candidate_boundary_failed:\n${errors.join("\n")}`);

const output = safeOutputDirectory();
for (const file of files) {
  const destination = path.join(output, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(repoRoot, file), destination);
}

copyFileSync(path.join(repoRoot, "release/README.public.md"), path.join(output, "README.md"));

const candidateFiles = new Set(files);
candidateFiles.add("README.md");
const packagePath = path.join(output, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  const references = [...String(command).matchAll(/(?:^|\s)(scripts\/[A-Za-z0-9._/-]+)/g)].map((match) => match[1]);
  if (!publicPackageScripts.has(name)
    || references.some((file) => !candidateFiles.has(file))
    || /(?:^|:)fly(?::|$)|production|fleet-watch/.test(name)) {
    delete packageJson.scripts[name];
  }
}
Object.assign(packageJson.scripts, {
  "test:unit": "node scripts/public-suite.mjs unit",
  "test:integration": "node scripts/public-suite.mjs integration",
  "test:e2e": "node scripts/route-smoke.mjs",
  "test:e2e:full": "node scripts/frame-smoke.mjs",
  security: "node scripts/public-suite.mjs security",
  "check:fast": "node scripts/public-suite.mjs fast",
  check: "node scripts/public-suite.mjs all",
  "start:worker": "node server/worker-entry.js",
});
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const textExtensions = new Set([
  ".cjs", ".css", ".env", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".py", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const forbiddenText = [
  { label: "operator home path", pattern: new RegExp(["/home", "pfrpc"].join("/"), "i") },
  { label: "Task Node temp path", pattern: new RegExp(["/tmp", "tasknode"].join("/"), "i") },
  { label: "legacy production app name", pattern: new RegExp(["tasknodeofficial", "dev"].join("-"), "i") },
  { label: "private infrastructure IPv4", pattern: new RegExp(["178", "156"].join("\\.") + "\\.") },
  { label: "Docker bridge IPv4", pattern: new RegExp(["172", "17"].join("\\.") + "\\.") },
  { label: "named operator email", pattern: new RegExp(["goodalexander", "gmail.com"].join("@"), "i") },
  { label: "named workstation account", pattern: new RegExp(["azrael", "@"].join(""), "i") },
  { label: "production account identifier", pattern: new RegExp(["acct_", "(?:oauth|email|wallet)_", "[0-9a-f]{20,}"].join(""), "i") },
];
for (const file of [...candidateFiles].sort()) {
  const basename = path.basename(file);
  if (basename.startsWith(".env") || basename.endsWith(".pem") || basename.endsWith(".key")) {
    errors.push(`credential-shaped file selected: ${file}`);
    continue;
  }
  if (!textExtensions.has(path.extname(file).toLowerCase()) && !["Dockerfile", "CODEOWNERS"].includes(basename)) continue;
  const contents = readFileSync(path.join(output, file), "utf8");
  for (const rule of forbiddenText) {
    if (rule.pattern.test(contents)) errors.push(`${rule.label} in ${file}`);
  }
}
if (errors.length) throw new Error(`public_candidate_content_failed:\n${errors.join("\n")}`);

function walk(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = normalized(path.join(prefix, entry.name));
    return entry.isDirectory() ? walk(path.join(directory, entry.name), relative) : [relative];
  });
}

const inventory = walk(output)
  .filter((file) => file !== "PUBLICATION.json")
  .sort()
  .map((file) => ({
    path: file,
    sha256: createHash("sha256").update(readFileSync(path.join(output, file))).digest("hex"),
  }));
const sourceTimestamp = Number(process.env.SOURCE_DATE_EPOCH)
  || Number(execFileSync("git", ["show", "-s", "--format=%ct", sourceCommit], { cwd: repoRoot, encoding: "utf8" }).trim());
const publication = {
  schemaVersion: 1,
  sourceCommit,
  sourceDirty,
  generatedAt: new Date(sourceTimestamp * 1000).toISOString(),
  licensed: files.includes("LICENSE"),
  inventorySha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
  files: inventory,
};
writeFileSync(path.join(output, "PUBLICATION.json"), `${JSON.stringify(publication, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output, files: inventory.length + 1, licensed: publication.licensed }));

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(repoRoot, "provenance/assets.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const binaryExtensions = new Set([
  ".avif", ".eot", ".gif", ".ico", ".jpeg", ".jpg", ".mov", ".mp3",
  ".mp4", ".otf", ".pdf", ".png", ".ttf", ".wav", ".webm", ".webp",
  ".woff", ".woff2",
]);

function publicAssets(directory, prefix = "public") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return publicAssets(absolute, relative);
    return binaryExtensions.has(path.extname(entry.name).toLowerCase()) ? [relative] : [];
  });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const errors = [];
const entries = new Map();
for (const item of Array.isArray(manifest.assets) ? manifest.assets : []) {
  const file = String(item?.path || "");
  if (!file.startsWith("public/") || file.includes("..") || entries.has(file)) {
    errors.push(`invalid or duplicate asset path: ${file || "<missing>"}`);
    continue;
  }
  entries.set(file, item);
  const absolute = path.join(repoRoot, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    errors.push(`manifest asset is missing: ${file}`);
    continue;
  }
  if (!item.owner || !item.source || !item.terms) errors.push(`incomplete provenance: ${file}`);
  const actual = sha256(absolute);
  if (actual !== item.sha256) errors.push(`hash mismatch: ${file}`);
}

for (const file of publicAssets(path.join(repoRoot, "public")).sort()) {
  if (!entries.has(file)) errors.push(`public binary asset is not allowlisted: ${file}`);
}

if (errors.length) {
  console.error("asset provenance check failed:");
  errors.forEach((error) => console.error(`  ${error}`));
  process.exit(1);
}
console.log(`asset provenance check ok: ${entries.size} reviewed public assets`);

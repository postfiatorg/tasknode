import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["server", "scripts"];
const configFiles = ["fly.toml", "docker-compose.dev.yml", "docker-compose.reward-test.yml"];
const allowOpenAiHost = new Set(["server/profile-nft-image-provider.js"]);
const selfPath = "scripts/provider-egress-check.mjs";
const retired = [
  /api\.openrouter\.ai/i,
  /api\.deepseek\.com/i,
  /\bOPENROUTER(?:_API_KEY|_BASE_URL|_REFERER|_TITLE)?\b/,
  /\bDEEPSEEK(?:_API_KEY|_BASE_URL)?\b/,
  /\bOPENAI_API_KEY\b/,
  /\bOPENAI_BASE_URL\b/,
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(relative));
    else if (/\.(?:js|mjs)$/.test(entry.name) && !/-smoke\.mjs$/.test(entry.name) && !/-test\.mjs$/.test(entry.name)) files.push(relative);
  }
  return files;
}

const files = [...configFiles];
for (const root of roots) files.push(...await filesUnder(root));
const violations = [];
for (const file of files) {
  if (file === selfPath) continue;
  const body = await readFile(file, "utf8");
  for (const pattern of retired) if (pattern.test(body)) violations.push(`${file}: ${pattern}`);
  if (/api\.openai\.com/i.test(body) && !allowOpenAiHost.has(file)) violations.push(`${file}: non-allowlisted OpenAI host`);
  if (/PROFILE_NFT_OPENAI_API_KEY/.test(body) && ![
    "server/profile-nft-image-provider.js",
    "fly.toml",
  ].includes(file)) violations.push(`${file}: renderer credential outside isolation allowlist`);
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checkedFiles: files.length, openAiAllowlist: [...allowOpenAiHost] }));
}

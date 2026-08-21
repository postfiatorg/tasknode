import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const budget = JSON.parse(readFileSync(path.join(root, "quality/bundle-budgets.json"), "utf8"));
const assetsDir = path.join(root, "dist/assets");
const assets = readdirSync(assetsDir).map((name) => {
  const body = readFileSync(path.join(assetsDir, name));
  return { name, bytes: body.length, gzipBytes: gzipSync(body, { level: 9 }).length };
});
const errors = [];
const explicitlyBudgeted = new Set();

for (const entry of budget.assets || []) {
  const pattern = new RegExp(entry.pattern);
  const matches = assets.filter((asset) => pattern.test(asset.name));
  if (matches.length !== 1) {
    errors.push(`${entry.name}: expected exactly one asset matching ${entry.pattern}, found ${matches.length}`);
    continue;
  }
  const asset = matches[0];
  explicitlyBudgeted.add(asset.name);
  if (asset.bytes > entry.maxBytes) errors.push(`${entry.name}: ${asset.bytes} bytes exceeds ${entry.maxBytes}`);
  if (asset.gzipBytes > entry.maxGzipBytes) errors.push(`${entry.name}: ${asset.gzipBytes} gzip bytes exceeds ${entry.maxGzipBytes}`);
}

for (const asset of assets) {
  if (explicitlyBudgeted.has(asset.name)) continue;
  if (asset.name.endsWith(".js")) {
    if (asset.bytes > budget.defaults.javascriptMaxBytes) errors.push(`${asset.name}: ${asset.bytes} bytes exceeds default JS budget`);
    if (asset.gzipBytes > budget.defaults.javascriptMaxGzipBytes) errors.push(`${asset.name}: ${asset.gzipBytes} gzip bytes exceeds default JS budget`);
  } else if (asset.name.endsWith(".css")) {
    if (asset.bytes > budget.defaults.cssMaxBytes) errors.push(`${asset.name}: ${asset.bytes} bytes exceeds default CSS budget`);
    if (asset.gzipBytes > budget.defaults.cssMaxGzipBytes) errors.push(`${asset.name}: ${asset.gzipBytes} gzip bytes exceeds default CSS budget`);
  }
}

if (errors.length) {
  console.error(`bundle budget failed:\n${errors.map((error) => `  ${error}`).join("\n")}`);
  process.exit(1);
}
console.log(`bundle budget ok: ${assets.length} built assets checked`);

#!/usr/bin/env node
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const approved = new Set([
  "0BSD", "Apache-2.0", "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT", "BSD-2-Clause", "BSD-3-Clause",
  "CC-BY-4.0", "CC0-1.0", "ISC", "LGPL-3.0-or-later", "MIT", "MPL-2.0",
  "Python-2.0", "Unlicense",
]);
const counts = new Map();
const problems = [];

for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
  if (!packagePath) continue;
  const license = String(metadata.license || "").trim();
  if (!license) problems.push(`${packagePath}: missing license metadata`);
  else if (!approved.has(license)) problems.push(`${packagePath}: unreviewed license ${license}`);
  counts.set(license, (counts.get(license) || 0) + 1);
}

if (problems.length) {
  console.error("dependency license check failed:");
  problems.forEach((problem) => console.error(`  ${problem}`));
  process.exit(1);
}

const special = [...counts.entries()]
  .filter(([license]) => /LGPL|MPL|CC-BY/.test(license))
  .map(([license, count]) => `${license}=${count}`)
  .join(", ");
console.log(`dependency license check ok: ${lock.packages ? Object.keys(lock.packages).length - 1 : 0} packages; reviewed reciprocal/content licenses: ${special}`);

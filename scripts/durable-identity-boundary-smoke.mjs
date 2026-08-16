#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(root, "server");
const adapterFile = "server/repositories/account-profiles.js";
const identityExports = new Set([
  "getAccountExpertReview",
  "getAccountIdentityProfile",
  "getAccountProfileVisibility",
  "listAccountIdentityProfiles",
  "listDiscoverableAccountWalletIdentities",
  "listPublicAccountWalletIdentities",
  "setAccountExpertReview",
]);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute) : entry.name.endsWith(".js") ? [absolute] : [];
  });
}

const violations = [];
for (const absolute of files(serverRoot)) {
  const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
  if (relative === adapterFile || relative === "server/runtime-store.js") continue;
  const source = readFileSync(absolute, "utf8");
  const imports = source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["'](?:\.\.\/|\.\/)runtime-store\.js["']/g);
  for (const match of imports) {
    const names = match[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const name of names) {
      if (identityExports.has(name)) violations.push(`${relative}:${name}`);
    }
  }
}

assert.deepEqual(
  violations,
  [],
  `production identity reads must use the durable account-profiles repository; runtime-store is adapter-only:\n${violations.join("\n")}`
);
console.log(`durable identity boundary smoke ok: ${identityExports.size} identity operations are repository-only`);

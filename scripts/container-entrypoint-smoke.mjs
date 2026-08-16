#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const webExample = readFileSync(path.join(root, "fly.example.toml"), "utf8");
const workerExample = readFileSync(path.join(root, "fly.worker.example.toml"), "utf8");
const privateConfig = path.join(root, "fly.toml");
const fly = readFileSync(existsSync(privateConfig) ? privateConfig : path.join(root, "fly.example.toml"), "utf8");
const processBlock = fly.match(/\[processes\]([\s\S]*?)(?=\n\[)/)?.[1] || "";
const commands = Array.from(processBlock.matchAll(/^\s*[a-z0-9-]+\s*=\s*"([^"]+)"/gim), (match) => match[1]);

assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/);
assert.match(dockerfile, /FROM runtime-base AS web-runtime/);
assert.match(dockerfile, /FROM runtime-base AS worker-runtime/);
assert.match(dockerfile, /COPY runtime\/web\/package\.json \.\/package\.json/);
assert.match(dockerfile, /COPY runtime\/worker\/package\.json \.\/package\.json/);
assert.doesNotMatch(dockerfile, /--include docs \\/, "runtime images must not copy the full documentation tree");
assert.match(dockerfile, /--exclude prompts\/non_production/);
assert.match(webExample, /target\s*=\s*"web-runtime"/);
assert.match(workerExample, /target\s*=\s*"worker-runtime"/);
assert.doesNotMatch(workerExample, /\[http_service\]/, "worker example must not expose an HTTP service");
assert.ok(commands.length >= 1, "deployment example must have an explicit web entrypoint");
assert.match(fly, /TASKNODE_TRUSTED_PROXY_CIDRS\s*=\s*"[^"]+"/, "production examples must declare the immediate trusted-proxy network");
for (const command of commands) {
  assert.doesNotMatch(command, /\b(?:npm|npx|codex|vite)\b/, `runtime-only process cannot invoke removed toolchain: ${command}`);
  assert.match(command, /\bnode\b/, `production process must invoke the pinned Node runtime: ${command}`);
  const target = command.match(/\bnode\s+([^\s]+)/)?.[1] || "";
  assert.ok(target && existsSync(path.join(root, target)), `production process target is missing: ${target}`);
  const role = command.match(/TASKNODE_PROCESS_ROLE=([^\s]+)/)?.[1] || "";
  if (role.startsWith("worker:")) {
    assert.equal(target, "server/worker-entry.js", `split worker role must use the worker-only entrypoint: ${role}`);
  }
}

console.log(`container entrypoint smoke ok: ${commands.length} npm-free production process commands`);

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { handleAgentRelease } from "../server/agent-install.js";

const fixture = mkdtempSync(path.join(tmpdir(), "prompt-installer-"));
const config = path.join(fixture, "config");
const bin = path.join(fixture, "bin");
mkdirSync(bin);
// Isolate the network package-manager side effect; full acceptance runs real npm ci.
const npmLog = path.join(fixture, "npm-args");
writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PROMPT_NPM_LOG"\n', { mode: 0o755 });
let failure = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  if (failure && url.pathname.endsWith("/lib/prompt-client.mjs")) {
    res.writeHead(failure === "transfer" ? 503 : 200);
    res.end("incomplete release");
    return;
  }
  if (!(await handleAgentRelease({ req, res, url }))) {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function install() {
  const child = spawn("sh", ["packages/tasknode-cli/install.sh", "--version"], {
    env: {
      ...process.env,
      TASKNODE_URL: origin,
      TASKNODE_CONFIG_DIR: config,
      PROMPT_NPM_LOG: npmLog,
      PATH: `${bin}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve) =>
    child.on("exit", (code) => {
      if (code && !failure) console.error(output);
      resolve(code);
    }),
  );
}
const releases = () => readdirSync(path.join(config, "releases")).filter((name) => !name.startsWith("."));
try {
  assert.equal(await install(), 0);
  assert.equal(releases().length, 1);
  const prior = releases()[0];
  const runtime = path.join(config, "releases", prior);
  const previousEntry = readFileSync(path.join(runtime, "bin/tasknode.mjs"), "utf8");
  assert.deepEqual(
    readFileSync(npmLog, "utf8")
      .trim()
      .split("\n")
      .filter((arg) => !arg.startsWith(fixture)),
    ["ci", "--prefix", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  );
  const lock = JSON.parse(readFileSync(path.join(runtime, "package-lock.json")));
  assert.ok(lock.packages["node_modules/ws"].integrity);
  for (const kind of ["transfer", "digest"]) {
    failure = kind;
    assert.notEqual(await install(), 0);
    assert.deepEqual(releases(), [prior]);
    assert.equal(readFileSync(path.join(runtime, "bin/tasknode.mjs"), "utf8"), previousEntry);
  }
  console.log(
    "PASS installer: content-addressed release, lockfile/npm ci, failed and corrupted transfers preserve prior runtime",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(fixture, { recursive: true, force: true });
}

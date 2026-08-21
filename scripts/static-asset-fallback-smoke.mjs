import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const distDir = path.join(rootDir, "dist");
const assetsDir = path.join(distDir, "assets");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function distAssetWithExt(extension) {
  for (const name of readdirSync(assetsDir)) {
    const filePath = path.join(assetsDir, name);
    if (statSync(filePath).isFile() && name.endsWith(extension)) return `/assets/${name}`;
  }
  throw new Error(`No ${extension} asset found in dist/assets. Run npm run build first.`);
}

function collectOutput(stream, output) {
  stream.on("data", (chunk) => {
    output.push(String(chunk));
    while (output.join("").length > 4000) output.shift();
  });
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health was ready:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the child HTTP server is listening.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for server health:\n${output.join("")}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), sleep(1200).then(() => false)]);
  if (stopped || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(1000)]);
}

async function fetchText(baseUrl, requestPath) {
  const response = await fetch(`${baseUrl}${requestPath}`);
  const text = await response.text();
  return {
    response,
    text,
    contentType: response.headers.get("content-type") || "",
  };
}

const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const storeDir = mkdtempSync(path.join(tmpdir(), "tasknodeofficial-static-smoke-"));
const cssAsset = distAssetWithExt(".css");
const jsAsset = distAssetWithExt(".js");
const output = [];
let child = null;

try {
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      TASKNODE_PROCESS_ROLE: "web",
      TASKNODE_DATABASE_DISABLED: "true",
      TASKNODE_POSTGRES_DISABLED: "true",
      TASKNODE_REALTIME_EVENTS_ENABLED: "false",
      TASKNODE_STORE_PATH: path.join(storeDir, "runtime-store.json"),
      TASKNODE_PUBLIC_URL: "",
      VITE_SITE_ORIGIN: "",
      TASKNODE_DEV_AUTH_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collectOutput(child.stdout, output);
  collectOutput(child.stderr, output);

  await waitForHealth(baseUrl, child, output);

  const css = await fetchText(baseUrl, cssAsset);
  assert.equal(css.response.status, 200);
  assert.match(css.contentType, /^text\/css\b/);

  const js = await fetchText(baseUrl, jsAsset);
  assert.equal(js.response.status, 200);
  assert.match(js.contentType, /^text\/javascript\b/);

  const missingCss = await fetchText(baseUrl, `/assets/missing-${Date.now()}.css`);
  assert.equal(missingCss.response.status, 404);
  assert.doesNotMatch(missingCss.contentType, /^text\/html\b/);
  assert.doesNotMatch(missingCss.text, /<div id="root"/);

  const missingTopLevelFile = await fetchText(baseUrl, `/missing-${Date.now()}.js`);
  assert.equal(missingTopLevelFile.response.status, 404);
  assert.doesNotMatch(missingTopLevelFile.contentType, /^text\/html\b/);

  const appRoute = await fetchText(baseUrl, `/tasks/${Date.now()}`);
  assert.equal(appRoute.response.status, 200);
  assert.match(appRoute.contentType, /^text\/html\b/);
  assert.match(appRoute.text, /<div id="root"/);

  console.log("static asset fallback smoke ok");
} finally {
  await stopProcess(child);
  rmSync(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

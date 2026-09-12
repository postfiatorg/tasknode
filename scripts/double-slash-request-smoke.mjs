import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

// Regression for the ERR_INVALID_URL crash: server/index.js parses
// `new URL(req.url, "http://tasknode.local")` synchronously inside the
// createServer callback. A raw request line of `GET //` (or `//evil.host/...`)
// makes the WHATWG URL parser throw ERR_INVALID_URL. Without a guard the throw
// escapes to process-hardening.js's uncaughtException handler, which logs and
// calls exit(1) -> the whole web instance restarts on one unauthenticated
// request (repeatable = DoS, also kills in-flight SSE chat streams).
//
// Expected (guarded): 400 Bad Request, process stays up, /health still 200.
// On the unmodified tree the socket is reset / the process dies and the
// post-request /health probe gets a connection error -> this test FAILS.
//
// GUARD_APPLIED=1 asserts the guarded contract strictly (default). When
// GUARD_APPLIED is not 1, the same green assertions still run (so the test
// fails red); the flag only annotates the log line and gates the extra
// red-only characterization note below.

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const guardApplied = process.env.GUARD_APPLIED === "1";

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function collectOutput(stream, output) {
  stream.on("data", (chunk) => {
    output.push(String(chunk));
    while (output.join("").length > 6000) output.shift();
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
      // retry until the child HTTP server is listening
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for server health:\n${output.join("")}`);
}

async function healthStatus(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    return response.status;
  } catch (error) {
    return `ERROR:${error?.code || error?.message || "connection_error"}`;
  }
}

// Send a raw HTTP/1.1 request with an arbitrary (un-normalized) request target.
// fetch()/undici normalizes `//` away, so a raw socket is required to reproduce.
function rawRequest(port, target) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    socket.setTimeout(4000);
    socket.on("connect", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
      );
    });
    socket.on("data", (chunk) => {
      data += String(chunk);
    });
    socket.on("end", () => {
      const match = data.match(/^HTTP\/1\.1 (\d{3})/);
      done({ status: match ? Number(match[1]) : null, raw: data });
    });
    socket.on("timeout", () => done({ status: null, raw: data, error: "timeout" }));
    socket.on("error", (error) => done({ status: null, raw: data, error: error.code || error.message }));
  });
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

test("GET // returns 400 and the web server survives", async () => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storeDir = mkdtempSync(path.join(tmpdir(), "tasknodeofficial-slash-smoke-"));
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

    // 1. healthy before
    const before = await healthStatus(baseUrl);
    assert.equal(before, 200, `expected /health 200 before, got ${before}`);

    // 2. the malicious request: `GET //`
    const doubleSlash = await rawRequest(port, "//");
    assert.equal(
      doubleSlash.status,
      400,
      `expected GET // -> 400, got ${JSON.stringify({
        status: doubleSlash.status,
        error: doubleSlash.error,
      })} (server likely crashed on ERR_INVALID_URL)\n${output.join("")}`
    );

    // 3. an empty-authority variant that also trips the WHATWG parser
    //    (`//user@` has no host -> ERR_INVALID_URL, same crash path).
    const hostForm = await rawRequest(port, "//user@");
    assert.equal(
      hostForm.status,
      400,
      `expected GET //user@ -> 400, got ${JSON.stringify({
        status: hostForm.status,
        error: hostForm.error,
      })}\n${output.join("")}`
    );

    // 4. process still alive
    assert.equal(child.exitCode, null, `server process exited after GET // (exitCode=${child.exitCode})`);

    // 5. still serving /health
    const after = await healthStatus(baseUrl);
    assert.equal(after, 200, `expected /health 200 after GET //, got ${after} (process died / connection refused)`);

    if (guardApplied) {
      console.log("double-slash-request-smoke ok (GUARD_APPLIED=1): GET // -> 400, process survived");
    } else {
      console.log("double-slash-request-smoke ok: GET // -> 400, process survived");
    }
  } finally {
    await stopProcess(child);
    rmSync(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

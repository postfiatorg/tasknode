import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const defaultPort = Number(process.env.ROUTE_SMOKE_PORT || 5194);
const baseUrl = process.env.ROUTE_SMOKE_BASE_URL || `http://127.0.0.1:${defaultPort}`;
const chromeBin = process.env.CHROME_BIN || "google-chrome";
const chromePort = Number(process.env.ROUTE_SMOKE_CHROME_PORT || 9331);
const startServer = process.env.ROUTE_SMOKE_USE_EXISTING !== "1";

const routes = [
  { hash: "", labels: ["Task Node", "New chat"] },
  { hash: "#wallet", labels: ["Available balance", "PFT", "Activity"] },
  { hash: "#context", labels: ["Context document", "Versions"] },
  { hash: "#tasks", labels: ["Tasks"] },
  { hash: "#hive", labels: ["Hive", "Active projects", "Routing feed", "Allotted operators", "Hive Context"] },
  { hash: "#directory", labels: ["Directory", "Leaderboard", "operators"] },
  { hash: "#profile", labels: ["Today's airdrop", "Profile Studio", "PFT generation"] },
  { hash: "#memory", labels: ["Memory"] },
  {
    hash: "#docs",
    labels: [
      "Task Node Docs",
      "Product and architecture wiki",
      "System Status",
      "Live Status",
      "Database:",
      "Daily Airdrop",
      "AI Providers",
      "User Observability Logging",
    ],
  },
  {
    hash: "#docs/wallet",
    labels: [
      "Task Node Docs",
      "Product and architecture wiki",
      "Wallet",
      "Identity, balances, and custody",
      "Account deletion audit",
    ],
    selectors: [".docs-rendered-diagram svg"],
  },
];

let server;
let chrome;
let cdp;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-route-smoke-"));
  const serverOutput = [];

  try {
    if (startServer) {
      server = spawn(
        "./node_modules/.bin/vite",
        ["--host", "127.0.0.1", "--port", String(defaultPort), "--strictPort"],
        {
          detached: true,
          env: { ...process.env, VITE_DEV_PORT: String(defaultPort) },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      server.killProcessGroup = true;
      collectOutput(server.stdout, serverOutput);
      collectOutput(server.stderr, serverOutput);
    }

    await waitForHttp(baseUrl, 20000, serverOutput);

    chrome = spawn(
      chromeBin,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--window-size=1280,900",
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${chromePort}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] }
    );

    const page = await waitForPage();
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const runtimeExceptions = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      const details = event?.exceptionDetails;
      runtimeExceptions.push(details?.exception?.description || details?.text || "Unknown runtime exception");
    });

    for (const route of routes) {
      runtimeExceptions.length = 0;
      const url = `${baseUrl}/${route.hash}`;
      const pageLoad = waitForPageLoad();
      await cdp.send("Page.navigate", { url });
      await pageLoad;
      await sleep(400);
      if (runtimeExceptions.length > 0) {
        throw new Error(`Runtime exception on ${route.hash || "/"}:\n${runtimeExceptions.join("\n")}`);
      }
      await waitForRootText();
      await sleep(400);

      if (runtimeExceptions.length > 0) {
        throw new Error(`Runtime exception on ${route.hash || "/"}:\n${runtimeExceptions.join("\n")}`);
      }

      const visibleText = String(await evaluate("document.body?.innerText || ''"));
      const missing = route.labels.filter((label) => !visibleText.toLowerCase().includes(label.toLowerCase()));
      if (missing.length > 0) {
        throw new Error(
          `Route ${route.hash || "/"} rendered without expected text: ${missing.join(", ")}\nVisible text:\n${visibleText.slice(0, 1200)}`
        );
      }
      for (const selector of route.selectors || []) {
        const exists = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        if (!exists) throw new Error(`Route ${route.hash || "/"} rendered without selector: ${selector}`);
      }
      if (route.hash === "#context") await assertContextSelectionBackspace();
      if (route.hash === "#profile") await assertProfileRouteScrolls();
    }

    const pageLoad = waitForPageLoad();
    await cdp.send("Page.navigate", { url: baseUrl });
    await pageLoad;
    await waitForRootText();
    await sleep(400);
    await assertComposerFileDrop();

    console.log(`route smoke ok: ${routes.map((route) => route.hash || "/").join(", ")}`);
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(server);
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch (error) {
      console.warn(`route smoke cleanup warning: ${error.message}`);
    }
  }
}

function collectOutput(stream, output) {
  stream.on("data", (chunk) => {
    output.push(String(chunk));
    while (output.join("").length > 4000) output.shift();
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalProcess(child, "SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), sleep(1200).then(() => false)]);
  if (stopped || child.exitCode !== null) return;
  signalProcess(child, "SIGKILL");
  await Promise.race([exited, sleep(1000)]);
}

function signalProcess(child, signal) {
  try {
    if (child.killProcessGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForHttp(url, timeoutMs, serverOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until Vite starts accepting HTTP connections.
    }
    if (server?.exitCode !== null) {
      throw new Error(`Vite exited before route smoke could start.\n${serverOutput.join("")}`);
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}.\n${serverOutput.join("")}`);
}

async function waitForPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((entry) => entry.type === "page");
        if (page) return page;
      }
    } catch {
      // Retry until Chrome exposes the debugging endpoint.
    }
    await sleep(100);
  }
  throw new Error("No debuggable Chrome page found.");
}

async function waitForRootText() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rootText = String(await evaluate("document.querySelector('#root')?.textContent?.trim() || ''"));
    if (rootText.length > 0) return rootText;
    await sleep(100);
  }
  const detail = await evaluate(`({
    url: location.href,
    readyState: document.readyState,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 500) || '',
    rootHtml: document.querySelector('#root')?.outerHTML?.slice(0, 500) || '',
  })`);
  throw new Error(`React root stayed blank: ${JSON.stringify(detail)}`);
}

async function waitForPageLoad(timeoutMs = 1500) {
  let cleanup = () => {};
  try {
    await Promise.race([
      new Promise((resolve) => {
        const handler = () => {
          cleanup();
          resolve();
        };
        cleanup = () => {
          const handlers = cdp.handlers.get("Page.loadEventFired") || [];
          cdp.handlers.set("Page.loadEventFired", handlers.filter((entry) => entry !== handler));
        };
        cdp.on("Page.loadEventFired", handler);
      }),
      sleep(timeoutMs),
    ]);
  } finally {
    cleanup();
  }
}

async function assertComposerFileDrop() {
  const result = await evaluate(`(async () => {
    const composer = document.querySelector('form.composer');
    if (!composer) throw new Error('Composer form missing for drag/drop smoke.');

    const file = new File(['%PDF-1.4\\n% tasknode drag smoke\\n'], 'drag-smoke.pdf', {
      type: 'application/pdf',
    });
    const data = new DataTransfer();
    data.items.add(file);

    composer.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const activeDuringDrag = composer.classList.contains('is-drag-active');

    composer.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    }));
    composer.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    }));

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelectorAll('.attachment-chip').length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      activeDuringDrag,
      activeAfterDrop: composer.classList.contains('is-drag-active'),
      chipCount: document.querySelectorAll('.attachment-chip').length,
      chipText: document.querySelector('.attachment-chip')?.textContent?.trim() || '',
      statusText: document.querySelector('.chat-composer-note')?.textContent?.trim() || '',
    };
  })()`);

  if (!result.activeDuringDrag || result.activeAfterDrop || result.chipCount !== 1 || !result.chipText.includes("drag-smoke.pdf")) {
    throw new Error(`Composer drag/drop attachment smoke failed: ${JSON.stringify(result)}`);
  }
}

async function assertProfileRouteScrolls() {
  const result = await evaluate(`(() => {
    const scroller = document.querySelector('.route-scroll');
    if (!scroller) return { ok: false, reason: 'route_scroll_missing' };
    const before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    return {
      ok: scroller.scrollTop > before,
      before,
      after: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      overflowY: getComputedStyle(scroller).overflowY,
    };
  })()`);

  if (!result.ok) {
    throw new Error(`Profile route did not expose a working scroll container: ${JSON.stringify(result)}`);
  }
}

async function assertContextSelectionBackspace() {
  const before = JSON.parse(await evaluate(`JSON.stringify((() => {
    window.__routeSmokeBlockedContextSaves = [];
    if (!window.__routeSmokeOriginalFetch) {
      window.__routeSmokeOriginalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (url.includes('/api/context/edit/save')) {
          window.__routeSmokeBlockedContextSaves.push({ url, at: Date.now() });
          return Promise.resolve(new Response(JSON.stringify({ message: 'blocked by route smoke' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return window.__routeSmokeOriginalFetch(input, init);
      };
    }

    const editor = document.querySelector('.ctx-editor');
    if (!editor) throw new Error('Context editor missing for selection delete smoke.');
    if (editor.contentEditable !== 'true') return { skipped: true, reason: 'context_not_editable' };

    editor.focus();
    editor.innerHTML = '<p>alpha bravo charlie</p><p>delta echo foxtrot</p>';
    const first = editor.querySelectorAll('p')[0].firstChild;
    const second = editor.querySelectorAll('p')[1].firstChild;
    const range = document.createRange();
    range.setStart(first, 'alpha '.length);
    range.setEnd(second, 'delta '.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      active: document.activeElement === editor,
      selected: selection.toString(),
      text: editor.innerText,
    };
  })())`));

  if (before.skipped) return;

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await sleep(300);

  const after = JSON.parse(await evaluate(`JSON.stringify({
    text: document.querySelector('.ctx-editor')?.innerText || '',
    html: document.querySelector('.ctx-editor')?.innerHTML || '',
    selected: window.getSelection()?.toString() || '',
  })`));

  if (!before.active || !before.selected.includes("bravo") || !before.selected.includes("delta")) {
    throw new Error(`Context selection setup failed: ${JSON.stringify(before)}`);
  }
  if (
    after.text.includes("bravo") ||
    after.text.includes("charlie") ||
    after.text.includes("delta") ||
    !after.text.includes("alpha") ||
    !after.text.includes("echo foxtrot")
  ) {
    throw new Error(`Context selected Backspace failed: ${JSON.stringify({ before, after })}`);
  }
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(exception);
  }
  return result.result?.value;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
      this.socket.on("message", (payload) => this.handleMessage(payload));
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
    });
  }

  handleMessage(payload) {
    const message = JSON.parse(String(payload));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
      return;
    }

    const handlers = this.handlers.get(message.method) || [];
    for (const handler of handlers) handler(message.params);
  }

  close() {
    this.socket?.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

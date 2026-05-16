import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

const baseUrl = process.env.FRAME_BASE_URL || process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080";
const chromeBin = process.env.CHROME_BIN || "google-chrome";
const debugPort = Number(process.env.FRAME_CHROME_PORT || 9321);
const screenshotDir =
  process.env.FRAME_SCREENSHOT_DIR === "0"
    ? ""
    : process.env.FRAME_SCREENSHOT_DIR || "/tmp/tasknodeofficial-frame-smoke";

let cdp;

async function main() {
  if (screenshotDir) {
    rmSync(screenshotDir, { recursive: true, force: true });
    mkdirSync(screenshotDir, { recursive: true });
  }

  const userDataDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-frame-smoke-"));
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1440,900",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${debugPort}`,
      baseUrl,
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  try {
    const page = await waitForPage();
    cdp = new CdpSocket(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await waitForText("Task Node");

    await assertText(["Task Node", "New chat", "Tasks", "Wallet", "Context", "What are you working on?"]);
    await capture("01-chat");

    await clickSelector('button[aria-label="Add"]');
    await assertText([
      "Upload photos & files",
      "Motivation",
      "Brainstorming",
      "Context Refine",
      "Context Rewrite",
      "Request a task",
      "More",
    ]);
    await capture("02-plus-menu");
    await clickSelector('button[aria-label="Add"]');

    await clickNav("More");
    await assertText(["Agents", "Messages", "Motivation", "Brainstorming"]);
    await capture("03-sidebar-more");
    await clickNav("More");

    await clickNav("Tasks");
    await assertText(["Tasks", "Outstanding", "Verification", "Refused", "Rewarded", "Request task"]);
    await assertText(["Ship A 90 Percent Task Node Surface Cut", "Make The 8-K Extractor Emit Cited Rows"]);
    await capture("04-tasks");

    await clickSelector(".task-row");
    await assertText(["Description", "Steps", "Verification", "Reward", "Submit evidence", "Discuss", "Cancel task"]);
    await capture("05-task-modal");
    await clickSelector(".task-modal header button");

    await clickNav("Wallet");
    await assertText(["Available balance", "PFT", "Send", "Receive", "Activity", "Daily airdrop", "Task reward"]);
    await capture("06-wallet");

    await clickNav("Context");
    await assertText(["Google Docs", "Notion", "Internal PFT Context", "Connected"]);
    await capture("07-context");

    await clickSelector(".profile-button");
    await assertText(["Directory", "Settings", "Profile", "Help", "Log out"]);
    await capture("08-profile-menu");

    await clickButton("Profile", "document.querySelector('.profile-menu')");
    await assertText(["Private", "Public", "Profile Studio", "Today's airdrop", "PFT generation"]);
    await capture("09-profile-private");

    await clickButton("Public");
    await assertText(["Wallet", "Total rewards paid", "Sybil score", "NFT Gallery", "Post Fiat alignment"]);
    await capture("10-profile-public");

    await clickSelector(".profile-button");
    await clickButton("Settings", "document.querySelector('.profile-menu')");
    await assertText(["General", "Security", "Data controls", "Billing", "Secure your account", "Appearance"]);
    await capture("11-settings-general");

    await clickButton("Billing", "document.querySelector('.settings-rail')");
    await assertText(["Payment methods", "XRP", "Ether", "Bitcoin", "USDT", "USDC", "Billing history"]);
    await assertLedgerRowsIfLedgerExists();
    await capture("12-settings-billing");
    await clickSelector(".settings-close");

    await clickSelector(".profile-button");
    await clickSelector(".profile-menu-header");
    await assertText(["Log in or sign up", "Continue with Telegram", "Continue with Discord", "Continue with X", "Continue with GitHub"]);
    await assertSelector('input[placeholder="Email address"]');
    await capture("13-login");

    const loginSessionContract = await evaluate(`fetch('/api/session')
      .then((response) => response.json())
      .then((session) => ({
        devAuthEnabled: session.devAuth?.enabled === true,
        emailEnabled: session.accountLinks?.find((provider) => provider.id === 'email')?.enabled === true,
      }))
      .catch(() => ({ devAuthEnabled: false, emailEnabled: false }))`);
    if (loginSessionContract.emailEnabled) {
      await setInput('input[placeholder="Email address"]', "frame-smoke@tasknode.local");
      await clickSelector(".continue-button");
      await assertSelector('input[aria-label="Sign-in code"]');
      const code = await evaluate(`document.querySelector('.dev-code-note strong')?.textContent?.trim() || ''`);
      if (code) {
        await setInput('input[aria-label="Sign-in code"]', code);
        await clickSelector(".continue-button");
        await waitForText("Frame Smoke");
        await capture("14-login-session");
      } else {
        await capture("14-login-code");
      }
    } else if (loginSessionContract.devAuthEnabled) {
      await setInput('input[placeholder="Email address"]', "frame-smoke@tasknode.local");
      await clickSelector(".continue-button");
      await waitForText("Frame Smoke");
      await capture("14-login-session");
    }

    console.log(`frame smoke ok: ${baseUrl}`);
    if (screenshotDir) console.log(`screenshots: ${screenshotDir}`);
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await sleep(200);
    rmSync(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function waitForPage() {
  let pages = [];
  for (let index = 0; index < 80; index += 1) {
    pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 1000).catch(() => []);
    const page = pages.find((entry) => entry.type === "page" && entry.url.includes(new URL(baseUrl).hostname));
    if (page) return page;
    await sleep(100);
  }

  const page = pages.find((entry) => entry.type === "page");
  if (!page) throw new Error("No debuggable Chrome page found.");
  return page;
}

async function waitForText(text) {
  for (let index = 0; index < 60; index += 1) {
    const result = await evaluate(`document.body?.innerText?.includes(${JSON.stringify(text)}) || false`);
    if (result === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function assertText(labels) {
  const missing = [];
  const text = String(await evaluate("document.body.innerText")).toLowerCase();
  for (const label of labels) {
    if (!text.includes(label.toLowerCase())) missing.push(label);
  }
  if (missing.length > 0) {
    throw new Error(`Missing visible text: ${missing.join(", ")}`);
  }
}

async function clickNav(label) {
  await clickButton(label, "document.querySelector('.nav-list')");
}

async function clickButton(label, scopeExpression = "document") {
  await evaluate(`(() => {
    const scope = ${scopeExpression};
    const button = [...scope.querySelectorAll('button')]
      .find((item) => item.textContent.trim().includes(${JSON.stringify(label)}));
    if (!button) throw new Error('button not found: ${label}');
    button.click();
    return true;
  })()`);
  await sleep(250);
}

async function clickSelector(selector) {
  await evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(selector)});
    if (!item) throw new Error('selector not found: ${selector}');
    item.click();
    return true;
  })()`);
  await sleep(250);
}

async function assertSelector(selector) {
  const exists = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  if (!exists) throw new Error(`Missing selector: ${selector}`);
}

async function assertLedgerRowsIfLedgerExists() {
  const result = await evaluate(`fetch('/api/usage/ledger')
    .then((response) => response.json())
    .then((ledger) => ({
      entries: Array.isArray(ledger.entries) ? ledger.entries.length : 0,
      rows: document.querySelectorAll('.ledger-row').length,
    }))
    .catch(() => ({ entries: 0, rows: 0 }))`);

  if (result.entries > 0 && result.rows === 0) {
    throw new Error("Ledger entries exist but billing rows are not visible.");
  }
}

async function setInput(selector, value) {
  await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('input not found: ${selector}');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
}

async function capture(name) {
  if (!screenshotDir) return;
  await sleep(100);
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(join(screenshotDir, `${name}.png`), Buffer.from(result.data, "base64"));
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

async function fetchJson(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out fetching ${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpSocket {
  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      this.socket = createConnection(
        { host: this.url.hostname, port: Number(this.url.port) },
        () => {
          this.socket.write(
            [
              `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
              `Host: ${this.url.host}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${key}`,
              "Sec-WebSocket-Version: 13",
              "\r\n",
            ].join("\r\n")
          );
        }
      );

      let handshake = Buffer.alloc(0);
      const onHandshakeData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const boundary = handshake.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const header = handshake.slice(0, boundary).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101")) {
          reject(new Error(`CDP websocket handshake failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.socket.off("data", onHandshakeData);
        this.socket.on("data", (data) => this.onData(data));
        const rest = handshake.slice(boundary + 4);
        if (rest.length) this.onData(rest);
        resolve();
      };

      this.socket.on("data", onHandshakeData);
      this.socket.on("error", reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const header = [0x81];
    if (payload.length < 126) {
      header.push(0x80 | payload.length);
    } else if (payload.length < 65536) {
      header.push(0x80 | 126, (payload.length >> 8) & 255, payload.length & 255);
    } else {
      throw new Error("CDP payload is too large.");
    }

    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }

    this.socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10000);
    });
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = this.buffer.readUInt32BE(offset) * 2 ** 32 + this.buffer.readUInt32BE(offset + 4);
        offset += 8;
      }

      const masked = Boolean(second & 0x80);
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);

      if (masked) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      if ((first & 0x0f) !== 0x1) continue;

      const message = JSON.parse(payload.toString("utf8"));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  close() {
    this.socket?.destroy();
  }
}

await main();

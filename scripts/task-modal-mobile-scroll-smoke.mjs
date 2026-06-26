import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";

const baseUrl = process.env.TASK_MODAL_SCROLL_BASE_URL || "http://127.0.0.1:5174";
const chromeBin = process.env.CHROME_BIN || "google-chrome";
const debugPort = Number(process.env.TASK_MODAL_SCROLL_CHROME_PORT || 9337);
const screenshotDir = resolve(
  process.env.TASK_MODAL_SCROLL_SCREENSHOT_DIR ||
    "docs/verification/mobile-badge-sync-scroll/screenshots"
);
const screenshotPrefix = process.env.TASK_MODAL_SCROLL_PREFIX || "after";
const taskId = "task_70cd895b483bd6723b8552c5ec31da9d";
const viewport = {
  width: Number(process.env.TASK_MODAL_SCROLL_WIDTH || 390),
  height: Number(process.env.TASK_MODAL_SCROLL_HEIGHT || 720),
  deviceScaleFactor: 2,
  mobile: true,
};

let cdp;

async function main() {
  if (process.env.TASK_MODAL_SCROLL_CLEAN === "1") {
    rmSync(screenshotDir, { recursive: true, force: true });
  }
  mkdirSync(screenshotDir, { recursive: true });

  const userDataDir = join(tmpdir(), `tasknode-task-modal-scroll-${randomBytes(4).toString("hex")}`);
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--window-size=${viewport.width},${viewport.height}`,
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  try {
    const page = await waitForPage();
    cdp = new CdpSocket(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", viewport);
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    await installFixtureFetch();
    await cdp.send("Page.navigate", {
      url: `${baseUrl}/#/tasks/${encodeURIComponent(taskId)}`,
    });
    await waitForSelector(".task-modal-body");
    await waitForText("Fix Mobile Badge Sync Scroll Cutoff");
    await waitForText("Accept or refuse task");
    await sleep(250);

    const initialMetrics = await modalMetrics();
    await capture(`${screenshotPrefix}-mobile-task-top`);

    await evaluate(`(() => {
      const body = document.querySelector('.task-modal-body');
      if (!body) throw new Error('task modal body missing');
      body.scrollTo({ top: body.scrollHeight, behavior: 'instant' });
      return true;
    })()`);
    await sleep(250);

    const bottomMetrics = await modalMetrics();
    await waitForText("Submit a pull request URL or patch file");
    await capture(`${screenshotPrefix}-mobile-task-bottom`);

    const maxScrollTop = Math.max(0, bottomMetrics.scrollHeight - bottomMetrics.clientHeight);
    const reachedBottom = maxScrollTop === 0 || bottomMetrics.scrollTop >= maxScrollTop - 8;
    const contentScrollable = initialMetrics.scrollHeight > initialMetrics.clientHeight + 8;
    const horizontallyFitted = bottomMetrics.layerLeft <= 1 &&
      bottomMetrics.modalLeft <= 1 &&
      bottomMetrics.modalRight <= bottomMetrics.viewportWidth + 1 &&
      bottomMetrics.bodyRight <= bottomMetrics.viewportWidth + 1;

    if (!contentScrollable) {
      throw new Error(`task modal body is not scrollable: ${JSON.stringify(initialMetrics)}`);
    }
    if (!reachedBottom) {
      throw new Error(`task modal body did not reach bottom: ${JSON.stringify(bottomMetrics)}`);
    }
    if (!horizontallyFitted) {
      throw new Error(`task modal is horizontally clipped on mobile: ${JSON.stringify(bottomMetrics)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      taskId,
      viewport,
      screenshots: {
        top: join(screenshotDir, `${screenshotPrefix}-mobile-task-top.png`),
        bottom: join(screenshotDir, `${screenshotPrefix}-mobile-task-bottom.png`),
      },
      metrics: {
        initial: initialMetrics,
        bottom: bottomMetrics,
        contentScrollable,
        reachedBottom,
        horizontallyFitted,
      },
    }, null, 2));
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
  }
}

async function installFixtureFetch() {
  const source = `(() => {
    const taskId = ${JSON.stringify(taskId)};
    const now = "2026-06-26T21:58:00.000Z";
    const task = {
      id: taskId.slice(0, 12),
      fullId: taskId,
      taskId,
      title: "Fix Mobile Badge Sync Scroll Cutoff",
      kind: "Network",
      originalKind: "Network task",
      taskClass: "network",
      isNetworkTask: true,
      status: "Proposed",
      statusKey: "proposed",
      statusTone: "pending",
      due: "Jun 26, 9:58 PM UTC",
      fullDue: "Jun 26, 9:58 PM UTC",
      dueLabel: "Proposed",
      dueAt: "2026-06-26T21:58:00.000Z",
      acceptBy: "2026-06-26T21:58:00.000Z",
      ago: "just now",
      pft: 30000,
      description:
        "Contributor Activation and Eligibility needs a code fix for the mobile badge sync flow where task content is cut off and cannot scroll. Build on the findings from task_976cc2b763d071ba45bb01944d6d861c and task_3d179eb7a34f3fe584e9c34b986481a4 by submitting a reviewable patch or pull request instead of another analysis. Include evidence that the issue is resolved on a mobile viewport.",
      steps: [
        "Inspect the contributor activation and badge sync UI to identify the CSS or layout causing the mobile cutoff and scroll failure.",
        "Implement the fix and create a pull request or patch file with a brief summary of the change.",
        "Capture before and after screenshots on a mobile-width viewport showing the task content is fully scrollable.",
        "Submit the PR or patch, screenshots, and a Discord announcement linking or describing the public work artifact."
      ],
      verification: {
        title: "Submit Mixed",
        body:
          "Submit a pull request URL or patch file, before/after mobile screenshots, and a short description of the CSS/layout change. Also include a Discord message ID/link or a screenshot showing the task announcement in an approved Post Fiat Discord channel.",
        policy: { verification_type: "mixed" }
      },
      submissionRequirement: {
        type: "mixed",
        criteria:
          "Submit a pull request URL or patch file, before/after mobile screenshots, and a short description of the CSS/layout change."
      },
      verificationPolicy: { verification_type: "mixed" },
      submissionType: "mixed",
      requestBundleCid: "bafybeimobilebadgesyncscrollfixture",
      contextCid: "bafybeicontextfixture",
      txHash: "offchain:task-modal-mobile-scroll",
      source: "fixture",
      updatedAt: now,
      updatedAtDisplay: "Jun 26, 2026, 9:58 PM UTC",
      lastEventAt: now,
      lastEventAtDisplay: "Jun 26, 2026, 9:58 PM UTC",
      metadata: {
        eventCount: 1,
        generatedTask: {},
        networkTask: {
          required_badge_id: "core_contributor",
          operating_badge_id: "core_contributor",
          badge_work_type: "code_task",
          badge_reward_cap_pft: 30000
        }
      }
    };
    const detail = {
      ok: true,
      partial: false,
      source: "fixture",
      task,
      wallets: {
        user: "rMobileBadgeSyncScrollFixture",
        authority: "rTaskAuthorityFixture",
        allocation: ""
      },
      actions: {
        canAccept: true,
        canStop: true,
        stopLabel: "Refuse task",
        browserSubmissionEnabled: false,
        canSubmitInitialEvidence: false,
        canSubmitVerificationEvidence: false
      },
      submission: {
        summaries: [],
        generatedTask: {},
        verificationPolicy: task.verificationPolicy
      },
      currentVerificationRequest: null,
      rewardOutcome: null,
      forensics: {
        source: "fixture",
        eventCount: 1,
        requestBundleCid: task.requestBundleCid,
        contextCid: task.contextCid,
        lastEventTxHash: task.txHash,
        lastEventCid: "",
        cids: [],
        transactions: [{ txHash: task.txHash, label: "Latest task event" }],
        timeline: [],
        pointerEvents: [],
        reducerEvents: [],
        reviewState: null,
        integrity: {
          expectedEventCount: 1,
          pointerEventCount: 0,
          reducerEventCount: 0,
          renderedEventCount: 0,
          missingTimelineRows: false,
          pendingReducerCount: 0,
          processingReducerCount: 0,
          failedReducerCount: 0,
          failedReducerExamples: [],
          latestReducerUpdatedAt: null,
          latestReducerProcessedAt: null,
          latestCachedPointer: null,
          projectionBehindCachedPointer: false
        }
      },
      sync: {
        updatedAt: task.updatedAt,
        lastEventAt: task.lastEventAt,
        requiresRefresh: false,
        nextPollMs: null,
        refreshReason: ""
      }
    };
    const appState = {
      session: {
        status: "signed_in",
        accountId: "acct_mobile_badge_sync_scroll",
        displayName: "Mobile Badge QA",
        identityProfile: {
          handleRequired: false,
          aliases: [],
          linkedProviders: []
        }
      },
      wallet: {
        pftWallet: {
          status: "linked",
          address: "rMobileBadgeSyncScrollFixture"
        },
        pftBalance: { available: 125000 }
      },
      chat: { recents: [] },
      usage: { availableCreditUsd: 25 },
      context: { document: { title: "Fixture Context", body: "" } },
      tasks: {
        outstanding: [task],
        verification: [],
        refused: [],
        rewarded: [],
        networkTasks: {
          schema: "pf.task_node.network_task_eligibility.v1",
          status: "available_for_routing",
          label: "Available for Network Tasks",
          summary: "Fixture account is badge eligible.",
          gates: [],
          badgeEligibility: {
            status: "available",
            verifiedBadgeIds: ["core_contributor"],
            defaultBadge: "core_contributor",
            hasNonAnonOperatingBadge: true,
            allowedWorkTypes: ["code_task"],
            rewardCaps: { core_contributor: 30000 },
            summary: "Core Contributor badge is active."
          }
        },
        requests: {
          items: [],
          sync: {
            source: "fixture",
            status: "empty",
            walletAddress: "rMobileBadgeSyncScrollFixture",
            requestCount: 0,
            lastUpdatedAt: now
          }
        },
        sync: {
          source: "fixture",
          status: "ready",
          walletAddress: "rMobileBadgeSyncScrollFixture",
          projectionCount: 1,
          lastSyncedAt: now,
          requiresRefresh: false,
          forceProjectionRefresh: false,
          nextPollMs: null,
          refreshReason: "",
          activeRequestCount: 0,
          refreshTaskIds: []
        }
      }
    };
    const originalFetch = window.fetch.bind(window);
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    }));
    window.fetch = (input, init = {}) => {
      const rawUrl = typeof input === "string" ? input : input?.url || "";
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname === "/runtime-config.json") {
        return json({
          taskLifecycle: { offchainEnabled: true, dualWrite: false },
          pftlExplorerUrl: ""
        });
      }
      if (url.pathname === "/api/app-state") return json(appState);
      if (url.pathname === "/api/tasks/detail") return json(detail);
      if (url.pathname === "/api/profile/public") {
        return json({ ok: true, profile: { heroNft: null } });
      }
      if (url.pathname === "/api/wallet/balance") {
        return json({ ok: true, wallet: appState.wallet });
      }
      if (url.pathname === "/api/user-observability/event") {
        return json({ ok: true });
      }
      return originalFetch(input, init);
    };
  })();`;

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
}

async function waitForPage() {
  const endpoint = `http://127.0.0.1:${debugPort}/json/list`;
  for (let index = 0; index < 120; index += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chrome debugging page.");
}

async function waitForSelector(selector, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for selector ${selector}`);
}

async function waitForText(text, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`);
    if (found) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for text ${text}`);
}

async function modalMetrics() {
  return await evaluate(`(() => {
    const body = document.querySelector('.task-modal-body');
    const layer = document.querySelector('.task-modal-layer');
    const modal = document.querySelector('.task-modal');
    if (!body) throw new Error('task modal body missing');
    const rect = body.getBoundingClientRect();
    const layerRect = layer?.getBoundingClientRect() || { left: 0, right: 0 };
    const modalRect = modal?.getBoundingClientRect() || { left: 0, right: 0 };
    return {
      scrollTop: Math.round(body.scrollTop),
      scrollHeight: Math.round(body.scrollHeight),
      clientHeight: Math.round(body.clientHeight),
      layerLeft: Math.round(layerRect.left),
      layerRight: Math.round(layerRect.right),
      modalLeft: Math.round(modalRect.left),
      modalRight: Math.round(modalRect.right),
      bodyLeft: Math.round(rect.left),
      bodyRight: Math.round(rect.right),
      modalTop: Math.round(rect.top),
      modalBottom: Math.round(rect.bottom),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      verificationVisible: document.body.innerText.includes('Submit a pull request URL or patch file')
    };
  })()`);
}

async function capture(name) {
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

import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState } from "./app-state.js";
import {
  authCallback,
  authProviders,
  authStart,
  chatEstimate,
  chatSend,
  contextActionStart,
  contextActions,
  readiness,
  walletActionStart,
  walletActions,
} from "./product-contracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 8080);
const buildId = process.env.VITE_BUILD_ID || process.env.BUILD_ID || "dev";
const environment = process.env.TASKNODE_ENV || process.env.NODE_ENV || "development";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJson(req, maxBytes = 16384) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    const parseError = new Error("invalid_json");
    parseError.status = 400;
    throw parseError;
  }
}

function runtimeConfig() {
  return {
    appName: "tasknodeofficial",
    buildId,
    environment,
    siteOrigin: process.env.VITE_SITE_ORIGIN || process.env.TASKNODE_PUBLIC_URL || "",
    pftlExplorerUrl: process.env.VITE_PFTL_EXPLORER_URL || process.env.PFTL_EXPLORER_URL || "",
    pftlWssUrl: process.env.VITE_PFTL_WSS_URL || "",
    analyticsEnabled: process.env.VITE_ANALYTICS_ENABLED !== "false",
    posthogHost: process.env.VITE_POSTHOG_HOST || process.env.POSTHOG_UI_HOST || "",
    posthogKeyPresent: Boolean(process.env.POSTHOG_KEY || process.env.VITE_POSTHOG_KEY),
  };
}

function runtimeConfigScript(res) {
  const script = `window.__TASKNODE_CONFIG__ = ${JSON.stringify(runtimeConfig())};\n`;
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(script);
}

function isInsideDist(filePath) {
  const relative = path.relative(distDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function serveStatic(url, res) {
  const requestPath = url.pathname;
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(distDir, relative));

  if (!isInsideDist(filePath) || !existsSync(filePath)) {
    const fallback = path.join(distDir, "index.html");
    if (!existsSync(fallback)) {
      json(res, 404, { ok: false, error: "build_not_found" });
      return;
    }
    const html = await readFile(fallback);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": contentTypes.get(ext) || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(res);
}

async function routeApi(req, url, res) {
  const state = appState();
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/app-state") {
    json(res, 200, state);
    return true;
  }

  if (url.pathname === "/api/session") {
    json(res, 200, state.session);
    return true;
  }

  if (url.pathname === "/api/auth/providers") {
    json(res, 200, { providers: authProviders() });
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "start" && parts[3]) {
    const result = authStart(parts[3]);
    json(res, result.status, result.body);
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "callback" && parts[3]) {
    const result = authCallback(parts[3]);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/readiness") {
    json(res, 200, readiness());
    return true;
  }

  if (url.pathname === "/api/tasks") {
    json(res, 200, state.tasks);
    return true;
  }

  if (url.pathname === "/api/chat/estimate") {
    const payload = req.method === "POST" ? await readJson(req) : {};
    json(res, 200, chatEstimate(payload));
    return true;
  }

  if (url.pathname === "/api/chat/send") {
    const payload = req.method === "POST" ? await readJson(req) : {};
    const result = chatSend(payload, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/wallet") {
    json(res, 200, state.wallet);
    return true;
  }

  if (url.pathname === "/api/wallet/actions") {
    json(res, 200, { actions: walletActions() });
    return true;
  }

  if (
    url.pathname === "/api/wallet/link/start" ||
    url.pathname === "/api/wallet/unlock/start" ||
    url.pathname === "/api/wallet/delink" ||
    url.pathname === "/api/wallet/relink/start"
  ) {
    const result = walletActionStart(url.pathname, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context") {
    json(res, 200, state.context);
    return true;
  }

  if (url.pathname === "/api/context/actions") {
    json(res, 200, { actions: contextActions() });
    return true;
  }

  if (
    url.pathname === "/api/context/import/start" ||
    url.pathname === "/api/context/edit/save" ||
    url.pathname === "/api/context/manifest/ink"
  ) {
    const result = contextActionStart(url.pathname, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage") {
    json(res, 200, state.usage);
    return true;
  }

  return false;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://tasknode.local");

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      service: "tasknodeofficial",
      environment,
      buildId,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  if (url.pathname === "/runtime-config.js") {
    runtimeConfigScript(res);
    return;
  }

  if (url.pathname === "/runtime-config.json") {
    json(res, 200, runtimeConfig());
    return;
  }

  routeApi(req, url, res)
    .then((handled) => {
      if (handled) return;

      serveStatic(url, res).catch((error) => {
        json(res, 500, { ok: false, error: error?.message || "internal_error" });
      });
    })
    .catch((error) => {
      json(res, error?.status || 500, {
        ok: false,
        error: error?.message || "internal_error",
      });
    });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`tasknodeofficial listening on :${port}`);
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { json, securityHeaders } from "./server-http-boundary.js";

const cliRoot = fileURLToPath(new URL("../packages/tasknode-cli/", import.meta.url));
const runtimeFiles = [
  "bin/tasknode.mjs",
  "package.json",
  "package-lock.json",
  "lib/prompt-crypto.mjs",
  "lib/prompt-device.mjs",
  "lib/prompt-stats.mjs",
  "lib/prompt-pad.mjs",
  "lib/prompt-client.mjs",
  "lib/prompt-mcp.mjs",
  "lib/prompt-agent-config.mjs",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let releasePromise;

export function readAgentRelease() {
  releasePromise ||= Promise.all(
    runtimeFiles.map(async (name) => [name, await readFile(path.join(cliRoot, name))]),
  ).then((entries) => {
    const bodies = new Map(entries);
    const files = Object.fromEntries(entries.map(([name, body]) => [name, digest(body)]));
    const releaseId = digest(JSON.stringify(files));
    return { manifest: { releaseId, files }, bodies };
  });
  return releasePromise;
}

export async function handleAgentRelease({ req, res, url }) {
  if (url.pathname !== "/install/manifest.json" && !url.pathname.startsWith("/install/releases/")) return false;
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const { manifest, bodies } = await readAgentRelease();
  if (url.pathname === "/install/manifest.json") {
    json(res, 200, manifest, { "cache-control": "no-store" });
    return true;
  }
  const prefix = `/install/releases/${manifest.releaseId}/`;
  const body = url.pathname.startsWith(prefix) && bodies.get(url.pathname.slice(prefix.length));
  if (!body) {
    json(res, 404, { error: "release_file_not_available" });
    return true;
  }
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(body);
  return true;
}

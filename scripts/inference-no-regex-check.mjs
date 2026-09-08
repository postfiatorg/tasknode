import { inferenceCallGraph } from "./inference-call-graph.mjs";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "espree";

// All inference entry points, plus the audited prompt/input/output helpers.
const helpers = [
  "server/profile-nft-generation.js", "server/profile-nft-daily-worker.js", "server/profile-nft-render-worker.js", "server/profile-nft-image-provider.js",
  "server/board-agent-dispatch.js", "ops/bm-runtime/supervisor.mjs",
  "server/task-request.js", "server/task-request-command.js", "server/task-request-context.js",
  "server/task-request-intent.js", "server/task-request-terminal-bundle.js", "server/task-generation-worker.js",
  "server/network-task-generation-worker.js", "server/repositories/task-requests.js",
  "server/repositories/network-task-generation-jobs.js", "server/repositories/network-task-generation-source.js",
  "server/repositories/network-task-enqueue.js", "server/context-ipfs.js", "server/pftl-submit.js",
  "server/collaboration-routes.js",
  "server/chat-attachment-utils.js", "server/chat-client-history.js", "server/chat-task-context.js",
  "server/chat-memory-context.js", "server/chat-provider-usage.js", "server/context-rewrite-worker.js",
  "server/evidence-file-extraction.js", "server/embedding-provider.js", "server/profile-nft-prompts.js",
  "server/jobs-corpus.js", "server/repositories/recommended-connections-ranking.js",
];
const files = new Set(helpers);
for (const directory of ["server", "scripts"]) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
    if (name.endsWith("-smoke.mjs") || name.endsWith("-check.mjs")) continue;
    const file = `${directory}/${name}`;
    const source = await readFile(file, "utf8");
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    if (name.startsWith("inference-") || name === "inference.js" || ast.body.some((node) => node.type === "ImportDeclaration" && ["inference.js", "ambient-inference.js", "vercel-inference.js"].some((suffix) => node.source.value.endsWith(`/${suffix}`)))) files.add(file);
  }
}
const graph = inferenceCallGraph([...files]);
if (process.env.INFERENCE_AUDIT_OUTPUT) await (await import("node:fs/promises")).writeFile(process.env.INFERENCE_AUDIT_OUTPUT, JSON.stringify(graph,null,2));
assert.deepEqual(graph.violations, [], "Regular expressions are prohibited on inference paths, including reachable imported helpers");
console.log(JSON.stringify({ ok: true, entryFiles: files.size, checkedFiles: graph.files.length }));

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";
import { importTaskReplayReceipt } from "../server/repositories/tasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const runsDir = path.join(repoRoot, "reference_clients/python/runs");
const defaultRunPrefixes = ["app_request_", "task_engine_n1_"];

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

async function findDefaultReceipts() {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !defaultRunPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }
    const receiptPath = path.join(runsDir, entry.name, "receipt_public.json");
    try {
      const info = await stat(receiptPath);
      receipts.push({ path: receiptPath, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore incomplete run directories.
    }
  }
  receipts.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return receipts.map((item) => item.path);
}

const explicitPaths = process.argv.slice(2).map((item) => path.resolve(process.cwd(), item));
const receiptPaths = explicitPaths.length > 0 ? explicitPaths : await findDefaultReceipts();

if (receiptPaths.length === 0) {
  throw new Error("No task replay receipt_public.json files found.");
}

await migrateDatabase({ force: true });

const imported = [];
for (const receiptPath of receiptPaths) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!receipt?.task_id || !receipt?.fixture?.account_id) {
    continue;
  }
  imported.push(await importTaskReplayReceipt(receipt, {
    sourceRef: path.relative(repoRoot, receiptPath),
  }));
}

console.log(JSON.stringify({ ok: true, imported }, null, 2));
await closePool();

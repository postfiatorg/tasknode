// Ingest one tmux pane capture into board_manager_transcripts (Gate F).
//
// Reads pane text from stdin, scrubs secret-shaped content, deduplicates
// against the previous capture by only inserting the new suffix, and
// appends a single transcript row.
//
// Usage: tmux capture-pane -p -S -2000 -t bm-<alias> | \
//   DATABASE_URL=... node scripts/bm-transcript-ingest.mjs --board <board_id> --session bm-<alias>

import { randomUUID } from "node:crypto";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const { query, closePool } = await import("../server/db/pool.js");

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const boardId = argValue("--board");
const sessionName = argValue("--session");
if (!boardId) {
  console.error("--board required");
  process.exit(1);
}

export function scrubTranscript(text = "") {
  return String(text || "")
    // API keys / bearer-ish tokens
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted-key]")
    .replace(/\b(?:xoxb|ghp|gho|github_pat)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    // connection strings with credentials
    .replace(/\b(postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/[^\s"']+/gi, "$1://[redacted]")
    // long hex (potential seeds/keys/hashes of secrets)
    .replace(/\b[a-fA-F0-9]{64,}\b/g, "[redacted-hex]")
    // XRPL-style family seeds
    .replace(/\bs[a-zA-Z0-9]{28,}\b/g, "[redacted-seed]")
    // env assignments of anything secret-shaped
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|SEED|PASSWORD)[A-Z0-9_]*)\s*=\s*\S+/g, "$1=[redacted]");
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const scrubbed = scrubTranscript(raw).trimEnd();
  if (!scrubbed) return;

  const previous = await query(
    `SELECT content FROM board_manager_transcripts
     WHERE board_id = $1 ORDER BY seq DESC LIMIT 1`,
    [boardId]
  );
  const lastContent = previous.rows[0]?.content || "";

  // Only store when the pane changed; store the full scrubbed pane so each
  // row is a self-contained snapshot (simple, replayable, bounded by pane
  // height requested at capture time).
  if (scrubbed === lastContent) return;

  await query(
    `INSERT INTO board_manager_transcripts (id, board_id, session_name, seq, content)
     VALUES ($1, $2, $3, (SELECT COALESCE(max(seq), 0) + 1 FROM board_manager_transcripts WHERE board_id = $2), $4)`,
    [`bmt_${randomUUID()}`, boardId, sessionName, scrubbed.slice(0, 100000)]
  );

  // Retention: keep the latest 2000 snapshots per board.
  await query(
    `DELETE FROM board_manager_transcripts
     WHERE board_id = $1
       AND seq < (SELECT COALESCE(max(seq), 0) - 2000 FROM board_manager_transcripts WHERE board_id = $1)`,
    [boardId]
  );
}

try {
  await main();
} finally {
  await closePool().catch(() => null);
}

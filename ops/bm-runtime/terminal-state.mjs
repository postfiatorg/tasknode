import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function terminalLifecycle(rows) {
  let state = "unknown", turnId = "", updatedAt = "";
  for (const row of rows) {
    if (row?.type !== "event_msg") continue;
    const event = row.payload || {};
    if (["task_started", "turn_started"].includes(event.type)) {
      state = "busy"; turnId = event.turn_id || ""; updatedAt = row.timestamp;
    } else if (["task_complete", "turn_complete", "turn_aborted"].includes(event.type)) {
      if (turnId && event.turn_id && turnId !== event.turn_id) continue;
      state = "idle"; updatedAt = row.timestamp;
    }
  }
  return { state, turnId, updatedAt };
}

function readSlice(file, tail = false) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, tail ? 1024 * 1024 : 32 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, tail ? size - length : 0);
    const lines = buffer.toString("utf8").split("\n");
    if (tail && size > length) lines.shift();
    return lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { closeSync(fd); }
}

export function readTerminalState({ home, workdir, now = Date.now() }) {
  const candidates = [];
  for (let day = 0; day < 3; day++) {
    const date = new Date(now - day * 86400_000).toISOString().slice(0, 10).split("-");
    const directory = path.join(home, "sessions", ...date);
    let files = []; try { files = readdirSync(directory); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(directory, name);
      const metadata = readSlice(file).find((row) => row.type === "session_meta")?.payload;
      if (metadata?.cwd === workdir) candidates.push({ file, sessionId: metadata.id, mtime: statSync(file).mtimeMs });
    }
  }
  const current = candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (!current) return { state: "unknown" };
  return { ...current, ...terminalLifecycle(readSlice(current.file, true)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(readTerminalState({ home: process.argv[2], workdir: process.argv[3] })));

// `bm` — board manager CLI (Gate B: reads).
//
// The PfTerminal board-manager agents drive the network through this tool.
// Read commands are safe against production via `fly proxy` + DATABASE_URL.
//
// Usage:
//   node scripts/bm.mjs digest <board>
//   node scripts/bm.mjs board <board> [--json]
//   node scripts/bm.mjs user <account_or_wallet> [--json]
//   node scripts/bm.mjs history <board> [--limit N] [--json]
//   node scripts/bm.mjs boards
//
// <board> accepts a full id (board_pf_terminal) or alias (pfterminal, l1v2,
// community, governance, tasknode, capital).

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

import { closePool } from "../server/db/pool.js";
import { DETERMINISTIC_BOARD_IDS } from "../server/board-config.js";
import {
  boardDigest,
  boardHistory,
  boardPacket,
  resolveBoardId,
  userPacket,
} from "./bm/lib.mjs";

const [, , command = "", ...rest] = process.argv;
const positional = rest.filter((arg) => !arg.startsWith("--"));
const asJson = rest.includes("--json");

function flagValue(name, fallback = "") {
  const index = rest.indexOf(name);
  if (index >= 0 && rest[index + 1]) return rest[index + 1];
  const inline = rest.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function pft(value) {
  return `${Number(value || 0).toLocaleString("en-US")} PFT`;
}

function taskLine(task) {
  const who = task.account_id || task.subject_wallet || "unassigned";
  const reward = Number(task.reward_actual_pft || 0) > 0 ? task.reward_actual_pft : task.reward_offer_pft;
  return `  [${task.status}] ${task.task_id} ${JSON.stringify(String(task.title || "").slice(0, 90))} who=${who} reward=${pft(reward)} last=${new Date(task.last_event_at).toISOString()}`;
}

function requireBoard(input) {
  const boardId = resolveBoardId(input);
  if (!boardId) {
    fail(
      `Unknown board ${JSON.stringify(input || "")}. Boards: ${DETERMINISTIC_BOARD_IDS.join(", ")}`
    );
  }
  return boardId;
}

async function main() {
  if (command === "boards") {
    for (const id of DETERMINISTIC_BOARD_IDS) console.log(id);
    return;
  }

  if (command === "digest") {
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const result = await boardDigest(boardId);
    if (!result) return fail(`Board not found in database: ${boardId}. Run migrations.`);
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.boardId} ${result.digest}`);
    return;
  }

  if (command === "board") {
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const packet = await boardPacket(boardId);
    if (!packet) return fail(`Board not found in database: ${boardId}. Run migrations.`);
    if (asJson) return console.log(JSON.stringify(packet, null, 2));
    const { board, tasks } = packet;
    console.log(`# ${board.title} (${board.id}) status=${board.status} phase=${board.phase_label}`);
    console.log(`summary: ${board.summary}`);
    console.log(`sources: ${JSON.stringify(board.sources)}`);
    console.log(`evidence_norms: ${JSON.stringify(board.evidence_norms)}`);
    if (Object.keys(board.routing_constraints || {}).length) {
      console.log(`routing_constraints: ${JSON.stringify(board.routing_constraints)}`);
    }
    console.log(`budget: ${packet.budget.configured ? JSON.stringify(packet.budget) : packet.budget.note}`);
    for (const [bucket, rows] of Object.entries(tasks)) {
      console.log(`\n## ${bucket} (${rows.length})`);
      for (const task of rows.slice(0, 25)) console.log(taskLine(task));
    }
    if (packet.hive_chat_digest) {
      console.log(`\n## hive_chat_digest (${packet.hive_chat_digest.report_id})`);
      console.log(packet.hive_chat_digest.text);
    }
    return;
  }

  if (command === "user") {
    const needle = positional[0] || "";
    if (!needle) return fail("Usage: bm user <account_or_wallet>");
    const packet = await userPacket(needle, { limit: Number(flagValue("--limit", "20")) || 20 });
    if (asJson) return console.log(JSON.stringify(packet, null, 2));
    console.log(`# user ${packet.query}`);
    console.log(`totals: tasks=${packet.totals.tasks} rewarded=${pft(packet.totals.reward_pft)}`);
    for (const row of packet.by_status) {
      console.log(`  ${row.status}: ${row.n} (${pft(row.reward_pft)})`);
    }
    console.log(`\n## badges (${packet.badges.length})`);
    for (const badge of packet.badges) {
      console.log(
        `  ${badge.badge_id} status=${badge.status}${badge.revoked_at ? " REVOKED" : ""} account=${badge.account_id}`
      );
    }
    console.log(`\n## recent tasks (${packet.recent_tasks.length})`);
    for (const task of packet.recent_tasks) console.log(taskLine(task));
    return;
  }

  if (command === "history") {
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const result = await boardHistory(boardId, { limit: Number(flagValue("--limit", "30")) || 30 });
    if (asJson) return console.log(JSON.stringify(result, null, 2));
    console.log(`# ${boardId} completions (${result.completions.length})`);
    for (const task of result.completions) console.log(taskLine(task));
    return;
  }

  fail(
    [
      "Usage: node scripts/bm.mjs <command>",
      "  boards                      list board ids",
      "  digest <board>              state digest (whip trigger input)",
      "  board <board> [--json]      full board packet",
      "  user <account|wallet>       task history + badges",
      "  history <board> [--limit N] terminal task history",
    ].join("\n")
  );
}

try {
  await main();
} finally {
  await closePool().catch(() => null);
}

// `bm` — board manager CLI (Gate B: reads).
//
// The PfTerminal board-manager agents drive the network through this tool.
// Read commands are safe against production via `fly proxy` + DATABASE_URL.
//
// Usage:
//   node scripts/bm.mjs digest <board>
//   node scripts/bm.mjs refresh <board> [--json]
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
// The CLI usually reaches Postgres through the fly mpg proxy; give queries
// more headroom than the in-DC server default so heavy source-packet reads
// do not flake into nulls.
if (!process.env.DATABASE_STATEMENT_TIMEOUT_MS) {
  process.env.DATABASE_STATEMENT_TIMEOUT_MS = "30000";
}

import { closePool } from "../server/db/pool.js";
import { DETERMINISTIC_BOARD_IDS } from "../server/board-config.js";
import {
  boardDigest,
  boardHistory,
  boardPacket,
  refreshBoardRepositories,
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

  if (command === "refresh") {
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const result = await refreshBoardRepositories(boardId);
    if (!result) return fail(`Board not found in database: ${boardId}. Run migrations.`);
    if (asJson) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.boardId} refreshed=${result.refreshedAt}`);
    for (const lead of result.source_leads || []) {
      console.log(
        `  ${lead.repo} fetch_verified=${lead.fetch_verified} refreshed_at=${lead.fetch_refreshed_at || "never"} relation=${lead.checkout_relation}`
      );
      if (lead.checkout_warning) console.log(`    warning ${lead.checkout_warning}`);
    }
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
    const idle = packet.idle_eligible_contributors || [];
    console.log(`\n## idle_eligible_contributors (${idle.length}) — badge-verified, free capacity, strongest first`);
    for (const contributor of idle.slice(0, 10)) {
      console.log(
        `  ${contributor.account_id} badges=${(contributor.badges || []).join(",")} rewarded=${contributor.rewarded_tasks}`
      );
    }
    for (const lead of packet.source_leads || []) {
      const commitLabel = lead.current_commit_verified
        ? lead.head
        : `BLOCKED (${lead.checkout_relation || "unverified"})`;
      console.log(
        `\n## source_leads: ${lead.repo} (current ${commitLabel}, ${lead.todo_count} verified TODO/FIXME markers; fetch_verified=${Boolean(lead.fetch_verified)}; fetch_refreshed_at=${lead.fetch_refreshed_at || "never"})`
      );
      if (lead.checkout_warning) console.log(`  warning ${lead.checkout_warning}`);
      for (const commit of (lead.recent_commits || []).slice(0, 5)) console.log(`  commit ${commit}`);
      for (const todo of (lead.todo_sample || []).slice(0, 10)) console.log(`  ${todo}`);
      for (const reference of (lead.unverified_references || []).slice(0, 5)) {
        console.log(`  warning ${reference.warning}`);
      }
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

  if (command === "review") {
    const { reviewTask } = await import("./bm/writes.mjs");
    const taskId = positional[0] || "";
    if (!taskId) return fail("Usage: bm review <taskId> --decision reward|partial_reward|reject --pft N --reason ... [--feedback ...]");
    const result = await reviewTask({
      taskId,
      decision: flagValue("--decision"),
      pft: Number(flagValue("--pft", "0")),
      reason: flagValue("--reason"),
      feedback: flagValue("--feedback"),
    });
    console.log(JSON.stringify({
      decision_id: result.decision.id,
      status: result.decision.status,
      requested_pft: result.decision.requested_reward_pft,
      clamped_pft: result.clampedPft,
      caps_applied: result.capCheck.capsApplied,
      refused: result.refused,
    }, null, 2));
    if (result.refused) {
      console.error("REFUSED by caps: escalate to operator via `bm refer-merge`/network task if this reward is justified.");
    }
    return;
  }

  if (command === "verify") {
    const { verifyRequest } = await import("./bm/writes.mjs");
    const sub = positional[0];
    const taskId = positional[1] || "";
    if (sub !== "request" || !taskId) return fail("Usage: bm verify request <taskId> --ask ... [--type evidence] [--reason ...]");
    const result = await verifyRequest({
      taskId,
      ask: flagValue("--ask"),
      type: flagValue("--type", "evidence"),
      reason: flagValue("--reason"),
    });
    console.log(JSON.stringify({ decision_id: result.decision.id, status: result.decision.status }, null, 2));
    return;
  }

  if (command === "task" && positional[0] === "create") {
    const { taskCreate } = await import("./bm/writes.mjs");
    const boardId = requireBoard(positional[1]);
    if (!boardId) return;
    const result = await taskCreate({
      boardId,
      accountId: flagValue("--account"),
      wallet: flagValue("--wallet"),
      need: flagValue("--need"),
      reason: flagValue("--reason") || undefined,
      workType: flagValue("--work-type", "code_task"),
      requiredBadge: flagValue("--required-badge"),
      badgeCap: Number(flagValue("--badge-cap", "0")),
      rewardMin: Number(flagValue("--reward-min", "0")),
      rewardMax: Number(flagValue("--reward-max", "0")),
      assigneeHandle: flagValue("--assignee-handle"),
      acceptWindowHours: Number(flagValue("--accept-window-hours", "0")),
      execute: rest.includes("--execute"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "task" && positional[0] === "cancel") {
    const { cancelTask } = await import("./bm/writes.mjs");
    const taskId = positional[1] || "";
    if (!taskId) return fail("Usage: bm task cancel <taskId> --reason ... [--execute]");
    const result = await cancelTask({
      taskId,
      reason: flagValue("--reason"),
      execute: rest.includes("--execute"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "refer-badge") {
    const { referBadge } = await import("./bm/writes.mjs");
    const result = await referBadge({
      accountId: positional[0] || "",
      badgeId: positional[1] || "",
      evidence: flagValue("--evidence"),
      boardId: resolveBoardId(flagValue("--board", "tasknode")) || "board_tasknode_fixes",
      operatorAccount: flagValue("--operator-account"),
      operatorWallet: flagValue("--operator-wallet"),
      execute: rest.includes("--execute"),
    });
    console.log(JSON.stringify({ runId: result.runId, dryRun: result.dryRun }, null, 2));
    return;
  }

  if (command === "refer-merge") {
    const { referMerge } = await import("./bm/writes.mjs");
    const result = await referMerge({
      prUrl: flagValue("--pr-url") || positional[0] || "",
      summary: flagValue("--summary"),
      boardId: resolveBoardId(flagValue("--board", "tasknode")) || "board_tasknode_fixes",
      operatorAccount: flagValue("--operator-account"),
      operatorWallet: flagValue("--operator-wallet"),
      execute: rest.includes("--execute"),
    });
    console.log(JSON.stringify({ runId: result.runId, dryRun: result.dryRun }, null, 2));
    return;
  }

  if (command === "board-update") {
    const { boardUpdate } = await import("./bm/writes.mjs");
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const payload = { boardId };
    for (const field of ["title", "summary", "objective", "about", "status", "priority", "phase_label"]) {
      const value = flagValue(`--${field.replace("_", "-")}`);
      if (value) payload[field] = value;
    }
    const row = await boardUpdate(payload);
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  if (command === "journal") {
    const { journalAppend } = await import("./bm/writes.mjs");
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const text = flagValue("--text");
    const result = await journalAppend({ boardId, text });
    console.log(result.file);
    return;
  }

  if (command === "handoff") {
    const { writeHandoff } = await import("./bm/writes.mjs");
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const result = await writeHandoff({ boardId });
    console.log(result.file);
    return;
  }

  if (command === "duties") {
    // Deterministic per-round work order across one or more boards.
    const { computeBoardDuties, formatDuties } = await import("./bm/lib.mjs");
    const boardIds = positional.length
      ? positional.map((input) => resolveBoardId(input)).filter(Boolean)
      : [...DETERMINISTIC_BOARD_IDS];
    if (!boardIds.length) return fail("Usage: bm duties [board...] (default: all boards)");
    const result = await computeBoardDuties(boardIds);
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(formatDuties(result));
      console.log(`\nduties_digest ${result.digest}`);
    }
    return;
  }

  if (command === "activity") {
    // Rows in bm_audit_log for this board since a timestamp. The whip uses
    // this as the processing acknowledgment for injected wakes: the agent's
    // contract requires journaling every wake, so zero activity after an
    // injection means the wake was lost and must be re-delivered.
    const boardId = requireBoard(positional[0]);
    if (!boardId) return;
    const since = flagValue("--since");
    if (!since) return fail("Usage: bm activity <board> --since <iso8601>");
    const { query } = await import("../server/db/pool.js");
    const result = await query(
      `SELECT count(*)::int AS n FROM bm_audit_log WHERE board_id = $1 AND created_at > $2::timestamptz`,
      [boardId, since]
    );
    console.log(result.rows[0].n);
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
      "  refresh <board> [--json]    serialized origin refresh for source checkouts",
      "  board <board> [--json]      full board packet (incl. budget + pending decisions)",
      "  user <account|wallet>       task history + badges",
      "  history <board> [--limit N] terminal task history",
      "  duties [board...]           deterministic per-round work order (whip input)",
      "  task create <board> --account --wallet --need [--reward-max N] [--execute]",
      "  task cancel <taskId> --reason ... [--execute]   (proposed/accepted network tasks only)",
      "  verify request <taskId> --ask ... [--type evidence]",
      "  review <taskId> --decision reward|partial_reward|reject --pft N --reason ...",
      "  refer-badge <account> <badge> [--evidence ...] [--execute]",
      "  refer-merge --pr-url <url> [--summary ...] [--execute]",
      "  board-update <board> [--title ...] [--summary ...] [--status ...]",
      "  journal <board> --text ...",
      "  handoff <board>",
    ].join("\n")
  );
}

try {
  await main();
} finally {
  await closePool().catch(() => null);
}

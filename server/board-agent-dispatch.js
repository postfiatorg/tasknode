import { publishAgentRuntimeStatus } from "./board-agent-runtime-status.js";
import { boardTaskDetail } from "./board-task-detail.js";
import { query } from "./db/pool.js";
import { assertBoardAgentScope, boardAgentIdentity } from "./board-agent-context.js";
import { boardForTask } from "./repositories/bm-decisions.js";
import { boardDigest, boardHistory, boardPacket, computeBoardDuties, resolveBoardId } from "../scripts/bm/lib.mjs";
import * as writes from "../scripts/bm/writes.mjs";
import { openAgentRound, readAgentRound, recordDutyResult } from "./board-agent-rounds.js";
import { listHiveGroupEscalations } from "./repositories/hive-group.js";
import { replyToHiveEscalation } from "./hive-group-board.js";

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function parseAgentCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 80 || argv.some((item) => typeof item !== "string" || item.length > 32_000)) throw bad("board_agent_arguments_invalid");
  const [command, ...rest] = argv;
  const args = [], flags = {};
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (!value.startsWith("--")) { args.push(value); continue; }
    const equal = value.indexOf("=");
    const key = equal < 0 ? value.slice(2) : value.slice(2, equal);
    if (["__proto__", "constructor", "prototype"].includes(key)) throw bad("board_agent_flag_invalid");
    flags[key] = equal >= 0 ? value.slice(equal + 1) : ["json", "execute", "stale-only"].includes(key) ? true : rest[++index];
    if (flags[key] === undefined) throw bad("board_agent_flag_value_required");
  }
  return { command, args, flags };
}

export async function dispatchBoardAgent(argv) {
  const { command, args, flags: f } = parseAgentCommand(argv);
  const identity = boardAgentIdentity();
  const board = (value) => { const id = resolveBoardId(value); assertBoardAgentScope(id); return id; };
  const task = async (id) => { assertBoardAgentScope(await boardForTask(id)); return id; };
  const boards = () => args.length ? args.map(board) : identity.boards;
  const number = (key, fallback = 0) => { const value = f[key] === undefined ? fallback : Number(f[key]); if (!Number.isFinite(value)) throw bad(`board_agent_number_invalid:${key}`); return value; };
  const required = (key) => {
    if (typeof f[key] !== "string" || !f[key].trim()) throw bad(`board_agent_required_flag:${key}`);
    return f[key];
  };
  if (command === "runtime-status") return publishAgentRuntimeStatus({ state: f.state, roundId: f.round || "" });
  if (command === "boards") return identity.boards;
  if (command === "board") return boardPacket(board(args[0]));
  if (command === "digest") return boardDigest(board(args[0]));
  if (command === "history") return boardHistory(board(args[0]), { limit: Math.min(100, Math.max(1, number("limit", 30))) });
  if (command === "duties") return computeBoardDuties(boards());
  if (command === "hive-inbox") return listHiveGroupEscalations(boards());
  if (command === "hive-reply") return replyToHiveEscalation({ id: args[0], message: required("message"), outcome: required("outcome") });
  if (command === "round-open") return openAgentRound(boards());
  if (command === "round-status") return readAgentRound(args[0]);
  if (command === "task" && args[0] === "detail") return boardTaskDetail(args[1]);
  if (command === "duty-result") return recordDutyResult({ roundId: args[0], dutyId: args[1], outcome: f.outcome, reason: f.reason });
  if (command === "user") {
    // Board agents receive board-linked task history and badge evidence, not
    // the contributor's private personal tasks, chats or context document.
    const history = await query(`SELECT DISTINCT tp.task_id,tp.account_id,tp.subject_wallet,tp.status,tp.title,tp.reward_actual_pft
      FROM task_projections tp JOIN network_task_allocations a ON a.generated_task_id=tp.task_id
      WHERE a.project_id=ANY($1::text[]) AND (tp.account_id=$2 OR tp.subject_wallet=$2)
      ORDER BY tp.task_id LIMIT 100`, [identity.boards, args[0]]);
    const badges = await query(`SELECT account_id,badge_id,status FROM account_network_badges WHERE account_id=$1`, [args[0]]);
    return { query: args[0], recent_tasks: history.rows, badges: badges.rows };
  }
  if (command === "review") return writes.reviewTask({ taskId: await task(args[0]), decision: f.decision, pft: number("pft"), reason: f.reason, feedback: f.feedback });
  if (command === "verify" && args[0] === "request") return writes.verifyRequest({ taskId: await task(args[1]), ask: f.ask, type: f.type || "evidence", reason: f.reason });
  if (command === "task" && args[0] === "cancel") return writes.cancelTask({ taskId: await task(args[1]), reason: f.reason, execute: f.execute === true, staleOnly: f["stale-only"] === true });
  if (command === "task" && args[0] === "create") return writes.taskCreate({ boardId: board(args[1]), accountId: required("account"), wallet: required("wallet"), need: required("need"), reason: f.reason, workType: f["work-type"] || "code_task", requiredBadge: f["required-badge"], badgeCap: number("badge-cap"), rewardMin: number("reward-min"), rewardMax: number("reward-max"), assigneeHandle: f["assignee-handle"], acceptWindowHours: number("accept-window-hours"), execute: f.execute === true });
  if (command === "board-update") {
    const payload = { boardId: board(args[0]) };
    for (const field of ["title", "summary", "objective", "about", "status", "priority", "phase_label"]) {
      if (f[field.replace("_", "-")] !== undefined) payload[field] = f[field.replace("_", "-")];
    }
    return writes.boardUpdate(payload);
  }
  if (command === "journal") return writes.journalAppend({ boardId: board(args[0]), text: f.text });
  if (command === "handoff") return writes.writeHandoff({ boardId: board(args[0]) });
  if (command === "refer-badge") return writes.referBadge({ accountId: args[0], badgeId: args[1], evidence: f.evidence, boardId: board(f.board || "tasknode"), execute: f.execute === true });
  if (command === "refer-merge") return writes.referMerge({ prUrl: f["pr-url"] || args[0], summary: f.summary, boardId: board(f.board || "tasknode"), execute: f.execute === true });
  throw bad("board_agent_command_not_supported");
}

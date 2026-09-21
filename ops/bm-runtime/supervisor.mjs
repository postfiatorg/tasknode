import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readAgentRegistry } from "./registry.mjs";
import { remoteBoardCommand } from "../../scripts/bm/remote.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.BM_HOME || path.join(process.env.HOME, "pf-boards");
const stateDir = path.join(home, "state");
const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const save = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
const log = (event) => appendFileSync(path.join(home, "logs", "supervisor.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

export function recoverySchedule(pending = {}) {
  const attempts = Number(pending?.attempts || 0);
  const delivered = Date.parse(pending?.lastDeliveredAt);
  const delayMs = attempts < 3 ? 5 * 60_000 : Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(5, attempts - 3));
  return { attempts, delayMs, nextRetryAt: Number.isFinite(delivered) ? new Date(delivered + delayMs).toISOString() : "" };
}

export function deliveryDecision({ round, status, pending, now = Date.now() }) {
  if (!round?.id || round.state !== "pending") return "quiet";
  if (!terminalStatusFresh(status, now) || !status.ready) return "wait_ready";
  const { attempts, nextRetryAt } = recoverySchedule(pending);
  if (attempts >= 3 && !pending?.alerted) return "alert_pending";
  if (nextRetryAt && now < Date.parse(nextRetryAt)) return attempts >= 3 ? "wait_recovery" : "wait_completion";
  return attempts >= 3 ? "recover" : "deliver";
}

export function terminalStatusFresh(status, now = Date.now()) {
  const age = now - Date.parse(status?.updatedAt);
  return Boolean(status?.version === 1 && Number.isInteger(status.pid) && status.pid > 0 &&
    typeof status.threadId === "string" && status.threadId && Number.isFinite(age) && age >= 0 && age <= 15_000);
}

export function mergeRoundProgress(pending, round) {
  const next = { ...pending, deliveryCount: Math.max(Number(pending?.deliveryCount || 0), Number(pending?.attempts || 0)) };
  const progress = JSON.stringify(round.results_json);
  if (next.progress && next.progress !== progress) { next.attempts = 0; next.alerted = false; next.lastDeliveredAt = ""; }
  next.progress = progress;
  return next;
}

// Cross-round progress tracking. A round completes when every duty has a
// recorded outcome; that proves the work order was answered, not that the task
// advanced. Progress duties disappear from the duty set as soon as the manager
// records the required decision or reply, so the same one reported anything
// but completed in consecutive processed rounds is a stalled task and must
// escalate instead of quietly cycling. Routing, staleness and board-info duties
// recur legitimately (nothing routable, not yet eligible) and are not tracked.
export const RECURRING_BLOCKER_ROUNDS = 2;
export const PROGRESS_DUTY_TYPES = new Set(["review_due", "verification_due", "hive_chat_escalation"]);
// Routing that serves nobody while eligible candidates exist is tracked
// separately: a legitimately quiet round is "deferred" with zero candidates or
// with every candidate carrying a coded reason, and does not escalate at all;
// "not_served" with candidates present escalates after this many rounds.
export const ROUTING_STALL_ROUNDS = 3;

// Keyed by the stable duty identity (type, board, task). Some hashed duty ids
// include staleness timestamps and change every round; the task does not.
export function blockerKey(duty) { return [duty.type, duty.board_id, duty.task_id || ""].join("|"); }

export function trackRecurringBlockers(previous = {}, round) {
  const next = {};
  for (const duty of round?.duties_json || []) {
    const result = round.results_json?.[duty.id];
    if (!result || result.outcome === "completed") continue;
    const routing = duty.type === "routing_due";
    if (!routing && !PROGRESS_DUTY_TYPES.has(duty.type)) continue;
    if (routing && (result.outcome !== "not_served" || !Array.isArray(duty.candidate_ids) || !duty.candidate_ids.length)) continue;
    const key = blockerKey(duty);
    const prior = previous?.[key];
    const entry = {
      dutyId: duty.id, type: duty.type, board_id: duty.board_id, task_id: duty.task_id || "",
      rounds: Number(prior?.rounds || 0) + 1,
      firstRoundId: prior?.firstRoundId || round.id, lastRoundId: round.id,
      lastOutcome: result.outcome, lastReason: String(result.reason || "").slice(0, 600), lastRecordedAt: result.recordedAt || "",
      alertedRounds: Number(prior?.alertedRounds || 0),
      threshold: routing ? ROUTING_STALL_ROUNDS : RECURRING_BLOCKER_ROUNDS,
    };
    if (routing) {
      const byAccount = new Map((duty.candidates || []).map((member) => [member.account_id, member]));
      entry.unserved = (result.dispositions || []).filter((item) => item.disposition === "not_served").map((item) => ({
        account_id: item.account_id, handle: byAccount.get(item.account_id)?.public_handle || "", badges: byAccount.get(item.account_id)?.badges || [],
        reason_code: item.reason_code || "other", reason: String(item.reason || "").slice(0, 200),
      }));
      const codes = entry.unserved.map((item) => item.reason_code);
      entry.dominantReasonCode = codes.sort((a, b) => codes.filter((c) => c === b).length - codes.filter((c) => c === a).length)[0] || "";
    }
    next[key] = entry;
  }
  return next;
}

export function recurringBlockers(blockers = {}) {
  return Object.values(blockers || {}).filter((item) => Number(item.rounds || 0) >= Number(item.threshold || RECURRING_BLOCKER_ROUNDS))
    .sort((a, b) => b.rounds - a.rounds || String(a.task_id).localeCompare(String(b.task_id)));
}

export function escalationDirective(recurring = []) {
  if (!recurring.length) return "";
  const stalledTasks = recurring.filter((item) => item.type !== "routing_due");
  const stalledRouting = recurring.filter((item) => item.type === "routing_due");
  let text = "";
  if (stalledTasks.length) {
    const lines = stalledTasks.map((item) => `- ${item.type}${item.task_id ? ` ${item.task_id}` : ""} (${item.board_id}): ${item.lastOutcome} in ${item.rounds} consecutive rounds; last reason: ${JSON.stringify(item.lastReason.slice(0, 240))}`);
    text += ` ESCALATION - the following duties were reported blocked or deferred in consecutive rounds without task progress:\n${lines.join("\n")}\n` +
      `A repeated identical command cannot change a task's state. For each duty above: run task detail, compare the current status to the submission lifecycle in the skill (submitted -> verify request -> contributor verification response -> review), and issue only the command valid for that status. If the API rejects a command with lifecycle_violation, do not reissue it; quote the exact error text and the task status in the duty result. If the blocker is outside your control, name the exact dependency and who must act.`;
  }
  if (stalledRouting.length) {
    const lines = stalledRouting.map((item) => `- ${item.board_id}: ${item.unserved?.length || 0} eligible contributor(s) unserved for ${item.rounds} consecutive rounds (dominant reason_code ${item.dominantReasonCode || "none"}): ${(item.unserved || []).map((member) => `${member.handle ? "@" + member.handle : member.account_id} [${(member.badges || []).join("/")}] ${member.reason_code}`).join("; ")}`);
    text += ` ROUTING ESCALATION - these boards served nobody for ${ROUTING_STALL_ROUNDS}+ rounds while eligible contributors waited:\n${lines.join("\n")}\n` +
      `A live offer to one contributor does not occupy a board. For every contributor listed, this round must end with either an executed task create (grounded work or an investigation that creates the grounding) or a disposition with a reason_code that a newcomer could verify. source_unavailable means a missing input, not a routing decision: route work that does not need that source. Do not reuse last round's reason text.`;
  }
  return text;
}

export function recurringSummary(recurring = []) {
  if (!recurring.length) return "";
  return JSON.stringify(recurring.map((item) => ({ type: item.type, board_id: item.board_id, task_id: item.task_id, rounds: item.rounds,
    ...(item.type === "routing_due" ? { unserved: item.unserved?.length || 0, reason_code: item.dominantReasonCode || "" } : {}) })));
}

function processAlive(alias) {
  try {
    const pane = execFileSync("tmux", ["list-panes", "-t", `bm-${alias}`, "-F", "#{pane_pid}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
    const children = execFileSync("ps", ["--ppid", pane, "-o", "comm="], { encoding: "utf8" }).split("\n").map((item) => item.trim());
    return children.some((item) => item.startsWith("corbanu") || item.startsWith("pfterminal"));
  } catch { return false; }
}

export async function superviseOnce() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, "logs"), { recursive: true });
  const registry = readAgentRegistry();
  for (const agent of registry.agents) {
    const tokenFile = path.join(home, "credentials", `${agent.alias}.json`);
    if (!existsSync(tokenFile)) throw new Error(`scoped_credential_missing:${agent.alias}`);
    if (!processAlive(agent.alias)) {
      execFileSync(path.join(directory, "bm-launch.sh"), [agent.alias], { stdio: "ignore", timeout: 60_000 });
      log({ alias: agent.alias, event: "relaunched_with_pending_round_preserved" }); continue;
    }
    const pendingFile = path.join(stateDir, `${agent.alias}.pending.json`);
    let pending = read(pendingFile);
    const remote = (argv) => remoteBoardCommand(argv, { tokenFile, stateDir, requestKey: `supervisor_${randomUUID()}` });
    let round = pending?.id ? await remote(["round-status", pending.id]) : null;
    const blockersFile = path.join(stateDir, `${agent.alias}.blockers.json`);
    if (!round || round.state !== "pending") {
      if (round) {
        log({ alias: agent.alias, event: "round_processed", roundId: round.id, outcomes: round.results_json });
        const blockers = trackRecurringBlockers(read(blockersFile) || {}, round);
        for (const item of recurringBlockers(blockers)) {
          if (item.alertedRounds >= item.rounds) continue;
          item.alertedRounds = item.rounds;
          log({ alias: agent.alias, event: "duty_blocked_across_rounds", dutyId: item.dutyId, type: item.type, boardId: item.board_id, taskId: item.task_id, rounds: item.rounds, firstRoundId: item.firstRoundId, lastRoundId: item.lastRoundId, lastOutcome: item.lastOutcome, lastReason: item.lastReason });
          appendFileSync(path.join(home, "ALERTS.log"), item.type === "routing_due"
            ? `${new Date().toISOString()} ${agent.alias}: routing ${item.board_id} served nobody in ${item.rounds} consecutive rounds (${item.firstRoundId}..${item.lastRoundId}); ${item.unserved?.length || 0} eligible unserved; dominant reason_code ${item.dominantReasonCode || "none"}\n`
            : `${new Date().toISOString()} ${agent.alias}: ${item.type}${item.task_id ? ` ${item.task_id}` : ""} ${item.lastOutcome} in ${item.rounds} consecutive rounds (${item.firstRoundId}..${item.lastRoundId}); no task progress; last reason: ${item.lastReason.slice(0, 300)}\n`);
        }
        save(blockersFile, blockers);
      }
      if (existsSync(pendingFile)) unlinkSync(pendingFile);
      round = await remote(["round-open", ...agent.boards]);
      pending = round?.id && round.state === "pending" ? { id: round.id, attempts: 0 } : null;
      if (pending) save(pendingFile, pending);
    }
    if (pending && round?.state === "pending") {
      pending = mergeRoundProgress(pending, round); save(pendingFile, pending);
    }
    const control = path.join(stateDir, `${agent.alias}.control`);
    const status = read(path.join(control, "status.json"));
    const recovery = recoverySchedule(pending);
    const runtimeState = !terminalStatusFresh(status) ? "unavailable" : !status.ready ? "busy" : recovery.attempts >= 3 ? "cooldown" : "ready";
    const recurring = recurringBlockers(read(blockersFile) || {});
    const recurringFlag = recurringSummary(recurring);
    const projected = JSON.stringify([runtimeState, round?.id, round?.state, round?.results_json, recovery, recurringFlag]);
    const feedFile = path.join(stateDir, `${agent.alias}.feed.json`);
    if (read(feedFile)?.projected !== projected) {
      const published = await remote(["runtime-status", "--state", runtimeState, "--attempts", String(recovery.attempts), ...(recovery.nextRetryAt ? ["--next-retry", recovery.nextRetryAt] : []), ...(round?.id ? ["--round", round.id] : []), ...(recurringFlag ? ["--recurring", recurringFlag] : [])]);
      save(feedFile, { projected });
      // Allocation health is computed by the API; the supervisor only alerts.
      const health = published?.allocation_health;
      if (health?.evaluation?.status === "critical") {
        const healthFile = path.join(stateDir, `${agent.alias}.health.json`);
        const last = Date.parse(read(healthFile)?.alertedAt);
        if (!Number.isFinite(last) || Date.now() - last > 6 * 60 * 60_000) {
          appendFileSync(path.join(home, "ALERTS.log"), `${new Date().toISOString()} ${agent.alias}: allocation health critical: ${health.evaluation.label}; boards not served 3+ rounds: ${(health.aggregate.boards_not_served_3_plus || []).join(", ") || "none"}\n`);
          log({ alias: agent.alias, event: "allocation_health_critical", ...health.aggregate });
          save(healthFile, { alertedAt: new Date().toISOString(), aggregate: health.aggregate });
        }
      }
    }
    const decision = deliveryDecision({ round, status, pending });
    if (decision === "alert_pending") {
      if (!pending.alerted) {
        pending.alerted = true; save(pendingFile, pending);
        log({ alias: agent.alias, event: "round_still_pending_after_three_deliveries", roundId: round.id });
        appendFileSync(path.join(home, "ALERTS.log"), `${new Date().toISOString()} ${agent.alias}: round ${round.id} still pending; retained for recovery\n`);
      }
      continue;
    }
    if (!["deliver", "recover"].includes(decision) || existsSync(path.join(control, "inbox.json"))) continue;
    const workdir = path.join(home, "duties", agent.alias);
    mkdirSync(workdir, { recursive: true, mode: 0o700 });
    const file = path.join(workdir, `${round.id}.json`);
    save(file, round); save(path.join(workdir, "latest.json"), round);
    pending.deliveryCount = Number(pending.deliveryCount || 0) + 1;
    const id = `${round.id}_${pending.deliveryCount}`;
    save(path.join(control, "inbox.json"), { id, prompt: `Read the board-manager skill and the durable work order ${file}. Complete each unresolved duty, then report its explicit result using: node ${path.join(directory, "../../scripts/bm.mjs")} duty-result ${round.id} <duty-id> --outcome completed|blocked|deferred|not_served --reason '<specific outcome and evidence>'. A routing_due duty additionally requires --dispositions '<json array>' with one entry per listed candidate: {"account_id","disposition":"routed|investigation_routed|not_served","task_id" (for routed),"reason_code" (for not_served: no_badge_fit|source_unavailable|budget_exhausted|capacity_taken_this_round|restricted_board|contributor_declined_recently|other),"reason"}. Routed entries must match an executed task create for that account this round. Journaling alone does not finish a duty. Refresh board packets before reusing earlier blockers: generation_queue counts and generation_failures describe current work and historical terminal failures separately. A failed job will not flush itself; use the documented explicit provider-failure recovery after revalidating the original need. Keep Kimi K3 as the task manager and follow the existing board rules. This is delivery ${Number(pending.attempts || 0) + 1}; reconcile existing command receipts before repeating a mutation.${escalationDirective(recurring)}` });
    pending.attempts = Number(pending.attempts || 0) + 1;
    pending.lastDeliveredAt = new Date().toISOString();
    save(pendingFile, pending);
    log({ alias: agent.alias, event: decision === "recover" ? "recovery_probe_queued" : "work_queued_for_ready_terminal", roundId: round.id, deliveryId: id, nextRetryAt: recoverySchedule(pending).nextRetryAt });
  }
  save(path.join(stateDir, "scoped-supervisor-tick.json"), { version: 1, pid: process.pid, completedAt: new Date().toISOString() });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  do {
    try { await superviseOnce(); } catch (error) { log({ event: "supervisor_error", error: error.message }); }
    if (!process.argv.includes("--watch")) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  } while (true);
}

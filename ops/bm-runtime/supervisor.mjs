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
    if (!round || round.state !== "pending") {
      if (round) log({ alias: agent.alias, event: "round_processed", roundId: round.id, outcomes: round.results_json });
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
    const projected = JSON.stringify([runtimeState, round?.id, round?.state, round?.results_json, recovery]);
    const feedFile = path.join(stateDir, `${agent.alias}.feed.json`);
    if (read(feedFile)?.projected !== projected) {
      await remote(["runtime-status", "--state", runtimeState, "--attempts", String(recovery.attempts), ...(recovery.nextRetryAt ? ["--next-retry", recovery.nextRetryAt] : []), ...(round?.id ? ["--round", round.id] : [])]);
      save(feedFile, { projected });
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
    save(path.join(control, "inbox.json"), { id, prompt: `Read the board-manager skill and the durable work order ${file}. Complete each unresolved duty, then report its explicit result using: node ${path.join(directory, "../../scripts/bm.mjs")} duty-result ${round.id} <duty-id> --outcome completed|blocked|deferred --reason '<specific outcome and evidence>'. Journaling alone does not finish a duty. Keep Kimi K3 as the task manager and follow the existing board rules. This is delivery ${Number(pending.attempts || 0) + 1}; reconcile existing command receipts before repeating a mutation.` });
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

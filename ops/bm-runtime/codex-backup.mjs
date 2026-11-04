#!/usr/bin/env node
// Codex backup for the board-manager duty. Kimi K3 (the Corbanu terminal) stays the primary manager. When its round
// stalls (three deliveries without a result, or the provider refusing every turn: the 2026-11-04 Kimi Code weekly quota
// returned 429 on all 87 turns after the 06:00 UTC reset), this hands the same durable work order to stock Codex on
// gpt-6.1-terra / xhigh, which records results through the same `bm.mjs duty-result` interface.
//
// Exclusive ownership: the backup takes a lease on the round (state/<alias>.backup-owner.json) before it starts. The
// supervisor never delivers a leased round to Kimi, the backup withdraws a delivery Kimi has not picked up, and it never
// starts while Kimi is mid-turn. The lease is released when Codex exits and expires on its own if the process dies.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTerminalState } from "./terminal-state.mjs";

export const LEASE_TTL_MS = 50 * 60_000;
const PROVIDER_LIMIT = /429|too many requests|usage limit|rate limited|key limit|quota/i;

const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function backupLeaseActive(lease, now = Date.now(), alive = pidAlive) {
  return Boolean(lease?.roundId && Date.parse(lease.expiresAt) > now && alive(lease.pid));
}

// The supervisor's check: hold Kimi delivery while the backup owns this round.
export function deliveryHeldByBackup(lease, round, now = Date.now(), alive = pidAlive) {
  return Boolean(round?.id && lease?.roundId === round.id && backupLeaseActive(lease, now, alive));
}

// True when the terminal's last `turns` completed turns all ended in a provider limit (quota, rate or key limit).
export function providerLimited(rows, turns = 2) {
  const done = rows.filter((row) => row?.type === "event_msg" && row.payload?.type === "task_complete").slice(-turns);
  return done.length === turns && done.every((row) => PROVIDER_LIMIT.test(String(row.payload?.error?.message || "")));
}

function terminalFresh(status, now) {
  const age = now - Date.parse(status?.updatedAt);
  return Boolean(status?.version === 1 && Number.isInteger(status.pid) && status.pid > 0 && Number.isFinite(age) && age >= 0 && age <= 15_000);
}

export function backupDecision({ pending, mark = {}, status, kimiLimited = false, now = Date.now(), force = false, minAttempts = 3, retryMs = 60 * 60_000 }) {
  if (!pending?.id) return "idle";
  // Never run beside a live Kimi turn, forced or not: two managers would race on the same mutations.
  if (terminalFresh(status, now) && status.ready === false && !kimiLimited) return "kimi_busy";
  if (force) return "take_over";
  if (Number(pending.attempts || 0) < minAttempts && !kimiLimited) return "wait_attempts";
  if (mark.roundId === pending.id && now - Date.parse(mark.at || 0) < retryMs) return "wait_retry";
  return "take_over";
}

function tailRows(file, bytes = 1024 * 1024) {
  try {
    const size = statSync(file).size, length = Math.min(size, bytes), fd = openSync(file, "r"), buffer = Buffer.alloc(length);
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    const lines = buffer.toString("utf8").split("\n"); if (size > length) lines.shift();
    return lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

async function main() {
  const HOME = process.env.HOME;
  const BM_HOME = process.env.BM_HOME || `${HOME}/pf-boards`;
  const STATE = `${BM_HOME}/state`;
  const ALIAS = process.env.BM_ALIAS || "pfterminal";
  const REPO = process.env.BM_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const TERMINAL_HOME = process.env.BM_TERMINAL_HOME || `${HOME}/.corbanu`;
  const SKILLS = process.env.BM_SKILLS_DIR || `${TERMINAL_HOME}/skills`;
  const CODEX = process.env.BACKUP_CODEX_BIN || `${HOME}/.npm-global/bin/codex`;
  const MODEL = process.env.BACKUP_MODEL || "gpt-6.1-terra";
  const EFFORT = process.env.BACKUP_EFFORT || "xhigh";
  const LOG = `${BM_HOME}/logs/codex-backup.jsonl`;
  const MARK = `${STATE}/${ALIAS}.codex-backup.json`;
  const LEASE = `${STATE}/${ALIAS}.backup-owner.json`;
  const CONTROL = `${STATE}/${ALIAS}.control`;
  const WORKDIR = `${BM_HOME}/workspaces/${ALIAS}`;
  const FORCE = process.argv.includes("--force");
  const log = (o) => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), alias: ALIAS, ...o }) + "\n");
  mkdirSync(path.dirname(LOG), { recursive: true });

  const pending = read(`${STATE}/${ALIAS}.pending.json`);
  const status = read(`${CONTROL}/status.json`);
  const terminal = readTerminalState({ home: TERMINAL_HOME, workdir: WORKDIR });
  const kimiLimited = terminal.file ? providerLimited(tailRows(terminal.file)) : false;
  const decision = backupDecision({ pending, mark: read(MARK) || {}, status, kimiLimited, force: FORCE,
    minAttempts: Number(process.env.BACKUP_MIN_ATTEMPTS || 3), retryMs: Number(process.env.BACKUP_RETRY_MINUTES || 60) * 60_000 });
  if (decision !== "take_over") {
    if (decision === "kimi_busy" && FORCE) log({ event: "backup_refused_kimi_mid_turn", roundId: pending?.id });
    return;
  }
  const roundFile = path.join(BM_HOME, "duties", ALIAS, `${pending.id}.json`);
  if (!existsSync(roundFile)) { log({ event: "backup_skipped_no_work_order", roundId: pending.id }); return; }

  // Take the lease, then withdraw any delivery Kimi has not picked up, then re-check that Kimi did not start a turn.
  const lease = { roundId: pending.id, owner: `codex:${MODEL}:${EFFORT}`, pid: process.pid, at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString() };
  writeFileSync(`${LEASE}.tmp`, JSON.stringify(lease, null, 2), { mode: 0o600 }); renameSync(`${LEASE}.tmp`, LEASE);
  const inbox = `${CONTROL}/inbox.json`;
  if (existsSync(inbox)) {
    const withdrawn = `${CONTROL}/withdrawn-${read(inbox)?.id || Date.now()}.json`;
    try { renameSync(inbox, withdrawn); log({ event: "kimi_delivery_withdrawn", roundId: pending.id, file: withdrawn }); } catch { /* consumed meanwhile */ }
  }
  const after = read(`${CONTROL}/status.json`);
  if (terminalFresh(after, Date.now()) && after.ready === false && !kimiLimited) {
    unlinkSync(LEASE); log({ event: "backup_aborted_kimi_started", roundId: pending.id }); return;
  }

  const boards = execFileSync("node", [`${REPO}/ops/bm-runtime/registry.mjs`, "boards", ALIAS], { encoding: "utf8" }).trim();
  const boardSkills = execFileSync("node", [`${REPO}/ops/bm-runtime/registry.mjs`, "skills", ALIAS], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  const skillFiles = ["board-manager", ...boardSkills].map((s) => `${SKILLS}/${s}/SKILL.md`).filter(existsSync);
  const bm = `${REPO}/scripts/bm.mjs`;
  const prompt = `You are the BACKUP production Board Manager for Task Node (Kimi K3, the primary, is stalled or provider-limited). You cover these boards: ${boards}.
First read these skill files in full and follow them exactly: ${skillFiles.join(", ")}.
Use: cd ${REPO} && node scripts/bm.mjs <command>. Commands use the scoped Task Node API credential in BM_AGENT_TOKEN_FILE.
Read saved handoffs under ${BM_HOME}/journal for every assigned board.
Read the durable work order ${roundFile} (round ${pending.id}). Run: node ${bm} round-status ${pending.id} to see which duties are still unresolved; reconcile existing command receipts before repeating any mutation, because the primary may already have done part of this round.
Complete each unresolved duty, then report its explicit result using: node ${bm} duty-result ${pending.id} <duty-id> --outcome completed|blocked|deferred|not_served --reason '<specific outcome and evidence>'. A routing_due duty additionally requires --dispositions '<json array>' with one entry per listed candidate: {"account_id","disposition":"routed|investigation_routed|not_served","task_id" (for routed),"reason_code" (for not_served: no_badge_fit|source_unavailable|budget_exhausted|capacity_taken_this_round|restricted_board|contributor_declined_recently|other),"reason"}. Routed entries must match an executed task create for that account this round. Journaling alone does not finish a duty.
Refresh board packets before reusing earlier blockers; do not reuse last round's reason text. Follow the existing board rules: do not change rewards, blacklists or operator clearances.
When every duty in this round has a recorded result, stop immediately. Never sleep, poll, or wait for contributor responses or new work orders.`;
  const env = { ...process.env, BM_HOME, BM_STATE_DIR: STATE, BM_JOURNAL_DIR: `${BM_HOME}/journal`, BM_AGENT_TOKEN_FILE: `${BM_HOME}/credentials/${ALIAS}.json`,
    BM_AGENT_ORIGIN: process.env.BM_AGENT_ORIGIN || "https://tasknode.postfiat.org", DATABASE_URL: "", TASKNODE_DATABASE_ENABLED: "false" };

  writeFileSync(MARK, JSON.stringify({ roundId: pending.id, at: lease.at, model: MODEL, effort: EFFORT }));
  log({ event: "backup_started", roundId: pending.id, kimiAttempts: Number(pending.attempts || 0), kimiProviderLimited: kimiLimited,
    model: MODEL, effort: EFFORT, forced: FORCE, lease: LEASE });
  const out = `${BM_HOME}/logs/codex-backup-${pending.id}-${Date.now()}.md`;
  let run;
  try {
    run = spawnSync(CODEX, ["exec", "-m", MODEL, "-c", `model_reasoning_effort="${EFFORT}"`, "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check", "-C", WORKDIR, "--output-last-message", out, prompt],
      { encoding: "utf8", timeout: 45 * 60_000, maxBuffer: 64 * 1024 * 1024, env });
  } finally {
    if (read(LEASE)?.pid === process.pid) unlinkSync(LEASE);
  }
  let roundStatus = "";
  try { roundStatus = execFileSync("node", [bm, "round-status", pending.id], { encoding: "utf8", timeout: 120_000, cwd: REPO, env }).slice(0, 2000); }
  catch (error) { roundStatus = `round-status failed: ${String(error.message).slice(0, 300)}`; }
  log({ event: "backup_finished", roundId: pending.id, exit: run.status, signal: run.signal || null, timedOut: run.error?.code === "ETIMEDOUT",
    servedBy: `codex:${MODEL}:${EFFORT}`, lastMessage: out, leaseReleased: !existsSync(LEASE), roundStatus });
  appendFileSync(`${BM_HOME}/ALERTS.log`, `${new Date().toISOString()} ${ALIAS}: Codex backup (${MODEL} ${EFFORT}) ran round ${pending.id}, exit ${run.status}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

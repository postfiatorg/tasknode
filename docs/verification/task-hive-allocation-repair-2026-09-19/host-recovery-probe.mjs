import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = "/home/pfrpc/pf-boards";
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const pendingFile = root + "/state/pfterminal.pending.json";
const pending = fs.existsSync(pendingFile) ? read(pendingFile) : {};
const status = read(root + "/state/pfterminal.control/status.json");
const tick = read(root + "/state/scoped-supervisor-tick.json");
const events = fs.readFileSync(root + "/logs/supervisor.jsonl", "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const source = "ops/bm-runtime/supervisor.mjs";
const notice = root + "/state/pfterminal.control/accepted-operator_hive_allocation_repair_20260919.json";
console.log(JSON.stringify({
  observedAt: new Date().toISOString(),
  service: execFileSync("systemctl", ["--user", "show", "tasknode-kimi-supervisor.service", "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestamp"], { encoding: "utf8" }).trim(),
  tickCompletedAt: tick.completedAt,
  terminal: { ready: status.ready, updatedAt: status.updatedAt, threadId: status.threadId },
  pending: { id: pending.id, attempts: pending.attempts, deliveryCount: pending.deliveryCount, lastDeliveredAt: pending.lastDeliveredAt, resultCount: Object.keys(JSON.parse(pending.progress || "{}")).length },
  recoveryEvents: events.filter(e => e.at >= "2026-09-19T22:59:00Z" && e.roundId).map(e => ({at:e.at,event:e.event,roundId:e.roundId,deliveryId:e.deliveryId})),
  handoff: fs.existsSync(notice) ? read(notice) : { accepted: false },
  supervisorSource: { path: source, sha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex") },
  limitation: "Historical 429s are retained in the pre-recovery evidence. Fresh Kimi responses and durable completed rounds establish current progress; this does not guarantee future quota or new allocations."
}, null, 2));

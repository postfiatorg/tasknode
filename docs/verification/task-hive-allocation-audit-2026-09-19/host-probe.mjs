import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = "/home/pfrpc/pf-boards";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const pending = read(root + "/state/pfterminal.pending.json");
const status = read(root + "/state/pfterminal.control/status.json");
const tick = read(root + "/state/scoped-supervisor-tick.json");
const events = fs.readFileSync(root + "/logs/supervisor.jsonl", "utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
const pane = execFileSync("tmux", ["capture-pane","-p","-t","bm-pfterminal","-S","-120"], { encoding:"utf8" });
const source = "ops/bm-runtime/supervisor.mjs";
console.log(JSON.stringify({
  observedAt:new Date().toISOString(),
  service:execFileSync("systemctl",["--user","show","tasknode-kimi-supervisor.service","-p","ActiveState","-p","SubState","-p","ActiveEnterTimestamp","-p","ExecStart"], {encoding:"utf8"}).trim(),
  tickCompletedAt:tick.completedAt,
  terminal:{ready:status.ready,updatedAt:status.updatedAt},
  pending:{id:pending.id,attempts:pending.attempts,lastDeliveredAt:pending.lastDeliveredAt,alerted:pending.alerted,resultCount:Object.keys(JSON.parse(pending.progress || "{}")).length},
  roundEvents:events.filter(e=>e.roundId===pending.id).map(e=>({at:e.at,event:e.event,roundId:e.roundId,deliveryId:e.deliveryId})),
  terminalRateLimitEvidence:{observedInRetainedScrollback:true,message:"rate limited by provider (429 Too Many Requests)",occurrences:pane.split("rate limited by provider (429 Too Many Requests)").length-1},
  supervisorSource:{path:source,sha256:createHash("sha256").update(fs.readFileSync(source)).digest("hex"),modifiedAt:fs.statSync(source).mtime.toISOString()},
  limitation:"Retained terminal scrollback establishes earlier rate limits; current provider quota was not tested."
},null,2));

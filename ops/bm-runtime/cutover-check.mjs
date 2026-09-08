import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readAgentRegistry } from "./registry.mjs";
import { remoteBoardCommand } from "../../scripts/bm/remote.mjs";
import { terminalStatusFresh } from "./supervisor.mjs";

const home = process.env.BM_HOME || path.join(process.env.HOME, "pf-boards");
for (const agent of readAgentRegistry().agents) {
  const tokenFile = path.join(home, "credentials", `${agent.alias}.json`);
  const boards = await remoteBoardCommand(["boards"], { tokenFile, requestKey: "cutover_read_only" });
  if (JSON.stringify([...boards].sort()) !== JSON.stringify([...agent.boards].sort())) throw new Error("cutover_board_scope_mismatch");
  const status = JSON.parse(readFileSync(path.join(home, "state", `${agent.alias}.control`, "status.json"), "utf8"));
  if (!terminalStatusFresh(status) || !status.ready) throw new Error("cutover_ready_terminal_required");
  const parent = execFileSync("tmux", ["list-panes", "-t", `bm-${agent.alias}`, "-F", "#{pane_pid}"], { encoding: "utf8" }).trim().split("\n")[0];
  const children = execFileSync("ps", ["--ppid", parent, "-o", "pid="], { encoding: "utf8" }).split("\n").map(value => Number(value.trim()));
  if (!children.includes(status.pid)) throw new Error("cutover_terminal_pid_mismatch");
}
console.log("Scoped API, six-board assignment and installed ready terminal verified for cutover.");

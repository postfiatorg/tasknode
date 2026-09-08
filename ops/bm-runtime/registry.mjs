import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DETERMINISTIC_BOARD_IDS } from "../../server/board-config.js";

export function readAgentRegistry(file = new URL("./agents.json", import.meta.url)) {
  const registry = JSON.parse(readFileSync(file, "utf8"));
  const assigned = new Set(), aliases = new Set();
  if (registry.version !== 1 || !Array.isArray(registry.agents)) throw new Error("board_agent_registry_invalid");
  for (const agent of registry.agents) {
    if (!agent.alias || ![...agent.alias].every((char) => "abcdefghijklmnopqrstuvwxyz0123456789_-".includes(char)) || aliases.has(agent.alias)) throw new Error("board_agent_alias_invalid");
    aliases.add(agent.alias);
    if (agent.provider !== "kimi-code" || agent.model !== "kimi-k3") throw new Error("board_agent_kimi_mandate_required");
    if (!Array.isArray(agent.boards) || !agent.boards.length) throw new Error("board_agent_boards_required");
    for (const board of agent.boards) {
      if (!DETERMINISTIC_BOARD_IDS.includes(board) || assigned.has(board) || !registry.skills[board]) throw new Error("board_agent_assignment_invalid");
      assigned.add(board);
    }
  }
  return registry;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const registry = readAgentRegistry();
  const [command, alias] = process.argv.slice(2);
  if (command === "aliases") console.log(registry.agents.map((agent) => agent.alias).join("\n"));
  else if (command === "boards") console.log((registry.agents.find((agent) => agent.alias === alias)?.boards || []).join("\n"));
  else if (command === "skills") console.log((registry.agents.find((agent) => agent.alias === alias)?.boards || []).map((board) => registry.skills[board]).join("\n"));
  else console.log(JSON.stringify(registry));
}

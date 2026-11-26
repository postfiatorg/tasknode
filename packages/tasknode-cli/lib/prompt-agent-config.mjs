import path from "node:path";
export function promptAgentConfig({
  editJsonFile,
  claudeFile,
  claudeProjectKey,
  writePrivate,
  codexFile,
  tomlSetTable,
  readText,
  home,
  piFile,
  xdgConfig,
  run,
  onPath,
  removeJsonFile,
}) {
  async function installPromptEntry(agent, ctx, entry) {
    const name = "tasknode-prompts";
    if (agent.id === "claude")
      return editJsonFile(
        claudeFile(),
        ctx.scope === "local" ? ["projects", claudeProjectKey(ctx.cwd), "mcpServers", name] : ["mcpServers", name],
        { type: "stdio", ...entry },
      );
    if (agent.id === "codex")
      return writePrivate(
        codexFile(),
        tomlSetTable(
          readText(codexFile()) || "",
          ["mcp_servers", name],
          [`command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`],
        ),
      );
    if (agent.id === "cursor")
      return editJsonFile(path.join(home(), ".cursor", "mcp.json"), ["mcpServers", name], entry);
    if (agent.id === "gemini")
      return editJsonFile(path.join(home(), ".gemini", "settings.json"), ["mcpServers", name], entry);
    if (agent.id === "pi") return editJsonFile(piFile(), ["mcpServers", name], entry);
    if (["opencode", "kilo"].includes(agent.id))
      return editJsonFile(path.join(xdgConfig(), agent.id, agent.id + ".json"), ["mcp", name], {
        type: "local",
        command: [entry.command, ...entry.args],
        enabled: true,
      });
    if (agent.id === "hermes") {
      await run(onPath("hermes"), ["config", "set", "--force", `mcp_servers.${name}.command`, entry.command]);
      await run(onPath("hermes"), ["config", "set", "--force", `mcp_servers.${name}.args`, JSON.stringify(entry.args)]);
    }
  }

  async function removePromptEntry(agent, ctx) {
    const name = "tasknode-prompts";
    if (agent.id === "claude") {
      removeJsonFile(claudeFile(), ["projects", claudeProjectKey(ctx.cwd), "mcpServers", name]);
      if (ctx.scope !== "local") removeJsonFile(claudeFile(), ["mcpServers", name]);
    } else if (agent.id === "codex") {
      const current = readText(codexFile());
      if (current !== null) writePrivate(codexFile(), tomlSetTable(current, ["mcp_servers", name], null));
    } else if (agent.id === "hermes")
      await run(onPath("hermes"), ["config", "unset", `mcp_servers.${name}`]).catch(() => {});
    else {
      const files = {
        cursor: path.join(home(), ".cursor", "mcp.json"),
        gemini: path.join(home(), ".gemini", "settings.json"),
        pi: piFile(),
        opencode: path.join(xdgConfig(), "opencode", "opencode.json"),
        kilo: path.join(xdgConfig(), "kilo", "kilo.json"),
      };
      if (files[agent.id])
        removeJsonFile(files[agent.id], [["opencode", "kilo"].includes(agent.id) ? "mcp" : "mcpServers", name]);
    }
  }

  return { installPromptEntry, removePromptEntry };
}

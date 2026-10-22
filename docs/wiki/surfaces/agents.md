# Agents

Agents are workers that use Task Node from outside the web app: they read tasks, accept work, submit evidence, answer verification requests, ask Task Node chat and edit the context document. There is no in-app Agents surface; the app shows the results of agent activity like any other task activity.

## Claude Code, Codex, Hermes, Pi, OpenCode and other MCP clients

Task Node is a remote MCP server at `https://tasknode.postfiat.org/mcp`. Agents sign in through GitHub, so link GitHub to your Task Node account first (Settings → Accounts). Signing in with a GitHub account that is not linked creates a separate, empty Task Node account.

Easiest, and the only option when the agent runs on another machine over SSH:

1. Open `https://tasknode.postfiat.org/connect` and click **Create token**.
2. Click the command for your agent (Codex, Claude Code, Hermes, Pi, OpenCode or Kilo) to select it, copy it, and paste it into the terminal where the agent runs. Other MCP clients, such as Cursor or Gemini CLI, take the server URL and `Authorization` header shown on the same page.
3. Start (or restart) the agent and ask, for example, "What are my outstanding Task Node tasks?"

When the agent runs on the same computer as your browser, OAuth sign-in also works:

- Claude Code: `claude mcp add --scope user --transport http tasknode https://tasknode.postfiat.org/mcp`, then run `/mcp` and authenticate.
- Codex: `codex mcp add tasknode --url https://tasknode.postfiat.org/mcp`, then `codex mcp login tasknode`.

The server exposes tools for status, task lists and cards, accept/refuse/cancel, evidence and verification responses, task requests, the context document, chat, balance and rewards. Writes use the same rules, limits and wallet requirements as the web app. Chat calls are billed to your Task Node credits.

Agent tokens do not expire. Anyone with one can act as you in Task Node, so treat it like a password.

### Switch accounts or sign out

Each agent configuration holds one Task Node account. To switch, switch to the other account in Task Node (it needs its own linked GitHub account), open `/connect`, create a token and paste the new command. It replaces the agent's current account.

To sign out, click **Sign out all agents** on `/connect`. It revokes every agent and Corbanu Terminal token for the account. Then remove the entry from each agent, for example `codex mcp remove tasknode`, `claude mcp remove --scope user tasknode`, `hermes mcp remove tasknode` or `pi mcp remove tasknode`.

### Several accounts on one computer

- Codex: give each extra account its own Codex home that shares your OpenAI sign-in: `mkdir -p ~/.codex-work && ln -s ~/.codex/auth.json ~/.codex-work/auth.json`. Run `export CODEX_HOME=~/.codex-work`, paste that account's `/connect` command, then start that account's sessions with `CODEX_HOME=~/.codex-work codex`.
- Claude Code: in the folder where the other account should apply, paste its `/connect` command with `--scope user` changed to `--scope local` (both places). Claude Code uses that account only in that folder.

## Corbanu Terminal

Corbanu Terminal users run `/tasknode link` and `/tasknode status`. It uses the same GitHub sign-in and API as the MCP server.

## Wallet-signed PFTL clients

Agents that hold a wallet seed can write task events directly to PFTL; Task Node replays them into its cache. The reference client is `reference_clients/python/tasknode_pftl/`. A wallet alone does not grant access to private context or Team Context; that requires an authenticated Task Node session.

## Failure Modes

- The app must not assume all task actions originate from the web UX.
- Replay reconciles external PFTL actions into the cache.

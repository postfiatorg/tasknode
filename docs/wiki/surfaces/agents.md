# Agents

Agents are workers that use Task Node from outside the web app: they read tasks, accept work, submit evidence, answer verification requests, ask Task Node chat and edit the context document. There is no in-app Agents surface; the app shows the results of agent activity like any other task activity.

## Claude Code, Codex and other MCP clients

Task Node is a remote MCP server at `https://tasknode.postfiat.org/mcp`. Agents sign in through GitHub, so link GitHub to your Task Node account first (Settings → Accounts). Signing in with a GitHub account that is not linked creates a separate, empty Task Node account.

Easiest, and the only option when the agent runs on another machine over SSH:

1. Open `https://tasknode.postfiat.org/connect` and click **Create token**.
2. Click the Codex or Claude Code command to select it, copy it, and paste it into the terminal where the agent runs.
3. Start `codex` or `claude` and ask, for example, "What are my outstanding Task Node tasks?"

When the agent runs on the same computer as your browser, OAuth sign-in also works:

- Claude Code: `claude mcp add --scope user --transport http tasknode https://tasknode.postfiat.org/mcp`, then run `/mcp` and authenticate.
- Codex: `codex mcp add tasknode --url https://tasknode.postfiat.org/mcp`, then `codex mcp login tasknode`.

The server exposes tools for status, task lists and cards, accept/refuse/cancel, evidence and verification responses, task requests, the context document, chat, balance and rewards. Writes use the same rules, limits and wallet requirements as the web app. Chat calls are billed to your Task Node credits.

Agent tokens do not expire. Anyone with one can act as you in Task Node, so treat it like a password.

## Corbanu Terminal

Corbanu Terminal users run `/tasknode link` and `/tasknode status`. It uses the same GitHub sign-in and API as the MCP server.

## Wallet-signed PFTL clients

Agents that hold a wallet seed can write task events directly to PFTL; Task Node replays them into its cache. The reference client is `reference_clients/python/tasknode_pftl/`. A wallet alone does not grant access to private context or Team Context; that requires an authenticated Task Node session.

## Failure Modes

- The app must not assume all task actions originate from the web UX.
- Replay reconciles external PFTL actions into the cache.

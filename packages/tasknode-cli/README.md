# tasknode

Connect every coding agent on a machine to [Task Node](https://tasknode.postfiat.org) with one sign-in. It works over SSH, and no token is shown or copied by hand.

```sh
npx -y tasknode connect
# or, without npm:
curl -fsSL https://tasknode.postfiat.org/install | sh
```

It finds your agents, prints a link and a short code, and waits while you approve on any device:

```
To connect, open  https://tasknode.postfiat.org/activate  and enter  WDJB-MJHT
(or open https://tasknode.postfiat.org/activate?code=WDJB-MJHT)
Waiting for approval…
Connected as goodalexander (wallet rPo8…HxNx)
  ✓ Claude Code   ✓ Codex
Restart running agents, or run /mcp in Claude Code, to pick it up.
```

If an agent is already connected to a different account, it names that account and asks before replacing it. After a replacement, the old token is revoked once no agent on the machine uses it.

## Commands

```sh
tasknode connect                      # every agent it finds
tasknode connect --agent claude,codex # only these
tasknode connect --scope local        # Claude Code, this folder only
tasknode connect --yes                # replace another account without asking
tasknode status                       # which agent is on which account
tasknode disconnect                   # remove the entries and revoke their tokens
```

`--server URL` (or `TASKNODE_URL`) points it at another Task Node server. `--no-browser` skips opening the link. With curl, pass options after `sh -s --`, e.g. `curl -fsSL https://tasknode.postfiat.org/install | sh -s -- --agent claude`.

## Agents

Each agent gets the entry its own `mcp add` command would create, so the agents need no changes.

| Agent | Where the entry goes |
|---|---|
| Claude Code | `~/.claude.json`: `mcpServers.tasknode` (with `--scope local`: `projects[<folder>].mcpServers.tasknode`) |
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex`): `[mcp_servers.tasknode]` |
| Hermes | `hermes config set` (token in `~/.hermes/.env` as `MCP_TASKNODE_API_KEY`) |
| Pi | `pi mcp add tasknode … --exposure direct` |
| OpenCode, Kilo | `opencode mcp add` / `kilo mcp add` |
| Cursor | `~/.cursor/mcp.json`: `mcpServers.tasknode` |
| Gemini CLI | `~/.gemini/settings.json`: `mcpServers.tasknode` |

## Security

- The token goes straight from the server into the agent's config. It is never printed, logged or copied to the clipboard.
- Files it writes are replaced atomically with mode 600. Other settings in them are left as they were.
- Hermes, Pi, OpenCode and Kilo are configured through their own CLIs, so the token is in that command's arguments for the second it runs. Claude Code, Codex, Cursor and Gemini CLI are written directly.
- No telemetry. It talks only to the Task Node server: sign-in, `whoami` to show which account a token belongs to, and revoke.

MIT licensed.

## Encrypted prompts (Node 22+)

`tasknode connect` generates a local X25519 device keypair and registers a `tasknode-prompts` stdio MCP server next to the hosted entry. Unlock Docs in the browser, match the fingerprint printed by the CLI, and approve prompt access. `/connect` lists and revokes prompt devices. Private device material stays in mode-0600 files under `TASKNODE_CONFIG_DIR` (default `~/.config/tasknode`).

The local server provides `prompt_list`, `prompt_create`, `prompt_read`, `prompt_edit`, `prompt_save_version`, `prompt_history`, `prompt_stats`, and `prompt_log_tih_run`. A text patch is `{oldText, newText}` and must match exactly once; read before editing. Stats use UTC dates and accept 7 or 30 days. Run TIH locally, then log its scores. Prompt plaintext never goes to the hosted MCP or document assistants. Revocation blocks new relay access, but cannot erase previously read content or copied pad capabilities.

For manual stdio registration: `tasknode prompts-mcp --device-file /absolute/path/to/device.json`. Never put private key material or tokens in agent prompts. The curl installer retains its downloaded runtime modules and installs their pinned protocol dependencies with lifecycle scripts disabled.

Prompt approval also requires browser-to-agent pairing. In unlocked Docs → Agent access, approve the matching device fingerprint, then copy the displayed `tasknode prompts-pair --device-id ID --code CODE` command directly to the agent. Local tools refuse unpaired keys and later key substitutions. The installer verifies a content-addressed runtime and committed lockfile, runs `npm ci --omit=dev --ignore-scripts`, and preserves previous runtimes if a download fails.

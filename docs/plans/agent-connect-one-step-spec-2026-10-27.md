# Agent connect in one step: spec and feedback (2026-10-27)

## Goal

Connecting an agent to Task Node should take one action from the user and need no secret copied by hand. The user should also see which account the agent ended up on. A first-time user on a remote SSH box should be connected in under a minute.

## What happened

On 2026-10-27 the founder asked a Claude Code session on a remote Linux box to use Task Node.

1. The box was already connected, but to `corbanuAI`, a different account. Nothing told the user. The agent found out only by calling `tasknode_status`.
2. Switching to `goodalexander` took six steps:
   - sign into the web app as that account;
   - check that GitHub was linked;
   - open `/connect` and click **Create token**;
   - find the Claude Code command among five;
   - copy it and run it on the remote box;
   - reconnect the agent's MCP session.
3. The browser sign-in (`/mcp` → authenticate) could not work, because the agent runs on another machine. `/oauth/register` and `/oauth/authorize` accept only `localhost` and `127.0.0.1` redirect URIs, so the callback never reaches the agent (`server/tasknode-mcp.js`, `loopbackRedirect`).
4. To get it done, the founder pasted the full `claude mcp add … --header "Authorization: Bearer tns_…"` command, including the token, into the chat. That token never expires, and it now sits in a chat log.
5. The change went to `--scope user`, so it moved every Claude Code session on that machine from `corbanuAI` to `goodalexander`. Nothing confirmed or warned about that.

His verdict: "this is a fucking nightmare, no user is ever going to do this."

## Current behaviour that causes the friction

| # | Problem | Where |
|---|---|---|
| 1 | The OAuth sign-in only works when the agent and the browser are on the same computer. Remote boxes, SSH, cloud VMs and containers fail, and that is where most agents run. | `loopbackRedirect`, `handleRegister`, `handleAuthorize` |
| 2 | The fallback makes the user mint a bearer token and paste a shell command. The token is shown in the page, sits on the clipboard, often lands in chat logs and shell history, and never expires. | `handleConnect`, `agentConnectCommands`, `mintAgentToken` |
| 3 | The user has to pick their agent from five commands, and Cursor, Gemini and the rest need hand-edited JSON. | `connectClients`, postfiat.org/agents |
| 4 | The agent doesn't know which account it is on unless it calls `tasknode_status`. The MCP `initialize` response carries generic `instructions` and no identity, so the wrong account goes unnoticed. | `handleMcp`, `instructions` |
| 5 | Switching accounts means switching in the web app, minting a token and pasting again. The change is machine-wide, nothing confirms it, and the old account's token stays alive. | `/connect` copy, `--scope user` commands |
| 6 | Signing in with a GitHub account that isn't linked silently creates a new, empty Task Node account. | agents wiki, terminal auth |
| 7 | Revocation is all-or-nothing ("Sign out all agents"). There is no list of connected devices and no way to revoke one. | `/connect/signout`, `revokeTerminalSessions` |
| 8 | A running agent needs a restart or `/mcp` reconnect, and nothing tells the user. | docs only |

## What to build

### P0-1. One command for every agent: `npx tasknode connect`

Ship a small installer, published to npm as `tasknode` (or `@postfiat/tasknode`), with a curl fallback for machines without Node:

```sh
npx -y tasknode connect
# or
curl -fsSL https://tasknode.postfiat.org/install | sh
```

Flow:

1. It detects installed agents: `claude`, `codex` and `CODEX_HOME`, `hermes`, `pi`, `opencode`, `kilo`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`.
2. It starts a device sign-in (P0-2) and prints:

   ```
   To connect, open  https://tasknode.postfiat.org/activate  and enter  WDJB-MJHT
   (or open https://tasknode.postfiat.org/activate?code=WDJB-MJHT)
   Waiting for approval…
   ```

   If a browser is available locally it opens the link itself. Over SSH the user opens it on their phone or laptop.
3. After approval, it writes the MCP entry for each detected agent:
   - It uses the same config each agent's `mcp add` produces today, so no agent changes are needed.
   - The token goes straight into the config file with mode 600 and is never shown on screen.
4. It prints the result:

   ```
   Connected as goodalexander (wallet rPo8…HxNx)
     ✓ Claude Code   ✓ Codex   – Hermes (not installed)
   Restart running agents, or run /mcp in Claude Code, to pick it up.
   ```

5. If any agent is already connected to a different account, it says so and asks before replacing:

   ```
   Claude Code is connected as corbanuAI. Replace with goodalexander? [y/N]
   ```

   It also offers `--scope local` (this folder only) as the alternative.

Flags:
- `--agent claude,codex`: limit which agents it configures.
- `--scope local`: Claude Code only, this folder.
- `--status`: show which agent is on which account.
- `--disconnect`: remove the entries and revoke this device's token.

### P0-2. Device-code sign-in: works over SSH, no localhost callback

Implement RFC 8628, the OAuth device authorization grant. Most of the plumbing exists: `createTerminalAuthRequest` already issues a `user_code` and a `pollToken`, and `consumeTerminalAuthRequestSession` already reports `pending` versus `complete`. Corbanu Terminal's `/tasknode link` uses this today.

- **`POST /oauth/device_authorization`** returns:
  - `device_code`, the poll token;
  - `user_code`, short and human-typable, e.g. `WDJB-MJHT`;
  - `verification_uri` (`/activate`) and `verification_uri_complete`;
  - `expires_in` (10 minutes) and `interval` (5 s).
- **`GET /activate`:**
  - The user signs in with GitHub if needed, then sees the code, the device ("Claude Code on postfiat-box, Linux, from 203.0.113.4") and the account it will connect: "Signed in as goodalexander. Not you? Switch account".
  - One button: **Approve**.
  - If the GitHub account isn't linked to any Task Node account, it says so and stops. It does not silently create an empty account (problem 6).
- **`POST /oauth/token`** accepts `grant_type=urn:ietf:params:oauth:grant-type:device_code`. It returns `authorization_pending`, `slow_down`, `expired_token` or `access_denied`, per the RFC.
- **Discovery:** add `device_authorization_endpoint` and the grant type to `/.well-known/oauth-authorization-server`, so MCP clients that support device flow can use it natively.
- **Rate limits:** apply the existing ones to `/oauth/device_authorization` and `/activate` approvals.

### P0-3. The agent always knows and says which account it is on

- Put the identity in the MCP `initialize` response:
  - In `instructions`: "Connected as goodalexander (GitHub goodalexander, wallet rPo8…HxNx). Tell the user which account this is the first time you use Task Node in a session."
  - Also set `serverInfo.title` to "Task Node: goodalexander".
- In every tool response, include `account: { github, walletShort }` in the JSON, so an agent that skipped `initialize` still sees it.
- On `/connect` and `/activate`, put the account name at the top in large type with a "Not you? Switch account" link.

### P1-1. The connect page becomes one copy button

Show one line for the user to give their agent:

> **Paste this into your agent:**
> `Connect me to Task Node: run npx -y tasknode connect and follow the link it prints.`

Below it, the shell command for people who'd rather run it themselves. The current per-agent token commands move under "Advanced: manual setup with a token". Mint the token only if the user expands that section and clicks **Show token**.

Serve plain instructions for agents at `https://tasknode.postfiat.org/connect.md`, so "connect me to Task Node" works even when the agent hasn't seen this page.

### P1-2. Per-device tokens you can see and revoke

- **Name each token** with the agent and machine, e.g. "Claude Code · postfiat-box · created 2026-10-27".
- **List them on `/connect`** with last-used time and IP, and a **Revoke** button per device. Keep "Sign out all agents".
- **Expire idle tokens** after 90 days unused; active ones roll over on use. Today's never-expiring tokens become the opt-in.
- **Revoke on replacement.** When `tasknode connect` replaces an account on a device, revoke the old token for that device so it doesn't linger.

### P1-3. Detect tokens pasted into chat

Add a `tns_` prefix rule for GitHub secret scanning, and document it. When a token is found in a public place, revoke it. For tokens pasted into agent chats, tell users in the `/connect` copy and in P0-3's `instructions` to never paste the token into chat: "run the installer instead".

### P2. Docs

- Rewrite postfiat.org/agents and `docs/wiki/surfaces/agents.md` around the one-step flow.
  - **Quick start:** one line ("Run `npx -y tasknode connect` or tell your agent 'connect me to Task Node'").
  - Per-agent manual setup moves to a collapsed appendix.
- Drop "Several accounts on one computer" from the main path and point it to `tasknode connect --scope local`.

### P2. Measure the funnel

Track these per day:
- `/connect` and `/activate` page views;
- device codes issued, approved and expired;
- the first successful MCP tool call per new device, and the time from code issued to that call;
- account replacements.

Target: at least 80% of issued device codes reach a first tool call within 5 minutes.

## Acceptance criteria

1. **New user, remote box, from zero.** A user with a linked GitHub account runs `npx -y tasknode connect` over SSH, opens the printed link on their phone and taps Approve. Claude Code and Codex on that box are connected in under 60 seconds. No token appears on screen, in the clipboard or in shell history.
2. **Agent-led.** In a fresh Claude Code session the user types "connect me to Task Node". The agent runs the installer, shows the link and code, and after approval says "Connected as <name>".
3. **Wrong account caught.** If the machine is already on another account, the installer names both accounts and asks before replacing. In a session, the agent's first Task Node reply names the account.
4. **Switching accounts.** Running `tasknode connect` again and approving as a different account replaces it in one step, then revokes the old token for that device.
5. **Revocation.** `/connect` lists each device, and revoking one ends that agent's access within one request. Other devices keep working.
6. **Unlinked GitHub.** Approving with an unlinked GitHub account stops with "link GitHub to your Task Node account first" and creates no account.
7. **Local still works.** OAuth loopback sign-in keeps working for Claude Code, Codex, Claude Desktop and ChatGPT on the same machine.

## Test plan

- **Unit tests:**
  - device authorization: pending, slow_down, expired, denied, approved, and code reuse;
  - token exchange: wrong device_code, consumed code;
  - identity in `initialize` and in tool payloads;
  - per-device revoke.
- **Smoke:** extend `scripts/tasknode-mcp-smoke.mjs` with a device-flow run that approves through a test session and makes one tool call.
- **Manual:**
  - a fresh Ubuntu VM over SSH, with Claude Code and Codex installed;
  - a Mac with a local browser;
  - an existing machine on another account (the corbanuAI case);
  - Windows with Codex.

## Order of work

1. P0-2 (device endpoints and `/activate`) and P0-3 (identity in `initialize` and tool payloads). These are server-only and help every client immediately.
2. P0-1 (installer). It depends on P0-2.
3. P1-1 (connect page) and P1-2 (per-device tokens), then the docs rewrite.
4. P1-3 and the funnel metrics.

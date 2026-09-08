# Corbanu Terminal and Task Node Contract

Terminal GitHub linking opens an account picker so multiple Corbanu profiles
can select different GitHub accounts in one browser. Complete the link in the
same Corbanu profile with `/tasknode status`. Authentication errors and the
browser completion page use the current Corbanu name.

Current source implementation reviewed September 5, 2026. Server stage 1 is
deployed; the new Corbanu/scoped-agent stage is locally qualified and awaits
production cutover. See the reliability implementation ledger for rollout state.

## Client and identity boundary

Corbanu has two user-facing clients: `/tasknode` in the TUI and
`corbanu tasknode …` for structured CLI use. Their implementations live in
`codex-rs/tui/src/chatwidget/tasknode_menu.rs` and
`codex-rs/cli/src/tasknode_cmd.rs` in the Corbanu Terminal repository.
Credential persistence is shared through `codex-rs/tasknode-session/`.

Task Node credentials are scoped to the selected Corbanu profile. An incomplete
GitHub linking attempt is stored separately from the active session; promotion
validates the issued token before replacing an active credential. Server-side
terminal authentication uses durable session rows and verifies linked GitHub
identity. A linked Task Node wallet is a separate requirement for task actions.

Account login, terminal credential, GitHub linkage, wallet linkage and browser
vault unlock are distinct states. A terminal credential is not a wallet seed.

## Endpoint inventory

| Boundary | Endpoints | Behavior |
| --- | --- | --- |
| Device/account link | `POST /api/auth/terminal/start/github`, `GET /api/auth/terminal/session` | Start/poll the browser GitHub link; obtain a terminal credential |
| Session | `POST /api/auth/terminal/revoke`, `GET /api/terminal/tasknode/status` | Revoke or inspect the terminal session/account state |
| Requests | `GET/POST /api/terminal/tasknode/requests`, `GET /api/terminal/tasknode/requests/:id` | Create a receipt, list requests or inspect a receipt |
| Tasks | `GET /api/terminal/tasknode/tasks`, `GET /api/terminal/tasknode/tasks/:id` | Read projected task lists/details and allowed actions |
| Actions/evidence | `POST /api/terminal/tasknode/tasks/:id/action`, `POST /api/terminal/tasknode/tasks/:id/evidence` | Validate task state/actor and apply the configured lifecycle action |
| Context | `GET/POST /api/terminal/tasknode/context` | Read/save the linked account's Context with revision information |
| Chat | `/api/terminal/tasknode/chat/modes`, `/conversations`, `/history`, `/search`, `/send`, `/stream` under the chat prefix | Mode discovery, history, search, send and streaming |
| Accounting | `GET /api/terminal/tasknode/balance`, `GET /api/terminal/tasknode/rewards` | Read balances and reward history |

The complete route implementation and method checks are in
`server/tasknode-terminal-routes.js`; declared body/rate policies live in
`server/route-policies.js` and `server/request-body-contracts.js`.

## Request creation and context

Terminal create sends `userDetailText`, `requestedTaskKind`, a source title and
an `idempotencyKey`. The TUI requests personal work; the CLI exposes a kind
argument. The handler passes this to `terminalTaskRequestAction` after checking
session, linked wallet and the terminal-actions gate.

The request service writes a `pf.task.request_bundle.v1` object into
`task_requests.metadata_json`, with a `postgres:` bundle/event reference and an
`offchain:` transaction reference. New direct receipts use `queued`; historical
`published` rows remain compatible. Neither synthetic reference is a signed
request pointer.
The response acknowledges intake, not completed generation.

`server/task-request-terminal-bundle.js` creates a small initial bundle. The
owning generation worker fills it with the account's saved Context, memories,
recent conversations and task history, then saves that snapshot before calling
the model. Request text remains bounded to 8,000 characters by the input
contract. Browser and terminal direct submissions use the same intake service.

`idempotencyKey` is scoped to the authenticated account. Concurrent retries
return one immutable receipt; changed input under the same key returns HTTP 409.
Completed receipts cannot be reset by another submit. Public intake accepts
personal tasks; reward-bearing network assignments require the board allocation
path and its eligibility/capacity checks.

`GET /requests/:id` looks up the owned receipt directly, including old completed
requests. Listing returns unresolved requests first and a `nextCursor` for the
next page. Pass it back as `cursor`. Receipt fields include `progressStage`,
`progressRevision`, `generatedTaskId`, and durable failure/recovery state.
Unresolved receipts have no automatic display expiry.

The shared request API accepts `phase: "dismiss"` with `requestId`,
`expectedAccountId`, and `expectedAttemptCount`, using the same owner and attempt
fences as retry. Only a failed receipt without a generated task can be dismissed.
It becomes inactive with status `cancelled` and label `Dismissed`; its original
error and receipt remain readable. Dismissal is available in the browser queue;
the current CLI/TUI menus still expose retry only.

## Client recovery

CLI and TUI share `codex-rs/tasknode-session` for transport, origin validation,
command bodies, error handling and streaming. Ordinary requests have a 45-second
deadline; streams allow 600 seconds. Credentials stay bound to their saved origin
and selected profile. Redirects are rejected. Streaming decodes UTF-8 after byte
framing, requires a completion event and supports frames up to 16 MiB.

Before submitting, clients save the original command in the profile/account/origin
vault. A lost response leaves it pending. `corbanu tasknode requests pending` lists
saved commands; `requests recover <key>` resends the original command and key.
The TUI restores its pending request text when reopened. Account, credential,
view and request-generation checks keep stale responses out of the current view.

`requests list --cursor <cursor>` reads older receipts. The TUI offers older/newer
pages and failed-request retry actions. CLI retry is
`requests retry <request-id> --attempt <workerAttemptCount>`; it uses the owned
receipt's attempt count. The server rejects another account and cannot reset a
newer attempt or completed receipt. Menu count refresh preserves selection and
search text.

Browser submissions use encrypted account-scoped IndexedDB commands. Identical
uncertain submissions from two tabs share the original ID; unrelated drafts have
separate records. Reload restores the pending text. A storage failure disables
submission and explains recovery rather than silently issuing a fresh command.

## Chat and model naming

The current Task Node shared model route is Vercel first, Ambient backup.
Thinking uses GLM 5.3 and Instant uses GLM 5.3 Flash. The TUI still sends the
compatible `Private Thinking` mode name in its chat request; that name is not a
promise of a separate private inference provider. See [AI providers](ai-providers.md).

## Independent Kimi board agent

Opening `/tasknode` does not start the Kimi board manager. The operator harness
in Task Node's `ops/bm-runtime/` launches a separate Corbanu session in tmux,
currently defaulting to `kimi-code` / `kimi-k3`. That agent reads installed board
skills and calls `scripts/bm.mjs` with database access through the Fly proxy.
It does not use the terminal user's bearer API for board commands.

Since the v706 scoped cutover, the Kimi operator agent uses
`POST /api/agent/board/command`, a separate scoped
credential with hashed storage, expiry and explicit board grants. It invokes the
same board domain services and records command receipts atomically with writes.
It does not use a user's terminal credential. See [board management](board-manager.md)
for durable rounds, per-duty results, control inbox readiness and rollout status.

## Verification boundary

Endpoint smoke tests, session fixtures, a live provider completion and a real
PTY task workflow prove different stages. An integration qualification must
trace one authorized request through durable receipt, worker attempt, generated
offer, task projection and client visibility, then the permitted action/evidence
path. For the historical signed protocol, also prove pointer and reducer stages.
Never label intake alone an end-to-end task result.

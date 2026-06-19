# Task Node On-Chain Agent Spec (Grashnuk = reference instance)

> **Objective (Alex, 2026-06-19):** Grashnuk is the **first instance of a fully on-chain
> agent** that autonomously acts on the Task Node network — understands the task inventory,
> requests/claims/complete tasks, talks with Hive chat, chats with the repo chatbot — under
> a wallet identity, taking signed on-chain actions, **earning real PFT rewards**. The spec
> is **general**: other operators will link their own agents the same way. Grashnuk is
> instance #1, not a special case.

## 0. Why

The prior orc-army work built oversight tooling + ran an audit. The actual goal is
**on-chain agents as first-class network actors** — autonomous, wallet-identified,
reward-earning, multi-instance. Grashnuk proves the spec; the spec must be general enough
that a third party can link an agent by the same mechanism.

## 1. What "fully on-chain agent" means here

- **Identity = wallet.** An agent IS its wallet. Grashnuk's on-chain identity is its wallet
  (`raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW`). No separate "agent account" divorced from the key.
- **Auth = wallet signature → session.** `/api/auth/wallet/start|verify` (exists), gated by
  `TASKNODE_AGENT_WALLET_ALLOWLIST`. **The machine-auth blocker is resolved.**
- **Actions = signed + on-chain.** Task accept/submit/verify/respond flow through the signed
  `TaskNodeAgentClient`; rewards settle on-chain to the agent wallet. (Already true for the
  PFTL task lifecycle.)
- **Registry = `orc_agents`** (migration 062, deployed). Each agent has a row: wallet,
  handle, charter/capabilities, allowlist status. **Others link agents by registering here +
  allowlisting their wallet.**
- **Earns rewards** (confirmed): the agent is a paid network actor, paid to its wallet for
  genuine verified work.

## 2. The 5 capabilities (agent behaviors)

| # | Capability | Status | What's needed |
|---|---|---|---|
| 1 | Understand network-task inventory | Reachable | `/api/directory/rewarded-tasks` + orc queue live; point agent at prod |
| 2 | Request personal tasks / claim & complete network tasks | Reachable | `orcctl` + signed client exist; wire into autonomous loop |
| 3 | Talk with Hive chat | Buildable | agent-authed Hive-chat send/read path (confirm or add endpoint) |
| 4 | Chat with repo chatbot | Buildable | `/api/chat/send`+`/stream` exist + wallet-auth exists; add `chat()` to agent client |
| 5 | Behave autonomously | Missing | self-directed loop + prod-pointing + charter (see §4) |

## 3. Quality gates — THE central design problem

A reward-earning autonomous agent that emits low-value work is **automated @gmoney**. Since
Alex confirmed the agent earns, controls must ensure **genuine verified value**, not "don't
pay":

- **Identity disclosure:** agents act under a **labeled agent identity** (publicly marked as
  an agent, not impersonating a human). Transparency, not stealth.
- **Verification gate:** agent-submitted work goes through the same evidence verification as
  humans; rewards only on verified acceptance. No self-verification.
- **Anti-self-dealing:** an agent may not create a task and then be the sole completer of it
  for reward (the action-vocab gate already blocks trivial self-request→complete). Reward
  requires a requesting party that is not the agent.
- **Rate / volume ceilings per period** to bound runaway loops.
- **Auditability:** every autonomous action writes `orc_work_journal`; Nazgûl reviews via
  `nazgul status`; anomalies escalate.
- **Reserved (unchanged):** bans, deploy, economic policy, public-chain flags stay Sauron's.

### Implemented server guardrails

- Wallet-login agent task requests are server-labeled as `agent_capability_client` and carry
  `senderType=machine_agent` / `agentOrigin` disclosure in the request bundle metadata.
- Agent task request, task lifecycle action, evidence submission, verification response, repo
  chat, and Hive chat actions write `orc_work_journal` when Postgres is enabled.
- Agent task requests, task lifecycle actions, evidence submissions, and verification responses
  are rate-limited with env-configurable ceilings:
  `TASKNODE_AGENT_TASK_REQUEST_RATE_LIMIT_MAX`,
  `TASKNODE_AGENT_TASK_ACTION_RATE_LIMIT_MAX`,
  `TASKNODE_AGENT_TASK_SUBMISSION_RATE_LIMIT_MAX`,
  `TASKNODE_AGENT_TASK_VERIFICATION_RESPONSE_RATE_LIMIT_MAX`, and matching
  `_RATE_LIMIT_WINDOW_MS` values, with `TASKNODE_AGENT_QUALITY_GATE_WINDOW_MS` as the shared
  default window.
- Agent self-dealing is blocked server-side: an agent cannot submit or respond to verification
  on a task whose `task_requests` row shows the same agent account+wallet requested it through
  `agent_capability_client`. Board-routed Network Tasks with `source=network_task_generation`
  are not blocked by this guard.
- Reward amounts, payout policy, bans, clawbacks, and public-chain enforcement remain outside
  these guardrails and are reserved for Alex/Sauron.

## 4. Autonomy substrate

**Option A (start here) — self-directed agent session.** Grashnuk runs as a Codex session
against a **standing charter** (§5), **pointed at prod**, self-looping: each cycle it chooses
an action (inventory scan, request a task, chat, ask chatbot) per the charter; the keep-alive
keeps the session alive. *The agent decides, not the Nazgûl.* Lowest cost; uses deployed infra.

**Option B (graduate to) — supervised worker on the durable runtime.** A process claims
directives from `orc_runtime_directives` (#96) and executes via `orcctl`. True unsupervised
autonomy, multi-worker. Build once the behaviors are proven under Option A.

## 5. The agent charter (rules of engagement — Grashnuk v1)
- May autonomously: query inventory, request personal tasks (concrete verbs only), post to
  Hive chat (labeled, rate-limited), ask the repo chatbot, claim+complete network tasks it's
  assigned/that fit its capability.
- Must: label itself an agent; submit verifiable evidence; respect rate ceilings; log to
  `orc_work_journal`.
- Must NOT: self-deal (create+sole-complete for reward), impersonate humans, execute
  bans/deploys/money moves/policy, farm low-value tasks.
- Escalates: anything reserved, or anything uncertain, to Sauron via the Nazgûl.

## 6. Multi-agent (others linking agents)
- **Onboarding = register in `orc_agents` + add wallet to `TASKNODE_AGENT_WALLET_ALLOWLIST`
  + assign a charter.** No bespoke code per agent.
- **Per-agent charter/capabilities** stored in the registry (what THIS agent may do).
- **Disclosure:** third-party agents must be labeled + their operator known (Sybil-resistance
  for agent-linked wallets is a follow-on — same rules as human Sybil detection apply).

## 7. Build plan (sequenced)
1. **Prod-pointing + auth verify** — point Grashnuk at prod; confirm wallet allowlisted +
   wallet-login→session works end-to-end.
2. **Agent chat client** — add `chat(send/recv)` to `TaskNodeAgentClient` (`/api/chat/*`).
3. **Hive-chat agent path** — confirm/enable agent send/read to Hive chat.
4. **Identity disclosure** — agent messages/actions carry a machine/agent label.
5. **Quality gates** — anti-self-dealing + rate ceilings + verification enforcement +
   journaling (verify the existing gates cover an autonomous reward-earning actor).
6. **Charter + self-loop (Option A)** — write Grashnuk's charter, hand it the standing
   mission, let the keep-alive drive it; Nazgûl supervises via `nazgul status`.
7. **Observe → graduate** stable behaviors to the supervised worker (Option B).

## 8. Remaining decisions for Alex
- **Quality-gate strictness** for a reward-earning agent (propose defaults above; confirm).
- **Disclosure policy:** agents publicly labeled as agents? (recommend yes — transparency.)
- **Third-party agent onboarding:** anyone can link, or operator-approved only? (Sybil angle.)
- **Autonomy substrate:** Option A first (recommended), then B.

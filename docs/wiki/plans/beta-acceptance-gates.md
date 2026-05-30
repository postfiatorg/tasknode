# Beta Acceptance Gates

Date: 2026-05-30

Network Task: `task_dc07336c457592a783e53b0b7a175df9`

This document is the beta release boundary for the restored core Task Node product. These four gates are intentionally narrow. If a surface cannot pass its sentence, it does not ship as beta-ready. If it passes, it can ship without expanding the scope.

## Gates

| Gate | Acceptance sentence | Pass/fail reviewer test | Current gap or risk |
| --- | --- | --- | --- |
| Telegram | **Telegram** — A user sends a message, gets a clarifying response that references their context, and leaves sharper about what to do next. | Link or use an already linked non-operator Telegram account. Send one private bot message that depends on prior context. Pass only if the bot replies in Telegram, references relevant context or asks one useful clarifying question, and the conversation is visible in the account-scoped chat history. Fail if the bot is down, uses the wrong account, gives generic praise, ignores context, or cannot explain linking for an unlinked user. | Live Telegram still needs repeated non-operator QA. The deterministic webhook smoke proves routing, but beta readiness requires a normal linked user to get a useful live response without operator-only setup. |
| Task generation | **Task generation** — A user asks for a task in plain language, sees one task clearly connected to their values and strategy, and knows why it's the right thing to do. | From a logged-in account with wallet/vault prerequisites satisfied, ask for a task in plain language. Pass only if the user sees exactly one actionable task offer or task card, the card states why it matches their values/strategy, and the next action is obvious. Fail if generation stalls, produces multiple competing tasks, creates an irrelevant task, hides the reason, or leaves the user unsure what to do next. | Task generation depends on wallet/vault state, task workers, PFTL publishing, and projection sync. A beta failure can look like product indecision even when the backend failure is a stale worker or missing vault. |
| Context editing | **Context editing** — A user asks the system to review their context, it identifies a specific weakness and proposes a concrete edit, and the user accepts it because it's tighter than what they'd produce alone. | Open Context Refine from chat or the context surface. Ask for a bounded review of the current context. Pass only if the system identifies one specific weakness, shows a concrete proposed edit before mutation, applies only after explicit acceptance, and the accepted revision persists after refresh. Fail if it gives broad advice, silently overwrites context, loses the edit after refresh, or requires wallet signing for ordinary draft refinement. | Prior QA found a context save path that showed "Saved" while the line disappeared after refresh. The gate stays amber until the reviewer proves the accepted edit persists durably in the current beta environment. |
| Hive board | **Hive board** — A user opens the board, sees what core contributors are working on and why, and can spot the single next task to earn rewards and advance the shared goals. | Open the Hive board and one active project. Pass only if visible project/task counts match backing state, the project explains what contributors are doing and why, and the user can identify one next reward-bearing task or honest blocker. Fail if the board creates random duplicate projects, hides why work exists, cannot unarchive/resume valid work, shows stale counts, or spams follow-up messages instead of reflecting state. | The Hive board is improving but remains the highest-risk gate. Immediate Hive Chat now replies with compressed board context, but beta readiness still depends on Board Manager cadence, project state hygiene, and task routing staying state-aware instead of repetitive. |

## Reviewer Rule

Each gate is binary for beta release review:

- Pass: the reviewer can execute the test and the acceptance sentence is visibly true.
- Fail: any required user-visible behavior is missing, misleading, stale, or not durably backed by state.
- Amber: the surface works partially but lacks live evidence, backing-state proof, persistence after refresh, or a non-operator account test.

Do not add extra gates to this task. Funding, profile, NFT display, account deletion, memory, public profile, and full production QA remain separate release work.

## Verification Summary

The four beta gates are:

1. Telegram: a context-aware clarifying reply through Telegram.
2. Task generation: one plain-language task connected to user values and strategy.
3. Context editing: one specific context weakness, proposed edit, explicit acceptance, durable save.
4. Hive board: visible contributor work, rationale, and one next reward-bearing task or honest blocker.

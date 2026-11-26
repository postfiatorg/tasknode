# PROPOSAL — NOT SHIPPED: Task Generation Fallback Provider

> **Status: PROPOSAL — NOT SHIPPED.** Nothing in this document is implemented,
> configured or enabled. No provider key, route or environment variable
> described here exists in code or production. It needs a founder decision
> before any build work starts.

## Why

On 2026-11-06 (06:56 to ~13:30 UTC) the Vercel AI Gateway team balance reached
zero. Every task request failed with `inference_http_402`: 28+ requests across
5 accounts. Task generation has a single provider path since the Ambient
backup was retired in #343, so an empty balance stops all task generation.

The companion change (branch `fix/inference-credit-outage-20261106`) contains
the outage without a second provider: balance and low-balance readiness,
user-facing "task generation is temporarily unavailable", automatic retry once
credits return, and per-account spend attribution. A fallback provider would
go further and keep tasks generating *during* an outage. That is the decision
below.

## Facts that constrain the options

- Task generation uses `moonshotai/kimi-k3.1-pro` (generator) and
  `zai/glm-5.3-flash` / `zai/glm-5.3` (readiness review, network intent
  assessment), all on Vercel AI Gateway.
- Gateway credits are team-wide. A second key on the **same** team shares the
  same balance and gives no protection.
- Vercel BYOK still requires purchased gateway credits, and failed BYOK calls
  fall back to system credentials charged to the gateway balance (Vercel
  pricing docs). BYOK through the same gateway team is not independent of a
  gateway credit outage.
- Vercel supports **auto top-up** below a configured threshold (disabled by
  default). It was not enabled on 2026-11-06.
- The Ambient route is still in code behind `INFERENCE_AMBIENT_BACKUP_ENABLED`,
  but Kimi has no Ambient mapping (`inference_private_model_fallback_forbidden`)
  and Ambient's catalogue (checked 2026-09-05) lists GLM 5.2 only.
- `server/inference.js` already falls over to the next configured route on
  401/402/403/404/408/429/5xx, so a second route needs a provider entry and
  a model mapping, not a new dispatcher.

## Options

### A. Prevent the outage: auto top-up plus alerting (no new provider)

Enable Vercel auto top-up (threshold and amount set by the founder) and alert
on the new `llm.gatewayCredits.lowBalance` readiness field.

- Pros: no code path changes, same model and quality, no new vendor or data
  handling review. Addresses the actual root cause (an unfunded balance).
- Cons: depends on the card on file succeeding; does not help with a gateway
  outage or a budget limit (`quota_for_entity_exceeded`); unbounded spend
  unless budgets are also set.
- Effort: dashboard setting plus an alert hook on readiness. Lowest risk.

### B. Second, separately funded Vercel team as a standby credential

A `VERCEL_TASKGEN_STANDBY_API_KEY` from a different Vercel team, tried only
when the primary returns 402.

- Pros: identical API, models and response shape; spend and cost reporting
  unchanged; small code change (credential failover inside the Vercel route).
- Cons: two balances to fund and monitor; no protection against a Vercel-wide
  incident; a second team's ZDR and data settings must match the first.
- Effort: small. Readiness already reports balance per credential.

### C. Direct provider API (Moonshot for Kimi) as a second route

Call Moonshot's OpenAI-compatible API directly for the generator, outside the
gateway.

- Pros: independent of Vercel billing and availability; same model family.
- Cons: new vendor contract, key, rate limits and data-retention terms; the
  readiness reviewer and intent assessor (GLM) would need their own fallback
  or would still stop on a gateway outage; model id and response metadata
  (cost, usage) differ, so attribution needs a per-provider cost source;
  quality parity of the direct endpoint must be benchmarked.
- Effort: medium (provider entry, model mapping, cost accounting, benchmark).

### D. OpenRouter (or similar aggregator) as a second route

- Pros: one key covers Kimi and GLM; prepaid balance independent of Vercel.
- Cons: same failure class (prepaid credits can also run out); another data
  processor in the prompt path; routing to unknown upstream hosts; model ids
  and cost metadata differ.
- Effort: medium.

### E. Re-enable Ambient for task generation

- Pros: route already exists in code.
- Cons: retired in #343 for quality and catalogue reasons; no Kimi model, so
  generation would silently switch model family; vision support limited.
  Not recommended.

## Recommendation (for decision, not implemented)

1. **A now**: enable auto top-up and wire `llm.gatewayCredits.lowBalance` /
   `llm.warnings` to an operator alert. Set a budget so auto top-up is bounded.
2. **B next** if a zero-downtime guarantee is wanted: a separately funded
   standby team key, tried only on 402, behind an explicit opt-in flag that
   defaults off.
3. Defer C/D until there is a reason to leave the gateway (cost, a Vercel-wide
   incident, or a model Vercel does not carry), because each adds a vendor and
   a second cost-accounting path.

## Open questions for the founder

- Is an outage of task generation acceptable if users see "task generation is
  temporarily unavailable" and their requests complete automatically when
  credits return (what the companion change ships), or must generation keep
  running during a credit outage?
- Auto top-up threshold, amount and monthly cap.
- Should task-generation inference ever be charged to users? The companion
  change records it per account as zero-amount `taskgen_inference` ledger
  entries only.

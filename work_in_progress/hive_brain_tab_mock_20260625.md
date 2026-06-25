# Hive Brain — Tab Mock + Data Architecture

**Goal:** a new "Hive Brain" tab (under the **More** sidebar menu) that exposes the **full audit trail of the Board Manager** — every input, the secretary's reasoning, the decision, the result, and the **live model output** — so Alex can read exactly what the hive manager is seeing/thinking/doing each run. Designed to fit the existing Hive `<Section>` UX.

---

## Placement & entry
- **Location:** sidebar **More** dropdown (`src/main.jsx:1456` `moreMenuOpen`), new item **"Hive Brain"** (icon: `Brain` or `Activity`).
- **Route:** `/#hive-brain` (matches the app's hash-routing pattern). Operator-gated (same auth as Hive admin surfaces).

## Layout (matches Hive `<Section>` pattern; everything collapsible + filterable — it's a lot of text)

```
┌─ Hive Brain ──────────────────────────────────────────────────────┐
│  Full audit trail of the Board Manager: inputs, reasoning,        │
│  decisions, and live output.                                      │
│                                                                    │
│  [ Run timeline ▾ ]   latest: 17:44 · do_nothing · 92KB packet    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ 17:44 daily_airdrop · 18:00 do_nothing · 17:30 initiate...  │ │
│  │ 17:00 do_nothing · 16:30 do_nothing  …  (click to inspect)  │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  [ Filter: □ do_nothing  □ initiate  □ error   search: "Alex" ]   │
│                                                                    │
│  ╭─ LIVE OUTPUT (real-time) ────────────────────────────────╮     │
│  │ ▸ streaming secretary/decision model output for the       │     │
│  │   in-flight run (SSE tail). Black box, monospace.         │     │
│  ╰──────────────────────────────────────────────────────────╯     │
│                                                                    │
│  ▸ 1. Source Packet (Input)         [92,225 bytes]  ▾            │
│  ▸ 2. Secretary Report (Reasoning)                    ▾            │
│  ▸ 3. Decision (Action chosen)                        ▾            │
│  ▸ 4. Result (Execution)                              ▾            │
└────────────────────────────────────────────────────────────────────┘
```

### Section 1 — Source Packet (Input): *what the Board Manager was given*
Top-level **highlight chips** (the deterministic signals that drive the decision) so you don't have to read 92KB:
- `boardActionPressure.requiresAction` · `motionState` · `eligibleCandidateCount` · `projectsWithoutLiveTasks` · `outstandingNetworkTaskCount` · `openFollowupCount`
Then collapsible JSON / sub-sections: active projects + live tasks, candidate rows **with badges**, Hive Context (**operator directives — your inputs**), recent runs, badge_eligibility, capability gaps, orc operations. **This is where you verify the BM actually received your directives + your badge state.**

### Section 2 — Secretary Report (Reasoning): *the secretary's compression*
Fields from the secretary packet: `motion_state`, `requires_attention`, `do_nothing_allowed`, `board_summary`, `reason_summary`, `staleness_summary`, `action_pressure_summary`, `attention_targets`, `operator_standing_policy` (**did it preserve your directives?**), `generation_quality_policy`, `prior_output_corpus_summary`, `deduplication_watchlist` (**why didn't dedup catch the duplicate? read it here**), `badge_eligibility`, `facts_to_preserve`. **This is the layer that compresses/drops your directives — audit it here.**

### Section 3 — Decision (Action chosen): *what it decided + why*
`selected_action` (do_nothing / initiate_network_task / cancel / message_user / …), the full `decision_json`, the model's **reasoning/justification**, **rejected actions + why**, confidence, risk notes, model+tokens used. **This is where you see "why no task" or "why a duplicate."**

### Section 4 — Result (Execution): *what actually happened*
Executed action, task created/cancelled (id), error (e.g., `board_manager_openrouter_timeout`, malformed JSON), usage (tokens/cost), duration. **Closes the loop: decision → outcome.**

### LIVE OUTPUT panel
A real-time tail of the **current/in-flight run's model output** (secretary + decision streaming), so you can watch it reason as it happens — not just post-hoc. Black/mono box, SSE.

### Filter + search
Since it's text-heavy: filter runs by action (`do_nothing`/`initiate`/`error`), and full-text search across packets/decisions (e.g., "goodalexander", a task id, "do_nothing") to find the run that matters.

---

## Data architecture (for the orc to wire — auditable)

**Data mostly EXISTS already** in:
- `board_manager_runs`: `started_at`, `selected_action`, `status`, `source_packet_json`, `decision_json`, `micro_summary_json`, `usage_json`, `output_text`, `error`, `reasoning_effort`, `model`, `provider`, `scope`, `trigger`.
- `board_manager_secretary_packets`: the secretary packet JSON + `created_at`.
- Existing helpers: `getBoardManagerAgentFeed`, `getBoardManagerUserMessages` (`server/repositories/board-manager.js`).

**Wire:**
1. **`GET /api/hive/brain/runs`** — paginated list of recent runs (time, action, status, size, error) for the timeline + filters.
2. **`GET /api/hive/brain/run/:id`** — full detail: source packet + secretary report + decision + result for one run (the inspect view).
3. **`GET /api/hive/brain/live` (SSE)** — stream the in-flight run's model output in real time (secretary + decision). Requires capturing the model's streaming chunks during a run (currently only final `output_text` is stored) — emit them to the SSE channel as the run executes.
4. **`src/features/hive/HiveBrainView.jsx`** — the view: run timeline + 4 collapsible Sections + live panel + filter/search, matching the `<Section>` UX. Gated to operator.
5. **More-menu entry** in `src/main.jsx` (the `moreMenuOpen` dropdown) → Hive Brain.

**Auditability requirements:** every run's full input→reasoning→decision→result is retrievable (no truncation; the JSON is stored raw); the live stream is also persisted to the run's `output_text` so nothing is lost; operator-only access.

## Constraints
- Operator-gated (not public — this exposes internal board reasoning + contributor data).
- Read-only (audit view) — no mutations from this tab.
- Fit the existing `<Section>` component + app styling; collapsible JSON; performant (paginate runs; lazy-load a run's full packet).
- No economic/reward-policy surface.

## Sequencing
1. **Nazgûl:** this mock (done — review/adjust).
2. **Orc:** wire the data architecture (3 endpoints + SSE live capture) + build `HiveBrainView.jsx` + More-menu entry. Test (operator-gated, paginated, live stream works, audit data complete). Deploy + verify.

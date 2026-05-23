# Agent-Managed About Panels

Status: implemented for Hive project documents

This plan defines how the Board Manager should update readable About panels across Task Node surfaces, starting with Hive project detail pages.

The immediate target is the Hive project About section. A project card such as `Capital Deployment Protocol` should not only show static seed text. It should have a current, agent-maintained project status document that explains what the project is, why it matters, what is happening now, what is blocked, and what execution points matter next.

## Product Goal

An About panel should make a complex project understandable without asking the user to read raw Hive Secretary reports, Board Manager actions, task pointers, or database state.

For a Hive project, the About panel should answer:

- What is this project?
- Why does it matter to the network?
- What is the current execution status?
- What are the key points relevant to moving it forward?
- What is blocked or unclear?
- What should the Board Manager or contributors pay attention to next?

This is not a marketing page. It is an operational briefing for people and agents.

## Example Target Shape

On a Hive project detail page:

```text
01
About
What this project is

[Static project description from network_projects.about]

Project Status
[Agent-maintained current status blob]

Key execution points
- ...
- ...
- ...

Blocked or unclear
- ...

Last updated by Board Manager
May 22, 2026
```

For the example `Capital Deployment Protocol`, the static row can say:

```text
The Capital Deployment Protocol is the alpha-generation workstream for turning network activity into market opportunity routing. It exists because the report says Task Node should support alternative-data discovery and routing.
```

The agent-managed Project Status should be allowed to say things like:

```text
The project is currently in opportunity-routing map phase. The important execution question is how validated Task Node outputs become credible market signals, and what evidence is required before a signal can influence capital deployment. The next useful work is to define routing criteria, evidence thresholds, and the relationship between contributor tasks and deployable alpha.
```

That blob should be editable only by the Board Manager or an operator action hook, not manually by the frontend.

## Data Boundary

Do not overload `network_projects.about` with frequently changing status text.

Implemented table:

`network_project_product_docs`

Fields:

- `id`
- `project_id`
- `status`: `current`, `superseded`, or `archived`
- `title`
- `summary`
- `project_status`
- `key_points_json`
- `blocked_or_unclear_json`
- `next_actions_json`
- `source_packet_digest`
- `source_refs_json`
- `board_manager_run_id`
- `provider`
- `model`
- `prompt_version`
- `output_json`
- `created_at`
- `superseded_at`

The table is a Postgres read/write planning artifact. It is not canonical task protocol state. It can be regenerated from project rows, Hive Context, Hive Secretary reports, project-linked task projections, contributor state, and Board Manager run history.

## Board Manager Action

Use the implemented action:

`refresh_project_document`

The action targets a specific `network_projects.id`.

Input packet:

- project row: title, type, phase, summary, objective, static about text, targets
- latest Hive Secretary report
- relevant Hive Context entries
- current project-linked tasks when available
- contributor rollups when available
- recent Board Manager actions for the project
- existing current product document, if any

Output:

- one current project product document
- source references sufficient for audit
- concise reason for why the document changed

The Board Manager should choose this action when:

- a project has no product document;
- the project phase changed;
- new validated Hive Context materially changes the project;
- project-linked task state changes the operational status;
- contributors or blockers changed;
- the current document is stale.

It should not refresh just because someone opened the Hive page.

## Board Manager Prompt

Project documents are written by the Board Manager itself.

The `refresh_project_document` action requires `payload.project_document` in the Board Manager JSON decision. The action hook validates and persists that document directly. It does not call OpenRouter, DeepSeek, or a second writing model.

The Board Manager prompt should require plain English and avoid jargon. It should not invent task state or contributor work. If status is unclear, it should say what information is missing and recommend information-gathering tasks or user follow-up.

Expected structured output:

```json
{
  "title": "",
  "summary": "",
  "project_status": "",
  "key_points": [],
  "blocked_or_unclear": [],
  "next_actions": []
}
```

## UI Rules

The Hive project detail About section should show:

1. Static project description from `network_projects.about`.
2. Collapsed agent-managed `Project Status` from `network_project_product_docs.current`.
3. Key execution points after expansion.
4. Blockers or unknowns after expansion when present.
5. Next actions after expansion.
6. Last updated timestamp and model/prompt metadata in a subtle audit line.

The collapsed state should show the title, timestamp, and short summary only. The expanded state should show the full generated document. This keeps Hive project pages scannable while preserving the audit detail for operators.

If no product document exists:

- show the static project description;
- show a restrained empty state: `Project status has not been generated yet.`;
- do not show filler copy.

The Project Status blob should be expandable if it becomes long, but the first two or three lines should be visible by default.

## Generalization Beyond Hive

The same pattern can later power About panels for other surfaces:

- Tasks: task explanation and current review status;
- Profile: profile trust explanation;
- Memory: what the memory packet is doing;
- Context: how the current context document is used;
- Wallet: custody and balance explanation;
- Hive: project and network coordination status.

Do not create a generic cross-page table first. Start with Hive project documents because the data model and Board Manager action are already scoped there. Generalize only after the Hive project document path works.

## Implementation Steps

Implemented:

1. `server/db/migrations/038_network_project_product_docs.sql` adds current/superseded project documents.
2. `server/repositories/hive-project-product-docs.js` reads current docs, builds one project source packet, and inserts a new current version while superseding the old one.
3. `prompts/hive/board_manager_v1.md` defines `payload.project_document` for the `refresh_project_document` action.
4. `schemas/board-manager-action.schema.json` validates the product-document fields in the Board Manager decision.
5. `server/board-manager-actions.js` implements `refresh_project_document` without calling a secondary writer model.
6. `server/repositories/board-manager.js` marks `refresh_project_document` as an implemented hook in the Board Manager source packet.
7. `GET /api/hive/projects` includes current project product documents through `server/repositories/hive-projects.js`.
8. `src/features/hive/HiveView.jsx` renders Project Status inside the Hive project About section.
9. `scripts/board-manager-action-hooks-smoke.mjs` verifies the executed action hook writes a current document when Postgres is enabled and records `provider = codex_exec`.

## Done Criteria

This milestone is done when:

- a project with no product document shows a clean empty Project Status state;
- Board Manager can refresh one project document through `refresh_project_document`;
- the Hive project page shows the generated Project Status and key points;
- the document can be regenerated without duplicating current rows;
- docs and prompt list show the prompt and code surfaces;
- tests prove the old static `about` field and the new current product document do not overwrite each other.

## Reviewer To Do List

Review implementation against this document (agent managed about panels). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.

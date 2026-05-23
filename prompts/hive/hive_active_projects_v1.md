You determine active Hive projects for Task Node.

The source packet contains:

- the latest Hive Secretary report, which summarizes validated-wallet Hive Inputs;
- the currently registered project list, if any;
- current project type boundaries.

Your job is to decide which projects should be active before any network tasks are allocated. A project is a durable coordination container that can later receive tasks, contributors, and reward routing. Do not create user tasks. Do not fabricate live contributors, task rows, routed transactions, or activity.

Use only these project types:

- `protocol_marketing`
- `protocol_development`
- `alpha_generation`
- `protocol_applications`
- `network_validation`

Return projects that are useful to an operator who asks, "What is the network actually working on?" Prefer 1 to 5 active projects. If the source packet is thin, return a small project set and say what evidence it is based on.

Project rules:

- Preserve an existing project only if it remains useful and supported by the Secretary report.
- Create a new project when the report describes a clear unresolved network workstream.
- A project is a durable workstream, product, protocol, or network capability. Do not create a project whose title is only a discovery activity such as "scoping", "research", "planning", "audit", or "investigation".
- If the network is still discovering what should be done, make the durable project visible and put that uncertainty in `phase_label`, `about`, and `rationale`. For example, the project can be "Post Fiat L1" with phase "Scoping"; it should not be "Post Fiat L1 scoping".
- If a project cannot yet be made concrete, explain in `rationale` that the next Network Tasks should gather missing information. Do not turn uncertainty itself into a fake project.
- Use plain language titles.
- The summary should be one sentence.
- The about text should explain what the project is and why it exists.
- `task_count` is the planned or scoped task count, not live allocated task rows.
- `contributor_count` is the target operator count, not live allocated contributors.
- `pft_routed` is the planned route budget or target, not a confirmed payment total.
- Keep all live fields honest: no fake wallets, no fake task IDs, no fake activity.

## Reviewer To Do List

Review implementation against this document (hive active projects v1). Mark each item when verified.

### Memory Efficiency
- [ ] Prompt input blocks bounded; large context clipped or digested before call.
- [ ] Prompt output schema minimal for downstream storage.

### Code Quality
- [ ] Prompt version recorded when output persisted to DB or PFTL payload.
- [ ] Structured output prompts match parser validation in caller.

### Coherence
- [ ] Prompt policy matches surface doc behavior (e.g., evidence types, mode rules).
- [ ] Used-by call sites in docs-content.js still accurate.

### Bloat
- [ ] Prompt text avoids redundant restatement of data already in input blocks.
- [ ] No duplicate prompt files for same behavior without version bump.

### Security
- [ ] Prompt instructs model not to invent hidden state or exfiltrate secrets.
- [ ] Private/user data handling matches provider privacy mode for caller.

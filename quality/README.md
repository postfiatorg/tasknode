# Task Node Quality Gates

Enforceable repository policy, kept apart from product docs so rules change in code review.

- `npm run format-check`: LF line endings, no trailing whitespace, final newline.
- `npm run lint`: React hooks, accessibility basics, and JavaScript syntax for app, server, and scripts.
- `npm run file-size-check`: modularity limits from `file-size-limits.json`.
- `npm run bundle-budget-check`: built asset budgets from `bundle-budgets.json`.

`npm run check` (the CI gate) runs all of them.

Design mocks are product inputs, not source. Keep them in the local, gitignored `mocks/` intake
folder; never import them from `src/`, `server/`, or `shared/`.

# Task Node Quality Gates

This folder contains enforceable quality policy for the repo. It is intentionally separate from product docs so the rules can be changed in code review without rewriting specs.

## Required Checks

- `npm run format-check`: source/config files must use LF line endings, no trailing whitespace, and a final newline.
- `npm run lint`: React hooks, accessibility basics, and JavaScript syntax rules must pass for app/server code.
- `npm run file-size-check`: feature code must stay below modularity limits. Any exception needs an owner, a reason, and a removal date.
- `npm run quality`: runs all three checks above.

`npm run check` includes `npm run quality` before the smoke tests and build.

## Mock Process

Mocks are a first-class design input, but they are not production code.

- Put fresh user or designer drops in `mocks/incoming/`.
- Promote stable reference mocks to `mocks/canonical/`.
- Keep active product comparison mocks in `mocks/*.jsx` only when they are currently being implemented.
- Existing root mocks such as `jsx_mock.jsx` and `login.jsx` may remain in place while they are active product input.
- Move superseded mocks to `mocks/archive/`.
- Do not import `mocks/` files from `src/` or `server/`.

The normal source lint and source-size gates ignore mocks so design handoff files can remain faithful to the designer. Mocks still have a high-water file-size cap so a pasted artifact cannot silently become a second application.

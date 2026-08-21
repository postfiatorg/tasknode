# Mock Intake

This folder is the intentional intake area for designer/product JSX mocks.
Mocks are allowed in the repo because they are product inputs, not production
code.

## Rules

- Put new UX mocks in `mocks/incoming/` unless they are replacing an existing
  named mock.
- Promote stable references to `mocks/canonical/`.
- Keep implementation notes in the PR or the WIP file that consumes the mock.
- Do not import files from `mocks/` into `src/` or `server/`.
- Do not treat mock data as runtime truth. Production UI should read API state
  or render an honest empty/loading state.

## Current Structure

- `canonical/`: long-lived reference mocks.
- root `*.jsx`: active product mocks currently being ported or compared.
- `incoming/`: drop zone for new designer/product mocks.
- `archive/`: superseded mocks kept only for provenance.

Quality gates exclude this folder from normal app-size and lint requirements,
but mock files still have a separate high-water mark so accidental massive
pastes are visible.

# Team Context UX Verification

The visual fixture renders six production-shaped collaborators with long rewarded-work summaries at desktop and mobile widths.

## Before

- `screenshots/before-desktop.png`
- Three equal-width cards force long prose into narrow columns.
- Dense and empty members receive identical card weight.
- Full summaries render immediately with no scan-first state.

## After

- `screenshots/after-desktop.png`
- `screenshots/after-mobile.png`
- One contributor per ruled row with stable identity and activity metrics.
- Long updates use a readable measure and concise preview.
- Five detailed summaries expose keyboard-accessible `Read full update` controls.
- The no-work member stays compact and does not show a meaningless expansion control.
- Desktop and 390px mobile fixtures have no horizontal overflow.

## Reproduction

Run Vite on port 5175 and Chrome with CDP on port 9342, then execute:

`SCREENSHOT_PATH=<path> node scripts/team-context-visual-smoke.mjs`

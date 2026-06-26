# Mobile Badge Sync Scroll Cutoff Evidence

Task: `task_70cd895b483bd6723b8552c5ec31da9d`

## Fix

The mobile task detail modal was offset by the collapsed-sidebar rule:
`.app-shell.sidebar-collapsed .task-modal-layer { left: 56px; }`.

On mobile, the task surface uses the collapsed sidebar state, and that selector
has higher specificity than the mobile `.task-modal-layer { left: 0; }` rule.
The modal therefore started 56px too far right and the right edge of the task
brief was clipped.

The patch adds a mobile-specific override for
`.app-shell.sidebar-collapsed .task-modal-layer`, pins the modal to `100dvh`,
and keeps the body as the touch scroll container.

## Screenshots

- Before: `screenshots/before-mobile-task-top.png`
- Before scrolled: `screenshots/before-mobile-task-bottom.png`
- After: `screenshots/after-mobile-task-top.png`
- After scrolled: `screenshots/after-mobile-task-bottom.png`

## Verification

Command:

```sh
TASK_MODAL_SCROLL_BASE_URL=http://127.0.0.1:5178 TASK_MODAL_SCROLL_PREFIX=after node scripts/task-modal-mobile-scroll-smoke.mjs
```

Passing metrics from the after run:

```json
{
  "viewport": { "width": 390, "height": 720, "mobile": true },
  "initial": {
    "layerLeft": 0,
    "layerRight": 390,
    "modalLeft": 0,
    "modalRight": 390,
    "bodyLeft": 0,
    "bodyRight": 390
  },
  "bottom": {
    "scrollTop": 906,
    "scrollHeight": 1547,
    "clientHeight": 641,
    "modalRight": 390,
    "bodyRight": 390
  },
  "contentScrollable": true,
  "reachedBottom": true,
  "horizontallyFitted": true
}
```

## Discord Announcement

No Discord webhook/channel config was available in this local worktree or the
main repo env files, so no real Discord message ID was produced here.

Announcement text to post:

```text
Submitted fix for task_70cd895b483bd6723b8552c5ec31da9d: mobile task detail content was clipped during the badge-sync task flow because the collapsed-sidebar task modal offset overrode the mobile left:0 rule. PR includes the CSS fix, a rerunnable mobile scroll smoke, and before/after screenshots showing the task content reaches the verification section at 390px width.
```

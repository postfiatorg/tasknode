# Task Timestamp Format Audit - 2026-05-19

## Scope

Focused audit of task timestamp rendering in the Tasks list, task detail modal,
and forensics timeline.

## Root Cause

Task generation and replay imports can store acceptance deadlines as midnight
UTC timestamps such as `2026-05-20T00:00:00Z`. The task list treated every
deadline-like value as an exact timestamp and rendered it with hour/minute, so
date-only task deadlines appeared as `May 20, 12:00 AM`.

That was misleading because those rows represented a calendar deadline, not a
meaningful midnight event time.

## Fix

- Added `shared/task-time-format.js` as the shared formatting path.
- `formatTaskDeadline` renders midnight/date-only deadlines as UTC calendar
  dates, for example `May 20`.
- Explicit non-midnight deadlines still render date, time, and timezone.
- `formatTaskTimestamp` renders real event/review timestamps with date, time,
  and timezone.
- Task forensics now uses the shared timestamp formatter instead of a local
  formatter.

## Changed Files

- `shared/task-time-format.js`
- `server/repositories/tasks.js`
- `src/features/tasks/TaskDetailModal.jsx`
- `scripts/task-time-format-smoke.mjs`
- `package.json`

## Verification

- `npm run task-time-format-smoke`
- `npm run quality`
- `npm run build`
- `git diff --check`
- Browser screenshots against `http://localhost:5174/#tasks`:
  - `/tmp/tasknode-task-timestamps-list.png`
  - `/tmp/tasknode-task-timestamps-detail.png`

## Before / After

Before:

```text
Deadline
May 20, 12:00 AM
```

After:

```text
Deadline
May 20
```

Real event timestamps still include time and timezone, for example:

```text
May 19, 3:42 PM UTC
```

# Task Node systemd units

`tasknodeofficial-board-refresh.timer` starts the oneshot Board Manager repository refresh every 15 minutes. Install the service and timer as user units, then enable the timer with `systemctl --user enable --now tasknodeofficial-board-refresh.timer`. The job uses an atomic process lock and exits successfully when another run owns it, so timer events never stack.

Board and digest reads are fetch-free: this timer owns repository freshness. Each source lead exposes `fetch_refreshed_at`; when it is more than 30 minutes old (or absent), consumers must treat the lead as historical rather than current repository truth. The service journal includes the latest per-board and per-repository refresh timestamps.

Production sample from 2026-08-08 (abridged):

```text
board_repository_refresh started_at=2026-08-08T00:02:54.238Z boards=6
board_repository_refresh board=board_pf_terminal refreshed_at=2026-08-08T00:02:55.603Z sources=1
  repo=PfTerminal fetch_verified=true fetch_refreshed_at=2026-08-08T00:02:55.938Z relation=ahead
board_repository_refresh board=board_tasknode_fixes refreshed_at=2026-08-08T00:03:34.485Z sources=1
  repo=tasknodeofficial fetch_verified=true fetch_refreshed_at=2026-08-08T00:03:34.839Z relation=missing_upstream
board_repository_refresh completed_at=2026-08-08T00:03:35.287Z boards=6
```

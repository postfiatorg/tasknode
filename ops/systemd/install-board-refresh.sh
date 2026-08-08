#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
TIMER="tasknodeofficial-board-refresh.timer"

mkdir -p "$SYSTEMD_USER_DIR"
ln -sfn "$DIR/tasknodeofficial-board-refresh.service" "$SYSTEMD_USER_DIR/tasknodeofficial-board-refresh.service"
ln -sfn "$DIR/$TIMER" "$SYSTEMD_USER_DIR/$TIMER"

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER"
systemctl --user is-enabled "$TIMER"
systemctl --user list-timers "$TIMER" --no-pager

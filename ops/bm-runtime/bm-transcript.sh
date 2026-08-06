#!/usr/bin/env bash
# Mirror each enabled board's tmux pane into board_manager_transcripts
# (Gate F: Hive Brain = the terminal view). Run from cron every 5 minutes.

set -uo pipefail
. "$(dirname "$0")/bm-env.sh"

ENABLED_FILE="$BM_HOME/enabled-boards"
[ -f "$ENABLED_FILE" ] || exit 0
bm_load_db_env
[ -n "${DATABASE_URL:-}" ] || { bm_log "transcript: no DATABASE_URL"; exit 1; }

while IFS= read -r ALIAS; do
  [ -n "$ALIAS" ] || continue
  case "$ALIAS" in \#*) continue ;; esac
  BOARD_ID=""
  for pair in $BM_BOARDS_LIST; do
    if [ "${pair%%:*}" = "$ALIAS" ]; then BOARD_ID="${pair##*:}"; fi
  done
  [ -n "$BOARD_ID" ] || continue
  SESSION="bm-$ALIAS"
  tmux has-session -t "$SESSION" 2>/dev/null || continue
  tmux capture-pane -p -S -2000 -t "$SESSION" 2>/dev/null | \
    (cd "$BM_REPO" && node scripts/bm-transcript-ingest.mjs --board "$BOARD_ID" --session "$SESSION") || \
    bm_log "transcript: ingest failed for $ALIAS"
done < "$ENABLED_FILE"

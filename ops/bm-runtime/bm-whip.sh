#!/usr/bin/env bash
# The whip (Gate D). Run from cron every 15 minutes.
#
# For each enabled board:
#   1. liveness: if the tmux session is dead, relaunch it (two strikes ->
#      alert file the operator can watch).
#   2. digest: compute `bm digest`; inject a continuation prompt ONLY if the
#      digest changed since the last injection (task completed / submission
#      arrived / board changed). Quiet board, quiet agent.
#
# Enable boards by listing aliases in $BM_HOME/enabled-boards (one per line).
# This keeps the pilot (Gate G: pfterminal only) deterministic.

set -uo pipefail
. "$(dirname "$0")/bm-env.sh"

ENABLED_FILE="$BM_HOME/enabled-boards"
[ -f "$ENABLED_FILE" ] || { bm_log "whip: no enabled-boards file; nothing to do"; exit 0; }

"$(dirname "$0")/bm-proxy.sh" >/dev/null 2>&1 || { bm_log "whip: proxy failed"; exit 1; }
bm_load_db_env

while IFS= read -r ALIAS; do
  [ -n "$ALIAS" ] || continue
  case "$ALIAS" in \#*) continue ;; esac
  BOARD_ID=""
  for pair in $BM_BOARDS_LIST; do
    if [ "${pair%%:*}" = "$ALIAS" ]; then BOARD_ID="${pair##*:}"; fi
  done
  [ -n "$BOARD_ID" ] || { bm_log "whip: unknown alias $ALIAS"; continue; }
  SESSION="bm-$ALIAS"

  # 1. Liveness.
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    STRIKES_FILE="$BM_STATE_DIR/$ALIAS.strikes"
    STRIKES=$(( $(cat "$STRIKES_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$STRIKES" > "$STRIKES_FILE"
    bm_log "whip: $SESSION dead (strike $STRIKES); relaunching"
    if "$(dirname "$0")/bm-launch.sh" "$ALIAS" >/dev/null 2>&1; then
      echo 0 > "$STRIKES_FILE"
    elif [ "$STRIKES" -ge 2 ]; then
      echo "$(date -u +%FT%TZ) $SESSION failed to relaunch after $STRIKES strikes" \
        >> "$BM_HOME/ALERTS.log"
      bm_log "whip: ALERT $SESSION relaunch failing"
    fi
    continue
  fi

  # 2. Conditional injection on digest change.
  DIGEST="$(cd "$BM_REPO" && node scripts/bm.mjs digest "$BOARD_ID" 2>/dev/null | awk '{print $2}')"
  if [ -z "$DIGEST" ]; then
    bm_log "whip: $ALIAS digest failed"
    continue
  fi
  STATE_FILE="$BM_STATE_DIR/$ALIAS.digest"
  LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [ "$DIGEST" = "$LAST" ]; then
    bm_log "whip: $ALIAS unchanged ($DIGEST); no injection"
    continue
  fi
  tmux send-keys -t "$SESSION" \
    "Board state changed (digest $DIGEST). Run: cd $BM_REPO && node scripts/bm.mjs board $BOARD_ID — then handle anything in awaiting_review, generate needed tasks, and journal what you did." \
    Enter
  echo "$DIGEST" > "$STATE_FILE"
  bm_log "whip: $ALIAS injected (digest $DIGEST)"
done < "$ENABLED_FILE"

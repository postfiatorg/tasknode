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

  # 1. Liveness. A session whose pane no longer has a live pfterminal
  # process (crashed, or exited into the keep-alive sleep) is dead even
  # though tmux still reports the session; inspect the pane's children.
  AGENT_ALIVE=false
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    PANE_PID="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 || true)"
    if [ -n "$PANE_PID" ] && ps --ppid "$PANE_PID" -o comm= 2>/dev/null | grep -q "^pfterminal"; then
      AGENT_ALIVE=true
    fi
  fi
  if [ "$AGENT_ALIVE" != "true" ]; then
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

  # 2. Wake delivery with processing acknowledgment.
  #
  # An injection is only *delivered*; it is *processed* when the agent writes
  # any bm_audit_log row afterward (its contract requires journaling every
  # wake). A pending wake without audit activity is re-injected up to 3
  # times, then alerts. This survives interrupted turns and model timeouts;
  # fire-and-forget does not.
  DIGEST="$(cd "$BM_REPO" && node scripts/bm.mjs digest "$BOARD_ID" 2>/dev/null | awk '{print $2}')"
  if [ -z "$DIGEST" ]; then
    bm_log "whip: $ALIAS digest failed"
    continue
  fi
  STATE_FILE="$BM_STATE_DIR/$ALIAS.digest"
  PENDING_FILE="$BM_STATE_DIR/$ALIAS.pending"
  LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"

  WAKE_MESSAGE="Board state changed (digest $DIGEST). Run: cd $BM_REPO && node scripts/bm.mjs board $BOARD_ID — then handle anything in awaiting_review, generate needed tasks, and journal what you did (journaling is also your wake acknowledgment)."

  if [ -f "$PENDING_FILE" ]; then
    # pending format: digest|iso_injected_at|attempts
    IFS='|' read -r PENDING_DIGEST PENDING_AT PENDING_ATTEMPTS < "$PENDING_FILE"
    ACTIVITY="$(cd "$BM_REPO" && node scripts/bm.mjs activity "$BOARD_ID" --since "$PENDING_AT" 2>/dev/null || echo "")"
    if [ -n "$ACTIVITY" ] && [ "$ACTIVITY" -gt 0 ] 2>/dev/null; then
      echo "$PENDING_DIGEST" > "$STATE_FILE"
      rm -f "$PENDING_FILE"
      bm_log "whip: $ALIAS wake acknowledged ($ACTIVITY audit rows); digest $PENDING_DIGEST committed"
      LAST="$PENDING_DIGEST"
    else
      ATTEMPTS=$(( ${PENDING_ATTEMPTS:-1} ))
      if [ "$ATTEMPTS" -ge 3 ]; then
        echo "$(date -u +%FT%TZ) $SESSION wake unacknowledged after $ATTEMPTS attempts (digest $PENDING_DIGEST)" >> "$BM_HOME/ALERTS.log"
        bm_log "whip: ALERT $ALIAS wake unacknowledged after $ATTEMPTS attempts; committing digest to avoid a loop"
        echo "$PENDING_DIGEST" > "$STATE_FILE"
        rm -f "$PENDING_FILE"
        LAST="$PENDING_DIGEST"
      else
        tmux send-keys -t "$SESSION" "$WAKE_MESSAGE" Enter
        echo "$DIGEST|$(date -u +%FT%TZ)|$(( ATTEMPTS + 1 ))" > "$PENDING_FILE"
        bm_log "whip: $ALIAS re-injected unacknowledged wake (attempt $(( ATTEMPTS + 1 )), digest $DIGEST)"
        continue
      fi
    fi
  fi

  if [ "$DIGEST" = "$LAST" ]; then
    bm_log "whip: $ALIAS unchanged ($DIGEST); no injection"
    continue
  fi
  tmux send-keys -t "$SESSION" "$WAKE_MESSAGE" Enter
  echo "$DIGEST|$(date -u +%FT%TZ)|1" > "$PENDING_FILE"
  bm_log "whip: $ALIAS injected (digest $DIGEST, awaiting acknowledgment)"
done < "$ENABLED_FILE"

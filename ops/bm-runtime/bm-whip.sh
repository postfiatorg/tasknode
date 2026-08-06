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

# Agent coverage config: each line "alias: board_id[,board_id...]" maps a
# tmux session (bm-<alias>) to the boards it manages. This is the multi-agent
# scaling knob: one agent can cover one board or several. Falls back to the
# legacy enabled-boards file (one alias per line = that alias's own board).
AGENTS_FILE="$BM_HOME/agents.conf"
if [ ! -f "$AGENTS_FILE" ]; then
  ENABLED_FILE="$BM_HOME/enabled-boards"
  [ -f "$ENABLED_FILE" ] || { bm_log "whip: no agents.conf or enabled-boards; nothing to do"; exit 0; }
  : > "$BM_STATE_DIR/agents.generated"
  while IFS= read -r ALIAS; do
    [ -n "$ALIAS" ] || continue
    case "$ALIAS" in \#*) continue ;; esac
    for pair in $BM_BOARDS_LIST; do
      if [ "${pair%%:*}" = "$ALIAS" ]; then echo "$ALIAS: ${pair##*:}" >> "$BM_STATE_DIR/agents.generated"; fi
    done
  done < "$AGENTS_FILE"
  AGENTS_FILE="$BM_STATE_DIR/agents.generated"
fi

"$(dirname "$0")/bm-proxy.sh" >/dev/null 2>&1 || { bm_log "whip: proxy failed"; exit 1; }
bm_load_db_env

while IFS= read -r AGENT_LINE; do
  [ -n "$AGENT_LINE" ] || continue
  case "$AGENT_LINE" in \#*) continue ;; esac
  ALIAS="${AGENT_LINE%%:*}"
  BOARDS_CSV="$(echo "${AGENT_LINE#*:}" | tr -d ' ')"
  BOARD_ID="${BOARDS_CSV%%,*}"   # primary board (used for launch context)
  [ -n "$ALIAS" ] && [ -n "$BOARDS_CSV" ] || { bm_log "whip: bad agents line: $AGENT_LINE"; continue; }
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

  # 2. Deterministic duty-driven wake with processing acknowledgment.
  #
  # Each round the whip computes the agent's mandatory to-do list from
  # durable state (bm duties): reviews due, verification requests due,
  # routing opportunities (idle badge capacity + free slots), stale
  # proposals, stale board info. The injection IS the work order. It fires
  # when the underlying board state OR the duty list changes, and stays
  # pending until the agent's audit activity acknowledges it (3 retries,
  # then alert).
  BOARD_ARGS="$(echo "$BOARDS_CSV" | tr ',' ' ')"
  DIGEST=""
  for ONE_BOARD in $BOARD_ARGS; do
    ONE="$(cd "$BM_REPO" && node scripts/bm.mjs digest "$ONE_BOARD" 2>/dev/null | awk '{print $2}')"
    DIGEST="$DIGEST$ONE"
  done
  DIGEST="$(printf '%s' "$DIGEST" | sha256sum | awk '{print $1}')"
  DUTIES_TEXT="$(cd "$BM_REPO" && node scripts/bm.mjs duties $BOARD_ARGS 2>/dev/null)"
  DUTIES_DIGEST="$(printf '%s' "$DUTIES_TEXT" | rg -o 'duties_digest [a-f0-9]+' | awk '{print $2}')"
  if [ -z "$DIGEST" ] || [ -z "$DUTIES_TEXT" ]; then
    bm_log "whip: $ALIAS digest/duties failed"
    continue
  fi
  COMBINED="$DIGEST:$DUTIES_DIGEST"
  STATE_FILE="$BM_STATE_DIR/$ALIAS.digest"
  PENDING_FILE="$BM_STATE_DIR/$ALIAS.pending"
  LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"

  WAKE_MESSAGE="Round wake for boards: $BOARDS_CSV (state $COMBINED).
$DUTIES_TEXT

Complete every numbered duty above in order, or journal exactly why a specific duty cannot be completed this round. Use: cd $BM_REPO && node scripts/bm.mjs <command>. Respect each board's budget, caps, and routing constraints. Journal what you did — journaling is also your wake acknowledgment."

  if [ -f "$PENDING_FILE" ]; then
    # pending format: digest|iso_injected_at|attempts
    IFS='|' read -r PENDING_DIGEST PENDING_AT PENDING_ATTEMPTS < "$PENDING_FILE"
    ACTIVITY=0
    for ONE_BOARD in $BOARD_ARGS; do
      ONE_N="$(cd "$BM_REPO" && node scripts/bm.mjs activity "$ONE_BOARD" --since "$PENDING_AT" 2>/dev/null || echo 0)"
      ACTIVITY=$(( ACTIVITY + ${ONE_N:-0} ))
    done
    if [ -n "$ACTIVITY" ] && [ "$ACTIVITY" -gt 0 ] 2>/dev/null; then
      echo "$PENDING_DIGEST" > "$STATE_FILE"
      rm -f "$PENDING_FILE"
      bm_log "whip: $ALIAS wake acknowledged ($ACTIVITY audit rows); state $PENDING_DIGEST committed"
      LAST="$PENDING_DIGEST"
    else
      ATTEMPTS=$(( ${PENDING_ATTEMPTS:-1} ))
      if [ "$ATTEMPTS" -ge 3 ]; then
        echo "$(date -u +%FT%TZ) $SESSION wake unacknowledged after $ATTEMPTS attempts (state $PENDING_DIGEST)" >> "$BM_HOME/ALERTS.log"
        bm_log "whip: ALERT $ALIAS wake unacknowledged after $ATTEMPTS attempts; committing state to avoid a loop"
        echo "$PENDING_DIGEST" > "$STATE_FILE"
        rm -f "$PENDING_FILE"
        LAST="$PENDING_DIGEST"
      else
        tmux send-keys -t "$SESSION" "$WAKE_MESSAGE" Enter
        echo "$COMBINED|$(date -u +%FT%TZ)|$(( ATTEMPTS + 1 ))" > "$PENDING_FILE"
        bm_log "whip: $ALIAS re-injected unacknowledged wake (attempt $(( ATTEMPTS + 1 )), state $COMBINED)"
        continue
      fi
    fi
  fi

  if [ "$COMBINED" = "$LAST" ]; then
    bm_log "whip: $ALIAS unchanged ($COMBINED); no injection"
    continue
  fi
  tmux send-keys -t "$SESSION" "$WAKE_MESSAGE" Enter
  echo "$COMBINED|$(date -u +%FT%TZ)|1" > "$PENDING_FILE"
  bm_log "whip: $ALIAS injected (state $COMBINED, awaiting acknowledgment)"
done < "$AGENTS_FILE"

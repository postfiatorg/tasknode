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
  done < "$ENABLED_FILE"
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

  # 1. Liveness. A session whose pane no longer has a live terminal
  # process (crashed, or exited into the keep-alive sleep) is dead even
  # though tmux still reports the session; inspect the pane's children.
  # Accept both Corbanu (corbanu*) and legacy pfterminal process names.
  AGENT_ALIVE=false
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    PANE_PID="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 || true)"
    if [ -n "$PANE_PID" ] && ps --ppid "$PANE_PID" -o comm= 2>/dev/null | grep -qE "^(pfterminal|corbanu)"; then
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

  # 1b. Contract currency. If the installed skills changed since this
  # session launched, the loaded contract is stale. Rotate the session at a
  # safe point (no pending unacknowledged wake) so session state always
  # matches the installed contract. The round file below also embeds the
  # full current contract every round regardless.
  CURRENT_SKILL_HASH="$(cat "$BM_SKILLS_DIR/board-manager/SKILL.md" "$BM_SKILLS_DIR"/board-*/SKILL.md 2>/dev/null | sha256sum | awk '{print $1}')"
  SESSION_SKILL_HASH="$(cat "$BM_STATE_DIR/$ALIAS.skillhash" 2>/dev/null || true)"
  if [ -n "$CURRENT_SKILL_HASH" ] && [ "$CURRENT_SKILL_HASH" != "$SESSION_SKILL_HASH" ] && [ ! -f "$BM_STATE_DIR/$ALIAS.pending" ]; then
    bm_log "whip: $ALIAS contract changed on disk; rotating session to load it"
    "$(dirname "$0")/bm-launch.sh" "$ALIAS" >/dev/null 2>&1 || bm_log "whip: $ALIAS contract rotation failed"
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

  # Write the round's work order to a tracked file; the injection is ONE
  # short line referencing it. Multi-line tmux injections scramble the TUI
  # composer, and files give us an auditable duty history.
  DUTIES_DIR="$BM_HOME/duties/$ALIAS"
  mkdir -p "$DUTIES_DIR"
  ROUND_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  ROUND_FILE="$DUTIES_DIR/round-$ROUND_STAMP.md"
  SESSION_START_FILE="$BM_STATE_DIR/$ALIAS.launched_at"
  SESSION_START="$(cat "$SESSION_START_FILE" 2>/dev/null || echo '1 hour ago')"
  SYSTEM_CHANGES="$(cd "$BM_REPO" && git log --oneline --since="$SESSION_START" -- ops/bm-runtime scripts/bm scripts/bm.mjs server/repositories/network-tasks.js server/repositories/bm-decisions.js server/repositories/network-task-capacity.js 2>/dev/null | head -12)"
  {
    echo "# Round work order — $ALIAS — $ROUND_STAMP"
    echo
    echo "Boards: $BOARDS_CSV"
    echo "State: $COMBINED"
    echo
    echo "## Current rules (generated from the live system this round — these"
    echo "override anything in your journal, handoff, or session memory)"
    echo
    echo "- Task-creation engine checks EXACTLY: verified badge, delivery wallet,"
    echo "  per-account capacity (free_slots shown per member below), and each"
    echo "  board's assignable_handles constraint. Nothing else. No operator"
    echo "  exclusions, no lane locks beyond badge fit, no one-task-per-person rule."
    echo "- Per-member engine verdicts in the duties below are computed by the"
    echo "  engine's own predicate this round. engine=eligible means task create"
    echo "  will accept them."
    if [ -n "$SYSTEM_CHANGES" ]; then
      echo
      echo "## System changes since your session started (your journal predates"
      echo "these; conclusions drawn before them are expired)"
      echo
      echo "$SYSTEM_CHANGES" | sed 's/^/- /'
    fi
    echo
    echo "$DUTIES_TEXT"
    echo
    echo "## Operating contract (current, full text — this supersedes the skill"
    echo "version loaded at your session start and anything in your journal)"
    echo
    cat "$BM_SKILLS_DIR/board-manager/SKILL.md" 2>/dev/null
    echo
    echo "Rules: complete every numbered duty in order, or journal exactly why a"
    echo "specific duty cannot be completed this round. Use: cd $BM_REPO && node scripts/bm.mjs <command>."
    echo "Respect each board's budget, caps, and routing constraints."
    echo "Journal what you did — journaling is also your wake acknowledgment."
  } > "$ROUND_FILE"
  cp "$ROUND_FILE" "$DUTIES_DIR/latest.md"
  (cd "$BM_REPO" && node scripts/bm.mjs duties $BOARD_ARGS --json 2>/dev/null) > "$DUTIES_DIR/latest.json" || true
  ls -1t "$DUTIES_DIR"/round-*.md 2>/dev/null | tail -n +51 | while IFS= read -r OLD; do rm -f "$OLD"; done

  WAKE_MESSAGE="Round wake (state ${COMBINED:0:12}…): read $ROUND_FILE and complete every numbered duty, or journal why a specific duty cannot be done. Journaling acknowledges the wake."

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
        tmux send-keys -t "$SESSION" C-u
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
  tmux send-keys -t "$SESSION" C-u
  tmux send-keys -t "$SESSION" "$WAKE_MESSAGE" Enter
  echo "$COMBINED|$(date -u +%FT%TZ)|1" > "$PENDING_FILE"
  bm_log "whip: $ALIAS injected (state $COMBINED, awaiting acknowledgment)"
done < "$AGENTS_FILE"

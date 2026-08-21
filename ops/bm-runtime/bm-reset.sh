#!/usr/bin/env bash
# Daily reset (Gate D). Run from cron once a day.
#
# One board at a time: ask the agent to finish its handoff, give it a grace
# window, write the DB-derived handoff skeleton regardless (bm handoff), then
# kill and relaunch the session with the handoff as opening context.

set -uo pipefail
. "$(dirname "$0")/bm-env.sh"

GRACE_SECONDS="${BM_RESET_GRACE_SECONDS:-600}"
ENABLED_FILE="$BM_HOME/enabled-boards"
[ -f "$ENABLED_FILE" ] || exit 0

"$(dirname "$0")/bm-proxy.sh" >/dev/null 2>&1
bm_load_db_env

while IFS= read -r ALIAS; do
  [ -n "$ALIAS" ] || continue
  case "$ALIAS" in \#*) continue ;; esac
  BOARD_ID=""
  for pair in $BM_BOARDS_LIST; do
    if [ "${pair%%:*}" = "$ALIAS" ]; then BOARD_ID="${pair##*:}"; fi
  done
  [ -n "$BOARD_ID" ] || continue
  SESSION="bm-$ALIAS"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux send-keys -t "$SESSION" \
      "DAILY RESET in $((GRACE_SECONDS / 60)) minutes. Write your handoff now: run cd $BM_REPO && node scripts/bm.mjs handoff $BOARD_ID , then open the file it prints and annotate threads in flight and what the next session must do first. Then journal 'handoff complete'." \
      Enter
    bm_log "reset: $ALIAS handoff requested, grace ${GRACE_SECONDS}s"
    sleep "$GRACE_SECONDS"
  fi

  # DB-derived skeleton is written regardless, so a hung agent cannot block
  # the reset contract.
  (cd "$BM_REPO" && node scripts/bm.mjs handoff "$BOARD_ID" >/dev/null 2>&1) || \
    bm_log "reset: $ALIAS bm handoff failed"

  "$(dirname "$0")/bm-launch.sh" "$ALIAS" >/dev/null 2>&1 && \
    bm_log "reset: $ALIAS relaunched" || \
    { bm_log "reset: $ALIAS relaunch FAILED"; echo "$(date -u +%FT%TZ) reset relaunch failed: $ALIAS" >> "$BM_HOME/ALERTS.log"; }
done < "$ENABLED_FILE"

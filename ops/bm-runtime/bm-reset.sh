#!/usr/bin/env bash
# Refresh long-running contexts only at a ready boundary with no pending duty.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/bm-env.sh"
while IFS= read -r ALIAS; do
  [ -f "$BM_STATE_DIR/$ALIAS.pending.json" ] && { bm_log "reset: $ALIAS deferred; unfinished round"; continue; }
  export BM_AGENT_TOKEN_FILE="$BM_HOME/credentials/$ALIAS.json"
  [ -f "$BM_AGENT_TOKEN_FILE" ] || continue
  while IFS= read -r BOARD; do
    (cd "$BM_REPO" && node scripts/bm.mjs handoff "$BOARD" --request-key "daily-handoff-$ALIAS-$BOARD-$(date -u +%F)" >/dev/null) || exit 1
  done < <(node "$DIR/registry.mjs" boards "$ALIAS")
  "$DIR/bm-launch.sh" "$ALIAS" --fresh || bm_log "reset: $ALIAS deferred until terminal ready"
done < <(node "$DIR/registry.mjs" aliases)

#!/usr/bin/env bash
# Launch (or relaunch) one board-manager PfTerminal session in tmux.
# Usage: bm-launch.sh <alias>   (community|pfterminal|l1v2|governance|tasknode|capital)

set -euo pipefail
. "$(dirname "$0")/bm-env.sh"

ALIAS="${1:?usage: bm-launch.sh <board-alias>}"
BOARD_ID=""
for pair in $BM_BOARDS_LIST; do
  if [ "${pair%%:*}" = "$ALIAS" ]; then BOARD_ID="${pair##*:}"; fi
done
[ -n "$BOARD_ID" ] || { echo "unknown board alias: $ALIAS"; exit 1; }

SESSION="bm-$ALIAS"
WORKDIR="$BM_HOME/workspaces/$ALIAS"
mkdir -p "$WORKDIR"

# Pre-trust the workspace so the TUI never blocks on the trust prompt when
# cron relaunches a session unattended.
PFT_CONFIG="$HOME/.pfterminal/config.toml"
if [ -f "$PFT_CONFIG" ] && ! grep -qF "[projects.\"$WORKDIR\"]" "$PFT_CONFIG"; then
  printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$WORKDIR" >> "$PFT_CONFIG"
fi

"$(dirname "$0")/bm-proxy.sh" >/dev/null
bm_load_db_env

LATEST_HANDOFF="$(ls -1t "$BM_JOURNAL_DIR/$BOARD_ID"/handoff-*.md 2>/dev/null | head -1 || true)"

PROMPT="You are the Board Manager for the '$BOARD_ID' board of the Post Fiat network.
Your operating contract is the board-manager skill; your board context is the
board-$ALIAS skill. Read both before acting, then follow them exactly.
Your tool is the bm CLI: cd $BM_REPO && node scripts/bm.mjs <command>
Start with: board $BOARD_ID, then handle awaiting_review first.
Journal every decision: node scripts/bm.mjs journal $BOARD_ID --text '...'."
if [ -n "$LATEST_HANDOFF" ]; then
  PROMPT="$PROMPT
Read your predecessor's handoff first: $LATEST_HANDOFF"
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$WORKDIR" \
  -e DATABASE_URL="${DATABASE_URL:-}" \
  -e TASKNODE_DATABASE_ENABLED="true" \
  -e BM_JOURNAL_DIR="$BM_JOURNAL_DIR" \
  -e BM_ACTOR="board_manager_$ALIAS" \
  -e BM_OPERATOR_ACCOUNT_ID="$BM_OPERATOR_ACCOUNT_ID" \
  -e BM_OPERATOR_WALLET="$BM_OPERATOR_WALLET" \
  "pfterminal -c model_provider=\"$BM_PROVIDER\" -m \"$BM_MODEL\" -c approval_policy=\"never\" -c sandbox_mode=\"danger-full-access\" $(printf '%q' "$PROMPT"); echo 'pfterminal exited'; sleep 86400"

bm_log "launch: $SESSION started (board=$BOARD_ID provider=$BM_PROVIDER model=$BM_MODEL)"
echo "launched $SESSION"

#!/usr/bin/env bash
# Shared environment for the Board Manager v2 runtime harness (Gate D).
# Sourced by bm-launch.sh, bm-whip.sh, bm-reset.sh, bm-proxy.sh.

set -u

# Cron runs with a minimal environment; make sure user-installed binaries
# (pfterminal, fly, node version managers) resolve exactly as they do in an
# interactive shell.
export PATH="$HOME/.local/bin:$HOME/.fly/bin:/usr/local/bin:$PATH"

export BM_REPO="${BM_REPO:-/home/pfrpc/repos/tasknodeofficial}"
export BM_HOME="${BM_HOME:-$HOME/pf-boards}"
export BM_STATE_DIR="$BM_HOME/state"
export BM_JOURNAL_DIR="${BM_JOURNAL_DIR:-$BM_HOME/journal}"
export BM_LOG_DIR="$BM_HOME/logs"
export BM_DB_ENV="$BM_HOME/db.env"          # 0600, written by bm-proxy.sh
export BM_PROXY_PORT="${BM_PROXY_PORT:-16380}"
export BM_MPG_CLUSTER="${BM_MPG_CLUSTER:-3x9jv02yd3dr6qp7}"
export BM_FLY_APP="${BM_FLY_APP:-tasknodeofficial-dev}"

# Model: operator mandate is Kimi K3. It is served by the `kimi-code`
# provider. Fallback if Moonshot is down: ambient + moonshotai/kimi-k2.7-code.
export BM_PROVIDER="${BM_PROVIDER:-kimi-code}"
export BM_MODEL="${BM_MODEL:-kimi-k3}"

# Escalation target (operator).
export BM_OPERATOR_ACCOUNT_ID="${BM_OPERATOR_ACCOUNT_ID:-acct_oauth_3c70e69ab7b8ef1fad3df508}"
export BM_OPERATOR_WALLET="${BM_OPERATOR_WALLET:-rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx}"

# The six boards: "<alias>:<board_id>" pairs; tmux session is bm-<alias>.
BM_BOARDS=(
  "community:board_community_promotion"
  "pfterminal:board_pf_terminal"
  "l1v2:board_postfiat_l1v2"
  "governance:board_ai_l1_governance"
  "tasknode:board_tasknode_fixes"
  "capital:board_capital_markets"
)
export BM_BOARDS_LIST="${BM_BOARDS[*]}"

mkdir -p "$BM_STATE_DIR" "$BM_JOURNAL_DIR" "$BM_LOG_DIR"

bm_log() {
  echo "$(date -u +%FT%TZ) $*" >> "$BM_LOG_DIR/harness.log"
}

bm_load_db_env() {
  # shellcheck disable=SC1090
  [ -f "$BM_DB_ENV" ] && . "$BM_DB_ENV"
}

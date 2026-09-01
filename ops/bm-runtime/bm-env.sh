#!/usr/bin/env bash
# Shared environment for the Board Manager v2 runtime harness (Gate D).
# Sourced by bm-launch.sh, bm-whip.sh, bm-reset.sh, bm-proxy.sh, and the skill installer.

set -u

# Cron runs with a minimal environment; make sure user-installed binaries
# (corbanu, legacy pfterminal, fly, node version managers) resolve exactly as
# they do in an interactive shell.
export PATH="$HOME/.local/bin:$HOME/.fly/bin:/usr/local/bin:$PATH"

export BM_REPO="${BM_REPO:-/home/pfrpc/repos/tasknode}"
export BM_HOME="${BM_HOME:-$HOME/pf-boards}"
export BM_STATE_DIR="$BM_HOME/state"
export BM_JOURNAL_DIR="${BM_JOURNAL_DIR:-$BM_HOME/journal}"
export BM_LOG_DIR="$BM_HOME/logs"
export BM_DB_ENV="$BM_HOME/db.env"          # 0600, written by bm-proxy.sh
export BM_PROXY_PORT="${BM_PROXY_PORT:-16380}"
# Current tasknode DB. bm-proxy validates this against the app's DATABASE_URL
# and overrides it when Fly points the app at a recovered/new MPG cluster.
export BM_MPG_CLUSTER="${BM_MPG_CLUSTER:-zp2wjrejjv5odn4q}"
export BM_FLY_APP="${BM_FLY_APP:-tasknodeofficial-dev}"

# Model: operator mandate is Kimi K3, served by the `kimi-code` provider
# (Kimi plan — NOT the Corbanu Plan route). The KIMI_API_KEY credential must
# exist in the vault of the resolved terminal home below. Fallback if
# Moonshot is down: ambient + moonshotai/kimi-k2.7-code.
export BM_PROVIDER="${BM_PROVIDER:-kimi-code}"
export BM_MODEL="${BM_MODEL:-kimi-k3}"

# Terminal binary. Corbanu Terminal is the supported surface; the legacy
# pfterminal names are compatibility fallbacks only (the pfterminal binary
# was removed in the Corbanu rebrand, which killed this harness on
# 2026-08-17). BM_TERMINAL_BIN (or legacy PFTERMINAL_BIN) overrides.
BM_TERMINAL_BIN="${BM_TERMINAL_BIN:-${PFTERMINAL_BIN:-}}"
if [ -z "$BM_TERMINAL_BIN" ]; then
  for candidate in corbanu pfterminal "$HOME/.local/bin/corbanu" "$HOME/.local/bin/pfterminal"; do
    resolved="$(command -v "$candidate" 2>/dev/null || true)"
    if [ -n "$resolved" ] && [ -x "$resolved" ]; then BM_TERMINAL_BIN="$resolved"; break; fi
    if [ -x "$candidate" ]; then BM_TERMINAL_BIN="$candidate"; break; fi
  done
fi
export BM_TERMINAL_BIN

# Terminal home: skills and config trust follow the resolved binary. The
# installed corbanu entrypoint pins CODEX_HOME=$HOME/.corbanu; legacy
# pfterminal used $HOME/.pfterminal.
if [ -z "${BM_TERMINAL_HOME:-}" ]; then
  case "$(basename "${BM_TERMINAL_BIN:-pfterminal}")" in
    pfterminal*) BM_TERMINAL_HOME="$HOME/.pfterminal" ;;
    *)           BM_TERMINAL_HOME="$HOME/.corbanu" ;;
  esac
fi
export BM_TERMINAL_HOME
export BM_SKILLS_DIR="${BM_SKILLS_DIR:-$BM_TERMINAL_HOME/skills}"

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
  if [ -f "$BM_DB_ENV" ]; then
    # shellcheck disable=SC1090
    . "$BM_DB_ENV"
  fi
  return 0
}

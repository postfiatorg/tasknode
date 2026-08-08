#!/usr/bin/env bash
# Refresh all configured Board Manager repositories from the production timer.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/bm-env.sh"

"$DIR/bm-proxy.sh" >/dev/null
bm_load_db_env
cd "$BM_REPO"
exec node scripts/board-manager-refresh-job.mjs

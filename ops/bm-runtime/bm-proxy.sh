#!/usr/bin/env bash
# Ensure the Fly Managed Postgres proxy is running and $BM_DB_ENV is fresh.
# The DATABASE_URL value is written to a 0600 file and never echoed.

set -euo pipefail
. "$(dirname "$0")/bm-env.sh"

ensure_proxy() {
  if nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null; then
    return 0
  fi
  bm_log "proxy: starting fly mpg proxy on :$BM_PROXY_PORT"
  tmux kill-session -t bm-proxy 2>/dev/null || true
  tmux new-session -d -s bm-proxy \
    "fly mpg proxy $BM_MPG_CLUSTER --local-port $BM_PROXY_PORT >> '$BM_LOG_DIR/proxy.log' 2>&1"
  for _ in $(seq 1 20); do
    sleep 1
    if nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null; then return 0; fi
  done
  bm_log "proxy: FAILED to start"
  return 1
}

ensure_db_env() {
  if [ -f "$BM_DB_ENV" ]; then
    return 0
  fi
  bm_log "db-env: fetching DATABASE_URL from fly app secrets"
  local url
  url="$(fly ssh console -a "$BM_FLY_APP" -C "sh -lc 'printenv DATABASE_URL'" 2>/dev/null \
    | tr -d '\r\n' | grep -o 'postgres[^ ]*' || true)"
  if [ -z "$url" ]; then
    bm_log "db-env: FAILED to fetch DATABASE_URL"
    return 1
  fi
  local local_url
  local_url="$(printf '%s' "$url" | sed -E "s#@[^/]+/#@localhost:$BM_PROXY_PORT/#")"
  umask 077
  printf 'export DATABASE_URL=%q\nexport TASKNODE_DATABASE_ENABLED=true\n' "$local_url" > "$BM_DB_ENV"
  bm_log "db-env: written $BM_DB_ENV"
}

ensure_proxy
ensure_db_env
echo "bm-proxy: ok (port $BM_PROXY_PORT)"

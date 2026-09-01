#!/usr/bin/env bash
# Ensure the Fly Managed Postgres proxy serves the app's current database and
# refresh the private runtime DB environment. DATABASE_URL is never logged.

set -euo pipefail
. "$(dirname "$0")/bm-env.sh"

remote_database_url() {
  local output
  output="$(fly ssh console -a "$BM_FLY_APP" \
    -C "sh -lc 'printf %s \"\$DATABASE_URL\"'" 2>/dev/null | tr -d '\r\n')"
  # Fly may write a machine-selection notice to stdout before the command's
  # output. Extract only the URI; never echo the full remote value.
  case "$output" in
    *postgresql://*) printf 'postgresql://%s' "${output#*postgresql://}" ;;
    *postgres://*) printf 'postgres://%s' "${output#*postgres://}" ;;
    *) return 1 ;;
  esac
}

cluster_from_database_url() {
  local without_scheme authority hostport host cluster
  without_scheme="${1#*://}"
  authority="${without_scheme%%/*}"
  authority="${authority%%\?*}"
  hostport="${authority##*@}"
  host="${hostport%%:*}"
  case "$host" in
    pgbouncer.*.flympg.net)
      cluster="${host#pgbouncer.}"
      cluster="${cluster%%.*}"
      ;;
    *.flympg.net|*.fly.dev)
      cluster="${host%%.*}"
      ;;
    *)
      cluster=""
      ;;
  esac
  if [ "${#cluster}" -ne 16 ]; then return 1; fi
  case "$cluster" in
    *[!0-9a-z]*) return 1 ;;
  esac
  printf '%s' "$cluster"
}

ensure_db_env() {
  local url cluster local_url
  if ! url="$(remote_database_url)"; then
    bm_log "db-env: FAILED to fetch DATABASE_URL"
    return 1
  fi
  case "$url" in
    postgres://*|postgresql://*) ;;
    *)
      bm_log "db-env: FAILED to fetch a supported DATABASE_URL"
      return 1
      ;;
  esac

  cluster="$(cluster_from_database_url "$url")" || {
    bm_log "db-env: FAILED to resolve MPG cluster from DATABASE_URL host"
    return 1
  }

  # The remote host identifies the MPG cluster. Keep credentials, database,
  # and query parameters, but connect through the local proxy port.
  local_url="$(printf '%s' "$url" | sed -E "s#@[^/]+/#@localhost:$BM_PROXY_PORT/#")"
  BM_MPG_CLUSTER="$cluster"
  export BM_MPG_CLUSTER

  umask 077
  printf 'export DATABASE_URL=%q\nexport TASKNODE_DATABASE_ENABLED=true\nexport BM_MPG_CLUSTER=%q\n' \
    "$local_url" "$cluster" > "$BM_DB_ENV"
  bm_log "db-env: refreshed for MPG cluster $cluster"
}

proxy_listener_matches_cluster() {
  local listener_output pid args matched=false
  listener_output="$(ss -ltnp "sport = :$BM_PROXY_PORT" 2>/dev/null || true)"
  for pid in $(printf '%s\n' "$listener_output" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u); do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    case "$args" in
      *"fly mpg proxy $BM_MPG_CLUSTER"*) matched=true ;;
      *) return 1 ;;
    esac
  done
  [ "$matched" = true ]
}

stop_stale_proxy_listener() {
  local listener_output listener_pids pid args _
  listener_output="$(ss -ltnp "sport = :$BM_PROXY_PORT" 2>/dev/null || true)"
  listener_pids="$(printf '%s\n' "$listener_output" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)"
  [ -n "$listener_pids" ] || return 0
  for pid in $listener_pids; do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    case "$args" in
      *"fly mpg proxy "*)
        bm_log "proxy: stopping stale listener pid $pid on :$BM_PROXY_PORT"
        kill "$pid" 2>/dev/null || true
        ;;
      *)
        bm_log "proxy: refusing to stop unmanaged listener pid $pid on :$BM_PROXY_PORT"
        return 1
        ;;
    esac
  done
  for _ in $(seq 1 20); do
    nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null || return 0
    sleep 0.2
  done
  for pid in $(printf '%s\n' "$listener_output" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u); do
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 0.5
  nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null && return 1
  return 0
}

ensure_proxy() {
  local proxy_cluster_file recorded_proxy_cluster _
  proxy_cluster_file="$BM_STATE_DIR/proxy.cluster"
  recorded_proxy_cluster="$(cat "$proxy_cluster_file" 2>/dev/null || true)"

  # An open port is not sufficient: it may still be forwarding to a stale
  # cluster. Only reuse it when its recorded cluster matches the app secret.
  if nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null \
    && [ "$recorded_proxy_cluster" = "$BM_MPG_CLUSTER" ] \
    && proxy_listener_matches_cluster; then
    return 0
  fi

  if [ -n "$recorded_proxy_cluster" ] && [ "$recorded_proxy_cluster" != "$BM_MPG_CLUSTER" ]; then
    bm_log "proxy: rotating from MPG cluster $recorded_proxy_cluster to $BM_MPG_CLUSTER"
  elif nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null; then
    bm_log "proxy: untracked listener on :$BM_PROXY_PORT; restarting bm-proxy"
  fi

  stop_stale_proxy_listener || return 1
  tmux kill-session -t bm-proxy 2>/dev/null || true
  tmux new-session -d -s bm-proxy \
    "fly mpg proxy $BM_MPG_CLUSTER --local-port $BM_PROXY_PORT >> '$BM_LOG_DIR/proxy.log' 2>&1"
  for _ in $(seq 1 20); do
    sleep 1
    if nc -z 127.0.0.1 "$BM_PROXY_PORT" 2>/dev/null; then
      printf '%s\n' "$BM_MPG_CLUSTER" > "$proxy_cluster_file"
      return 0
    fi
  done
  bm_log "proxy: FAILED to start MPG cluster $BM_MPG_CLUSTER"
  return 1
}

ensure_db_env
ensure_proxy
echo "bm-proxy: ok (port $BM_PROXY_PORT, cluster $BM_MPG_CLUSTER)"

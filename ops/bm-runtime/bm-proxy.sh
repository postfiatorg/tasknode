#!/usr/bin/env bash
# Ensure the Fly Managed Postgres proxy serves the app's current database and
# refresh the private runtime DB environment. DATABASE_URL is never logged.

set -euo pipefail
. "$(dirname "$0")/bm-env.sh"

# Preserve a deliberately supplied runtime credential before considering the
# generated cache. This is useful when an already-running manager still has a
# valid scoped database session but Fly control-plane auth is temporarily down.
CALLER_DATABASE_URL="${DATABASE_URL:-}"

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

write_local_db_env() {
  local local_url="$1"
  local cluster="$2"
  umask 077
  printf 'export DATABASE_URL=%q\nexport TASKNODE_DATABASE_ENABLED=true\nexport BM_MPG_CLUSTER=%q\n' \
    "$local_url" "$cluster" > "$BM_DB_ENV"
}

database_url_works() {
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  (
    cd "$BM_REPO"
    DATABASE_URL="$candidate" BM_PROXY_PORT="$BM_PROXY_PORT" TASKNODE_DATABASE_ENABLED=true node --input-type=module - <<'NODE'
import pg from "pg";

const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== process.env.BM_PROXY_PORT) {
  throw new Error("bm_database_url_not_local_proxy");
}
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  application_name: "tasknodeofficial:bm-credential-probe",
});
try {
  await client.connect();
  await client.query("SELECT 1");
} finally {
  await client.end().catch(() => {});
}
NODE
  ) >/dev/null 2>&1
}

database_alert_once() {
  local marker="$BM_STATE_DIR/database-credentials.alerted"
  if [ ! -f "$marker" ]; then
    echo "$(date -u +%FT%TZ) Board Manager database credentials unavailable; Fly auth and the cached credential both require repair" \
      >> "$BM_HOME/ALERTS.log"
    : > "$marker"
  fi
}

clear_database_alert() {
  rm -f "$BM_STATE_DIR/database-credentials.alerted"
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

if ensure_db_env; then
  ensure_proxy
  clear_database_alert
else
  # Fly auth is a control-plane dependency, not a reason to stop a healthy
  # manager data plane. Reuse only a credential that succeeds against the
  # already recorded proxy cluster; never trust a stale cache without a probe.
  RECORDED_CLUSTER="$(cat "$BM_STATE_DIR/proxy.cluster" 2>/dev/null || true)"
  if [ -n "$RECORDED_CLUSTER" ]; then
    BM_MPG_CLUSTER="$RECORDED_CLUSTER"
    export BM_MPG_CLUSTER
  fi
  ensure_proxy || {
    database_alert_once
    exit 1
  }

  CANDIDATE_DATABASE_URL="$CALLER_DATABASE_URL"
  if ! database_url_works "$CANDIDATE_DATABASE_URL"; then
    CANDIDATE_DATABASE_URL=""
    if [ -f "$BM_DB_ENV" ]; then
      # shellcheck disable=SC1090
      . "$BM_DB_ENV"
      CANDIDATE_DATABASE_URL="${DATABASE_URL:-}"
    fi
  fi
  if ! database_url_works "$CANDIDATE_DATABASE_URL"; then
    bm_log "db-env: cached credential validation failed"
    database_alert_once
    exit 1
  fi
  write_local_db_env "$CANDIDATE_DATABASE_URL" "$BM_MPG_CLUSTER"
  clear_database_alert
  bm_log "db-env: reused validated local credential for MPG cluster $BM_MPG_CLUSTER"
fi
echo "bm-proxy: ok (port $BM_PROXY_PORT, cluster $BM_MPG_CLUSTER)"

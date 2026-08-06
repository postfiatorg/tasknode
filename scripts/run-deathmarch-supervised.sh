#!/usr/bin/env bash
set -euo pipefail

repo_dir="/home/pfrpc/repos/tasknodeofficial"
fly_bin="${FLY_BIN:-/home/pfrpc/.fly/bin/fly}"
app_name="${DEATHMARCH_FLY_APP:-tasknodeofficial-dev}"
local_port="${DEATHMARCH_MPG_LOCAL_PORT:-16433}"

cd "$repo_dir"

if [[ -f .env.tasknodeofficial-dev ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.tasknodeofficial-dev
  set +a
fi

remote_database_url="$($fly_bin ssh console --quiet --app "$app_name" --command 'printenv DATABASE_URL' 2>/dev/null \
  | awk '/^postgres(ql)?:\/\// { print; exit }')"
if [[ -z "$remote_database_url" ]]; then
  echo "deathmarch_supervisor_error:remote_database_url_missing" >&2
  exit 1
fi

export DEATHMARCH_DATABASE_URL="$(
  REMOTE_DATABASE_URL="$remote_database_url" LOCAL_DATABASE_PORT="$local_port" \
    /usr/bin/node -e '
      const url = new URL(process.env.REMOTE_DATABASE_URL);
      url.hostname = "127.0.0.1";
      url.port = process.env.LOCAL_DATABASE_PORT;
      url.searchParams.delete("sslmode");
      process.stdout.write(url.toString());
    '
)"
export DEATHMARCH_DISCORD_CHANNEL_ID="${DEATHMARCH_DISCORD_CHANNEL_ID:-${DEATHMARCH_CHANNEL_ID:-}}"
export DEATHMARCH_DATABASE_CONNECTION_TIMEOUT_MS="${DEATHMARCH_DATABASE_CONNECTION_TIMEOUT_MS:-15000}"
export DEATHMARCH_DATABASE_QUERY_TIMEOUT_MS="${DEATHMARCH_DATABASE_QUERY_TIMEOUT_MS:-30000}"

exec /usr/bin/npm run deathmarch -- "$@"

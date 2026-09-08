#!/usr/bin/env bash
# Install one supervised production loop, replacing old wake/transcript cron jobs.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/bm-env.sh"
# Fail before touching live schedules when credentials/API/candidate are absent.
node "$DIR/cutover-check.mjs"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/tasknode-kimi-supervisor.service" <<EOF
[Unit]
Description=Task Node production Kimi duty supervisor
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$BM_REPO
Environment=BM_HOME=$BM_HOME
Environment=BM_TERMINAL_BIN=$BM_TERMINAL_BIN
Environment=BM_TERMINAL_HOME=$BM_TERMINAL_HOME
ExecStart=$(command -v flock) -n $BM_STATE_DIR/wake.lock $(command -v node) $DIR/supervisor.mjs --watch
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
EOF
cat > "$HOME/.config/systemd/user/tasknode-kimi-reset.service" <<EOF
[Unit]
Description=Refresh an idle Task Node Kimi context
After=network-online.target
[Service]
Type=oneshot
Environment=BM_HOME=$BM_HOME
Environment=BM_TERMINAL_BIN=$BM_TERMINAL_BIN
Environment=BM_TERMINAL_HOME=$BM_TERMINAL_HOME
ExecStart=/bin/bash $DIR/bm-reset.sh
EOF
cat > "$HOME/.config/systemd/user/tasknode-kimi-reset.timer" <<'EOF'
[Unit]
Description=Task Node Kimi daily idle refresh
[Timer]
OnCalendar=*-*-* 06:00:00 UTC
Persistent=true
Unit=tasknode-kimi-reset.service
[Install]
WantedBy=timers.target
EOF
# Preserve every unrelated cron entry exactly.
TEMP_CRON="$(mktemp)"
CUTOVER_COMPLETE=false
STARTED_NEW=false
cleanup() {
  rm -f "$TEMP_CRON"
  if [ "$CUTOVER_COMPLETE" != true ] && [ "$STARTED_NEW" = true ]; then
    systemctl --user disable --now tasknode-kimi-supervisor.service || true
    rm -f "$BM_STATE_DIR/scoped-supervisor-installed.json"
  fi
}
trap cleanup EXIT
crontab -l 2>/dev/null > "$TEMP_CRON" || true
python3 - "$TEMP_CRON" "$DIR" "$BM_HOME" <<'PY'
import sys
from pathlib import Path
file=Path(sys.argv[1]); lines=file.read_text().splitlines()
lines=[line for line in lines if not any(name in line for name in ('bm-whip.sh','bm-reset.sh','bm-transcript.sh'))]
file.write_text('\n'.join(lines)+'\n')
PY
systemctl --user daemon-reload
if ! systemctl --user is-active --quiet tasknode-kimi-supervisor.service; then STARTED_NEW=true; fi
systemctl --user enable --now tasknode-kimi-supervisor.service
systemctl --user is-active --quiet tasknode-kimi-supervisor.service
# Keep the working production cron until the new process completes a tick.
# A failed or slow startup leaves the previous schedule available for recovery.
node - "$BM_STATE_DIR/scoped-supervisor-tick.json" <<'JS'
const fs = require('node:fs');
const started = Date.now();
(async () => {
  while (Date.now() - started < 60_000) {
    try {
      const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
      if (status.version === 1 && Date.parse(status.completedAt) >= started) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error('Scoped supervisor did not finish a tick; production cron retained.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
printf '{"version":1,"installedAt":"%s"}\n' "$(date -u +%FT%TZ)" > "$BM_STATE_DIR/scoped-supervisor-installed.json"
crontab "$TEMP_CRON"
systemctl --user enable --now tasknode-kimi-reset.timer
systemctl --user disable --now tasknode-kimi-wake.timer 2>/dev/null || true
CUTOVER_COMPLETE=true
echo "Installed Kimi supervisor (10-second poll) and idle-only daily reset timer."

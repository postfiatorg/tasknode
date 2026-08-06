#!/usr/bin/env bash
# Install the Gate D cron contract: whip every 15 minutes, reset daily 06:00 UTC.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

( crontab -l 2>/dev/null | grep -v "bm-whip.sh\|bm-reset.sh" ;
  echo "*/15 * * * * $DIR/bm-whip.sh >> $HOME/pf-boards/logs/cron.log 2>&1" ;
  echo "0 6 * * * $DIR/bm-reset.sh >> $HOME/pf-boards/logs/cron.log 2>&1" ) | crontab -

echo "installed:"
crontab -l | grep bm-

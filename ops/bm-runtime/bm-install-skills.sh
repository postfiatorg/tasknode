#!/usr/bin/env bash
# Install (or refresh) the board-manager skills into PfTerminal's skills dir.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${PFTERMINAL_SKILLS_DIR:-$HOME/.pfterminal/skills}"
mkdir -p "$DEST"
for skill in "$DIR"/skills/*/; do
  name="$(basename "$skill")"
  mkdir -p "$DEST/$name"
  cp "$skill/SKILL.md" "$DEST/$name/SKILL.md"
  echo "installed $name"
done

#!/usr/bin/env bash
# Install (or refresh) board-manager skills in the resolved terminal's skills dir.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Preserve the legacy override while defaulting to the same terminal-home
# resolution used by launch/whip (Corbanu first, pfterminal fallback).
DEST="${PFTERMINAL_SKILLS_DIR:-}"
# shellcheck source=bm-env.sh
. "$DIR/bm-env.sh"
DEST="${DEST:-$BM_SKILLS_DIR}"
mkdir -p "$DEST"
for skill in "$DIR"/skills/*/; do
  name="$(basename "$skill")"
  mkdir -p "$DEST/$name"
  cp "$skill/SKILL.md" "$DEST/$name/SKILL.md"
  echo "installed $name"
done
echo "skills directory: $DEST"

#!/bin/sh
# Connect this machine's coding agents to Task Node:
#   curl -fsSL https://tasknode.postfiat.org/install | sh
# Options go after "sh -s --":
#   curl -fsSL https://tasknode.postfiat.org/install | sh -s -- --agent claude
# Everything runs inside main so a partial download does nothing.

main() {
  server="${TASKNODE_URL:-https://tasknode.postfiat.org}"
  server="${server%/}"

  if ! command -v node >/dev/null 2>&1; then
    echo "Task Node needs Node.js 18 or newer. Install it from https://nodejs.org, then run this again." >&2
    return 1
  fi
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  if [ "$major" -lt 18 ]; then
    echo "Task Node needs Node.js 18 or newer (found $(node --version 2>/dev/null)). Update it from https://nodejs.org, then run this again." >&2
    return 1
  fi

  dir=$(mktemp -d "${TMPDIR:-/tmp}/tasknode.XXXXXX") || return 1
  trap 'rm -rf "$dir"' EXIT
  trap 'rm -rf "$dir"; exit 130' INT TERM HUP
  cli="$dir/tasknode.mjs"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$server/install/tasknode.mjs" -o "$cli" || { echo "Could not download the installer from $server." >&2; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$cli" "$server/install/tasknode.mjs" || { echo "Could not download the installer from $server." >&2; return 1; }
  else
    echo "Install curl or wget, or run: npx -y tasknode connect" >&2
    return 1
  fi

  TASKNODE_INVOCATION="curl -fsSL $server/install | sh -s --"
  export TASKNODE_INVOCATION

  # This script arrives on stdin, so prompts read the terminal instead.
  # Without one, run without prompts: replacements then need --yes.
  if (exec </dev/tty) 2>/dev/null; then
    node "$cli" connect "$@" </dev/tty
  else
    node "$cli" connect "$@" </dev/null
  fi
}

main "$@"

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
    echo "Task Node needs Node.js 22 or newer. Install it from https://nodejs.org, then run this again." >&2
    return 1
  fi
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  if [ "$major" -lt 22 ]; then
    echo "Task Node needs Node.js 22 or newer (found $(node --version 2>/dev/null)). Update it from https://nodejs.org, then run this again." >&2
    return 1
  fi

  # The local stdio entry needs a durable runtime after the installer exits.
  dir="${TASKNODE_CONFIG_DIR:-$HOME/.config/tasknode}/runtime"
  mkdir -p "$dir/bin" "$dir/lib" || return 1
  chmod 700 "$dir"
  cli="$dir/bin/tasknode.mjs"
  download() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
    else return 1; fi
  }
  download "$server/install/tasknode.mjs" "$cli" || return 1
  for file in package.json lib/prompt-crypto.mjs lib/prompt-device.mjs lib/prompt-stats.mjs lib/prompt-pad.mjs lib/prompt-client.mjs lib/prompt-mcp.mjs; do
    download "$server/install/$file" "$dir/$file" || return 1
  done
  npm install --prefix "$dir" --omit=dev --ignore-scripts --no-audit --no-fund >&2 || return 1

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

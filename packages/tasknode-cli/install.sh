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

  # Each attempt gets a private directory. Never overwrite a runtime that an
  # existing MCP entry references, including during concurrent installations.
  umask 077
  releases="${TASKNODE_CONFIG_DIR:-$HOME/.config/tasknode}/releases"
  mkdir -p "$releases" || return 1
  stage=$(mktemp -d "$releases/.staging-XXXXXXXX") || return 1
  mkdir -p "$stage/bin" "$stage/lib" || return 1
  download() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
    else return 1; fi
  }
  download "$server/install/manifest.json" "$stage/manifest.json" || return 1
  release=$(node -e 'const m=require(process.argv[1]); if(!/^[a-f0-9]{64}$/.test(m.releaseId)) process.exit(1); console.log(m.releaseId)' "$stage/manifest.json") || return 1
  for file in bin/tasknode.mjs package.json package-lock.json lib/prompt-crypto.mjs lib/prompt-device.mjs lib/prompt-stats.mjs lib/prompt-pad.mjs lib/prompt-client.mjs lib/prompt-mcp.mjs lib/prompt-agent-config.mjs; do
    download "$server/install/releases/$release/$file" "$stage/$file" || return 1
    node -e 'const fs=require("fs"),c=require("crypto"),d=process.argv[1],f=process.argv[2],m=JSON.parse(fs.readFileSync(d+"/manifest.json")); if(c.createHash("sha256").update(fs.readFileSync(d+"/"+f)).digest("hex")!==m.files[f]) process.exit(1)' "$stage" "$file" || return 1
  done
  npm ci --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund >&2 || return 1
  dir="$releases/$release-${stage##*-}"
  mv "$stage" "$dir" || return 1
  cli="$dir/bin/tasknode.mjs"
  # connect atomically writes each MCP entry only after the complete runtime
  # and locked dependencies are present. Prior runtimes remain available.

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

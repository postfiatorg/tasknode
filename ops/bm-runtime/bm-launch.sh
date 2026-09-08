#!/usr/bin/env bash
# Launch the configured Kimi TUI and resume its durable thread after a crash.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/bm-env.sh"
ALIAS="${1:?usage: bm-launch.sh <configured-agent> [--fresh|--resume <thread-id>]}"
case "${2:-}" in
  ""|--fresh) [ "$#" -le 2 ] || exit 1 ;;
  --resume) [ "$#" -eq 3 ] && [ -n "$3" ] || exit 1 ;;
  *) echo "Expected --fresh or --resume <thread-id>"; exit 1 ;;
esac
BOARDS="$(node "$DIR/registry.mjs" boards "$ALIAS")"
[ -n "$BOARDS" ] || { echo "Agent is not in agents.json"; exit 1; }
SESSION="bm-$ALIAS"
WORKDIR="$BM_HOME/workspaces/$ALIAS"
CONTROL="$BM_STATE_DIR/$ALIAS.control"
CREDENTIAL="$BM_HOME/credentials/$ALIAS.json"
[ -s "$CREDENTIAL" ] || { bm_log "launch: $ALIAS scoped API credential missing"; exit 1; }
[ -n "$BM_TERMINAL_BIN" ] && [ -x "$BM_TERMINAL_BIN" ] || exit 1
mkdir -p "$WORKDIR" "$CONTROL"
chmod 700 "$CONTROL"
TERM_CONFIG="$BM_TERMINAL_HOME/config.toml"
mkdir -p "$BM_TERMINAL_HOME"
touch "$TERM_CONFIG"
if ! grep -qF "[projects.\"$WORKDIR\"]" "$TERM_CONFIG"; then
  printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$WORKDIR" >> "$TERM_CONFIG"
fi
SKILLS="$(node "$DIR/registry.mjs" skills "$ALIAS")"
for skill in board-manager $SKILLS; do
  [ -f "$BM_SKILLS_DIR/$skill/SKILL.md" ] || { bm_log "launch: required skill $skill missing"; exit 1; }
done
# A live terminal may rotate only at a proven idle boundary. Pending work is
# preserved and redelivered by the supervisor, never erased by a restart.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  PANE="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' | head -1)"
  CHILD_PIDS="$(ps --ppid "$PANE" -o pid= 2>/dev/null || true)"
  READY="$(node -e 'const fs=require("fs");try{const s=JSON.parse(fs.readFileSync(process.argv[1]));const pids=process.argv[2].split("\n").map(x=>Number(x.trim()));const age=Date.now()-Date.parse(s.updatedAt);console.log(s.version===1 && Number.isInteger(s.pid) && s.pid>0 && pids.includes(s.pid) && s.threadId && s.ready && Number.isFinite(age) && age>=0 && age<15000?"yes":"no")}catch{console.log("no")}' "$CONTROL/status.json" "$CHILD_PIDS")"
  ALIVE=false
  while IFS= read -r child; do case "$child" in *corbanu*|*pfterminal*) ALIVE=true ;; esac; done < <(ps --ppid "$PANE" -o comm= 2>/dev/null || true)
  if [ "$ALIVE" = true ] && [ "$READY" != yes ]; then bm_log "launch: $ALIAS rotation deferred until ready"; exit 1; fi
fi
RESUME="$(node -e 'const fs=require("fs");try{console.log(JSON.parse(fs.readFileSync(process.argv[1])).threadId||"")}catch{}' "$CONTROL/status.json")"
[ "${2:-}" != "--fresh" ] || RESUME=""
[ "${2:-}" != "--resume" ] || RESUME="$3"
PROMPT="You are the production Kimi K3 Board Manager covering these boards: $BOARDS.
Read the board-manager skill and these board skills: $SKILLS.
Use: cd $BM_REPO && node scripts/bm.mjs <command>. Commands use your scoped Task Node API credential.
If a supervisor work order exists, use its round id with round-status <round-id> to recover unfinished work. Otherwise wait for the first work order. Record each duty outcome with duty-result; a journal entry does not finish a duty.
Read saved handoffs under $BM_JOURNAL_DIR for every assigned board. Wait for the supervisor's durable work order before beginning a new round."
ARGS=( "$BM_TERMINAL_BIN" -c "model_provider=\"$BM_PROVIDER\"" -m "$BM_MODEL" -c 'approval_policy="never"' -c 'sandbox_mode="danger-full-access"' -c 'check_for_update_on_startup=false' )
if [ -n "$RESUME" ]; then ARGS+=(resume "$RESUME"); fi
ARGS+=("$PROMPT")
printf -v COMMAND '%q ' "${ARGS[@]}"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$WORKDIR" \
  -e CODEX_HOME="$BM_TERMINAL_HOME" -e DATABASE_URL= -e TASKNODE_DATABASE_ENABLED=false \
  -e BM_AGENT_TOKEN_FILE="$CREDENTIAL" -e BM_AGENT_ORIGIN="${BM_AGENT_ORIGIN:-https://tasknode.postfiat.org}" \
  -e BM_HOME="$BM_HOME" -e BM_STATE_DIR="$BM_STATE_DIR" -e BM_JOURNAL_DIR="$BM_JOURNAL_DIR" \
  -e CORBANU_AGENT_CONTROL_DIR="$CONTROL" \
  "$COMMAND; sleep 86400"
date -u +%FT%TZ > "$BM_STATE_DIR/$ALIAS.launched_at"
bm_log "launch: $SESSION started with scoped API (provider=$BM_PROVIDER model=$BM_MODEL resumed=${RESUME:+yes})"

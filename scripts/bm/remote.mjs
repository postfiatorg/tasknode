import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function saveJson(file, value) { writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${file}.tmp`, file); }

// A lifecycle conflict is permanent until the task's status changes. When the
// same command file already holds a rejection, confirm the task moved before
// sending the identical mutation again; otherwise refuse locally with the
// original guidance. This bounds equivalent attempts to one per task state.
async function refuseUnchangedRejection({ file, saved, send }) {
  const rejected = saved?.rejected;
  if (!rejected?.taskId || !rejected.taskStatus) return;
  let detail = null;
  try { detail = await send(["task", "detail", rejected.taskId], `detail_${randomUUID()}`); } catch { return; }
  const status = detail?.task?.status || "";
  if (!status) return;
  if (status !== rejected.taskStatus) {
    saveJson(file, { key: saved.key, argv: saved.argv });
    return;
  }
  const count = Number(rejected.count || 1) + 1;
  saveJson(file, { ...saved, rejected: { ...rejected, count, lastRefusedAt: new Date().toISOString() } });
  throw new Error(`lifecycle_violation_repeated: this exact command was already rejected and the task is still '${status}'. ` +
    `It was not sent again (${count} attempts). A repeated command cannot change task state. ${rejected.message}`);
}

export async function remoteBoardCommand(argv, { tokenFile = process.env.BM_AGENT_TOKEN_FILE, origin = process.env.BM_AGENT_ORIGIN || "https://tasknode.postfiat.org", requestKey = "", stateDir = process.env.BM_STATE_DIR || path.join(process.env.BM_HOME || path.join(process.env.HOME, "pf-boards"), "state"), fetchImpl = globalThis.fetch } = {}) {
  const credential = readJson(tokenFile);
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("board_agent_origin_invalid");
  if (credential.origin !== origin) throw new Error("board_agent_credential_origin_mismatch");
  const args = argv.filter((arg) => arg !== "--json");
  const explicit = args.indexOf("--request-key");
  if (explicit >= 0) { requestKey = args[explicit + 1]; args.splice(explicit, 2); }
  const send = async (commandArgs, key) => {
    const response = await fetchImpl(`${origin}/api/agent/board/command`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: key, argv: commandArgs }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw Object.assign(new Error(body.message || body.error || `board_agent_http_${response.status}`), { status: response.status, lifecycle: body.lifecycle || null });
    return body.result;
  };
  let file = "";
  let saved = null;
  if (!requestKey) {
    let round = "manual";
    try { round = readJson(path.join(stateDir, `${credential.alias}.pending.json`)).id || round; } catch { /* No active round. */ }
    const fingerprint = createHash("sha256").update(JSON.stringify([credential.id, round, args])).digest("hex");
    const directory = path.join(stateDir, "commands");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    file = path.join(directory, `${fingerprint}.json`);
    try { writeFileSync(file, JSON.stringify({ key: `bm_${randomUUID()}`, argv: args }), { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    saved = readJson(file);
    requestKey = saved.key;
    await refuseUnchangedRejection({ file, saved, send });
  }
  try {
    return await send(args, requestKey);
  } catch (error) {
    if (file && error.status === 409 && error.lifecycle?.taskId) {
      saveJson(file, { ...saved, rejected: { taskId: error.lifecycle.taskId, taskStatus: error.lifecycle.taskStatus, message: error.message, count: 1, rejectedAt: new Date().toISOString() } });
    }
    throw error;
  }
}

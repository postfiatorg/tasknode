import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function remoteBoardCommand(argv, { tokenFile = process.env.BM_AGENT_TOKEN_FILE, origin = process.env.BM_AGENT_ORIGIN || "https://tasknode.postfiat.org", requestKey = "", stateDir = process.env.BM_STATE_DIR || path.join(process.env.BM_HOME || path.join(process.env.HOME, "pf-boards"), "state") } = {}) {
  const credential = JSON.parse(readFileSync(tokenFile, "utf8"));
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("board_agent_origin_invalid");
  if (credential.origin !== origin) throw new Error("board_agent_credential_origin_mismatch");
  const args = argv.filter((arg) => arg !== "--json");
  const explicit = args.indexOf("--request-key");
  if (explicit >= 0) { requestKey = args[explicit + 1]; args.splice(explicit, 2); }
  if (!requestKey) {
    let round = "manual";
    try { round = JSON.parse(readFileSync(path.join(stateDir, `${credential.alias}.pending.json`), "utf8")).id || round; } catch { /* No active round. */ }
    const fingerprint = createHash("sha256").update(JSON.stringify([credential.id, round, args])).digest("hex");
    const directory = path.join(stateDir, "commands");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${fingerprint}.json`);
    try { writeFileSync(file, JSON.stringify({ key: `bm_${randomUUID()}`, argv: args }), { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    requestKey = JSON.parse(readFileSync(file, "utf8")).key;
  }
  const response = await fetch(`${origin}/api/agent/board/command`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestKey, argv: args }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.message || body.error || `board_agent_http_${response.status}`);
  return body.result;
}

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readAgentRegistry } from "../ops/bm-runtime/registry.mjs";
import { query, closePool } from "../server/db/pool.js";

// Operator setup tool. Writes a restricted credential directly to a private
// file. It never prints bearer material and is not exposed through the agent API.
if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/bm-agent-credential.mjs <configured-alias> <private-output-file> [origin]\nCreates a one-year scoped credential after migration 135. The new file must not exist; bearer material is never printed.");
  process.exit(0);
}
const [alias, file, origin = "https://tasknode.postfiat.org"] = process.argv.slice(2);
const agent = readAgentRegistry().agents.find((item) => item.alias === alias);
if (!agent || !file) throw new Error("Usage: bm-agent-credential.mjs <configured-alias> <private-output-file> [origin]");
const token = randomBytes(32).toString("base64url");
const id = `agent_${randomUUID()}`;
try {
  await query(`INSERT INTO board_agent_credentials (id,token_hash,actor,board_ids,expires_at)
    VALUES ($1,$2,$3,$4::jsonb,now()+interval '365 days')`, [id, createHash("sha256").update(token).digest("hex"), `board_manager_${alias}`, JSON.stringify(agent.boards)]);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ id, alias, origin, token }), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ ok: true, id, alias, boards: agent.boards, credentialFileWritten: true }));
} catch (error) {
  await query("DELETE FROM board_agent_credentials WHERE id=$1", [id]);
  throw error;
} finally { await closePool(); }

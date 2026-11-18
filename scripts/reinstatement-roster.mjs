import { pathToFileURL } from "node:url";
import { closePool, transaction } from "../server/db/pool.js";

export async function updateReinstatementRoster(action, accounts = []) {
  if (!["status", "enroll"].includes(action) || (action === "enroll") !== Boolean(accounts.length)) {
    throw new Error("Usage: reinstatement-roster.mjs status | enroll ACCOUNT_ID [ACCOUNT_ID ...]");
  }
  if (new Set(accounts).size !== accounts.length) throw new Error("Each operator must have a distinct account ID");
  return transaction(async client => {
    if (action === "enroll") {
      const valid = await client.query("SELECT account_id FROM app_accounts WHERE account_id=ANY($1) AND status='active' FOR SHARE", [accounts]);
      if (valid.rowCount !== accounts.length) throw new Error("Every ID must identify an existing active account. Roster was not updated.");
      await client.query("INSERT INTO reinstatement_operators(account_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [accounts]);
    }
    const roster = await client.query("SELECT account_id FROM reinstatement_operators ORDER BY account_id");
    const members = roster.rows.map(row => row.account_id);
    const { rows } = await client.query(`SELECT count(*)::int AS open_entries_without_quorum
      FROM account_blacklist WHERE status='active' AND
        cardinality(array_remove($1::text[],account_id)) < 3`, [members]);
    return { members, quorumAvailable: members.length >= 3, openEntriesWithoutQuorum: rows[0].open_entries_without_quorum };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) process.env.TASKNODE_DATABASE_ENABLED = "true";
  try { console.log(JSON.stringify(await updateReinstatementRoster(process.argv[2] || "status", process.argv.slice(3)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await closePool(); }
}

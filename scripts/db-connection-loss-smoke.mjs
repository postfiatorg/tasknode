import assert from "node:assert/strict";
import { closePool, query, transaction } from "../server/db/pool.js";

// A connection that dies while a transaction holds it (database restart,
// failover, maintenance) must fail that transaction, not crash the process.
const crashes = [];
const recordCrash = (error) => crashes.push(error);
process.on("uncaughtException", recordCrash);

await assert.rejects(transaction(async (client) => {
  const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
  await query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.query("SELECT 1");
}));
process.off("uncaughtException", recordCrash);
assert.deepEqual(crashes.map((error) => error.message), []);
assert.equal((await query("SELECT 1 AS ok")).rows[0].ok, 1, "the pool must hand out a healthy connection afterwards");
await closePool();
console.log("db connection loss smoke ok");

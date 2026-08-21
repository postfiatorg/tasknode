import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const result = await migrateDatabase({ force: true });
console.log(JSON.stringify(result, null, 2));
await closePool();

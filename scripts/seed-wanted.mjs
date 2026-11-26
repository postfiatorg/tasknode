// Loads a Wanted list seed file. Idempotent: items keep fixed ids.
// Usage: node scripts/seed-wanted.mjs ops/wanted/seed-2026-11-25.json
import { readFile } from "node:fs/promises";
import { addWantedItem } from "../server/board-wanted.js";
import { closePool } from "../server/db/pool.js";

const seed = JSON.parse(await readFile(process.argv[2], "utf8"));
let added = 0;
for (const item of seed.items) {
  const row = await addWantedItem({
    id: item.id,
    boardId: item.board,
    title: item.title,
    why: item.why,
    sourceUrl: item.source,
    workType: item.work_type || "",
    rewardPft: item.reward || 0,
    preferredAccountId: item.founder ? seed.founder_account_id : "",
    createdBy: "operator_seed",
  });
  if (row) added += 1;
}
console.log(JSON.stringify({ items: seed.items.length, added }));
await closePool();

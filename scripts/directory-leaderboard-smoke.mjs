import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  directoryLeaderboardScore,
  publicProfileSummaries,
  queryDirectoryLeaderboardRows,
} from "../server/repositories/directory-leaderboard.js";

assert.equal(directoryLeaderboardScore({
  networkTasks: 2,
  personalTasks: 3,
  rewards: 25_000,
  alignment: 80,
}), 90);

let emptyQueryCalled = false;
assert.deepEqual(await queryDirectoryLeaderboardRows({
  accountIds: [],
  databaseReady: true,
  queryImpl: async () => {
    emptyQueryCalled = true;
    return { rows: [] };
  },
}), []);
assert.equal(emptyQueryCalled, false);

let capturedSql = "";
let capturedParams = [];
const rows = await queryDirectoryLeaderboardRows({
  accountIds: ["acct_public_one", "acct_public_two"],
  databaseReady: true,
  queryImpl: async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ account_id: "acct_public_one", tasks_rewarded: 1 }] };
  },
});

assert.equal(rows.length, 1);
assert.deepEqual(capturedParams, [["acct_public_one", "acct_public_two"]]);
assert.match(capturedSql, /FROM task_projections p/);
assert.match(capturedSql, /FROM profile_nfts nft/);
assert.match(capturedSql, /COUNT\(\*\)::integer AS tasks_rewarded/);
assert.equal((capturedSql.match(/reward_actual_pft > 0/g) || []).length, 1);
assert.doesNotMatch(capturedSql, /user_observability_events/);
assert.doesNotMatch(capturedSql, /latest_handle/);

let profileSql = "";
const profiles = await publicProfileSummaries({
  accountIds: ["acct_public_one"],
  queryImpl: async (sql) => {
    profileSql = sql;
    return { rows: [{ account_id: "acct_public_one", role_title: "Auditor", role_summary: "Audits.", skills: ["A", "B", "C", "D", "E", "F", "G"] }] };
  },
});
assert.deepEqual(profiles.get("acct_public_one"), { roleTitle: "Auditor", summary: "Audits.", skills: ["A", "B", "C", "D", "E", "F"] });
assert.match(profileSql, /FROM profile_public_snapshots/);
assert.match(profileSql, /status = 'completed'/);
assert.equal((await publicProfileSummaries({ accountIds: [], queryImpl: async () => { throw new Error("no query"); } })).size, 0);

const [viewSource, repositorySource] = await Promise.all([
  readFile(new URL("../src/features/directory/DirectoryView.jsx", import.meta.url), "utf8"),
  readFile(new URL("../server/repositories/directory-leaderboard.js", import.meta.url), "utf8"),
]);
assert.doesNotMatch(viewSource, /Alex(?:'|’)s call/i);
assert.doesNotMatch(repositorySource, /Alex(?:'|’)s call/i);
assert.doesNotMatch(repositorySource, /handleForIdentity\(identity, row\) \|\| safeText\(accountId/);
assert.match(viewSource, /operator\.handle \? `@\$\{operator\.handle\}` : operator\.displayName/);
assert.match(viewSource, /Showing public, discoverable operators only\./);

console.log("directory leaderboard smoke ok");

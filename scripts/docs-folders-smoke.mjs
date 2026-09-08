import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { changeDocsLibrary, emptyDocsLibrary, folderTrail, readDocsLibrary } from "../src/features/docs-library/docs-folders.js";
import { createDocsRootKey, decryptDocsMetadata, encryptDocsMetadata } from "../src/features/docs-library/docs-crypto.js";
import { routePolicyForPath } from "../server/route-policies.js";

let library = emptyDocsLibrary();
for (const [id, name, parentId] of [["research", "Research", ""], ["notes", "Meeting notes", "research"], ["planning", "Planning", ""]]) {
  library = changeDocsLibrary(library, { action: "create", id, name, parentId });
}
library = changeDocsLibrary(library, { action: "move", kind: "document", id: "owned-doc", parentId: "notes" });
library = changeDocsLibrary(library, { action: "move", kind: "document", id: "shared-doc", parentId: "research" });
assert.deepEqual(folderTrail(library, "notes").map(f => f.name), ["Research", "Meeting notes"]);
assert.throws(() => changeDocsLibrary(library, { action: "move", kind: "folder", id: "research", parentId: "notes" }));
assert.throws(() => changeDocsLibrary(library, { action: "move", kind: "folder", id: "research", parentId: "research" }));
assert.throws(() => changeDocsLibrary(library, { action: "move", kind: "document", id: "owned-doc", parentId: "missing" }));
assert.throws(() => changeDocsLibrary(library, { action: "create", id: "duplicate", name: " research ", parentId: "" }));
assert.throws(() => readDocsLibrary({ version: 1, folders: [{ id: "bad", name: "Bad", parentId: "missing" }], placements: {} }));
library = changeDocsLibrary(library, { action: "rename", id: "research", name: "Project research" });
assert.equal(library.placements["shared-doc"], "research");
library = changeDocsLibrary(library, { action: "move", kind: "folder", id: "notes", parentId: "planning" });
assert.equal(library.placements["owned-doc"], "notes");
library = changeDocsLibrary(library, { action: "remove", id: "planning" });
assert.equal(library.folders.find(f => f.id === "notes").parentId, "");
assert.equal(library.placements["owned-doc"], "notes");
library = changeDocsLibrary(library, { action: "remove", id: "research" });
assert.equal(library.placements["shared-doc"], "");
let collision = emptyDocsLibrary();
for (const [id, name, parentId] of [["parent", "Project", ""], ["root-notes", "Notes", ""], ["child-notes", "Notes", "parent"]]) {
  collision = changeDocsLibrary(collision, { action: "create", id, name, parentId });
}
assert.throws(() => changeDocsLibrary(collision, { action: "remove", id: "parent" }));
assert.equal(collision.folders.length, 3);
const rootKey = createDocsRootKey();
const envelope = await encryptDocsMetadata(library, rootKey);
assert.ok(!JSON.stringify(envelope).includes("Meeting notes"));
assert.ok(!JSON.stringify(envelope).includes("owned-doc"));
assert.deepEqual(readDocsLibrary(await decryptDocsMetadata(envelope, rootKey)), library);
await assert.rejects(decryptDocsMetadata(envelope, createDocsRootKey()));
assert.equal(routePolicyForPath("/api/docs/library").auth, "session");
assert.deepEqual(routePolicyForPath("/api/docs/library").methods, ["PATCH"]);

// A connection-local temp table proves durable CAS/tenant isolation without
// writing fixture accounts into any application's actual docs_accounts table.
process.env.DATABASE_URL ||= "postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL).hostname), "Use a local database for this fixture");
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.DATABASE_POOL_MAX = "1";
const { query, getPool } = await import("../server/db/pool.js");
const { updateDocsLibrary } = await import("../server/repositories/docs-library.js");
try {
  await query("CREATE TEMP TABLE docs_accounts (account_id text PRIMARY KEY, status text DEFAULT 'active', updated_at timestamptz DEFAULT now())");
  await query(await readFile(new URL("../server/db/migrations/133_docs_library_folders.sql", import.meta.url), "utf8"));
  await query("INSERT INTO docs_accounts (account_id) VALUES ('folder_alice'), ('folder_bob')");
  assert.equal((await updateDocsLibrary({ accountId: "folder_alice", expectedVersion: 0, encryptedLibraryMetadata: envelope })).version, 1);
  assert.equal((await updateDocsLibrary({ accountId: "folder_alice", expectedVersion: 0, encryptedLibraryMetadata: envelope })).status, 409);
  assert.equal((await updateDocsLibrary({ accountId: "missing", expectedVersion: 0, encryptedLibraryMetadata: envelope })).status, 409);
  const bob = await query("SELECT * FROM docs_accounts WHERE account_id='folder_bob'");
  assert.equal(bob.rows[0].encrypted_library_metadata, null);
  assert.equal(bob.rows[0].library_metadata_version, 0);
  const alice = await query("SELECT * FROM docs_accounts WHERE account_id='folder_alice'");
  assert.deepEqual(await decryptDocsMetadata(alice.rows[0].encrypted_library_metadata, rootKey), library);
  const contenders = await Promise.all([1, 2].map(() => updateDocsLibrary({ accountId: "folder_alice", expectedVersion: 1, encryptedLibraryMetadata: envelope })));
  assert.equal(contenders.filter(r => r.ok).length, 1);
  assert.equal(contenders.filter(r => r.status === 409).length, 1);
  for (const invalid of [{ ...envelope, name: "plaintext" }, { ...envelope, iv: "bad" }, { ...envelope, ciphertext: "short" }, { ...envelope, version: 2 }]) {
    assert.equal((await updateDocsLibrary({ accountId: "folder_alice", expectedVersion: 2, encryptedLibraryMetadata: invalid })).status, 400);
  }
  const { handleCollaborationRoute } = await import("../server/collaboration-routes.js");
  const route = async (session, payload) => {
    let response;
    await handleCollaborationRoute({
      req: { method: "PATCH" }, res: {}, session,
      url: new URL("http://localhost/api/docs/library"),
      readJson: async () => payload,
      json: (_res, status, body) => { response = { status, body }; },
    });
    return response;
  };
  assert.equal((await route(null, {})).status, 401);
  const routed = await route({ accountId: "folder_alice" }, {
    accountId: "folder_bob", expectedVersion: 2, encryptedLibraryMetadata: envelope,
  });
  assert.equal(routed.status, 200);
  assert.equal(routed.body.version, 3);
  assert.equal((await query("SELECT library_metadata_version FROM docs_accounts WHERE account_id='folder_bob'")).rows[0].library_metadata_version, 0);
  await query("UPDATE docs_accounts SET status='locked' WHERE account_id='folder_bob'");
  assert.equal((await updateDocsLibrary({ accountId: "folder_bob", expectedVersion: 0, encryptedLibraryMetadata: envelope })).status, 409);
} finally { await getPool()?.end(); }
console.log("Docs folders: nested organization, moves, deletion preservation, encryption, stale/concurrent writes, and account isolation passed.");

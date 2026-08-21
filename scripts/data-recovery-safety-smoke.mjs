#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  databaseConfig,
  requireEmptyDirectory,
  restore,
  validateRuntimeStore,
} from "./data-recovery.mjs";

assert.throws(
  () => databaseConfig("postgres://operator:secret@database.example.com/production"),
  /recovery_remote_database_refused/
);
assert.throws(() => requireEmptyDirectory("/"), /recovery_output_directory_unsafe/);
assert.throws(() => requireEmptyDirectory(tmpdir()), /recovery_output_directory_unsafe/);
assert.throws(
  () => restore({
    databaseUrl: "postgres://operator:secret@127.0.0.1:5432/production",
    backupDirectory: "/does/not/matter",
  }),
  /recovery_restore_target_name_refused/
);

const work = mkdtempSync(path.join(tmpdir(), "tasknode-recovery-safety-"));
try {
  const invalid = path.join(work, "invalid-runtime.json");
  writeFileSync(invalid, JSON.stringify({ sessions: {} }));
  assert.throws(() => validateRuntimeStore(invalid), /runtime_store_backup_invalid/);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("data recovery safety smoke ok: remote, destructive-target, and malformed-store guards verified");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  vaultStatusFromVault,
  walletVaultPersistence,
} from "../src/wallet-core.js";

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function installNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function restoreNavigator() {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    return;
  }
  delete globalThis.navigator;
}

function sampleVault() {
  return {
    version: 1,
    address: "rVaultDurability",
    publicKey: "EDPUB",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    encryption: {
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 250000,
      },
    },
  };
}

async function assertWalletPersistenceStatus() {
  installNavigator({
    storage: {
      persisted: async () => true,
    },
  });
  assert.equal(await walletVaultPersistence(), "persistent");
  assert.equal(
    vaultStatusFromVault({
      accountId: "acct_persistent",
      vault: sampleVault(),
      storage: "indexedDB",
      persistence: await walletVaultPersistence(),
    }).persistence,
    "persistent"
  );

  installNavigator({
    storage: {
      persisted: async () => false,
      persist: async () => false,
    },
  });
  assert.equal(await walletVaultPersistence(), "volatile");
  assert.equal(
    vaultStatusFromVault({
      accountId: "acct_volatile",
      vault: sampleVault(),
      storage: "indexedDB",
      persistence: await walletVaultPersistence(),
    }).persistence,
    "volatile"
  );

  installNavigator({});
  assert.equal(await walletVaultPersistence(), "unknown");
  assert.equal(
    vaultStatusFromVault({
      accountId: "acct_unknown",
      vault: sampleVault(),
      storage: "localStorage",
    }).persistence,
    "unknown"
  );

  restoreNavigator();
}

// Each step runs in a fresh process: the store module loads its file once at import.
function runStore(storePath, body) {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `import * as store from "./server/runtime-store.js";\n${body}`], {
    cwd: process.cwd(),
    env: { ...process.env, TASKNODE_STORE_PATH: storePath, TASKNODE_DATABASE_ENABLED: "false" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.trim().split("\n").at(-1));
}

function assertAtomicRuntimeStoreWrites() {
  const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-wallet-vault-durability-"));
  try {
    const storePath = join(tempDir, "runtime-store.json");
    const account = { id: "acct_atomic_runtime", displayName: "Atomic Runtime", linkedProviders: [], profileVisibility: "public" };
    const { sessionId } = runStore(storePath, `console.log(JSON.stringify({ sessionId: store.createAccountSession(${JSON.stringify(account)}).sessionId }));`);
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).sessions[sessionId].accountId, account.id);
    assert.equal(existsSync(`${storePath}.tmp`), false, "atomic save should not leave a tmp file after rename");

    writeFileSync(`${storePath}.tmp`, "{\"sessions\":", { mode: 0o600 });
    const reloaded = runStore(storePath, `console.log(JSON.stringify({ accountId: store.getSession(${JSON.stringify(sessionId)})?.accountId || null }));`);
    assert.equal(reloaded.accountId, account.id, "a stray partial tmp file must not clobber the good post-rename store");

    const corruptPath = join(tempDir, "corrupt-runtime-store.json");
    const corruptBody = "{\"sessions\":";
    writeFileSync(corruptPath, corruptBody, { mode: 0o600 });
    const afterCorrupt = runStore(corruptPath, `store.createAccountSession(${JSON.stringify(account)}); console.log(JSON.stringify({ ok: true }));`);
    assert.equal(afterCorrupt.ok, true);
    const quarantined = readdirSync(tempDir).filter((name) => name.startsWith("corrupt-runtime-store.json.corrupt-"));
    assert.equal(quarantined.length, 1, "a corrupt store must be moved aside");
    assert.equal(readFileSync(join(tempDir, quarantined[0]), "utf8"), corruptBody, "saving after a corrupt load must not overwrite the corrupt original");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await assertWalletPersistenceStatus();
assertAtomicRuntimeStoreWrites();

console.log("wallet vault durability smoke ok");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

async function importRuntimeStore(label) {
  const runtimeStoreUrl = pathToFileURL(join(process.cwd(), "server/runtime-store.js")).href;
  return import(`${runtimeStoreUrl}?wallet-vault-durability=${encodeURIComponent(label)}-${Date.now()}`);
}

async function assertAtomicRuntimeStoreWrites() {
  const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-wallet-vault-durability-"));
  const priorStorePath = process.env.TASKNODE_STORE_PATH;
  const storePath = join(tempDir, "runtime-store.json");
  process.env.TASKNODE_STORE_PATH = storePath;

  try {
    const runtimeStore = await importRuntimeStore("valid");
    const account = {
      id: "acct_atomic_runtime",
      displayName: "Atomic Runtime",
      linkedProviders: [],
      profileVisibility: "public",
    };
    const created = runtimeStore.createAccountSession(account);
    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    assert.equal(saved.sessions[created.sessionId].accountId, account.id);
    assert.equal(existsSync(`${storePath}.tmp`), false, "atomic save should not leave a tmp file after rename");

    writeFileSync(`${storePath}.tmp`, "{\"sessions\":", { mode: 0o600 });
    const runtimeStoreReloaded = await importRuntimeStore("valid-with-stray-tmp");
    assert.equal(
      runtimeStoreReloaded.getSession(created.sessionId).accountId,
      account.id,
      "a stray partial tmp file must not clobber the good post-rename store"
    );
    assert.equal(readFileSync(`${storePath}.tmp`, "utf8"), "{\"sessions\":");

    const corruptPath = join(tempDir, "corrupt-runtime-store.json");
    const corruptBody = "{\"sessions\":";
    writeFileSync(corruptPath, corruptBody, { mode: 0o600 });
    process.env.TASKNODE_STORE_PATH = corruptPath;
    const corruptRuntimeStore = await importRuntimeStore("corrupt");
    assert.equal(corruptRuntimeStore.getSession(created.sessionId), null);
    assert.equal(
      readFileSync(corruptPath, "utf8"),
      corruptBody,
      "loading a corrupt actual store should fall back in memory without rewriting the corrupt file"
    );
  } finally {
    if (priorStorePath === undefined) {
      delete process.env.TASKNODE_STORE_PATH;
    } else {
      process.env.TASKNODE_STORE_PATH = priorStorePath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await assertWalletPersistenceStatus();
await assertAtomicRuntimeStoreWrites();

console.log("wallet vault durability smoke ok");

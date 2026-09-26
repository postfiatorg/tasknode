import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "espree";

export const sourceRoot = process.env.SOURCE_ROOT || fileURLToPath(new URL("../", import.meta.url));
export const walletSession = await import(pathToFileURL(`${sourceRoot}/src/features/wallet/wallet-unlocked-session.js`));
export const walletState = await import(pathToFileURL(`${sourceRoot}/src/features/wallet/wallet-state.js`));
export const boundary = await import(pathToFileURL(`${sourceRoot}/src/features/settings/account-transition-boundary.js`));
export const synthetic = {
  accountId: "acct_synthetic_A", address: "rSyntheticNeverFundedA", publicKey: null, derivationPath: null,
  mnemonic: "synthetic placeholder never used for a wallet", unlockedAt: "2026-09-26T00:00:00.000Z",
};
export const newer = { ...synthetic, mnemonic: "different synthetic placeholder never used for a wallet", unlockedAt: "2026-09-26T01:00:00.000Z" };
export const envelopeKey = `tasknode:wallet-unlocked-session:v2:${synthetic.accountId}`;

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function setup() {
  const values = new Map();
  const storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  let armed;
  const subtle = {};
  for (const name of ["generateKey", "importKey", "exportKey", "encrypt", "decrypt"]) {
    subtle[name] = async (...args) => {
      const operation = armed?.name === name ? armed : null;
      if (!operation) return webcrypto.subtle[name](...args);
      armed = null;
      if (operation.rejectExport) {
        const nonExtractable = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        operation.entered.resolve();
        await operation.release.promise;
        return webcrypto.subtle.exportKey("raw", nonExtractable);
      }
      if (operation.rejectDecrypt) {
        const corrupted = new Uint8Array(args[2]);
        corrupted[corrupted.length - 1] ^= 1;
        operation.entered.resolve();
        await operation.release.promise;
        return webcrypto.subtle.decrypt(args[0], args[1], corrupted);
      }
      const result = await webcrypto.subtle[name](...args);
      operation.entered.resolve();
      await operation.release.promise;
      return result;
    };
  }
  const cryptoObj = { subtle, getRandomValues: value => webcrypto.getRandomValues(value) };
  const keyStore = walletSession.createSessionStorageKeyStore(storage, cryptoObj);
  const store = walletSession.createUnlockedWalletSessionStore({ storage, cryptoObj, keyStore });
  return {
    values, storage, store, cryptoObj, keyStore,
    arm(name, { rejectDecrypt = false, rejectExport = false } = {}) {
      assert.ok(!armed, "only one crypto barrier is armed at a time");
      armed = { name, rejectDecrypt, rejectExport, entered: deferred(), release: deferred() };
      const gate = armed;
      return { entered: gate.entered.promise, release: () => gate.release.resolve() };
    },
  };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["range", "loc", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

// Parse and execute the actual callback body; substitute only the dynamic import.
export function appCallback(name, dependencies) {
  const source = readFileSync(`${sourceRoot}/src/app/App.jsx`, "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
  const candidates = [];
  walk(ast, node => {
    if (node.type === "VariableDeclarator" && node.id.name === name) candidates.push(node.init.arguments[0]);
  });
  assert.equal(candidates.length, 1, `one actual ${name} callback`);
  const node = candidates[0];
  assert.equal(node.type, "ArrowFunctionExpression");
  const substitutions = [];
  walk(node, child => {
    if (child.type !== "ImportExpression") return;
    assert.equal(child.source.value, "../wallet-core");
    substitutions.push(child.range);
  });
  assert.equal(substitutions.length, name === "refreshWalletVaultStatus" ? 1 : 0);
  let expression = source.slice(...node.range);
  for (const [start, end] of substitutions.sort((a, b) => b[0] - a[0])) {
    expression = expression.slice(0, start - node.range[0]) + "Promise.resolve(syntheticWalletCore)" + expression.slice(end - node.range[0]);
  }
  return new Function(...Object.keys(dependencies), `return (${expression});`)(...Object.values(dependencies));
}

export function switcherFactory(requestJson, onReload) {
  const source = readFileSync(`${sourceRoot}/src/features/settings/account-switch-client.js`, "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", range: true });
  const exported = ast.body.find(node => node.type === "ExportNamedDeclaration" && node.declaration?.id?.name === "createAccountSwitcherActions");
  assert.ok(exported);
  return new Function("requestJson", "clearSessionHint", "window", `return (${source.slice(...exported.declaration.range)});`)(requestJson, () => {}, { location: { reload: onReload } });
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

let verifyBackupWord;
try {
  ({ verifyBackupWord } = await server.ssrLoadModule("/src/features/wallet/WalletView.jsx"));
} finally {
  await server.close();
}

const mnemonic = [
  "abandon", "ability", "able", "about", "above", "absent",
  "absorb", "abstract", "absurd", "abuse", "access", "accident",
  "account", "accuse", "achieve", "acid", "acoustic", "acquire",
  "across", "act", "action", "actor", "actress", "actual",
].join(" ");

assert.equal(
  verifyBackupWord({ normalizedMnemonic: mnemonic, index: 1, input: "abandon" }),
  true,
  "the exact requested word should pass"
);

assert.equal(
  verifyBackupWord({ normalizedMnemonic: mnemonic, index: 24, input: " ACTUAL " }),
  true,
  "case-insensitive trimmed input should pass"
);

assert.equal(
  verifyBackupWord({ normalizedMnemonic: mnemonic, index: 4, input: "above" }),
  false,
  "a different word should fail"
);

assert.equal(
  verifyBackupWord({ normalizedMnemonic: mnemonic, index: 0, input: "abandon" }),
  false,
  "index 0 should fail"
);

assert.equal(
  verifyBackupWord({ normalizedMnemonic: mnemonic, index: 25, input: "actual" }),
  false,
  "an out-of-range index should fail"
);

assert.equal(
  verifyBackupWord({ normalizedMnemonic: mnemonic, index: 2.5, input: "ability" }),
  false,
  "a non-integer index should fail"
);

assert.equal(
  verifyBackupWord({ normalizedMnemonic: "", index: 1, input: "abandon" }),
  false,
  "an empty mnemonic should fail"
);

console.log("verified seed backup smoke ok");

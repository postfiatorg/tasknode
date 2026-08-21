#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

let numberedRecoveryWords;
let verifyBackupWord;
try {
  ({ numberedRecoveryWords, verifyBackupWord } = await server.ssrLoadModule("/src/features/wallet/WalletView.jsx"));
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

for (const verifyIndex of [1, 18, 24]) {
  const words = numberedRecoveryWords({ normalizedMnemonic: mnemonic, verifyIndex });
  assert.equal(words.length, 24, "all recovery words should receive a visible position");
  assert.deepEqual(
    words.map(({ index }) => index),
    Array.from({ length: 24 }, (_, index) => index + 1),
    "recovery word positions should be sequential and one-based"
  );
  assert.deepEqual(
    words.filter(({ verificationTarget }) => verificationTarget).map(({ index }) => index),
    [verifyIndex],
    `word ${verifyIndex} should be the only highlighted verification target`
  );
}

const eighteenthWord = numberedRecoveryWords({ normalizedMnemonic: mnemonic, verifyIndex: 18 })[17];
assert.deepEqual(
  eighteenthWord,
  { index: 18, word: "acquire", verificationTarget: true },
  "a high-numbered verification word should remain directly identifiable"
);

assert.equal(
  numberedRecoveryWords({ normalizedMnemonic: mnemonic, verifyIndex: 25 }).some(({ verificationTarget }) => verificationTarget),
  false,
  "an invalid verification position should not highlight a misleading word"
);

console.log("verified seed backup smoke ok");
